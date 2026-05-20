/**
 * Shared Analysis Orchestrator
 *
 * Extracts the core analysis pipeline from the CLI analyze command into a
 * reusable function that can be called from both the CLI and a server-side
 * worker process.
 *
 * IMPORTANT: This module must NEVER call process.exit(). The caller (CLI
 * wrapper or server worker) is responsible for process lifecycle.
 */

import path from 'path';
import fs from 'fs/promises';
import { runPipelineFromRepo } from './ingestion/pipeline.js';
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  executeWithReusedStatement,
  closeLbug,
  loadCachedEmbeddings,
  deleteNodesForFile,
  deleteAllCommunitiesAndProcesses,
  queryImporters,
} from './lbug/lbug-adapter.js';
import { createSearchFTSIndexes } from './search/fts-indexes.js';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  ensureGitNexusIgnored,
  registerRepo,
  cleanupOldKuzuFiles,
  INCREMENTAL_SCHEMA_VERSION,
} from '../storage/repo-manager.js';
import { computeFileHashes } from '../storage/file-hash.js';
import { walkRepositoryPaths } from './ingestion/filesystem-walker.js';
import { extractChangedSubgraph } from './incremental/subgraph-extract.js';
import { deriveIncrementalPlan } from './incremental/plan.js';
import { deriveIncrementalWriteSet } from './incremental/write-set.js';
import { shadowCandidatesFor } from './incremental/shadow-candidates.js';
import { validateIncrementalGraphConsistency } from './incremental/validation.js';
import { loadParseCache, saveParseCache, pruneCache } from '../storage/parse-cache.js';
import {
  saveFileParseArtifactsBatch,
} from '../storage/file-artifact-cache.js';
import {
  getCurrentCommit,
  getRemoteUrl,
  hasGitDir,
  getGitRoot,
  getInferredRepoName,
  resolveRepoIdentityRoot,
} from '../storage/git.js';
import type { CachedEmbedding } from './embeddings/types.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import { EMBEDDING_TABLE_NAME, REL_TABLE_NAME } from './lbug/schema.js';
import { STALE_HASH_SENTINEL } from './lbug/schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeCallbacks {
  onProgress: (phase: string, percent: number, message: string) => void;
  onLog?: (message: string) => void;
}

export interface AnalyzeOptions {
  /**
   * Force a full re-index of the pipeline. Callers may OR this with
   * other flags that imply re-analysis (e.g. `--skills`), so the value
   * here is the PIPELINE-force signal, NOT the registry-collision
   * bypass. See `allowDuplicateName` below.
   */
  force?: boolean;
  /** Explicit opt-in alias for default incremental-when-eligible behavior. */
  incremental?: boolean;
  embeddings?: boolean;
  /**
   * Override the auto-skip node-count cap for embedding generation.
   * `undefined` (default) keeps the built-in 50,000-node safety limit;
   * `0` disables the cap entirely; any positive integer sets a custom cap.
   * Mapped from the CLI's `--embeddings [limit]` argument.
   */
  embeddingsNodeLimit?: number;
  /**
   * Explicitly drop any embeddings present in the existing index instead of
   * preserving them. Only meaningful when `embeddings` is false/undefined:
   * the default behavior in that case is to load the previously generated
   * embeddings and re-insert them after the rebuild so a routine
   * re-analyze does not silently wipe a long embedding pass (#issue: analyze
   * silently wipes existing embeddings when run without --embeddings).
   */
  dropEmbeddings?: boolean;
  skipGit?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
  /** Skip installing standard GitNexus skill files to .claude/skills/gitnexus/. */
  skipSkills?: boolean;
  /**
   * User-provided alias for the registry `name` (#829). When set,
   * forwarded to `registerRepo` so the indexed repo is stored under
   * this alias instead of the path-derived basename.
   */
  registryName?: string;
  /**
   * Bypass the `RegistryNameCollisionError` guard and allow two paths
   * to register under the same `name` (#829). Controlled by the
   * dedicated `--allow-duplicate-name` CLI flag, intentionally
   * independent from `--force` — users who hit the collision guard
   * should be able to accept the duplicate without paying the cost
   * of a pipeline re-index.
   */
  allowDuplicateName?: boolean;
  /** @internal Test-only worker threshold override forwarded to the ingestion pipeline. */
  workerThresholdsForTest?: {
    minFiles?: number;
    minBytes?: number;
  };
}

export interface AnalyzeResult {
  repoName: string;
  repoPath: string;
  stats: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  alreadyUpToDate?: boolean;
  /** The raw pipeline result — only populated when needed by callers (e.g. skill generation). */
  pipelineResult?: any;
}

// Re-export the pure flag-derivation helper so external callers (and tests)
// keep importing from this module's stable surface.
export { deriveEmbeddingMode, DEFAULT_EMBEDDING_NODE_LIMIT } from './embedding-mode.js';
export type { EmbeddingMode } from './embedding-mode.js';
import {
  deriveEmbeddingMode as _deriveEmbeddingMode,
  deriveEmbeddingCap,
  DEFAULT_EMBEDDING_NODE_LIMIT,
} from './embedding-mode.js';

export const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

const escapeCypherString = (value: string): string => value.replace(/'/g, "''");
const escapeCypherLabel = (value: string): string => `\`${value.replace(/`/g, '``')}\``;
const firstCount = (rows: any[]): number => Number(rows?.[0]?.cnt ?? rows?.[0]?.[0] ?? 0);

interface AnalyzeProfileTimings {
  preflightMs: number;
  embeddingCacheLoadMs: number;
  parseCacheLoadMs: number;
  scanMs: number;
  structureMs: number;
  markdownMs: number;
  cobolMs: number;
  hashMs: number;
  incrementalPlanningMs: number;
  importerExpansionMs: number;
  pipelineMs: number;
  parseExtractMs: number;
  routesMs: number;
  toolsMs: number;
  ormMs: number;
  crossFileMs: number;
  scopeResolutionMs: number;
  mroMs: number;
  scopeExtractMs: number;
  scopeFinalizeMs: number;
  scopePropagateMs: number;
  scopeResolveMs: number;
  scopeEmitMs: number;
  communitiesMs: number;
  processesMs: number;
  dbWritebackMs: number;
  lbugInitMs: number;
  dirtyMetaMs: number;
  fullWipeMs: number;
  writeSetPlanningMs: number;
  deleteRowsMs: number;
  deleteGraphWideMs: number;
  subgraphExtractMs: number;
  graphLoadMs: number;
  validationMs: number;
  ftsMs: number;
  embeddingRestoreMs: number;
  embeddingGenerateMs: number;
  checkpointReopenMs: number;
  metadataMs: number;
  cacheSaveMs: number;
  fileArtifactSaveMs: number;
  registryMs: number;
  contextFilesMs: number;
  finalCloseMs: number;
  totalAnalyzeMs: number;
}

interface AnalyzeProfileCounters {
  parseCacheHits: number;
  parseCacheMisses: number;
  parsedFiles: number;
  fileArtifactHits: number;
  fileArtifactMisses: number;
  replayedFiles: number;
  artifactReplayEnabled: boolean;
  artifactReplayDisabledReason?: string;
  scopePreExtractedHits?: number;
  scopePreExtractedMisses?: number;
  scopeFilesExtracted?: number;
  scopeFilesResolved?: number;
}

export const isAnalyzeProfilingEnabled = (): boolean => process.env.GITNEXUS_VERBOSE === '1';

const formatMs = (ms: number): string => `${Math.max(0, Math.round(ms))}ms`;

const sumProfileMajorTimings = (timings: AnalyzeProfileTimings): number =>
  timings.preflightMs +
  timings.embeddingCacheLoadMs +
  timings.parseCacheLoadMs +
  timings.hashMs +
  timings.incrementalPlanningMs +
  timings.importerExpansionMs +
  timings.pipelineMs +
  timings.dbWritebackMs +
  timings.ftsMs +
  timings.embeddingRestoreMs +
  timings.embeddingGenerateMs +
  timings.checkpointReopenMs +
  timings.metadataMs +
  timings.cacheSaveMs +
  timings.fileArtifactSaveMs +
  timings.registryMs +
  timings.contextFilesMs;

export const formatAnalyzeProfileLog = (
  timings: AnalyzeProfileTimings,
  counters: AnalyzeProfileCounters,
): string[] => [
  'Analyze profile:',
  `  counters: parseCacheHits=${counters.parseCacheHits}, parseCacheMisses=${counters.parseCacheMisses}, parsedFiles=${counters.parsedFiles}, fileArtifactHits=${counters.fileArtifactHits}, fileArtifactMisses=${counters.fileArtifactMisses}, replayedFiles=${counters.replayedFiles}, artifactReplay=${counters.artifactReplayEnabled ? 'enabled' : `disabled(${counters.artifactReplayDisabledReason ?? 'not attempted'})`}`,
  `  scopeCounters: scopePreExtractedHits=${counters.scopePreExtractedHits ?? 0}, scopePreExtractedMisses=${counters.scopePreExtractedMisses ?? 0}, scopeFilesExtracted=${counters.scopeFilesExtracted ?? 0}, scopeFilesResolved=${counters.scopeFilesResolved ?? 0}`,
  `  pipeline: total=${formatMs(timings.pipelineMs)}, scan=${formatMs(timings.scanMs)}, structure=${formatMs(timings.structureMs)}, markdown=${formatMs(timings.markdownMs)}, cobol=${formatMs(timings.cobolMs)}, parseExtract=${formatMs(timings.parseExtractMs)}, routes=${formatMs(timings.routesMs)}, tools=${formatMs(timings.toolsMs)}, orm=${formatMs(timings.ormMs)}, crossFile=${formatMs(timings.crossFileMs)}, scopeResolution=${formatMs(timings.scopeResolutionMs)}, mro=${formatMs(timings.mroMs)}, communities=${formatMs(timings.communitiesMs)}, processes=${formatMs(timings.processesMs)}`,
  `  scopeResolution: extract=${formatMs(timings.scopeExtractMs)}, finalize=${formatMs(timings.scopeFinalizeMs)}, propagate=${formatMs(timings.scopePropagateMs)}, resolve=${formatMs(timings.scopeResolveMs)}, emit=${formatMs(timings.scopeEmitMs)}`,
  `  db: writeback=${formatMs(timings.dbWritebackMs)}, init=${formatMs(timings.lbugInitMs)}, close=${formatMs(timings.finalCloseMs)}, dirtyMeta=${formatMs(timings.dirtyMetaMs)}, fullWipe=${formatMs(timings.fullWipeMs)}, writeSetPlanning=${formatMs(timings.writeSetPlanningMs)}, deleteRows=${formatMs(timings.deleteRowsMs)}, deleteGraphWide=${formatMs(timings.deleteGraphWideMs)}, subgraphExtract=${formatMs(timings.subgraphExtractMs)}, graphLoad=${formatMs(timings.graphLoadMs)}, validation=${formatMs(timings.validationMs)}, checkpointReopen=${formatMs(timings.checkpointReopenMs)}`,
  `  postDb: fts=${formatMs(timings.ftsMs)}, embeddingCacheLoad=${formatMs(timings.embeddingCacheLoadMs)}, embeddingRestore=${formatMs(timings.embeddingRestoreMs)}, embeddingGenerate=${formatMs(timings.embeddingGenerateMs)}, metadata=${formatMs(timings.metadataMs)}, cacheSave=${formatMs(timings.cacheSaveMs)}, fileArtifactSave=${formatMs(timings.fileArtifactSaveMs)}, registry=${formatMs(timings.registryMs)}, contextFiles=${formatMs(timings.contextFilesMs)}`,
  `  orchestration: preflight=${formatMs(timings.preflightMs)}, parseCacheLoad=${formatMs(timings.parseCacheLoadMs)}, hash=${formatMs(timings.hashMs)}, incrementalPlanning=${formatMs(timings.incrementalPlanningMs)}, importerExpansion=${formatMs(timings.importerExpansionMs)}, accounted=${formatMs(sumProfileMajorTimings(timings))}, unaccounted=${formatMs(timings.totalAnalyzeMs - sumProfileMajorTimings(timings))}, total=${formatMs(timings.totalAnalyzeMs)}`,
];

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full GitNexus analysis pipeline.
 *
 * This is the shared core extracted from the CLI `analyze` command. It
 * handles: pipeline execution, LadybugDB loading, FTS indexing, embedding
 * generation, metadata persistence, and AI context file generation.
 *
 * The function communicates progress and log messages exclusively through
 * the {@link AnalyzeCallbacks} interface — it never writes to stdout/stderr
 * directly and never calls `process.exit()`.
 */
export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
): Promise<AnalyzeResult> {
  // Keep analyze's hash universe aligned with `gitnexus status`, even when
  // invoked from a subdirectory via `gitnexus analyze --incremental .`.
  if (!options.skipGit) {
    const gitRoot = getGitRoot(repoPath);
    if (gitRoot) repoPath = gitRoot;
  }
  const analyzeStart = Date.now();
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);
  const profile = {
    preflightMs: 0,
    embeddingCacheLoadMs: 0,
    parseCacheLoadMs: 0,
    hashMs: 0,
    incrementalPlanningMs: 0,
    importerExpansionMs: 0,
    pipelineMs: 0,
    dbWritebackMs: 0,
    lbugInitMs: 0,
    dirtyMetaMs: 0,
    fullWipeMs: 0,
    writeSetPlanningMs: 0,
    deleteRowsMs: 0,
    deleteGraphWideMs: 0,
    subgraphExtractMs: 0,
    graphLoadMs: 0,
    validationMs: 0,
    ftsMs: 0,
    embeddingRestoreMs: 0,
    embeddingGenerateMs: 0,
    checkpointReopenMs: 0,
    metadataMs: 0,
    cacheSaveMs: 0,
    fileArtifactSaveMs: 0,
    registryMs: 0,
    contextFilesMs: 0,
    finalCloseMs: 0,
  };

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  const preflightStart = Date.now();
  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  const existingMeta = await loadMeta(storagePath);
  profile.preflightMs += Date.now() - preflightStart;

  // Preserve the existing dirty-recovery behavior: downstream embedding
  // mode treats this as a forced rebuild, while the incremental planner
  // still reports the more specific fallback reason.
  const dirtyRecovery = !!existingMeta?.incrementalInProgress;
  if (dirtyRecovery) {
    options = { ...options, force: true };
  }

  // ── Cache embeddings from existing index before rebuild ────────────
  // Four modes:
  //   --embeddings              -> load cache, restore, then generate any new ones
  //   --force (with existing
  //    embeddings)              -> auto-imply --embeddings: load cache, restore,
  //                                regenerate embeddings for new/changed nodes
  //                                (a forced re-index of an embedded repo
  //                                shouldn't quietly downgrade to "preserve only")
  //   (default)                 -> if existing index has embeddings, preserve them
  //                                (load + restore, but do not generate); otherwise no-op
  //   --drop-embeddings         -> skip cache load entirely; rebuild wipes embeddings
  //
  // The default-preserve branch is what makes a routine `analyze` (e.g. a
  // post-commit hook) safe: a multi-minute embedding pass is no longer
  // silently dropped just because the caller omitted `--embeddings`.
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: CachedEmbedding[] = [];

  const existingEmbeddingCount = existingMeta?.stats?.embeddings ?? 0;
  const {
    forceRegenerateEmbeddings,
    preserveExistingEmbeddings,
    shouldGenerateEmbeddings,
    shouldLoadCache,
  } = _deriveEmbeddingMode(options, existingEmbeddingCount);

  if (options.dropEmbeddings && existingEmbeddingCount > 0) {
    log(
      `Dropping ${existingEmbeddingCount} existing embeddings (--drop-embeddings). ` +
        `Re-run with --embeddings to regenerate.`,
    );
  } else if (forceRegenerateEmbeddings) {
    log(
      `--force on a repo with ${existingEmbeddingCount} existing embeddings: ` +
        `regenerating embeddings for new/changed nodes. ` +
        `Pass --drop-embeddings to wipe them instead.`,
    );
  } else if (preserveExistingEmbeddings) {
    log(
      `Preserving ${existingEmbeddingCount} existing embeddings. ` +
        `Pass --embeddings to also generate embeddings for new/changed nodes, ` +
        `or --drop-embeddings to wipe them.`,
    );
  }

  // Compute current per-file content hashes from the same repository scan that
  // `gitnexus status` uses. Deriving hashes from graph File nodes let analyze
  // and status drift whenever generated files or non-symbol files were present.
  // `computeFileHashes` applies the shared generated-file filter while keeping
  // real source/config files such as package.json tracked.
  //
  // Phase 2 incremental optimization: derive this plan before the full
  // in-memory pipeline. The pipeline still runs unchanged for now; later
  // phases will use this early plan to decide which artifacts can be replayed.
  const hashStart = Date.now();
  const scannedFilePaths = (await walkRepositoryPaths(repoPath)).map((f) => f.path);
  const newFileHashes = await computeFileHashes(repoPath, scannedFilePaths);
  profile.hashMs = Date.now() - hashStart;
  const allFilePaths = [...newFileHashes.keys()];

  const planningStart = Date.now();
  const incrementalPlan = deriveIncrementalPlan({
    // Dirty recovery sets options.force above to preserve embedding behavior,
    // but the planner should still surface "dirty recovery" instead of the
    // generic forced-rebuild reason.
    force: dirtyRecovery ? false : options.force,
    existingMeta,
    repoHasGit,
    allFilePaths,
    currentFileHashes: newFileHashes,
  });
  profile.incrementalPlanningMs = Date.now() - planningStart;
  const isIncremental = incrementalPlan.mode === 'incremental';
  const hashDiff = isIncremental ? incrementalPlan.hashDiff : undefined;

  if (isAnalyzeProfilingEnabled()) {
    if (isIncremental && hashDiff) {
      log(
        `Incremental plan: mode=incremental changed=${hashDiff.changed.length}, added=${hashDiff.added.length}, deleted=${hashDiff.deleted.length}`,
      );
    } else if (incrementalPlan.mode === 'full') {
      log(`Incremental plan: mode=full reason=${incrementalPlan.reason}`);
    }
  }

  if (
    isIncremental &&
    hashDiff &&
    hashDiff.changed.length === 0 &&
    hashDiff.added.length === 0 &&
    hashDiff.deleted.length === 0
  ) {
    log('Already up to date');
    await ensureGitNexusIgnored(repoPath);
    if (isAnalyzeProfilingEnabled()) {
      const totalAnalyzeMs = Date.now() - analyzeStart;
      const accounted =
        profile.preflightMs + profile.hashMs + profile.incrementalPlanningMs + profile.finalCloseMs;
      log('Analyze profile:');
      log('  fastPath: unchanged incremental');
      log(
        `  orchestration: preflight=${formatMs(profile.preflightMs)}, hash=${formatMs(profile.hashMs)}, incrementalPlanning=${formatMs(profile.incrementalPlanningMs)}, accounted=${formatMs(accounted)}, unaccounted=${formatMs(totalAnalyzeMs - accounted)}, total=${formatMs(totalAnalyzeMs)}`,
      );
    }
    progress('done', 100, 'Already up to date');
    return {
      repoName:
        options.registryName ??
        getInferredRepoName(repoPath) ??
        path.basename(resolveRepoIdentityRoot(repoPath)),
      repoPath,
      stats: existingMeta?.stats ?? {},
      alreadyUpToDate: true,
    };
  }

  // We load caches only after the no-change incremental fast path. A no-op
  // analyze should not pay for parse-cache JSON reads or embedding preservation.
  if (shouldLoadCache && existingMeta) {
    const embeddingCacheLoadStart = Date.now();
    try {
      progress('embeddings', 0, 'Caching embeddings...');
      const initStart = Date.now();
      await initLbug(lbugPath);
      profile.lbugInitMs += Date.now() - initStart;
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      const closeStart = Date.now();
      await closeLbug();
      profile.finalCloseMs += Date.now() - closeStart;
    } catch (err: any) {
      log(
        `Warning: could not load cached embeddings ` +
          `(${err?.message ?? String(err)}). ` +
          `Embeddings will not be preserved on this run.`,
      );
      cachedEmbeddingNodeIds = new Set<string>();
      cachedEmbeddings = [];
      try {
        const closeStart = Date.now();
        await closeLbug();
        profile.finalCloseMs += Date.now() - closeStart;
      } catch {
        /* swallow */
      }
    } finally {
      profile.embeddingCacheLoadMs += Date.now() - embeddingCacheLoadStart;
    }
  }

  // ── Load incremental parse cache ──────────────────────────────────
  // Content-addressed: safe to reuse across `--force` runs (chunks whose
  // file contents haven't changed produce identical worker output).
  // Loaded into a single ParseCache object that the pipeline mutates
  // in-place (cache hits leave entries unchanged; misses add new ones).
  const parseCacheLoadStart = Date.now();
  const parseCache = await loadParseCache(storagePath);
  profile.parseCacheLoadMs = Date.now() - parseCacheLoadStart;

  const fileArtifactReplayStats = {
    artifactReplayEnabled: false,
    artifactReplayDisabledReason: isIncremental ? undefined : incrementalPlan.reason,
    fileArtifactHits: 0,
    fileArtifactMisses: 0,
    replayedFiles: 0,
    freshParsedFiles: 0,
  };

  let incrementalFreshFiles: Set<string> | undefined;
  if (isIncremental && hashDiff) {
    const importerExpansionStart = Date.now();
    incrementalFreshFiles = new Set(hashDiff.toWrite);
    const priorFileSet = new Set(existingMeta?.fileHashes ? Object.keys(existingMeta.fileHashes) : []);
    const shadowCandidates: string[] = [];
    for (const added of hashDiff.added) {
      for (const candidate of shadowCandidatesFor(added)) {
        if (priorFileSet.has(candidate) && !incrementalFreshFiles.has(candidate)) {
          incrementalFreshFiles.add(candidate);
          shadowCandidates.push(candidate);
        }
      }
    }

    try {
      const initStart = Date.now();
      await initLbug(lbugPath);
      profile.lbugInitMs += Date.now() - initStart;
      const seenFrontier = new Set<string>();
      let frontier = [...hashDiff.toWrite, ...hashDiff.deleted, ...shadowCandidates];
      for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
        const nextFrontier: string[] = [];
        for (const f of frontier) {
          if (seenFrontier.has(f)) continue;
          seenFrontier.add(f);
          const importers = await queryImporters(f);
          for (const importer of importers) {
            if (!incrementalFreshFiles.has(importer)) {
              incrementalFreshFiles.add(importer);
              nextFrontier.push(importer);
            }
          }
        }
        frontier = nextFrontier;
      }
      if (frontier.length > 0) {
        fileArtifactReplayStats.artifactReplayDisabledReason = 'importer expansion exceeded max depth';
        incrementalFreshFiles = undefined;
      }
    } catch (err) {
      fileArtifactReplayStats.artifactReplayDisabledReason = `importer expansion failed: ${(err as Error).message}`;
      incrementalFreshFiles = undefined;
    } finally {
      const closeStart = Date.now();
      await closeLbug();
      profile.finalCloseMs += Date.now() - closeStart;
      profile.importerExpansionMs += Date.now() - importerExpansionStart;
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ────────────────────────────────
  const pipelineStart = Date.now();
  const pipelineResult = await runPipelineFromRepo(
    repoPath,
    (p) => {
      const phaseLabel = PHASE_LABELS[p.phase] || p.phase;
      const scaled = Math.round(p.percent * 0.6);
      const message = p.detail
        ? `${p.message || phaseLabel} (${p.detail})`
        : p.message || phaseLabel;
      progress(p.phase, scaled, message);
    },
    {
      parseCache,
      workerThresholdsForTest: options.workerThresholdsForTest,
      ...(isIncremental && hashDiff && incrementalFreshFiles
        ? {
            fileArtifactReplay: {
              storagePath,
              currentFileHashes: newFileHashes,
              priorFileHashes: existingMeta?.fileHashes,
              freshFiles: incrementalFreshFiles,
              stats: fileArtifactReplayStats,
            },
          }
        : {}),
    },
  );
  profile.pipelineMs = Date.now() - pipelineStart;

  if (isAnalyzeProfilingEnabled()) {
    const reason = pipelineResult.parseStats.artifactReplayEnabled
      ? 'enabled'
      : `disabled: ${pipelineResult.parseStats.artifactReplayDisabledReason ?? fileArtifactReplayStats.artifactReplayDisabledReason ?? 'not attempted'}`;
    log(
      `File artifact replay: ${reason}, hits=${pipelineResult.parseStats.fileArtifactHits}, misses=${pipelineResult.parseStats.fileArtifactMisses}, replayed=${pipelineResult.parseStats.replayedFiles}, freshParsed=${pipelineResult.parseStats.parsedFiles}`,
    );
  }

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  progress('lbug', 60, 'Loading into LadybugDB...');

  const dbWritebackStart = Date.now();

  if (isIncremental && hashDiff) {
    log(
      `Incremental: changed=${hashDiff.changed.length}, ` +
        `added=${hashDiff.added.length}, ` +
        `deleted=${hashDiff.deleted.length} ` +
        `(skipping wipe + ${
          allFilePaths.length - hashDiff.toWrite.length
        } unchanged file rows preserved)`,
    );
    // Set the dirty flag BEFORE any destructive DB mutation. Cleared on
    // success at the meta-save step.
    const dirtyMetaStart = Date.now();
    await saveMeta(storagePath, {
      ...existingMeta!,
      incrementalInProgress: {
        startedAt: Date.now(),
        toWriteCount: hashDiff.toWrite.length,
      },
    });
    profile.dirtyMetaMs += Date.now() - dirtyMetaStart;
  } else {
    if (incrementalPlan.mode === 'full') {
      log(`Incremental fallback: ${incrementalPlan.reason}`);
    }
    // Full rebuild path: wipe DB files first.
    const fullWipeStart = Date.now();
    const closeStart = Date.now();
    await closeLbug();
    profile.finalCloseMs += Date.now() - closeStart;
    const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
    for (const f of lbugFiles) {
      try {
        await fs.rm(f, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    }
    profile.fullWipeMs += Date.now() - fullWipeStart;
  }

  const initStart = Date.now();
  await initLbug(lbugPath);
  profile.lbugInitMs += Date.now() - initStart;
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    if (isIncremental && hashDiff) {
      const writeSetPlanningStart = Date.now();
      const writeSetPlan = await deriveIncrementalWriteSet({
        hashDiff,
        fullGraph: pipelineResult.graph,
        priorFileHashes: existingMeta?.fileHashes,
        queryImporters,
      });
      profile.writeSetPlanningMs += Date.now() - writeSetPlanningStart;

      if (writeSetPlan.mode === 'full') {
        log(`Incremental fallback: ${writeSetPlan.reason}`);
        const fallbackWipeStart = Date.now();
        const closeStart = Date.now();
        await closeLbug();
        profile.finalCloseMs += Date.now() - closeStart;
        const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
        for (const f of lbugFiles) {
          try {
            await fs.rm(f, { recursive: true, force: true });
          } catch {
            /* swallow */
          }
        }
        profile.fullWipeMs += Date.now() - fallbackWipeStart;
        const initStart = Date.now();
        await initLbug(lbugPath);
        profile.lbugInitMs += Date.now() - initStart;
        const graphLoadStart = Date.now();
        await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
          lbugMsgCount++;
          const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
          progress('lbug', pct, msg);
        });
        profile.graphLoadMs += Date.now() - graphLoadStart;
      } else {
        if (writeSetPlan.diagnostics.importerExpansionSize > 0) {
          log(
            `Incremental: +${writeSetPlan.diagnostics.importerExpansionSize} importer(s) added to writable set ` +
              `(BFS depth ≤ ${writeSetPlan.diagnostics.importerBfsDepth}` +
              (writeSetPlan.diagnostics.shadowCandidatesSize > 0
                ? `, ${writeSetPlan.diagnostics.shadowCandidatesSize} shadow-seed(s)`
                : '') +
              `)`,
          );
        }

        const { effectiveWriteSet, filesToDelete } = writeSetPlan;
        const deleteRowsStart = Date.now();
        for (let i = 0; i < filesToDelete.length; i++) {
          const f = filesToDelete[i];
          try {
            await deleteNodesForFile(f);
          } catch {
            /* file may not have rows (e.g. an unparseable file) — fine */
          }
          if (i % 20 === 0) {
            progress('lbug', 62, `Removing rows for changed files (${i}/${filesToDelete.length})...`);
          }
        }
        profile.deleteRowsMs += Date.now() - deleteRowsStart;
        // 2. Drop graph-wide nodes (Community, Process). They'll be re-inserted
        //    from the fresh pipeline output below. Required for the
        //    "Leiden runs on the FULL graph" correctness invariant.
        const deleteGraphWideStart = Date.now();
        await deleteAllCommunitiesAndProcesses();
        profile.deleteGraphWideMs += Date.now() - deleteGraphWideStart;

        // 3. Extract the changed subgraph from the FULL ctx.graph and write
        //    only that. Unchanged-file rows in the DB stay untouched. Pass
        //    the SAME effectiveWriteSet so the subgraph and the deletes
        //    cover identical files (asymmetry would silently corrupt).
        const subgraphExtractStart = Date.now();
        const subgraph = extractChangedSubgraph(pipelineResult.graph, effectiveWriteSet);
        profile.subgraphExtractMs += Date.now() - subgraphExtractStart;
        const graphLoadStart = Date.now();
        await loadGraphToLbug(subgraph, pipelineResult.repoPath, storagePath, (msg) => {
          lbugMsgCount++;
          const pct = Math.min(84, 65 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 19));
          progress('lbug', pct, msg);
        });
        profile.graphLoadMs += Date.now() - graphLoadStart;

        const validationStart = Date.now();
        const validation = await validateIncrementalGraphConsistency({
          deletedFiles: hashDiff.deleted,
          effectiveWriteSet,
          fullGraph: pipelineResult.graph,
          finalFileHashes: newFileHashes,
          operations: {
            countNodesForFile: async (label, filePath) =>
              firstCount(
                await executeQuery(
                  `MATCH (n:${escapeCypherLabel(label)}) WHERE n.filePath = '${escapeCypherString(
                    filePath,
                  )}' RETURN count(n) AS cnt`,
                ),
              ),
            countFileNodes: async (filePath) =>
              firstCount(
                await executeQuery(
                  `MATCH (n:File) WHERE n.filePath = '${escapeCypherString(
                    filePath,
                  )}' RETURN count(n) AS cnt`,
                ),
              ),
            countGraphWideNodes: async (label) =>
              firstCount(await executeQuery(`MATCH (n:${label}) RETURN count(n) AS cnt`)),
            countRelationships: async () =>
              firstCount(await executeQuery(`MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`)),
          },
        });
        profile.validationMs += Date.now() - validationStart;
        if (validation.ok === false) {
          throw new Error(`Incremental validation failed: ${validation.reason}`);
        }
      }
    } else {
      // ── Full rebuild ───────────────────────────────────────────────
      const graphLoadStart = Date.now();
      await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
        lbugMsgCount++;
        const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
        progress('lbug', pct, msg);
      });
      profile.graphLoadMs += Date.now() - graphLoadStart;
    }
    profile.dbWritebackMs = Date.now() - dbWritebackStart - profile.validationMs;

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    progress('fts', 85, 'Creating search indexes...');
    const ftsStart = Date.now();
    await createSearchFTSIndexes();
    profile.ftsMs += Date.now() - ftsStart;
    progress('fts', 90, 'Search indexes ready');

    // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
    // Runs on BOTH the full-rebuild path and the incremental path:
    //   - Full rebuild: DB was wiped, every cached row needs to come back.
    //   - Incremental:  changed-file rows were just deleted by
    //                   deleteNodesForFile (which cascades to their
    //                   embedding rows) — so their cached vectors need
    //                   to come back too. Unchanged-file rows still
    //                   exist; re-inserting their cached vectors would
    //                   PK-conflict, but the per-batch try/catch below
    //                   silently ignores those (matches the existing
    //                   "some may fail if node was removed, that's
    //                   fine" semantics). Bugbot review on PR #1479
    //                   flagged that gating this on `!isIncremental`
    //                   silently lost changed-file embeddings.
    if (cachedEmbeddings.length > 0) {
      const embeddingRestoreStart = Date.now();
      const cachedDims = cachedEmbeddings[0].embedding.length;
      const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
      if (cachedDims !== EMBEDDING_DIMS) {
        // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
        log(
          `Embedding dimensions changed (${cachedDims}d -> ${EMBEDDING_DIMS}d), discarding cache`,
        );
        cachedEmbeddings = [];
        cachedEmbeddingNodeIds = new Set();
      } else {
        progress('embeddings', 88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        const EMBED_BATCH = 200;
        for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
          const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);

          try {
            await batchInsert(executeWithReusedStatement, batch);
          } catch {
            /* some may fail if node was removed, that's fine */
          }
        }
      }
      profile.embeddingRestoreMs += Date.now() - embeddingRestoreStart;
    }

    // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
    const preEmbeddingStats = await getLbugStats();
    let embeddingSkipped = true;
    let semanticMode: 'vector-index' | 'exact-scan' | undefined;

    if (shouldGenerateEmbeddings) {
      const { skipForCap, capDisabled, nodeLimit } = deriveEmbeddingCap(
        preEmbeddingStats.nodes,
        options.embeddingsNodeLimit,
      );
      if (!skipForCap) {
        embeddingSkipped = false;
        if (capDisabled && preEmbeddingStats.nodes > DEFAULT_EMBEDDING_NODE_LIMIT) {
          log(
            `Embedding node-count cap disabled — generating embeddings for ` +
              `${preEmbeddingStats.nodes.toLocaleString()} nodes. Ensure sufficient memory; ` +
              `the default ${DEFAULT_EMBEDDING_NODE_LIMIT.toLocaleString()}-node ` +
              `cap exists to prevent OOM.`,
          );
        }
      } else {
        log(
          `Embeddings skipped: ${preEmbeddingStats.nodes.toLocaleString()} nodes exceeds ` +
            `the ${nodeLimit.toLocaleString()}-node safety cap. ` +
            `Override with \`--embeddings 0\` to disable the cap, or ` +
            `\`--embeddings <n>\` to set a custom cap.`,
        );
      }
    }

    if (!embeddingSkipped) {
      const embeddingGenerateStart = Date.now();
      const { isHttpMode } = await import('./embeddings/http-client.js');
      const httpMode = isHttpMode();
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );
      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      // Build a Map<nodeId, contentHash> from cached embeddings for incremental mode
      let existingEmbeddings: Map<string, string> | undefined;
      if (cachedEmbeddingNodeIds.size > 0) {
        existingEmbeddings = new Map<string, string>();
        for (const e of cachedEmbeddings) {
          existingEmbeddings.set(e.nodeId, e.contentHash ?? STALE_HASH_SENTINEL);
        }
      }

      const { readServerMapping } = await import('./embeddings/server-mapping.js');
      // Mirror the registry's name-resolution chain so the server-mapping
      // lookup key stays aligned with the final registry name (#1259):
      //   --name → remote-derived → canonical-root basename
      // (preserved-alias is intentionally NOT consulted here — server
      // mappings are addressed by the operationally-meaningful name the
      // user configures, not by a sticky registry-only alias they may not
      // know about. The previous canonical-only logic ignored both --name
      // and remote-derived names, silently breaking server-mapping for
      // anyone with a `--name` alias or remote-named repo.)
      const projectName =
        options.registryName ??
        getInferredRepoName(repoPath) ??
        path.basename(resolveRepoIdentityRoot(repoPath));
      const serverName = await readServerMapping(projectName);
      const embeddingResult = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (p) => {
          const scaled = 90 + Math.round((p.percent / 100) * 8);
          const label =
            p.phase === 'loading-model'
              ? httpMode
                ? 'Connecting to embedding endpoint...'
                : 'Loading embedding model...'
              : `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`;
          progress('embeddings', scaled, label);
        },
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        { repoName: projectName, serverName },
        existingEmbeddings,
      );
      if (embeddingResult.semanticMode === 'exact-scan') {
        semanticMode = 'exact-scan';
        log(
          'Semantic embeddings were generated without a VECTOR index; ' +
            'queries will use exact-scan fallback within the configured limit.',
        );
      } else {
        semanticMode = 'vector-index';
      }
      profile.embeddingGenerateMs += Date.now() - embeddingGenerateStart;
    }

    // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
    progress('done', 98, 'Finalizing database...');

    // Force a CHECKPOINT + close, then reopen before marking the run clean in
    // meta.json. This proves the DB is readable after LadybugDB WAL replay and
    // prevents a successful incremental analyze from publishing clean metadata
    // while leaving a WAL state that `gitnexus serve` cannot open.
    const checkpointReopenStart = Date.now();
    const closeStart = Date.now();
    await closeLbug();
    profile.finalCloseMs += Date.now() - closeStart;
    const reopenStart = Date.now();
    await initLbug(lbugPath);
    profile.lbugInitMs += Date.now() - reopenStart;
    profile.checkpointReopenMs = Date.now() - checkpointReopenStart;

    progress('done', 98, 'Saving metadata...');

    const metadataStart = Date.now();
    const stats = await getLbugStats();

    // Count embeddings in the index (cached + newly generated)
    let embeddingCount = 0;
    try {
      const embResult = await executeQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
      );
      const row = embResult?.[0];
      embeddingCount = Number(row?.cnt ?? row?.[0] ?? 0);
    } catch {
      /* table may not exist if embeddings never ran */
    }

    if (!embeddingSkipped && stats.nodes > 0 && embeddingCount === 0) {
      throw new Error(
        'Embedding generation completed without persisted embeddings. ' +
          'The index was not registered to avoid silently reporting embeddings: 0.',
      );
    }

    const { getRuntimeCapabilities } = await import('./platform/capabilities.js');
    const runtimeCapabilities = getRuntimeCapabilities();
    const effectiveSemanticMode =
      semanticMode ??
      (runtimeCapabilities.semanticMode === 'vector-index' ? 'vector-index' : 'exact-scan');

    // Convert the post-run file-hash map to the on-disk Record<string,string>
    // shape consumed by RepoMeta.fileHashes.
    const newFileHashesRecord: Record<string, string> = {};
    for (const [k, v] of newFileHashes) newFileHashesRecord[k] = v;

    const meta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      // Captured here (not at registration) so it travels with the
      // on-disk meta.json — sibling-clone fingerprinting works for
      // out-of-tree consumers (group-status, future tooling) without
      // a second git shellout. `undefined` when the repo has no
      // origin remote, which is fine: paths-only repos behave as
      // before.
      remoteUrl: hasGitDir(repoPath) ? getRemoteUrl(repoPath) : undefined,
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
      },
      capabilities: {
        graph: { provider: 'ladybugdb', status: runtimeCapabilities.graph },
        fts: { provider: 'ladybugdb-fts', status: runtimeCapabilities.fts },
        vectorSearch: {
          provider: effectiveSemanticMode === 'vector-index' ? 'ladybugdb-vector' : 'exact-scan',
          status: embeddingCount > 0 ? effectiveSemanticMode : 'unavailable',
          exactScanLimit: runtimeCapabilities.exactScanLimit,
          reason: runtimeCapabilities.reason,
        },
      },
      // Incremental-indexing fields. Populated for git repos so the next
      // analyze run can take the incremental DB-writeback path. Setting
      // incrementalInProgress to undefined explicitly clears any prior
      // dirty flag (full and incremental success paths converge here).
      schemaVersion: hasGitDir(repoPath) ? INCREMENTAL_SCHEMA_VERSION : undefined,
      fileHashes: hasGitDir(repoPath) ? newFileHashesRecord : undefined,
      incrementalInProgress: undefined as { startedAt: number; toWriteCount: number } | undefined,
    };
    await saveMeta(storagePath, meta);
    profile.metadataMs += Date.now() - metadataStart;

    // Persist the incremental parse cache for the next run. Wraps in
    // try/catch so a cache-write failure never breaks an otherwise
    // successful indexing run. Prune stale chunk-hash entries first so
    // the cache file size stays bounded across runs (chunks whose
    // composition no longer matches anything in the current scan are
    // dead weight; the parse phase populates `usedKeys` as it processes
    // chunks).
    try {
      const cacheSaveStart = Date.now();
      const pruned = pruneCache(parseCache, parseCache.usedKeys);
      if (pruned > 0) {
        log(`Parse cache: pruned ${pruned} stale chunk entries`);
      }
      await saveParseCache(storagePath, parseCache);
      profile.cacheSaveMs += Date.now() - cacheSaveStart;
    } catch (e) {
      log(`Warning: could not save parse cache (${(e as Error).message}); continuing.`);
    }

    // Persist worker-equivalent per-file parse artifacts for a future
    // changed-file-only parse path. Nothing consumes these artifacts yet, so
    // cache write/prune failures must never affect graph output or metadata.
    try {
      const fileArtifactSaveStart = Date.now();
      const artifacts = pipelineResult.fileParseArtifacts ?? [];
      const shouldLimitArtifactSave =
        isIncremental &&
        pipelineResult.parseStats?.artifactReplayEnabled === true &&
        incrementalFreshFiles !== undefined;
      const artifactSaveSet = shouldLimitArtifactSave ? incrementalFreshFiles : undefined;
      const inputs = [];
      for (const artifact of artifacts) {
        if (artifactSaveSet !== undefined && !artifactSaveSet.has(artifact.filePath)) continue;
        const contentHash = newFileHashes.get(artifact.filePath);
        if (!contentHash) continue;
        inputs.push({
          filePath: artifact.filePath,
          contentHash,
          language: artifact.language,
          parserKey: artifact.parserKey,
          payload: artifact.payload,
        });
      }
      const { pruned } = await saveFileParseArtifactsBatch(storagePath, inputs, newFileHashes);
      if (pruned > 0) {
        log(`File artifact cache: pruned ${pruned} stale artifact(s)`);
      }
      profile.fileArtifactSaveMs += Date.now() - fileArtifactSaveStart;
    } catch (e) {
      log(`Warning: could not save file artifact cache (${(e as Error).message}); continuing.`);
    }

    // Forward the --name alias and the registry-collision bypass bit.
    // `allowDuplicateName` is its own concern — independent from the
    // pipeline `force` above. The CLI maps it from
    // `--allow-duplicate-name` only; `--force` and `--skills` both
    // trigger pipeline re-run but never bypass the registry guard.
    // The returned name is the one actually written to the registry
    // (after applying the precedence chain in registerRepo) — reuse it
    // so AGENTS.md / skill files reference the same name MCP clients
    // will look up (#979).
    const registryStart = Date.now();
    const projectName = await registerRepo(repoPath, meta, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
    });
    profile.registryMs += Date.now() - registryStart;

    // Keep generated .gitnexus contents ignored without editing the user's root .gitignore.
    const contextStart = Date.now();
    await ensureGitNexusIgnored(repoPath);

    // ── Generate AI context files (best-effort) ───────────────────────
    let aggregatedClusterCount = 0;
    if (pipelineResult.communityResult?.communities) {
      const groups = new Map<string, number>();
      for (const c of pipelineResult.communityResult.communities) {
        const label = c.heuristicLabel || c.label || 'Unknown';
        groups.set(label, (groups.get(label) || 0) + c.symbolCount);
      }
      aggregatedClusterCount = Array.from(groups.values()).filter((count) => count >= 5).length;
    }

    try {
      await generateAIContextFiles(
        repoPath,
        storagePath,
        projectName,
        {
          files: pipelineResult.totalFileCount,
          nodes: stats.nodes,
          edges: stats.edges,
          communities: pipelineResult.communityResult?.stats.totalCommunities,
          clusters: aggregatedClusterCount,
          processes: pipelineResult.processResult?.stats.totalProcesses,
        },
        undefined,
        {
          skipAgentsMd: options.skipAgentsMd,
          skipSkills: options.skipSkills,
          noStats: options.noStats,
        },
      );
    } catch {
      // Best-effort — don't fail the entire analysis for context file issues
    }
    profile.contextFilesMs += Date.now() - contextStart;

    // ── Close LadybugDB ──────────────────────────────────────────────
    const finalCloseStart = Date.now();
    await closeLbug();
    profile.finalCloseMs += Date.now() - finalCloseStart;

    if (isAnalyzeProfilingEnabled()) {
      const phaseTimings = pipelineResult.phaseTimings ?? {};
      const profileLines = formatAnalyzeProfileLog(
        {
          preflightMs: profile.preflightMs,
          embeddingCacheLoadMs: profile.embeddingCacheLoadMs,
          parseCacheLoadMs: profile.parseCacheLoadMs,
          scanMs: phaseTimings.scan ?? 0,
          structureMs: phaseTimings.structure ?? 0,
          markdownMs: phaseTimings.markdown ?? 0,
          cobolMs: phaseTimings.cobol ?? 0,
          hashMs: profile.hashMs,
          incrementalPlanningMs: profile.incrementalPlanningMs,
          importerExpansionMs: profile.importerExpansionMs,
          pipelineMs: profile.pipelineMs,
          parseExtractMs: phaseTimings.parse ?? 0,
          routesMs: phaseTimings.routes ?? 0,
          toolsMs: phaseTimings.tools ?? 0,
          ormMs: phaseTimings.orm ?? 0,
          crossFileMs: phaseTimings.crossFile ?? 0,
          scopeResolutionMs: phaseTimings.scopeResolution ?? 0,
          mroMs: phaseTimings.mro ?? 0,
          scopeExtractMs: pipelineResult.scopeStats?.extractMs ?? 0,
          scopeFinalizeMs: pipelineResult.scopeStats?.finalizeMs ?? 0,
          scopePropagateMs: pipelineResult.scopeStats?.propagateMs ?? 0,
          scopeResolveMs: pipelineResult.scopeStats?.resolveMs ?? 0,
          scopeEmitMs: pipelineResult.scopeStats?.emitMs ?? 0,
          communitiesMs: phaseTimings.communities ?? 0,
          processesMs: phaseTimings.processes ?? 0,
          dbWritebackMs: profile.dbWritebackMs,
          lbugInitMs: profile.lbugInitMs,
          dirtyMetaMs: profile.dirtyMetaMs,
          fullWipeMs: profile.fullWipeMs,
          writeSetPlanningMs: profile.writeSetPlanningMs,
          deleteRowsMs: profile.deleteRowsMs,
          deleteGraphWideMs: profile.deleteGraphWideMs,
          subgraphExtractMs: profile.subgraphExtractMs,
          graphLoadMs: profile.graphLoadMs,
          validationMs: profile.validationMs,
          ftsMs: profile.ftsMs,
          embeddingRestoreMs: profile.embeddingRestoreMs,
          embeddingGenerateMs: profile.embeddingGenerateMs,
          checkpointReopenMs: profile.checkpointReopenMs,
          metadataMs: profile.metadataMs,
          cacheSaveMs: profile.cacheSaveMs,
          fileArtifactSaveMs: profile.fileArtifactSaveMs,
          registryMs: profile.registryMs,
          contextFilesMs: profile.contextFilesMs,
          finalCloseMs: profile.finalCloseMs,
          totalAnalyzeMs: Date.now() - analyzeStart,
        },
        {
          ...(pipelineResult.parseStats ?? {
            parseCacheHits: 0,
            parseCacheMisses: 0,
            parsedFiles: 0,
            fileArtifactHits: 0,
            fileArtifactMisses: 0,
            replayedFiles: 0,
            artifactReplayEnabled: false,
          }),
          scopePreExtractedHits: pipelineResult.scopeStats?.preExtractedHits ?? 0,
          scopePreExtractedMisses: pipelineResult.scopeStats?.preExtractedMisses ?? 0,
          scopeFilesExtracted: pipelineResult.scopeStats?.filesExtracted ?? 0,
          scopeFilesResolved: pipelineResult.scopeStats?.filesResolved ?? 0,
        },
      );
      for (const line of profileLines) log(line);
    }

    progress('done', 100, 'Done');

    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      pipelineResult,
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
    throw err;
  }
}

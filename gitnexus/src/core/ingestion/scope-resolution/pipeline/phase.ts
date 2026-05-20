/**
 * Phase: scopeResolution
 *
 * Generic registry-primary resolution phase (RFC #909 Ring 3).
 *
 * For every language in `MIGRATED_LANGUAGES` (per-language flag set)
 * whose provider is registered in `SCOPE_RESOLVERS`:
 *   1. Filter scanned files by language extension.
 *   2. Read file contents.
 *   3. Drive the scope-based pipeline end-to-end via the generic
 *      `runScopeResolution(input, provider)` orchestrator.
 *   4. Emit IMPORTS / CALLS / ACCESSES / INHERITS / USES edges.
 *
 * Pairs with the per-language gates in `import-processor.ts` and
 * `call-processor.ts` that skip files when their language is registry-
 * primary, so we don't double-emit edges from both code paths.
 *
 * Adding a language is two changes:
 *   - Implement `ScopeResolver` in `languages/<lang>/scope-resolver.ts`
 *     and register it in `scope-resolution/pipeline/registry.ts`.
 *   - Add the language to `MIGRATED_LANGUAGES` in
 *     `registry-primary-flag.ts`.
 *
 * @deps    parse  (needs Symbol nodes already in the graph so emit-references
 *                  can attach edges to existing Function/Method/Class nodes)
 * @reads   scannedFiles
 * @writes  graph (IMPORTS, CALLS, ACCESSES, INHERITS, USES)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from '../../pipeline-phases/types.js';
import path from 'path';
import { getPhaseOutput } from '../../pipeline-phases/types.js';
import type { StructureOutput } from '../../pipeline-phases/structure.js';
import type { ParseOutput } from '../../pipeline-phases/parse.js';
import { isRegistryPrimary } from '../../registry-primary-flag.js';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { readFileContents } from '../../filesystem-walker.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { runScopeResolution } from './run.js';
import { SCOPE_RESOLVERS } from './registry.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import type { PipelineOptions } from '../../pipeline.js';
import { isDev, isSemanticModelValidatorEnabled } from '../../utils/env.js';
import {
  buildScopeFinalizeCacheMetadata,
  computeResolutionConfigHash,
  loadScopeFinalizeCache,
  saveScopeFinalizeCache,
  type ScopeFinalizeCachedOutput,
} from '../../../../storage/scope-finalize-cache.js';

import { logger } from '../../../logger.js';

const DEFAULT_SCOPE_FINALIZE_PATCH_MAX_FILES = 16;

const isUsableParsedFile = (value: unknown): value is import('gitnexus-shared').ParsedFile => {
  if (!value || typeof value !== 'object') return false;
  const parsed = value as Record<string, unknown>;
  return (
    typeof parsed.filePath === 'string' &&
    typeof parsed.moduleScope === 'string' &&
    Array.isArray(parsed.scopes) &&
    Array.isArray(parsed.parsedImports) &&
    Array.isArray(parsed.localDefs) &&
    Array.isArray(parsed.referenceSites)
  );
};

const hasUnsupportedPartialScopeHook = (provider: ScopeResolver): string | undefined => {
  if (provider.allowGlobalFreeCallFallback === true) return 'provider uses global free-call fallback';
  if (provider.populateNamespaceSiblings !== undefined) return 'provider uses namespace sibling population';
  if (provider.mirrorNamespaceTypeBindings !== undefined) return 'provider uses namespace type-binding mirroring';
  if (provider.resolveAdlCandidates !== undefined) return 'provider uses ADL candidates';
  if (provider.emitUnresolvedReceiverEdges !== undefined) return 'provider emits unresolved receiver edges';
  if (provider.detectInterfaceImplementations !== undefined) return 'provider detects interface implementations';
  if (provider.populateRangeBindings !== undefined) return 'provider uses range binding population';
  return undefined;
};

const normalizePartialScopePath = (filePath: string, repoPath?: string): string => {
  let normalized = filePath.replace(/\\/g, '/');
  if (repoPath !== undefined && path.isAbsolute(normalized)) {
    normalized = path.relative(repoPath, normalized).replace(/\\/g, '/');
  }
  if (/^[A-Za-z]:\//.test(normalized) && repoPath !== undefined) {
    normalized = path.win32.relative(repoPath.replace(/\\/g, '/'), normalized).replace(/\\/g, '/');
  }
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = path.posix.normalize(normalized);
  return normalized === '.' ? '' : normalized;
};

const addUnmatchedPartialScopeSample = (stats: PipelineOptions['partialScopeResolution']['stats'], filePath: string): void => {
  stats.scopePartialUnmatchedAffectedFiles ??= [];
  if (stats.scopePartialUnmatchedAffectedFiles.length < 10) stats.scopePartialUnmatchedAffectedFiles.push(filePath);
};

export const buildPartialScopeResolutionInput = (
  options: PipelineOptions | undefined,
  lang: SupportedLanguages,
  provider: ScopeResolver,
  files: readonly { path: string; content: string }[],
  finalizeCacheHit: boolean,
  repoPath?: string,
): { sourceFiles: ReadonlySet<string>; disabledReason?: string } | undefined => {
  const partial = options?.partialScopeResolution;
  const setDisabled = (reason: string): { sourceFiles: ReadonlySet<string>; disabledReason: string } => {
    if (partial?.stats) {
      partial.stats.scopePartialEnabled = false;
      partial.stats.scopePartialDisabledReason = reason;
    }
    return { sourceFiles: new Set(), disabledReason: reason };
  };
  if (partial?.enabled !== true) return setDisabled(partial?.disabledReason ?? 'partial scope disabled');
  if (finalizeCacheHit !== true) return setDisabled('scope finalize cache miss');
  if (lang !== SupportedLanguages.TypeScript) return setDisabled(`language ${lang} not allowlisted`);
  const unsupported = hasUnsupportedPartialScopeHook(provider);
  if (unsupported !== undefined) return setDisabled(unsupported);
  if (options.fileArtifactReplay?.stats.artifactReplayEnabled !== true) {
    return setDisabled('artifact replay not enabled');
  }
  const languageFiles = new Map<string, string>();
  for (const file of files) languageFiles.set(normalizePartialScopePath(file.path, repoPath), file.path);
  const rawAffected = new Set([
    ...partial.affectedFiles,
    ...(options.fileArtifactReplay?.stats.artifactMissFiles ?? []),
  ]);
  const affected = new Set<string>();
  for (const filePath of rawAffected) {
    const normalized = normalizePartialScopePath(filePath, repoPath);
    const matched = languageFiles.get(normalized);
    if (matched !== undefined) affected.add(matched);
    else addUnmatchedPartialScopeSample(partial.stats, filePath);
  }
  partial.stats.scopePartialRawAffectedFiles += rawAffected.size;
  partial.stats.scopePartialMatchedAffectedFiles += affected.size;
  if (affected.size === 0) return setDisabled('no affected files for language');
  partial.stats.scopePartialEnabled = true;
  partial.stats.scopePartialDisabledReason = undefined;
  partial.stats.scopePartialAffectedFiles += affected.size;
  return { sourceFiles: affected };
};

export interface ScopeResolutionOutput {
  /** True when at least one language ran. */
  readonly ran: boolean;
  /** Files seen across all languages. `0` when `ran === false`. */
  readonly filesProcessed: number;
  /** IMPORTS edges emitted across all languages. */
  readonly importsEmitted: number;
  /** Reference (CALLS / ACCESSES / INHERITS / USES) edges emitted. */
  readonly referenceEdgesEmitted: number;
  readonly preExtractedHits: number;
  readonly preExtractedMisses: number;
  readonly filesExtracted: number;
  readonly finalizeCacheHits: number;
  readonly finalizeCacheMisses: number;
  readonly finalizeCacheDisabledReason?: string;
  readonly partialEnabled: boolean;
  readonly partialDisabledReason?: string;
  readonly partialAffectedFiles: number;
  readonly partialRawAffectedFiles: number;
  readonly partialMatchedAffectedFiles: number;
  readonly partialUnmatchedAffectedFiles: readonly string[];
  readonly finalizePatchedFiles: number;
  readonly finalizeReusedFiles: number;
  readonly finalizePatchEnabled: boolean;
  readonly finalizePatchDisabledReason?: string;
  readonly referenceSitesResolved: number;
  readonly referenceSitesTotal: number;
  readonly emitFiles: number;
  readonly timings: {
    readonly extractMs: number;
    readonly finalizeMs: number;
    readonly propagateMs: number;
    readonly resolveMs: number;
    readonly emitMs: number;
  };
  /** Per-language breakdown for telemetry / shadow-parity. */
  readonly perLanguage: ReadonlyMap<
    SupportedLanguages,
    {
      readonly filesProcessed: number;
      readonly importsEmitted: number;
      readonly referenceEdgesEmitted: number;
    }
  >;
}

const NOOP_OUTPUT: ScopeResolutionOutput = Object.freeze({
  ran: false,
  filesProcessed: 0,
  importsEmitted: 0,
  referenceEdgesEmitted: 0,
  preExtractedHits: 0,
  preExtractedMisses: 0,
  filesExtracted: 0,
  finalizeCacheHits: 0,
  finalizeCacheMisses: 0,
  finalizeCacheDisabledReason: 'scope resolution did not run',
  partialEnabled: false,
  partialDisabledReason: 'scope resolution did not run',
  partialAffectedFiles: 0,
  partialRawAffectedFiles: 0,
  partialMatchedAffectedFiles: 0,
  partialUnmatchedAffectedFiles: [],
  finalizePatchedFiles: 0,
  finalizeReusedFiles: 0,
  finalizePatchEnabled: false,
  finalizePatchDisabledReason: 'scope resolution did not run',
  referenceSitesResolved: 0,
  referenceSitesTotal: 0,
  emitFiles: 0,
  timings: { extractMs: 0, finalizeMs: 0, propagateMs: 0, resolveMs: 0, emitMs: 0 },
  perLanguage: new Map(),
});

export const scopeResolutionPhase: PipelinePhase<ScopeResolutionOutput> = {
  name: 'scopeResolution',
  // Depends on `parse` because emit-references attaches edges to
  // already-existing Symbol nodes (Function/Method/Class). The legacy
  // `parse` phase still creates those nodes; we only replace the
  // import + call resolution layer.
  //
  // Also depends on `crossFile` — we don't read crossFile's output
  // directly (we have our own cross-file resolution), but crossFile
  // writes EXTENDS edges that `buildMro` consumes via
  // `iterRelationshipsByType('EXTENDS')`. Declaring the dep pins the
  // ordering explicitly: without it, Kahn's runner could schedule
  // scopeResolution before crossFile (both unblock after parse), and
  // the MRO walk would miss heritage edges crossFile later adds.
  deps: ['parse', 'crossFile', 'structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ScopeResolutionOutput> {
    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    // Reach into the parse phase's AST cache so per-file extract can
    // skip a second tree-sitter parse. Cache miss is safe (re-parses).
    // Worker-mode parses leave the cache empty for those files; they
    // also fall back to a fresh parse — no correctness impact.
    const parseOutput = getPhaseOutput<ParseOutput>(deps, 'parse');
    const { scopeTreeCache, resolutionContext, parsedFiles: workerParsedFiles } = parseOutput;
    // SemanticModel populated during `parse`: scope-resolution consumes
    // TypeRegistry / MethodRegistry / SymbolTable lookups instead of
    // rebuilding parallel indexes. See ARCHITECTURE.md § "Semantic-model
    // source of truth".
    const model = resolutionContext.model;

    // Build a per-file lookup of ParsedFile artifacts the workers (or
    // sequential extracts) already produced. Threading this into
    // `runScopeResolution` lets the per-language extract loop short-
    // circuit `extractParsedFile` — the dominant cost on the warm-cache
    // path, since workers can't return tree-sitter Trees across the
    // MessageChannel and scope-resolution would otherwise re-parse
    // every file from scratch on the main thread.
    const preExtractedByPath = new Map<string, import('gitnexus-shared').ParsedFile>();
    for (const pf of workerParsedFiles) {
      if (!isUsableParsedFile(pf)) continue;
      preExtractedByPath.set(pf.filePath, pf);
    }

    let totalFiles = 0;
    let totalImports = 0;
    let totalRefs = 0;
    let totalPreExtractedHits = 0;
    let totalPreExtractedMisses = 0;
    let totalFilesExtracted = 0;
    let totalFinalizeCacheHits = 0;
    let totalFinalizeCacheMisses = 0;
    let finalizeCacheDisabledReason: string | undefined;
    let partialEnabled = false;
    let partialDisabledReason: string | undefined;
    let partialAffectedFiles = 0;
    let partialRawAffectedFiles = 0;
    let partialMatchedAffectedFiles = 0;
    let partialUnmatchedAffectedFiles: readonly string[] = [];
    let finalizePatchedFiles = 0;
    let finalizeReusedFiles = 0;
    let finalizePatchEnabled = false;
    let finalizePatchDisabledReason: string | undefined;
    let referenceSitesResolved = 0;
    let referenceSitesTotal = 0;
    let emitFiles = 0;
    const totalTimings = { extractMs: 0, finalizeMs: 0, propagateMs: 0, resolveMs: 0, emitMs: 0 };
    let anyRan = false;
    const perLanguage = new Map<
      SupportedLanguages,
      {
        readonly filesProcessed: number;
        readonly importsEmitted: number;
        readonly referenceEdgesEmitted: number;
      }
    >();

    for (const [lang, provider] of SCOPE_RESOLVERS) {
      if (!isRegistryPrimary(lang)) continue;

      const langFiles = scannedFiles.filter((f) => getLanguageFromFilename(f.path) === lang);
      if (langFiles.length === 0) continue;

      const filePaths = langFiles.map((f) => f.path);
      const contents = await readFileContents(ctx.repoPath, filePaths);
      const files: { path: string; content: string }[] = [];
      for (const fp of filePaths) {
        const content = contents.get(fp);
        if (content !== undefined) files.push({ path: fp, content });
      }

      // Load per-language import-resolution config (tsconfig paths,
      // composer.json autoload, go.mod, ...). One I/O round trip per
      // workspace pass — cached implicitly by the result handed to
      // every `resolveImportTarget` call below.
      const resolutionConfig =
        provider.loadResolutionConfig !== undefined
          ? await provider.loadResolutionConfig(ctx.repoPath)
          : undefined;

      const resolutionConfigHash = computeResolutionConfigHash(resolutionConfig);
      let cachedFinalizeOutput: ScopeFinalizeCachedOutput | undefined;
      let cacheMetadata: ReturnType<typeof buildScopeFinalizeCacheMetadata> | undefined;
      let languageFinalizePatchedFiles = 0;
      const cacheStoragePath = ctx.options?.scopeFinalizeCache?.storagePath;
      const maxPatchFiles = ctx.options?.scopeFinalizeCache?.maxPatchFiles ?? DEFAULT_SCOPE_FINALIZE_PATCH_MAX_FILES;
      if (cacheStoragePath === undefined) {
        finalizeCacheDisabledReason = 'scope finalize cache not enabled';
      }

      // Compute cache metadata only after extraction/replay inside runScopeResolution would
      // normally occur. To keep runScopeResolution synchronous, mirror the same validated
      // pre-extracted artifacts here for the cache decision by file path.
      const currentParsedByPath = new Map<string, import('gitnexus-shared').ParsedFile>();
      if (cacheStoragePath !== undefined) {
        const missingPreExtractedFiles: { path: string; content: string }[] = [];
        for (const file of files) {
          const parsed = preExtractedByPath.get(file.path);
          if (parsed === undefined) {
            missingPreExtractedFiles.push(file);
            continue;
          }
          currentParsedByPath.set(file.path, parsed);
        }
        if (missingPreExtractedFiles.length > 0) {
          const unsafeReason =
            lang !== SupportedLanguages.TypeScript
              ? `language ${lang} not allowlisted`
              : hasUnsupportedPartialScopeHook(provider);
          if (unsafeReason !== undefined) {
            finalizePatchDisabledReason = unsafeReason;
          } else if (missingPreExtractedFiles.length > maxPatchFiles) {
            finalizePatchDisabledReason = `missing pre-extracted files exceeded patch threshold (${missingPreExtractedFiles.length}/${maxPatchFiles})`;
          } else if (ctx.options?.fileArtifactReplay?.stats.artifactReplayEnabled !== true) {
            finalizePatchDisabledReason = 'artifact replay not enabled';
          } else {
            for (const file of missingPreExtractedFiles) {
              const parsed = extractParsedFile(
                provider.languageProvider,
                file.content,
                file.path,
                (msg) => {
                  if (isSemanticModelValidatorEnabled()) logger.warn(`[scope-resolution:${lang}] ${msg}`);
                },
                scopeTreeCache.get(file.path),
              );
              if (parsed === undefined) {
                finalizePatchDisabledReason = `could not rebuild parsed file ${file.path}`;
                break;
              }
              currentParsedByPath.set(file.path, parsed);
            }
          }
          if (finalizePatchDisabledReason !== undefined) {
            finalizeCacheDisabledReason = finalizePatchDisabledReason;
          }
        }
        const currentParsedFiles = files
          .map((file) => currentParsedByPath.get(file.path))
          .filter((parsed): parsed is import('gitnexus-shared').ParsedFile => parsed !== undefined);
        if (currentParsedFiles.length === files.length) {
          for (const parsed of currentParsedFiles) provider.populateOwners(parsed);
          provider.populateWorkspaceOwners?.(currentParsedFiles, { fileContents: contents });
          cacheMetadata = buildScopeFinalizeCacheMetadata(
            lang,
            `${lang}:${provider.language}`,
            resolutionConfigHash,
            currentParsedFiles,
          );
          const cached = await loadScopeFinalizeCache(cacheStoragePath, cacheMetadata);
          if (cached.hit === true) {
            cachedFinalizeOutput = cached.output;
            totalFinalizeCacheHits++;
            if (missingPreExtractedFiles.length > 0) {
              finalizePatchEnabled = true;
              languageFinalizePatchedFiles = missingPreExtractedFiles.length;
              finalizePatchedFiles += languageFinalizePatchedFiles;
              finalizeReusedFiles += files.length - missingPreExtractedFiles.length;
            }
          } else {
            totalFinalizeCacheMisses++;
            finalizeCacheDisabledReason = cached.reason;
            if (missingPreExtractedFiles.length > 0) {
              finalizePatchDisabledReason = cached.reason;
            }
          }
        }
      }
      const currentParsedFiles = files
        .map((file) => currentParsedByPath.get(file.path))
        .filter((parsed): parsed is import('gitnexus-shared').ParsedFile => parsed !== undefined);

      const stats = runScopeResolution(
        {
          graph: ctx.graph,
          model,
          files,
          treeCache: scopeTreeCache,
          resolutionConfig,
          preExtractedParsedFiles: preExtractedByPath,
          ...(currentParsedFiles.length === files.length
            ? { preparedParsedFiles: currentParsedFiles }
            : {}),
          cachedFinalizeOutput,
          partialResolution: buildPartialScopeResolutionInput(ctx.options, lang, provider, files, cachedFinalizeOutput !== undefined, ctx.repoPath),
          onWarn: (msg) => {
            if (isSemanticModelValidatorEnabled()) {
              logger.warn(`[scope-resolution:${lang}] ${msg}`);
            }
          },
        },
        provider,
      );

      anyRan = true;
      totalFiles += stats.filesProcessed;
      totalImports += stats.importsEmitted;
      totalRefs += stats.referenceEdgesEmitted;
      if (stats.partialEnabled) partialEnabled = true;
      if (stats.partialDisabledReason !== undefined) partialDisabledReason = stats.partialDisabledReason;
      partialAffectedFiles += stats.partialAffectedFiles;
      partialRawAffectedFiles = ctx.options?.partialScopeResolution?.stats.scopePartialRawAffectedFiles ?? partialRawAffectedFiles;
      partialMatchedAffectedFiles = ctx.options?.partialScopeResolution?.stats.scopePartialMatchedAffectedFiles ?? partialMatchedAffectedFiles;
      partialUnmatchedAffectedFiles = ctx.options?.partialScopeResolution?.stats.scopePartialUnmatchedAffectedFiles ?? partialUnmatchedAffectedFiles;
      referenceSitesResolved += stats.resolve.sitesProcessed;
      referenceSitesTotal += stats.referenceSitesTotal;
      emitFiles += stats.emitFiles;
      totalPreExtractedHits += stats.preExtractedHits;
      totalPreExtractedMisses += stats.preExtractedMisses;
      totalFilesExtracted += stats.filesExtracted + languageFinalizePatchedFiles;
      if (cacheStoragePath !== undefined && cacheMetadata !== undefined && !stats.finalizeCacheHit) {
        try {
          await saveScopeFinalizeCache(cacheStoragePath, cacheMetadata, stats.finalizeOutput);
        } catch (err) {
          finalizeCacheDisabledReason = `cache save failed: ${(err as Error).message}`;
        }
      }
      totalTimings.extractMs += stats.timings.extractMs;
      totalTimings.finalizeMs += stats.timings.finalizeMs;
      totalTimings.propagateMs += stats.timings.propagateMs;
      totalTimings.resolveMs += stats.timings.resolveMs;
      totalTimings.emitMs += stats.timings.emitMs;
      perLanguage.set(lang, {
        filesProcessed: stats.filesProcessed,
        importsEmitted: stats.importsEmitted,
        referenceEdgesEmitted: stats.referenceEdgesEmitted,
      });

      if (isDev) {
        logger.info(
          `[scope-resolution:${lang}] ${stats.filesProcessed} files → ${stats.importsEmitted} IMPORTS + ${stats.referenceEdgesEmitted} reference edges (${stats.resolve.unresolved} unresolved sites, ${stats.referenceSkipped} skipped)`,
        );
      }
    }

    // Dispose the cross-phase Tree cache — scope-resolution is the
    // only consumer. Holding Trees past this point is pure memory
    // pressure: downstream phases (mro, community, csv-generator)
    // never read them, and tree-sitter Trees hold native-heap memory
    // under WASM runtimes. ASTCache.clear() fires the LRU dispose
    // handler which calls tree.delete?.() on each retained Tree.
    scopeTreeCache.clear();

    if (!anyRan) return NOOP_OUTPUT;

    if (ctx.options?.partialScopeResolution?.stats !== undefined) {
      ctx.options.partialScopeResolution.stats.scopePartialEnabled = partialEnabled;
      ctx.options.partialScopeResolution.stats.scopePartialDisabledReason = partialEnabled
        ? undefined
        : (partialDisabledReason ?? ctx.options.partialScopeResolution.disabledReason ?? 'partial scope disabled');
      ctx.options.partialScopeResolution.stats.scopePartialAffectedFiles = partialAffectedFiles;
      ctx.options.partialScopeResolution.stats.scopePartialRawAffectedFiles = partialRawAffectedFiles;
      ctx.options.partialScopeResolution.stats.scopePartialMatchedAffectedFiles = partialMatchedAffectedFiles;
      ctx.options.partialScopeResolution.stats.scopePartialUnmatchedAffectedFiles = [...partialUnmatchedAffectedFiles];
      ctx.options.partialScopeResolution.stats.scopeFinalizePatchedFiles = finalizePatchedFiles;
      ctx.options.partialScopeResolution.stats.scopeFinalizeReusedFiles = finalizeReusedFiles;
      ctx.options.partialScopeResolution.stats.scopeFinalizePatchEnabled = finalizePatchEnabled;
      ctx.options.partialScopeResolution.stats.scopeFinalizePatchDisabledReason = finalizePatchEnabled ? undefined : finalizePatchDisabledReason;
      ctx.options.partialScopeResolution.stats.scopeReferenceSitesResolved = referenceSitesResolved;
      ctx.options.partialScopeResolution.stats.scopeReferenceSitesTotal = referenceSitesTotal;
      ctx.options.partialScopeResolution.stats.scopeEmitFiles = emitFiles;
    }

    return {
      ran: true,
      filesProcessed: totalFiles,
      importsEmitted: totalImports,
      referenceEdgesEmitted: totalRefs,
      preExtractedHits: totalPreExtractedHits,
      preExtractedMisses: totalPreExtractedMisses,
      filesExtracted: totalFilesExtracted,
      finalizeCacheHits: totalFinalizeCacheHits,
      finalizeCacheMisses: totalFinalizeCacheMisses,
      finalizeCacheDisabledReason,
      partialEnabled,
      partialDisabledReason,
      partialAffectedFiles,
      partialRawAffectedFiles,
      partialMatchedAffectedFiles,
      partialUnmatchedAffectedFiles,
      finalizePatchedFiles,
      finalizeReusedFiles,
      finalizePatchEnabled,
      finalizePatchDisabledReason: finalizePatchEnabled ? undefined : finalizePatchDisabledReason,
      referenceSitesResolved,
      referenceSitesTotal,
      emitFiles,
      timings: totalTimings,
      perLanguage,
    };
  },
};

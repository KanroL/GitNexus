import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  deriveEmbeddingMode,
  deriveEmbeddingCap,
  DEFAULT_EMBEDDING_NODE_LIMIT,
} from '../../src/core/embedding-mode.js';
import {
  getStoragePaths,
  INCREMENTAL_SCHEMA_VERSION,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { computeFileHash } from '../../src/storage/file-hash.js';
import { createTempDir } from '../helpers/test-db.js';

describe('run-analyze module', () => {
  it('exports runFullAnalysis as a function', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(typeof mod.runFullAnalysis).toBe('function');
  });

  it('exports PHASE_LABELS', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(mod.PHASE_LABELS).toBeDefined();
    expect(mod.PHASE_LABELS.parsing).toBe('Parsing code');
  });

  it('formats analyze profiling counters and timings for verbose logs', async () => {
    const { formatAnalyzeProfileLog } = await import('../../src/core/run-analyze.js');

    const lines = formatAnalyzeProfileLog(
      {
        preflightMs: 1,
        embeddingCacheLoadMs: 2,
        parseCacheLoadMs: 3,
        scanMs: 1,
        structureMs: 2,
        markdownMs: 3,
        cobolMs: 4,
        hashMs: 5,
        incrementalPlanningMs: 6,
        importerExpansionMs: 7,
        pipelineMs: 91,
        parseExtractMs: 4,
        routesMs: 5,
        toolsMs: 6,
        ormMs: 7,
        crossFileMs: 6,
        scopeResolutionMs: 8,
        mroMs: 9,
        scopeExtractMs: 30,
        scopeFinalizeMs: 31,
        scopePropagateMs: 32,
        scopeResolveMs: 33,
        scopeEmitMs: 34,
        communitiesMs: 7,
        processesMs: 8,
        dbWritebackMs: 9,
        lbugInitMs: 10,
        dirtyMetaMs: 11,
        fullWipeMs: 12,
        writeSetPlanningMs: 13,
        deleteRowsMs: 14,
        deleteGraphWideMs: 15,
        subgraphExtractMs: 16,
        graphLoadMs: 17,
        validationMs: 10,
        ftsMs: 18,
        embeddingRestoreMs: 19,
        embeddingGenerateMs: 20,
        checkpointReopenMs: 11,
        metadataMs: 21,
        cacheSaveMs: 22,
        fileArtifactSaveMs: 23,
        registryMs: 24,
        contextFilesMs: 25,
        finalCloseMs: 26,
        totalAnalyzeMs: 400,
      },
      {
        parseCacheHits: 13,
        parseCacheMisses: 14,
        parsedFiles: 15,
        fileArtifactHits: 16,
        fileArtifactMisses: 17,
        replayedFiles: 0,
        artifactReplayEnabled: false,
        artifactReplayDisabledReason: 'not incremental',
        scopePreExtractedHits: 18,
        scopePreExtractedMisses: 19,
        scopeFilesExtracted: 20,
        scopeFilesResolved: 21,
      },
    );

    expect(lines).toEqual([
      'Analyze profile:',
      '  counters: parseCacheHits=13, parseCacheMisses=14, parsedFiles=15, fileArtifactHits=16, fileArtifactMisses=17, replayedFiles=0, artifactReplay=disabled(not incremental)',
      '  scopeCounters: scopePreExtractedHits=18, scopePreExtractedMisses=19, scopeFilesExtracted=20, scopeFilesResolved=21',
      '  pipeline: total=91ms, scan=1ms, structure=2ms, markdown=3ms, cobol=4ms, parseExtract=4ms, routes=5ms, tools=6ms, orm=7ms, crossFile=6ms, scopeResolution=8ms, mro=9ms, communities=7ms, processes=8ms',
      '  scopeResolution: extract=30ms, finalize=31ms, propagate=32ms, resolve=33ms, emit=34ms',
      '  db: writeback=9ms, init=10ms, close=26ms, dirtyMeta=11ms, fullWipe=12ms, writeSetPlanning=13ms, deleteRows=14ms, deleteGraphWide=15ms, subgraphExtract=16ms, graphLoad=17ms, validation=10ms, checkpointReopen=11ms',
      '  postDb: fts=18ms, embeddingCacheLoad=2ms, embeddingRestore=19ms, embeddingGenerate=20ms, metadata=21ms, cacheSave=22ms, fileArtifactSave=23ms, registry=24ms, contextFiles=25ms',
      '  orchestration: preflight=1ms, parseCacheLoad=3ms, hash=5ms, incrementalPlanning=6ms, importerExpansion=7ms, accounted=307ms, unaccounted=93ms, total=400ms',
    ]);
  });

  it('creates .gitnexus/.gitignore on the already-up-to-date fast path (#1233)', async () => {
    const tmpRepo = await createTempDir('gitnexus-run-analyze-fast-path-');
    try {
      await fs.writeFile(path.join(tmpRepo.dbPath, 'index.ts'), 'export const value = 1;\n');
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git add index.ts', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const indexHash = await computeFileHash(path.join(tmpRepo.dbPath, 'index.ts'));
      expect(indexHash).not.toBeNull();
      const meta: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: currentCommit,
        indexedAt: new Date().toISOString(),
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
        fileHashes: { 'index.ts': indexHash! },
      };
      await saveMeta(storagePath, meta);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        {},
        {
          onProgress: () => {},
        },
      );

      expect(result.alreadyUpToDate).toBe(true);
      await expect(
        fs.readFile(path.join(tmpRepo.dbPath, '.gitnexus', '.gitignore'), 'utf-8'),
      ).resolves.toBe('*\n');
    } finally {
      await tmpRepo.cleanup();
    }
  });
});

describe('deriveEmbeddingMode', () => {
  // Default `analyze` on a repo with existing embeddings: must preserve, must
  // NOT regenerate, must load the cache so phase 3.5 can re-insert vectors.
  it('default + existing>0 → preserve only (load cache, no generation)', () => {
    const m = deriveEmbeddingMode({}, 1234);
    expect(m.preserveExistingEmbeddings).toBe(true);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('default + existing=0 → no-op (no preserve, no generation, no cache load)', () => {
    const m = deriveEmbeddingMode({}, 0);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(false);
  });

  // The headline behavior change requested in PR feedback: --force on an
  // already-embedded repo must regenerate (top up new/changed nodes), not
  // silently downgrade to "preserve only".
  it('--force + existing>0 → forceRegenerate + generate + load cache', () => {
    const m = deriveEmbeddingMode({ force: true }, 500);
    expect(m.forceRegenerateEmbeddings).toBe(true);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('--force + existing=0 → no embedding work (force keeps prior semantics)', () => {
    const m = deriveEmbeddingMode({ force: true }, 0);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(false);
  });

  it('--embeddings → generate + load cache (incremental top-up)', () => {
    const m = deriveEmbeddingMode({ embeddings: true }, 500);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('--embeddings + existing=0 → generate; cache load still fires (harmless empty load)', () => {
    const m = deriveEmbeddingMode({ embeddings: true }, 0);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    // Cache load is gated at the call site by `existingMeta`, not by count;
    // when explicit `--embeddings` is set we always attempt the load so any
    // stray vectors from a partial prior run get picked up.
    expect(m.shouldLoadCache).toBe(true);
  });

  // --drop-embeddings is the explicit wipe path; it must suppress cache load
  // even when --force is also set (the dominant escape hatch).
  it('--drop-embeddings → suppresses cache load, no generation', () => {
    const m = deriveEmbeddingMode({ dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
  });

  it('--force + --drop-embeddings → drop wins (no cache load, no generation)', () => {
    const m = deriveEmbeddingMode({ force: true, dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
  });

  it('--embeddings + --drop-embeddings → drop suppresses cache load (no preservation)', () => {
    // --embeddings still generates, but the prior vectors are wiped first.
    const m = deriveEmbeddingMode({ embeddings: true, dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
  });
});

describe('deriveEmbeddingCap', () => {
  it('uses the default 50K cap when limit is undefined', () => {
    const d = deriveEmbeddingCap(10_000, undefined);
    expect(d.nodeLimit).toBe(DEFAULT_EMBEDDING_NODE_LIMIT);
    expect(d.capDisabled).toBe(false);
    expect(d.skipForCap).toBe(false);
  });

  it('skips when node count exceeds the default cap', () => {
    const d = deriveEmbeddingCap(75_000, undefined);
    expect(d.skipForCap).toBe(true);
    expect(d.capDisabled).toBe(false);
  });

  it('does not skip when node count equals the default cap (boundary)', () => {
    const d = deriveEmbeddingCap(DEFAULT_EMBEDDING_NODE_LIMIT, undefined);
    expect(d.skipForCap).toBe(false);
  });

  it('limit=0 disables the cap regardless of node count', () => {
    const d = deriveEmbeddingCap(1_000_000, 0);
    expect(d.capDisabled).toBe(true);
    expect(d.skipForCap).toBe(false);
    expect(d.nodeLimit).toBe(0);
  });

  it('honors a custom positive cap', () => {
    expect(deriveEmbeddingCap(99_999, 100_000).skipForCap).toBe(false);
    expect(deriveEmbeddingCap(100_001, 100_000).skipForCap).toBe(true);
  });

  it('custom cap below default still applies', () => {
    expect(deriveEmbeddingCap(15_000, 10_000).skipForCap).toBe(true);
  });
});

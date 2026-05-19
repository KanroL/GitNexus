import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';
import {
  FILE_ARTIFACT_CACHE_VERSION,
  clearFileArtifactCache,
  getFileArtifactCacheDir,
  loadFileParseArtifact,
  pruneFileArtifactCache,
  saveFileParseArtifact,
  saveFileParseArtifactsBatch,
  splitParseWorkerResultsByFile,
} from '../../src/storage/file-artifact-cache.js';

const minimalResult = (overrides: Partial<ParseWorkerResult> = {}): ParseWorkerResult => ({
  nodes: [],
  relationships: [],
  symbols: [],
  imports: [],
  calls: [],
  assignments: [],
  heritage: [],
  routes: [],
  fetchCalls: [],
  decoratorRoutes: [],
  toolDefs: [],
  ormQueries: [],
  constructorBindings: [],
  fileScopeBindings: [],
  parsedFiles: [],
  skippedLanguages: {},
  fileCount: 1,
  ...overrides,
});

const withTempStorage = async (fn: (storagePath: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gnx-fac-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const shardPaths = async (storagePath: string): Promise<string[]> => {
  const cacheDir = getFileArtifactCacheDir(storagePath);
  const firstLevel = await fs.readdir(cacheDir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of firstLevel) {
    if (!entry.isDirectory()) continue;
    const shardDir = path.join(cacheDir, entry.name);
    const names = await fs.readdir(shardDir);
    for (const name of names) {
      if (name.endsWith('.json')) out.push(path.join(shardDir, name));
    }
  }
  return out.sort();
};

describe('file artifact cache', () => {
  it('splits batch worker results into safe per-file artifacts', () => {
    const batch = minimalResult({
      nodes: [
        {
          id: 'Function:src/a.ts:runA',
          label: 'Function',
          properties: {
            name: 'runA',
            filePath: 'src/a.ts',
            startLine: 1,
            endLine: 1,
            language: 'typescript',
            isExported: true,
          },
        } as ParseWorkerResult['nodes'][number],
        {
          id: 'Function:src/b.ts:runB',
          label: 'Function',
          properties: {
            name: 'runB',
            filePath: 'src/b.ts',
            startLine: 1,
            endLine: 1,
            language: 'typescript',
            isExported: true,
          },
        } as ParseWorkerResult['nodes'][number],
      ],
      relationships: [
        {
          id: 'DEFINES:a',
          sourceId: 'File:src/a.ts',
          targetId: 'Function:src/a.ts:runA',
          type: 'DEFINES',
          confidence: 1,
          reason: 'test',
        },
        {
          id: 'CALLS:a-b',
          sourceId: 'Function:src/a.ts:runA',
          targetId: 'Function:src/b.ts:runB',
          type: 'CALLS',
          confidence: 1,
          reason: 'cross-file skipped',
        },
      ] as ParseWorkerResult['relationships'],
      symbols: [
        { filePath: 'src/a.ts', name: 'runA', nodeId: 'Function:src/a.ts:runA', type: 'Function' },
        { filePath: 'src/b.ts', name: 'runB', nodeId: 'Function:src/b.ts:runB', type: 'Function' },
      ] as ParseWorkerResult['symbols'],
      imports: [{ filePath: 'src/a.ts', rawImportPath: './b', language: 'typescript' }],
      calls: [{ filePath: 'src/a.ts', calledName: 'runB', sourceId: 'Function:src/a.ts:runA' }],
      assignments: [
        {
          filePath: 'src/a.ts',
          sourceId: 'Function:src/a.ts:runA',
          receiverText: 'x',
          propertyName: 'y',
        },
      ],
      heritage: [
        { filePath: 'src/b.ts', className: 'Child', parentName: 'Base', kind: 'extends' },
      ],
      routes: [
        {
          filePath: 'src/a.ts',
          httpMethod: 'GET',
          routePath: '/a',
          controllerName: null,
          methodName: null,
          middleware: [],
          prefix: null,
          lineNumber: 1,
        },
      ],
      toolDefs: [
        { filePath: 'src/b.ts', toolName: 'toolB', description: 'Tool B', lineNumber: 1 },
      ],
      ormQueries: [
        { filePath: 'src/a.ts', orm: 'prisma', model: 'User', method: 'findMany', lineNumber: 1 },
      ],
      parsedFiles: [{ filePath: 'src/b.ts', scopes: [] }] as ParseWorkerResult['parsedFiles'],
    });

    const split = splitParseWorkerResultsByFile([batch]);
    expect(split.map((artifact) => artifact.filePath)).toEqual(['src/a.ts', 'src/b.ts']);

    const a = split.find((artifact) => artifact.filePath === 'src/a.ts')?.payload;
    const b = split.find((artifact) => artifact.filePath === 'src/b.ts')?.payload;
    expect(a?.nodes).toHaveLength(1);
    expect(a?.symbols).toHaveLength(1);
    expect(a?.imports).toHaveLength(1);
    expect(a?.calls).toHaveLength(1);
    expect(a?.assignments).toHaveLength(1);
    expect(a?.routes).toHaveLength(1);
    expect(a?.ormQueries).toHaveLength(1);
    expect(a?.relationships.map((rel) => rel.id)).toEqual(['DEFINES:a']);
    expect(b?.nodes).toHaveLength(1);
    expect(b?.heritage).toHaveLength(1);
    expect(b?.toolDefs).toHaveLength(1);
    expect(b?.parsedFiles).toHaveLength(1);
    expect(b?.relationships).toHaveLength(0);
  });

  it('saves and loads a per-file artifact', async () => {
    await withTempStorage(async (storagePath) => {
      await saveFileParseArtifact(storagePath, {
        filePath: 'src/a.ts',
        contentHash: 'hash-a',
        language: 'typescript',
        parserKey: 'tree-sitter-typescript@x',
        payload: minimalResult({
          nodes: [
            {
              id: 'Function:src/a.ts:run',
              label: 'Function',
              properties: {
                name: 'run',
                filePath: 'src/a.ts',
                startLine: 1,
                endLine: 1,
                language: 'typescript',
                isExported: true,
              },
            } as ParseWorkerResult['nodes'][number],
          ],
        }),
      });

      const loaded = await loadFileParseArtifact(storagePath, {
        filePath: 'src/a.ts',
        contentHash: 'hash-a',
        language: 'typescript',
        parserKey: 'tree-sitter-typescript@x',
      });

      expect(loaded).not.toBeNull();
      expect(loaded?.version).toBe(FILE_ARTIFACT_CACHE_VERSION);
      expect(loaded?.filePath).toBe('src/a.ts');
      expect(loaded?.payload.fileCount).toBe(1);
      expect(loaded?.payload.nodes[0]?.id).toBe('Function:src/a.ts:run');
    });
  });

  it('returns a miss for content hash mismatch', async () => {
    await withTempStorage(async (storagePath) => {
      await saveFileParseArtifact(storagePath, {
        filePath: 'src/a.ts',
        contentHash: 'hash-a',
        payload: minimalResult(),
      });

      await expect(
        loadFileParseArtifact(storagePath, { filePath: 'src/a.ts', contentHash: 'hash-b' }),
      ).resolves.toBeNull();
    });
  });

  it('returns a miss for artifact version mismatch', async () => {
    await withTempStorage(async (storagePath) => {
      await saveFileParseArtifact(storagePath, {
        filePath: 'src/a.ts',
        contentHash: 'hash-a',
        payload: minimalResult(),
      });
      const [shard] = await shardPaths(storagePath);
      const raw = JSON.parse(await fs.readFile(shard, 'utf-8')) as Record<string, unknown>;
      raw.version = 'old-version';
      await fs.writeFile(shard, JSON.stringify(raw), 'utf-8');

      await expect(
        loadFileParseArtifact(storagePath, { filePath: 'src/a.ts', contentHash: 'hash-a' }),
      ).resolves.toBeNull();
    });
  });

  it('ignores a corrupt index safely', async () => {
    await withTempStorage(async (storagePath) => {
      const cacheDir = getFileArtifactCacheDir(storagePath);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(path.join(cacheDir, 'index.json'), '{not-json', 'utf-8');

      await expect(
        loadFileParseArtifact(storagePath, { filePath: 'src/a.ts', contentHash: 'hash-a' }),
      ).resolves.toBeNull();
    });
  });

  it('ignores a corrupt shard safely', async () => {
    await withTempStorage(async (storagePath) => {
      await saveFileParseArtifact(storagePath, {
        filePath: 'src/a.ts',
        contentHash: 'hash-a',
        payload: minimalResult(),
      });
      const [shard] = await shardPaths(storagePath);
      await fs.writeFile(shard, '{not-json', 'utf-8');

      await expect(
        loadFileParseArtifact(storagePath, { filePath: 'src/a.ts', contentHash: 'hash-a' }),
      ).resolves.toBeNull();
    });
  });

  it('prunes artifacts whose file hashes are not live', async () => {
    await withTempStorage(async (storagePath) => {
      await saveFileParseArtifact(storagePath, {
        filePath: 'src/a.ts',
        contentHash: 'hash-a',
        payload: minimalResult(),
      });
      await saveFileParseArtifact(storagePath, {
        filePath: 'src/b.ts',
        contentHash: 'hash-b',
        payload: minimalResult(),
      });

      const removed = await pruneFileArtifactCache(
        storagePath,
        new Map<string, string>([['src/a.ts', 'hash-a']]),
      );

      expect(removed).toBe(1);
      await expect(
        loadFileParseArtifact(storagePath, { filePath: 'src/a.ts', contentHash: 'hash-a' }),
      ).resolves.not.toBeNull();
      await expect(
        loadFileParseArtifact(storagePath, { filePath: 'src/b.ts', contentHash: 'hash-b' }),
      ).resolves.toBeNull();
      expect(await shardPaths(storagePath)).toHaveLength(1);
    });
  });

  it('saves artifact batches with one index update and prunes stale entries', async () => {
    await withTempStorage(async (storagePath) => {
      await saveFileParseArtifact(storagePath, {
        filePath: 'src/stale.ts',
        contentHash: 'old-hash',
        payload: minimalResult(),
      });

      const result = await saveFileParseArtifactsBatch(
        storagePath,
        [
          {
            filePath: 'src/a.ts',
            contentHash: 'hash-a',
            language: 'typescript',
            payload: minimalResult({ parsedFiles: [{ filePath: 'src/a.ts', scopes: [] }] as any }),
          },
          {
            filePath: 'src/b.ts',
            contentHash: 'hash-b',
            language: 'typescript',
            payload: minimalResult(),
          },
        ],
        new Map<string, string>([
          ['src/a.ts', 'hash-a'],
          ['src/b.ts', 'hash-b'],
        ]),
      );

      expect(result).toEqual({ saved: 2, pruned: 1 });
      await expect(
        loadFileParseArtifact(storagePath, {
          filePath: 'src/a.ts',
          contentHash: 'hash-a',
          language: 'typescript',
        }),
      ).resolves.not.toBeNull();
      await expect(
        loadFileParseArtifact(storagePath, { filePath: 'src/stale.ts', contentHash: 'old-hash' }),
      ).resolves.toBeNull();

      const index = JSON.parse(
        await fs.readFile(path.join(getFileArtifactCacheDir(storagePath), 'index.json'), 'utf-8'),
      ) as { artifacts?: unknown[] };
      expect(index.artifacts).toHaveLength(2);
    });
  });

  it('clears the cache directory', async () => {
    await withTempStorage(async (storagePath) => {
      await saveFileParseArtifact(storagePath, {
        filePath: 'src/a.ts',
        contentHash: 'hash-a',
        payload: minimalResult(),
      });

      await clearFileArtifactCache(storagePath);

      await expect(fs.access(getFileArtifactCacheDir(storagePath))).rejects.toThrow();
      await expect(
        loadFileParseArtifact(storagePath, { filePath: 'src/a.ts', contentHash: 'hash-a' }),
      ).resolves.toBeNull();
    });
  });
});

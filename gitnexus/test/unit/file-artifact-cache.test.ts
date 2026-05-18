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

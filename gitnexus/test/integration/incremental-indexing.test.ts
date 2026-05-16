import { execSync } from 'child_process';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { buildStatusReport } from '../../src/cli/status.js';
import { createTempDir } from '../helpers/test-db.js';

const analyzeOptions = { skipAgentsMd: true, skipSkills: true };
const callbacks = (logs: string[] = []) => ({
  onProgress: () => {},
  onLog: (message: string) => logs.push(message),
});

async function setupRepo() {
  const tmp = await createTempDir('gitnexus-incr-int-');
  const src = path.join(tmp.dbPath, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, 'provider.ts'),
    `export function value(): string {
  return 'v1';
}
`,
  );
  await writeFile(
    path.join(src, 'consumer.ts'),
    `import { value } from './provider';

export function useValue(): string {
  return value();
}
`,
  );
  await writeFile(
    path.join(src, 'extra.ts'),
    `export function extra(): number {
  return 1;
}
`,
  );
  await writeFile(path.join(tmp.dbPath, 'package.json'), '{"name":"incremental-fixture"}\n');
  execSync('git init', { cwd: tmp.dbPath, stdio: 'pipe' });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
    cwd: tmp.dbPath,
    stdio: 'pipe',
  });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m initial', {
    cwd: tmp.dbPath,
    stdio: 'pipe',
  });
  return tmp;
}

async function queryRepo<T = any>(repoPath: string, cypher: string): Promise<T[]> {
  const { lbugPath } = getStoragePaths(repoPath);
  await initLbug(lbugPath);
  try {
    return (await executeQuery(cypher)) as T[];
  } finally {
    await closeLbug();
  }
}

async function graphStats(repoPath: string) {
  const rows = await queryRepo<{ files: number; nodes: number; edges: number }>(
    repoPath,
    `MATCH (f:File) WITH count(f) AS files
     MATCH (n) WITH files, count(n) AS nodes
     MATCH ()-[r:CodeRelation]->() RETURN files, nodes, count(r) AS edges`,
  );
  const row = rows[0] ?? {};
  return {
    files: Number(row.files ?? 0),
    nodes: Number(row.nodes ?? 0),
    edges: Number(row.edges ?? 0),
  };
}

async function countNodesForPath(repoPath: string, filePath: string): Promise<number> {
  const rows = await queryRepo<{ cnt: number }>(
    repoPath,
    `MATCH (n) WHERE n.filePath = '${filePath}' RETURN count(n) AS cnt`,
  );
  return Number(rows[0]?.cnt ?? 0);
}

async function countFunctionsNamed(repoPath: string, name: string): Promise<number> {
  const rows = await queryRepo<{ cnt: number }>(
    repoPath,
    `MATCH (n:Function) WHERE n.name = '${name}' RETURN count(n) AS cnt`,
  );
  return Number(rows[0]?.cnt ?? 0);
}

async function assertIncrementalMatchesForce(repoPath: string) {
  const incrementalMeta = await loadMeta(getStoragePaths(repoPath).storagePath);
  const incrementalStats = await graphStats(repoPath);
  await runFullAnalysis(repoPath, { ...analyzeOptions, force: true }, callbacks());
  const forceMeta = await loadMeta(getStoragePaths(repoPath).storagePath);
  const forceStats = await graphStats(repoPath);

  expect(incrementalMeta?.stats?.files).toBe(forceMeta?.stats?.files);
  expect(incrementalMeta?.stats?.nodes).toBe(forceMeta?.stats?.nodes);
  expect(incrementalMeta?.stats?.edges).toBe(forceMeta?.stats?.edges);
  expect(incrementalMeta?.stats?.communities).toBe(forceMeta?.stats?.communities);
  expect(incrementalMeta?.stats?.processes).toBe(forceMeta?.stats?.processes);
  expect(incrementalStats).toEqual(forceStats);
}

describe('incremental indexing integration', () => {
  it('initial analyze writes metadata and file hashes', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      const meta = await loadMeta(getStoragePaths(repo.dbPath).storagePath);
      expect(meta?.fileHashes).toBeDefined();
      expect(meta?.fileHashes?.['src/provider.ts']).toMatch(/^[a-f0-9]{64}$/);
      expect(meta?.incrementalInProgress).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 240_000);

  it('second analyze with no changes returns already up to date', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      const second = await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      expect(second.alreadyUpToDate).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('modified source file incremental result matches force rebuild stats', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      const provider = path.join(repo.dbPath, 'src', 'provider.ts');
      const before = await readFile(provider, 'utf-8');
      await writeFile(provider, before.replace("return 'v1';", "return 'v2';"));
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      const meta = await loadMeta(getStoragePaths(repo.dbPath).storagePath);
      expect(meta?.incrementalInProgress).toBeUndefined();
      await assertIncrementalMatchesForce(repo.dbPath);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('deleted source file removes file-bound graph rows and matches force rebuild stats', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      await rm(path.join(repo.dbPath, 'src', 'extra.ts'));
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      expect(await countNodesForPath(repo.dbPath, 'src/extra.ts')).toBe(0);
      await assertIncrementalMatchesForce(repo.dbPath);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('dependency export changes invalidate importers and remove stale provider symbols', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      await writeFile(
        path.join(repo.dbPath, 'src', 'provider.ts'),
        `export function renamedValue(): string {
  return 'renamed';
}
`,
      );
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      expect(await countFunctionsNamed(repo.dbPath, 'value')).toBe(0);
      expect(await countFunctionsNamed(repo.dbPath, 'renamedValue')).toBe(1);
      await assertIncrementalMatchesForce(repo.dbPath);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('critical config changes fall back to full rebuild with observable reason', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      await writeFile(path.join(repo.dbPath, 'package.json'), '{"name":"changed-fixture"}\n');
      const logs: string[] = [];
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks(logs));
      expect(logs.some((line) => line.includes('Incremental fallback: critical config file changed'))).toBe(
        true,
      );
      const meta = await loadMeta(getStoragePaths(repo.dbPath).storagePath);
      expect(meta?.incrementalInProgress).toBeUndefined();
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('status reports added, modified, and deleted counts before indexing', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      await writeFile(path.join(repo.dbPath, 'src', 'added.ts'), 'export const added = 1;\n');
      const provider = path.join(repo.dbPath, 'src', 'provider.ts');
      const before = await readFile(provider, 'utf-8');
      await writeFile(provider, `${before}\n// status modification\n`);
      await rm(path.join(repo.dbPath, 'src', 'extra.ts'));

      const { storagePath, lbugPath, metaPath } = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(storagePath);
      expect(meta).not.toBeNull();
      const report = await buildStatusReport({
        repoPath: repo.dbPath,
        storagePath,
        lbugPath,
        metaPath,
        meta: meta!,
      });

      expect(report.changes.added).toBe(1);
      expect(report.changes.modified).toBe(1);
      expect(report.changes.deleted).toBe(1);
      expect(report.isUpToDate).toBe(false);
    } finally {
      await repo.cleanup();
    }
  }, 360_000);
});

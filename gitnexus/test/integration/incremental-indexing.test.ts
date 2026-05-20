import { execSync } from 'child_process';
import { access, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
import { getFileArtifactCacheDir, loadFileParseArtifact } from '../../src/storage/file-artifact-cache.js';
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

async function setupWorkerArtifactRepo() {
  const repo = await createTempDir('gitnexus-artifact-replay-int-');
  const src = path.join(repo.dbPath, 'src');
  await mkdir(src, { recursive: true });
  for (let i = 0; i < 15; i++) {
    await writeFile(
      path.join(src, `artifact-${i}.ts`),
      `export function artifact${i}(): number { return ${i}; }\n`,
    );
  }
  await writeFile(path.join(repo.dbPath, 'package.json'), '{"name":"artifact-replay-fixture"}\n');
  execSync('git init', { cwd: repo.dbPath, stdio: 'pipe' });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
    cwd: repo.dbPath,
    stdio: 'pipe',
  });
  execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m initial', {
    cwd: repo.dbPath,
    stdio: 'pipe',
  });
  return repo;
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

  it('initial analyze populates the per-file artifact cache for worker-parsed files', async () => {
    const repo = await createTempDir('gitnexus-artifact-cache-int-');
    try {
      const src = path.join(repo.dbPath, 'src');
      await mkdir(src, { recursive: true });
      for (let i = 0; i < 15; i++) {
        await writeFile(
          path.join(src, `artifact-${i}.ts`),
          `export function artifact${i}(): number { return ${i}; }\n`,
        );
      }
      await writeFile(path.join(repo.dbPath, 'package.json'), '{"name":"artifact-fixture"}\n');
      execSync('git init', { cwd: repo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A', {
        cwd: repo.dbPath,
        stdio: 'pipe',
      });
      execSync(
        'git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m initial',
        {
          cwd: repo.dbPath,
          stdio: 'pipe',
        },
      );

      const result = await runFullAnalysis(
        repo.dbPath,
        {
          ...analyzeOptions,
          workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
        },
        callbacks(),
      );
      expect(result.pipelineResult?.usedWorkerPool).toBe(true);
      expect(result.pipelineResult?.fileParseArtifacts?.length).toBeGreaterThan(0);
      const { storagePath } = getStoragePaths(repo.dbPath);
      const indexPath = path.join(getFileArtifactCacheDir(storagePath), 'index.json');
      await expect(access(indexPath)).resolves.toBeUndefined();

      const index = JSON.parse(await readFile(indexPath, 'utf-8')) as {
        artifacts?: Array<{ filePath: string; contentHash: string }>;
      };
      expect(index.artifacts?.length).toBeGreaterThan(0);
      const firstArtifact = index.artifacts![0];

      const artifact = await loadFileParseArtifact(storagePath, {
        filePath: firstArtifact.filePath,
        contentHash: firstArtifact.contentHash,
      });
      expect(artifact).not.toBeNull();
      expect(artifact?.payload.fileCount).toBe(1);
      expect(
        artifact?.payload.nodes.some((node) => node.properties.filePath === artifact.filePath),
      ).toBe(true);

      const beforeStat = await stat(indexPath);
      execSync('git update-index --chmod=+x src/artifact-0.ts', {
        cwd: repo.dbPath,
        stdio: 'pipe',
      });
      const events: string[] = [];
      const second = await runFullAnalysis(repo.dbPath, analyzeOptions, {
        onProgress: (phase) => events.push(`progress:${phase}`),
        onLog: (message) => events.push(`log:${message}`),
      });
      const afterStat = await stat(indexPath);
      expect(second.alreadyUpToDate).toBe(true);
      expect(events).toContain('log:Already up to date');
      expect(events).not.toContain('progress:extracting');
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    } finally {
      await closeLbug();
      await repo.cleanup();
    }
  }, 600_000);

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

  it('status is up to date immediately after analyze writes context files', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, {}, callbacks());

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

      expect(report.changes).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 4 });
      expect(report.isUpToDate).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('status becomes stale when a source file changes after analyze', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, {}, callbacks());
      await writeFile(path.join(repo.dbPath, 'src', 'added.ts'), 'export const added = 1;\n');

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
      expect(report.isUpToDate).toBe(false);
    } finally {
      await repo.cleanup();
    }
  }, 300_000);

  it('modified tracked file does not take unchanged fast path from a subdirectory', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      await writeFile(
        path.join(repo.dbPath, 'src', 'provider.ts'),
        "export function value(): string { return 'changed'; }\n",
      );

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
      expect(report.isUpToDate).toBe(false);
      expect(report.changes.modified).toBe(1);

      const logs: string[] = [];
      const events: string[] = [];
      const result = await runFullAnalysis(path.join(repo.dbPath, 'src'), analyzeOptions, {
        onProgress: (phase) => events.push(phase),
        onLog: (message) => logs.push(message),
      });

      expect(result.alreadyUpToDate).toBeUndefined();
      expect(logs).not.toContain('Already up to date');
      expect(events).toContain('extracting');
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('modified GitNexus-tracked file does not take unchanged fast path when git status is clean', async () => {
    const repo = await setupRepo();
    const previousNoGitignore = process.env.GITNEXUS_NO_GITIGNORE;
    try {
      process.env.GITNEXUS_NO_GITIGNORE = '1';
      await writeFile(path.join(repo.dbPath, '.gitignore'), 'src/local.ts\n');
      execSync('git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add .gitignore', {
        cwd: repo.dbPath,
        stdio: 'pipe',
      });
      execSync(
        'git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m ignore-local',
        {
          cwd: repo.dbPath,
          stdio: 'pipe',
        },
      );
      await writeFile(path.join(repo.dbPath, 'src', 'local.ts'), 'export const local = 1;\n');
      await runFullAnalysis(repo.dbPath, { ...analyzeOptions, force: true }, callbacks());

      await writeFile(path.join(repo.dbPath, 'src', 'local.ts'), 'export const local = 2;\n');
      const gitStatus = execSync(
        "git status --porcelain -- . ':(exclude).gitnexus' ':(exclude).gitnexus/**' ':(exclude).claude' ':(exclude).claude/**' ':(exclude).cursor' ':(exclude).cursor/**' ':(exclude)AGENTS.md' ':(exclude)CLAUDE.md'",
        { cwd: repo.dbPath, encoding: 'utf8' },
      );
      expect(gitStatus.trim()).toBe('');

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
      expect(report.isUpToDate).toBe(false);
      expect(report.changes.modified).toBe(1);

      const logs: string[] = [];
      const events: string[] = [];
      const result = await runFullAnalysis(repo.dbPath, analyzeOptions, {
        onProgress: (phase) => events.push(phase),
        onLog: (message) => logs.push(message),
      });

      expect(result.alreadyUpToDate).toBeUndefined();
      expect(logs).not.toContain('Already up to date');
      expect(events).toContain('extracting');
    } finally {
      if (previousNoGitignore === undefined) delete process.env.GITNEXUS_NO_GITIGNORE;
      else process.env.GITNEXUS_NO_GITIGNORE = previousNoGitignore;
      await repo.cleanup();
    }
  }, 600_000);

  it('status is up to date after incremental analyze updates source hashes', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, {}, callbacks());
      await writeFile(path.join(repo.dbPath, 'src', 'provider.ts'), "export function value() { return 'v2'; }\n");
      await runFullAnalysis(repo.dbPath, {}, callbacks());

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

      expect(report.changes).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 4 });
      expect(report.isUpToDate).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('package.json fallback analyze refreshes status hashes', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, {}, callbacks());
      await writeFile(path.join(repo.dbPath, 'package.json'), '{"name":"changed-fixture"}\n');
      const logs: string[] = [];
      await runFullAnalysis(repo.dbPath, {}, callbacks(logs));
      expect(logs.some((line) => line.includes('Incremental fallback: critical config file changed'))).toBe(
        true,
      );

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

      expect(report.changes).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 4 });
      expect(report.isUpToDate).toBe(true);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  it('status ignores generated GitNexus internal file changes', async () => {
    const repo = await setupRepo();
    try {
      await runFullAnalysis(repo.dbPath, {}, callbacks());
      await writeFile(path.join(repo.dbPath, '.gitnexus', 'internal.tmp'), 'generated\n');

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

      expect(report.changes).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 4 });
      expect(report.isUpToDate).toBe(true);
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

  it('derives the verbose incremental plan before the pipeline starts', async () => {
    const repo = await setupRepo();
    const previousVerbose = process.env.GITNEXUS_VERBOSE;
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      await writeFile(path.join(repo.dbPath, 'package.json'), '{"name":"changed-fixture"}\n');

      process.env.GITNEXUS_VERBOSE = '1';
      const events: string[] = [];
      await runFullAnalysis(repo.dbPath, analyzeOptions, {
        onProgress: (phase) => events.push(`progress:${phase}`),
        onLog: (message) => events.push(`log:${message}`),
      });

      const planIndex = events.findIndex((event) =>
        event.includes('Incremental plan: mode=full reason=critical config file changed'),
      );
      const pipelineStartIndex = events.findIndex((event) => event === 'progress:extracting');

      expect(planIndex).toBeGreaterThanOrEqual(0);
      expect(pipelineStartIndex).toBeGreaterThanOrEqual(0);
      expect(planIndex).toBeLessThan(pipelineStartIndex);
    } finally {
      if (previousVerbose === undefined) delete process.env.GITNEXUS_VERBOSE;
      else process.env.GITNEXUS_VERBOSE = previousVerbose;
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

  it('warm incremental replays unchanged file artifacts and parses fewer files', async () => {
    const repo = await setupWorkerArtifactRepo();
    try {
      await runFullAnalysis(
        repo.dbPath,
        { ...analyzeOptions, force: true, workerThresholdsForTest: { minFiles: 1, minBytes: 1 } },
        callbacks(),
      );
      await writeFile(
        path.join(repo.dbPath, 'src', 'artifact-0.ts'),
        'export function artifact0(): number { return 100; }\n',
      );
      const incremental = await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());

      expect(incremental.pipelineResult?.parseStats.artifactReplayEnabled).toBe(true);
      expect(incremental.pipelineResult?.parseStats.fileArtifactHits).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.parseStats.replayedFiles).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.parseStats.parsedFiles).toBeLessThan(
        incremental.pipelineResult!.parseStats.replayedFiles,
      );
      expect(incremental.pipelineResult?.scopeStats.preExtractedHits).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.scopeStats.filesExtracted).toBeLessThan(
        incremental.pipelineResult!.scopeStats.filesResolved,
      );

      const statusPaths = getStoragePaths(repo.dbPath);
      const meta = await loadMeta(statusPaths.storagePath);
      expect(meta).not.toBeNull();
      const report = await buildStatusReport({
        repoPath: repo.dbPath,
        storagePath: statusPaths.storagePath,
        lbugPath: statusPaths.lbugPath,
        metaPath: statusPaths.metaPath,
        meta: meta!,
      });
      expect(report.isUpToDate).toBe(true);
    } finally {
      await closeLbug();
      await repo.cleanup();
    }
  }, 600_000);
});

import { execSync } from 'child_process';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
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

async function setupCrossFileRelationshipRepo() {
  const repo = await createTempDir('gitnexus-cross-file-rel-int-');
  const src = path.join(repo.dbPath, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, 'api.ts'),
    `export function greet(name: string): string {
  return 'hi ' + name;
}
`,
  );
  await writeFile(
    path.join(src, 'user.ts'),
    `import { greet } from './api';

export function makeMessage(): string {
  return greet('Ada');
}
`,
  );
  await writeFile(
    path.join(src, 'index.ts'),
    `import { makeMessage } from './user';

export function run(): string {
  return makeMessage();
}
`,
  );
  await writeFile(path.join(repo.dbPath, 'package.json'), '{"name":"cross-file-fixture"}\n');
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

async function setupSearchFreshnessRepo() {
  const repo = await createTempDir('gitnexus-test-search-fresh-');
  const src = path.join(repo.dbPath, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, 'keep.ts'),
    `export function keepToken(): string {
  return 'freshnesskeepterm';
}
`,
  );
  await writeFile(
    path.join(src, 'change.ts'),
    `export function changedToken(): string {
  return 'freshnessoldterm';
}
`,
  );
  await writeFile(
    path.join(src, 'remove.ts'),
    `export function removedToken(): string {
  return 'freshnessremoveterm';
}
`,
  );
  await writeFile(path.join(repo.dbPath, 'package.json'), '{"name":"search-fresh-fixture"}\n');
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

async function structureTopology(repoPath: string): Promise<{
  folderPaths: string[];
  containsPairs: string[];
}> {
  const folderRows = await queryRepo<{ filePath: string }>(
    repoPath,
    `MATCH (f:Folder) RETURN f.filePath AS filePath`,
  );
  const folderToFolderRows = await queryRepo<{ source: string; target: string }>(
    repoPath,
    `MATCH (a:Folder)-[r:CodeRelation]->(b:Folder)
     WHERE r.type = 'CONTAINS'
     RETURN a.filePath AS source, b.filePath AS target`,
  );
  const folderToFileRows = await queryRepo<{ source: string; target: string }>(
    repoPath,
    `MATCH (a:Folder)-[r:CodeRelation]->(b:File)
     WHERE r.type = 'CONTAINS'
     RETURN a.filePath AS source, b.filePath AS target`,
  );

  return {
    folderPaths: folderRows.map((row) => row.filePath).sort(),
    containsPairs: [...folderToFolderRows, ...folderToFileRows]
      .map((row) => `${row.source}->${row.target}`)
      .sort(),
  };
}

async function persistentStructureTopology(repoPath: string): Promise<{
  files: string[];
  folders: string[];
  containsRelationships: string[];
}> {
  const fileRows = await queryRepo<{ id: string; name: string; filePath: string }>(
    repoPath,
    `MATCH (f:File) RETURN f.id AS id, f.name AS name, f.filePath AS filePath`,
  );
  const folderRows = await queryRepo<{ id: string; name: string; filePath: string }>(
    repoPath,
    `MATCH (f:Folder) RETURN f.id AS id, f.name AS name, f.filePath AS filePath`,
  );
  const folderToFolderRows = await queryRepo<{
    sourceId: string;
    sourcePath: string;
    targetId: string;
    targetPath: string;
    type: string;
  }>(
    repoPath,
    `MATCH (a:Folder)-[r:CodeRelation]->(b:Folder)
     WHERE r.type = 'CONTAINS'
     RETURN a.id AS sourceId, a.filePath AS sourcePath,
            b.id AS targetId, b.filePath AS targetPath, r.type AS type`,
  );
  const folderToFileRows = await queryRepo<{
    sourceId: string;
    sourcePath: string;
    targetId: string;
    targetPath: string;
    type: string;
  }>(
    repoPath,
    `MATCH (a:Folder)-[r:CodeRelation]->(b:File)
     WHERE r.type = 'CONTAINS'
     RETURN a.id AS sourceId, a.filePath AS sourcePath,
            b.id AS targetId, b.filePath AS targetPath, r.type AS type`,
  );

  return {
    files: fileRows.map((row) => `${row.id}|${row.name}|${row.filePath}`).sort(),
    folders: folderRows.map((row) => `${row.id}|${row.name}|${row.filePath}`).sort(),
    containsRelationships: [...folderToFolderRows, ...folderToFileRows]
      .map(
        (row) =>
          `${row.type}:${row.sourceId}|${row.sourcePath}->${row.targetId}|${row.targetPath}`,
      )
      .sort(),
  };
}

async function crossFileRelationshipTopology(repoPath: string): Promise<{
  imports: string[];
  calls: string[];
}> {
  const relationshipPairs = [
    ['File', 'File'],
    ['Function', 'Function'],
    ['Function', 'Method'],
    ['Method', 'Function'],
    ['Method', 'Method'],
  ] as const;
  const rows: Array<{
    sourceLabel: string;
    sourceId: string;
    sourceName: string;
    sourcePath: string;
    targetLabel: string;
    targetId: string;
    targetName: string;
    targetPath: string;
    type: string;
  }> = [];

  for (const [sourceLabel, targetLabel] of relationshipPairs) {
    rows.push(
      ...(await queryRepo<{
        sourceId: string;
        sourceName: string;
        sourcePath: string;
        targetId: string;
        targetName: string;
        targetPath: string;
        type: string;
      }>(
        repoPath,
        `MATCH (a:${sourceLabel})-[r:CodeRelation]->(b:${targetLabel})
         WHERE (r.type = 'IMPORTS' OR r.type = 'CALLS') AND a.filePath <> b.filePath
         RETURN a.id AS sourceId, a.name AS sourceName, a.filePath AS sourcePath,
                b.id AS targetId, b.name AS targetName, b.filePath AS targetPath,
                r.type AS type`,
      )).map((row) => ({
        ...row,
        sourceLabel,
        targetLabel,
      })),
    );
  }

  const serialize = (row: (typeof rows)[number]) =>
    `${row.type}:${row.sourceLabel}:${row.sourceId}|${row.sourceName}|${row.sourcePath}` +
    `->${row.targetLabel}:${row.targetId}|${row.targetName}|${row.targetPath}`;

  return {
    imports: rows.filter((row) => row.type === 'IMPORTS').map(serialize).sort(),
    calls: rows.filter((row) => row.type === 'CALLS').map(serialize).sort(),
  };
}

async function searchFreshnessSnapshot(
  repoPath: string,
  tokens: readonly string[],
): Promise<Record<string, { ftsAvailable: boolean; filePaths: string[]; nodeIds: string[] }>> {
  const { lbugPath } = getStoragePaths(repoPath);
  await initLbug(lbugPath);
  try {
    const snapshot: Record<
      string,
      { ftsAvailable: boolean; filePaths: string[]; nodeIds: string[] }
    > = {};
    for (const token of tokens) {
      const { results, ftsAvailable } = await searchFTSFromLbug(token, 10);
      snapshot[token] = {
        ftsAvailable,
        filePaths: results.map((result) => result.filePath).sort(),
        nodeIds: results.flatMap((result) => result.nodeIds ?? []).sort(),
      };
    }
    return snapshot;
  } finally {
    await closeLbug();
  }
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

  it('body-only incremental edit reuses cached scope finalize output', async () => {
    const repo = await setupRepo();
    const previousVerbose = process.env.GITNEXUS_VERBOSE;
    const workerOptions = {
      ...analyzeOptions,
      workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    };
    try {
      await runFullAnalysis(repo.dbPath, { ...workerOptions, force: true }, callbacks());

      await writeFile(
        path.join(repo.dbPath, 'src', 'consumer.ts'),
        `import { value } from './provider';

export function useValue(): string {
  const next = value();
  return next;
}
`,
      );
      const warm = await runFullAnalysis(repo.dbPath, workerOptions, callbacks());
      expect(warm.pipelineResult?.scopeStats.finalizeCacheMisses).toBeGreaterThan(0);

      await writeFile(
        path.join(repo.dbPath, 'src', 'provider.ts'),
        `export function value(): string {
  return 'v2';
}
`,
      );
      const logs: string[] = [];
      process.env.GITNEXUS_VERBOSE = '1';
      const cached = await runFullAnalysis(repo.dbPath, workerOptions, callbacks(logs));
      expect(cached.alreadyUpToDate).toBeUndefined();
      expect(cached.pipelineResult?.scopeStats.finalizeCacheHits).toBeGreaterThan(0);
      expect(cached.pipelineResult?.scopeStats.partialEnabled).toBe(true);
      expect(cached.pipelineResult?.scopeStats.partialAffectedFiles).toBeGreaterThan(0);
      expect(cached.pipelineResult?.scopeStats.referenceSitesResolved).toBeLessThanOrEqual(
        cached.pipelineResult!.scopeStats.referenceSitesTotal,
      );
      expect(cached.pipelineResult?.scopeStats.emitFiles).toBeLessThan(
        cached.pipelineResult!.scopeStats.filesResolved,
      );
      expect(cached.pipelineResult?.scopeStats.partialAffectedFiles).toBeGreaterThan(0);
      expect(logs).toContain(
        '  semanticSurface: changedFiles=0, unchangedFiles=1, importerExpansionSkipped=1, finalizeInvalidationReason=none',
      );
      expect(logs.some((line) => line.includes('scopeFinalizeCacheHit=1'))).toBe(true);
      expect(logs.some((line) => line.includes('scopePartial: enabled=true'))).toBe(true);
    } finally {
      if (previousVerbose === undefined) delete process.env.GITNEXUS_VERBOSE;
      else process.env.GITNEXUS_VERBOSE = previousVerbose;
      await repo.cleanup();
    }
  }, 600_000);

  it('import/export rename misses cached scope finalize output', async () => {
    const repo = await setupRepo();
    const workerOptions = {
      ...analyzeOptions,
      workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    };
    try {
      await runFullAnalysis(repo.dbPath, { ...workerOptions, force: true }, callbacks());
      await writeFile(path.join(repo.dbPath, 'src', 'extra.ts'), 'export function extra(): number { return 2; }\n');
      const warm = await runFullAnalysis(repo.dbPath, workerOptions, callbacks());
      expect(warm.pipelineResult?.scopeStats.finalizeCacheMisses).toBeGreaterThan(0);

      await writeFile(
        path.join(repo.dbPath, 'src', 'provider.ts'),
        "export function renamedValue(): string { return 'v2'; }\n",
      );
      await writeFile(
        path.join(repo.dbPath, 'src', 'consumer.ts'),
        `import { renamedValue } from './provider';

export function useValue(): string {
  return renamedValue();
}
`,
      );
      const renamed = await runFullAnalysis(repo.dbPath, workerOptions, callbacks());
      expect(renamed.pipelineResult?.scopeStats.finalizeCacheHits ?? 0).toBe(0);
      expect(renamed.pipelineResult?.scopeStats.finalizeCacheMisses).toBeGreaterThan(0);
      expect(renamed.pipelineResult?.scopeStats.partialEnabled).toBe(false);
    } finally {
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
      const incremental = await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      expect(incremental.pipelineResult?.scopeStats.partialEnabled).toBe(false);
      expect(await countNodesForPath(repo.dbPath, 'src/extra.ts')).toBe(0);
      await assertIncrementalMatchesForce(repo.dbPath);
    } finally {
      await repo.cleanup();
    }
  }, 600_000);

  describe('incremental structure topology', () => {
    it('adds Folder nodes and CONTAINS relationships for a file in a brand-new nested directory', async () => {
      const repo = await setupRepo();
      try {
        await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
        await mkdir(path.join(repo.dbPath, 'src', 'new', 'nested'), { recursive: true });
        await writeFile(
          path.join(repo.dbPath, 'src', 'new', 'nested', 'added.ts'),
          'export function added(): number { return 1; }\n',
        );

        await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
        const topology = await structureTopology(repo.dbPath);

        expect(topology.folderPaths).toEqual(expect.arrayContaining(['src/new', 'src/new/nested']));
        expect(topology.containsPairs).toEqual(
          expect.arrayContaining([
            'src->src/new',
            'src/new->src/new/nested',
            'src/new/nested->src/new/nested/added.ts',
          ]),
        );
      } finally {
        await closeLbug();
        await repo.cleanup();
      }
    }, 600_000);

    it('removes stale Folder and CONTAINS topology after deleting the last file in a directory', async () => {
      const repo = await setupRepo();
      try {
        await mkdir(path.join(repo.dbPath, 'src', 'obsolete'), { recursive: true });
        await writeFile(
          path.join(repo.dbPath, 'src', 'obsolete', 'only.ts'),
          'export function only(): number { return 1; }\n',
        );
        await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());

        await rm(path.join(repo.dbPath, 'src', 'obsolete', 'only.ts'));
        await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
        const topology = await structureTopology(repo.dbPath);

        expect(await countNodesForPath(repo.dbPath, 'src/obsolete/only.ts')).toBe(0);
        expect(topology.folderPaths).not.toContain('src/obsolete');
        expect(topology.containsPairs.some((pair) => pair.includes('src/obsolete'))).toBe(false);
      } finally {
        await closeLbug();
        await repo.cleanup();
      }
    }, 600_000);

    it('updates Folder and CONTAINS topology after moving a file to a new nested directory', async () => {
      const repo = await setupRepo();
      try {
        await mkdir(path.join(repo.dbPath, 'src', 'old'), { recursive: true });
        await writeFile(
          path.join(repo.dbPath, 'src', 'old', 'only.ts'),
          'export function only(): number { return 1; }\n',
        );
        await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());

        await mkdir(path.join(repo.dbPath, 'src', 'moved', 'nested'), { recursive: true });
        await rename(
          path.join(repo.dbPath, 'src', 'old', 'only.ts'),
          path.join(repo.dbPath, 'src', 'moved', 'nested', 'renamed.ts'),
        );
        await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
        const topology = await structureTopology(repo.dbPath);

        expect(await countNodesForPath(repo.dbPath, 'src/old/only.ts')).toBe(0);
        expect(topology.folderPaths).not.toContain('src/old');
        expect(topology.containsPairs.some((pair) => pair.includes('src/old'))).toBe(false);
        expect(topology.folderPaths).toEqual(
          expect.arrayContaining(['src/moved', 'src/moved/nested']),
        );
        expect(topology.containsPairs).toEqual(
          expect.arrayContaining([
            'src->src/moved',
            'src/moved->src/moved/nested',
            'src/moved/nested->src/moved/nested/renamed.ts',
          ]),
        );
      } finally {
        await closeLbug();
        await repo.cleanup();
      }
    }, 600_000);

    it('incremental structure topology matches force rebuild after add delete and move', async () => {
      const repo = await setupRepo();
      try {
        await mkdir(path.join(repo.dbPath, 'src', 'obsolete'), { recursive: true });
        await writeFile(
          path.join(repo.dbPath, 'src', 'obsolete', 'old.ts'),
          'export function old(): number { return 1; }\n',
        );
        await mkdir(path.join(repo.dbPath, 'src', 'old'), { recursive: true });
        await writeFile(
          path.join(repo.dbPath, 'src', 'old', 'moved.ts'),
          'export function moved(): number { return 2; }\n',
        );
        await writeFile(
          path.join(repo.dbPath, 'src', 'shared.ts'),
          'export function shared(): number { return 3; }\n',
        );
        await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());

        await mkdir(path.join(repo.dbPath, 'src', 'new', 'nested'), { recursive: true });
        await writeFile(
          path.join(repo.dbPath, 'src', 'new', 'nested', 'added.ts'),
          'export function added(): number { return 4; }\n',
        );
        await rm(path.join(repo.dbPath, 'src', 'obsolete', 'old.ts'));
        await mkdir(path.join(repo.dbPath, 'src', 'new', 'location'), { recursive: true });
        await rename(
          path.join(repo.dbPath, 'src', 'old', 'moved.ts'),
          path.join(repo.dbPath, 'src', 'new', 'location', 'moved.ts'),
        );

        await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
        const incrementalTopology = await persistentStructureTopology(repo.dbPath);

        await runFullAnalysis(repo.dbPath, { ...analyzeOptions, force: true }, callbacks());
        const forceTopology = await persistentStructureTopology(repo.dbPath);

        expect(incrementalTopology).toEqual(forceTopology);
      } finally {
        await closeLbug();
        await repo.cleanup();
      }
    }, 600_000);
  });

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

  it('incremental cross-file relationships match force rebuild after export change', async () => {
    const repo = await setupCrossFileRelationshipRepo();
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      await writeFile(
        path.join(repo.dbPath, 'src', 'api.ts'),
        `export function greetUser(name: string): string {
  return 'hi ' + name;
}
`,
      );
      await writeFile(
        path.join(repo.dbPath, 'src', 'user.ts'),
        `import { greetUser } from './api';

export function makeMessage(): string {
  return greetUser('Ada');
}
`,
      );

      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      const incrementalTopology = await crossFileRelationshipTopology(repo.dbPath);

      expect(incrementalTopology.imports.length).toBeGreaterThan(0);
      expect(incrementalTopology.calls.length).toBeGreaterThan(0);
      expect(incrementalTopology.calls.some((rel) => rel.includes('greetUser'))).toBe(true);
      expect(
        incrementalTopology.calls.some((rel) => rel.includes('Function:src/api.ts:greet|greet|')),
      ).toBe(false);

      await runFullAnalysis(repo.dbPath, { ...analyzeOptions, force: true }, callbacks());
      const forceTopology = await crossFileRelationshipTopology(repo.dbPath);

      expect(incrementalTopology).toEqual(forceTopology);
    } finally {
      await closeLbug();
      await repo.cleanup();
    }
  }, 600_000);

  it('incremental search index matches force rebuild after changed and deleted files', async () => {
    const repo = await setupSearchFreshnessRepo();
    const tokens = [
      'freshnesskeepterm',
      'freshnessoldterm',
      'freshnessnewterm',
      'freshnessremoveterm',
    ] as const;
    try {
      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      await writeFile(
        path.join(repo.dbPath, 'src', 'change.ts'),
        `export function changedToken(): string {
  return 'freshnessnewterm';
}
`,
      );
      await rm(path.join(repo.dbPath, 'src', 'remove.ts'));

      await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      const incrementalSnapshot = await searchFreshnessSnapshot(repo.dbPath, tokens);

      expect(Object.values(incrementalSnapshot).every((result) => result.ftsAvailable)).toBe(true);
      expect(incrementalSnapshot.freshnesskeepterm.filePaths).toContain('src/keep.ts');
      expect(incrementalSnapshot.freshnessnewterm.filePaths).toContain('src/change.ts');
      expect(incrementalSnapshot.freshnessoldterm.filePaths).not.toContain('src/change.ts');
      expect(incrementalSnapshot.freshnessoldterm.filePaths).toHaveLength(0);
      expect(incrementalSnapshot.freshnessremoveterm.filePaths).not.toContain('src/remove.ts');
      expect(incrementalSnapshot.freshnessremoveterm.filePaths).toHaveLength(0);

      await runFullAnalysis(repo.dbPath, { ...analyzeOptions, force: true }, callbacks());
      const forceSnapshot = await searchFreshnessSnapshot(repo.dbPath, tokens);

      expect(incrementalSnapshot).toEqual(forceSnapshot);
    } finally {
      await closeLbug();
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
      expect(incremental.pipelineResult?.usedWorkerPool).toBe(false);
      expect(incremental.pipelineResult?.parseStats.fileArtifactHits).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.parseStats.replayedFiles).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.parseStats.workerEligibleFiles).toBe(
        incremental.pipelineResult?.parseStats.parsedFiles,
      );
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

  it('warm incremental parses missing artifact files fresh without disabling replay', async () => {
    const repo = await setupWorkerArtifactRepo();
    try {
      await runFullAnalysis(
        repo.dbPath,
        { ...analyzeOptions, force: true, workerThresholdsForTest: { minFiles: 1, minBytes: 1 } },
        callbacks(),
      );
      const { storagePath } = getStoragePaths(repo.dbPath);
      const cacheDir = getFileArtifactCacheDir(storagePath);
      const index = JSON.parse(await readFile(path.join(cacheDir, 'index.json'), 'utf-8')) as {
        artifacts: Array<{ filePath: string; shard: string }>;
      };
      const missingArtifact = index.artifacts.find(
        (artifact) => artifact.filePath === 'src/artifact-1.ts',
      );
      expect(missingArtifact).toBeDefined();
      await rm(path.join(cacheDir, missingArtifact!.shard));

      await writeFile(
        path.join(repo.dbPath, 'src', 'artifact-0.ts'),
        'export function artifact0(): number { return 100; }\n',
      );
      const incremental = await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());

      expect(incremental.pipelineResult?.parseStats.artifactReplayEnabled).toBe(true);
      expect(incremental.pipelineResult?.parseStats.artifactReplayMode).toBe('partial');
      expect(incremental.pipelineResult?.scopeStats.partialEnabled).toBe(false);
      expect(incremental.pipelineResult?.parseStats.fileArtifactMisses).toBe(1);
      expect(incremental.pipelineResult?.parseStats.fileArtifactHits).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.parseStats.artifactShardReads).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.parseStats.replayedFiles).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.parseStats.parsedFiles).toBeGreaterThanOrEqual(2);
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

  it('small replay scope misses patch the finalize cache instead of global finalize', async () => {
    const repo = await setupWorkerArtifactRepo();
    try {
      await runFullAnalysis(
        repo.dbPath,
        { ...analyzeOptions, force: true, workerThresholdsForTest: { minFiles: 1, minBytes: 1 } },
        callbacks(),
      );
      await writeFile(
        path.join(repo.dbPath, 'src', 'artifact-2.ts'),
        'export function artifact2(): number { return 200; }\n',
      );
      const warm = await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());
      expect(warm.pipelineResult?.scopeStats.finalizeCacheMisses).toBeGreaterThan(0);

      const { storagePath } = getStoragePaths(repo.dbPath);
      const cacheDir = getFileArtifactCacheDir(storagePath);
      const index = JSON.parse(await readFile(path.join(cacheDir, 'index.json'), 'utf-8')) as {
        artifacts: Array<{ filePath: string; shard: string }>;
      };
      const staleScopeArtifact = index.artifacts.find(
        (artifact) => artifact.filePath === 'src/artifact-1.ts',
      );
      expect(staleScopeArtifact).toBeDefined();
      const shardPath = path.join(cacheDir, staleScopeArtifact!.shard);
      const shard = JSON.parse(await readFile(shardPath, 'utf-8')) as {
        payload: { parsedFiles?: unknown[] };
      };
      shard.payload.parsedFiles = [];
      await writeFile(shardPath, JSON.stringify(shard), 'utf-8');

      await writeFile(
        path.join(repo.dbPath, 'src', 'artifact-0.ts'),
        'export function artifact0(): number { return 100; }\n',
      );
      const incremental = await runFullAnalysis(repo.dbPath, analyzeOptions, callbacks());

      expect(incremental.pipelineResult?.parseStats.artifactReplayEnabled).toBe(true);
      expect(incremental.pipelineResult?.parseStats.fileArtifactHits).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.scopeStats.finalizePatchEnabled).toBe(true);
      expect(incremental.pipelineResult?.scopeStats.finalizePatchedFiles).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.scopeStats.finalizeReusedFiles).toBeGreaterThan(0);
      expect(incremental.pipelineResult?.scopeStats.finalizeCacheHits).toBeGreaterThan(0);

      await assertIncrementalMatchesForce(repo.dbPath);
    } finally {
      await closeLbug();
      await repo.cleanup();
    }
  }, 600_000);
});

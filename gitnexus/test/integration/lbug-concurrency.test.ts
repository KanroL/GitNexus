import { execSync } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { closeLbug } from '../../src/core/lbug/lbug-adapter.js';
import {
  acquireDbReadLock,
  DB_OPEN_BY_SERVER_MESSAGE,
} from '../../src/core/lbug/access-guard.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

async function setupTinyRepo() {
  const repo = await createTempDir('gitnexus-test-lbug-concurrency-');
  const src = path.join(repo.dbPath, 'src');
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, 'index.ts'), 'export const value = 1;\n');
  await writeFile(path.join(repo.dbPath, 'package.json'), '{"name":"lbug-concurrency"}\n');
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

describe('LadybugDB analyze concurrency guard', () => {
  it('fails before DB writeback when a server read handle is active', async () => {
    const repo = await setupTinyRepo();
    const { lbugPath } = getStoragePaths(repo.dbPath);
    const readGuard = await acquireDbReadLock(lbugPath);
    const phases: string[] = [];

    try {
      await expect(
        runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true, skipSkills: true },
          {
            onProgress: (phase) => phases.push(phase),
            onLog: () => {},
          },
        ),
      ).rejects.toThrow(DB_OPEN_BY_SERVER_MESSAGE);
      expect(phases).not.toContain('lbug');
      expect(phases).not.toContain('fts');
    } finally {
      await readGuard.release();
      await closeLbug();
      await repo.cleanup();
    }
  }, 120_000);
});

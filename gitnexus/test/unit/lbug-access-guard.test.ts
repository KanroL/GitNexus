import path from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { describe, expect, it } from 'vitest';
import {
  acquireDbReadLock,
  acquireDbWriteLock,
  DB_ANALYZE_IN_PROGRESS_MESSAGE,
  DB_OPEN_BY_SERVER_MESSAGE,
  DB_WRITE_IN_PROGRESS_MESSAGE,
  _dbAccessGuardPathsForTest,
} from '../../src/core/lbug/access-guard.js';
import { createTempDir } from '../helpers/test-db.js';

describe('LadybugDB access guard', () => {
  it('rejects a second writer while analyze holds the write lock', async () => {
    const tmp = await createTempDir('gitnexus-test-lbug-guard-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    const writer = await acquireDbWriteLock(dbPath);
    try {
      await expect(acquireDbWriteLock(dbPath)).rejects.toThrow(DB_ANALYZE_IN_PROGRESS_MESSAGE);
    } finally {
      await writer.release();
      await tmp.cleanup();
    }
  });

  it('rejects analyze while a server read lock is active', async () => {
    const tmp = await createTempDir('gitnexus-test-lbug-guard-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    const reader = await acquireDbReadLock(dbPath);
    try {
      await expect(acquireDbWriteLock(dbPath)).rejects.toThrow(DB_OPEN_BY_SERVER_MESSAGE);
    } finally {
      await reader.release();
      await tmp.cleanup();
    }
  });

  it('rejects server reads while analyze holds the write lock', async () => {
    const tmp = await createTempDir('gitnexus-test-lbug-guard-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    const writer = await acquireDbWriteLock(dbPath);
    try {
      await expect(acquireDbReadLock(dbPath)).rejects.toThrow(DB_WRITE_IN_PROGRESS_MESSAGE);
    } finally {
      await writer.release();
      await tmp.cleanup();
    }
  });

  it('removes stale reader markers before granting the writer lock', async () => {
    const tmp = await createTempDir('gitnexus-test-lbug-guard-');
    const dbPath = path.join(tmp.dbPath, 'lbug');
    const { readLockDir } = _dbAccessGuardPathsForTest(dbPath);
    const staleReaderPath = path.join(readLockDir, 'stale-reader.lock');
    await mkdir(readLockDir, { recursive: true });
    await writeFile(
      staleReaderPath,
      JSON.stringify({
        kind: 'read',
        pid: 0,
        acquiredAt: Date.now(),
        dbPath,
      }),
      'utf-8',
    );

    const writer = await acquireDbWriteLock(dbPath);
    try {
      await expect(readFile(staleReaderPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await writer.release();
      await tmp.cleanup();
    }
  });
});

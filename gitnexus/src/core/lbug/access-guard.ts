import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';

interface LockPayload {
  kind: 'read' | 'write';
  pid: number;
  acquiredAt: number;
  dbPath: string;
}

export interface DbAccessGuard {
  readonly lockPath: string;
  release: () => Promise<void>;
}

const writeLockPath = (dbPath: string): string => `${dbPath}.gitnexus-write.lock`;
const readLockDir = (dbPath: string): string => `${dbPath}.gitnexus-readers`;
const normalizeDbPath = (dbPath: string): string => path.resolve(dbPath);

export const DB_OPEN_BY_SERVER_MESSAGE =
  'GitNexus database is currently open by the server. Stop the server or close active sessions before running analyze.';

export const DB_WRITE_IN_PROGRESS_MESSAGE =
  'GitNexus database is currently being rebuilt by analyze. Retry after analyze completes.';

export const DB_ANALYZE_IN_PROGRESS_MESSAGE =
  'Another gitnexus analyze process is already writing this database. Wait for it to finish before running analyze again.';

const lockPayload = (kind: LockPayload['kind'], dbPath: string): LockPayload => ({
  kind,
  pid: process.pid,
  acquiredAt: Date.now(),
  dbPath,
});

const isMissingFileError = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
};

const readPayload = async (filePath: string): Promise<LockPayload | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      (parsed.kind !== 'read' && parsed.kind !== 'write') ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.acquiredAt !== 'number' ||
      typeof parsed.dbPath !== 'string'
    ) {
      return null;
    }
    return parsed as LockPayload;
  } catch {
    return null;
  }
};

const removeIfStale = async (filePath: string): Promise<boolean> => {
  const payload = await readPayload(filePath);
  if (payload && isProcessAlive(payload.pid)) return false;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (!isMissingFileError(err)) return false;
  }
  return true;
};

const activeWriteLock = async (dbPath: string): Promise<LockPayload | null> => {
  const lockPath = writeLockPath(dbPath);
  const payload = await readPayload(lockPath);
  if (payload && isProcessAlive(payload.pid)) return payload;
  await removeIfStale(lockPath);
  return null;
};

const activeReadLocks = async (dbPath: string): Promise<LockPayload[]> => {
  const dir = readLockDir(dbPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isMissingFileError(err)) return [];
    throw err;
  }

  const active: LockPayload[] = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    const payload = await readPayload(filePath);
    if (payload && isProcessAlive(payload.pid)) {
      active.push(payload);
      continue;
    }
    await removeIfStale(filePath);
  }
  return active;
};

const ensureLockParent = async (dbPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
};

export async function acquireDbWriteLock(dbPath: string): Promise<DbAccessGuard> {
  dbPath = normalizeDbPath(dbPath);
  await ensureLockParent(dbPath);
  const lockPath = writeLockPath(dbPath);
  await removeIfStale(lockPath);

  try {
    await fs.writeFile(lockPath, JSON.stringify(lockPayload('write', dbPath)), {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
      throw new Error(DB_ANALYZE_IN_PROGRESS_MESSAGE);
    }
    throw err;
  }

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await fs.unlink(lockPath);
    } catch (err) {
      if (!isMissingFileError(err)) throw err;
    }
  };

  const readers = await activeReadLocks(dbPath);
  if (readers.length > 0) {
    await release();
    throw new Error(DB_OPEN_BY_SERVER_MESSAGE);
  }

  return { lockPath, release };
}

export async function acquireDbReadLock(dbPath: string): Promise<DbAccessGuard> {
  dbPath = normalizeDbPath(dbPath);
  await ensureLockParent(dbPath);
  if (await activeWriteLock(dbPath)) {
    throw new Error(DB_WRITE_IN_PROGRESS_MESSAGE);
  }

  const dir = readLockDir(dbPath);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(
    dir,
    `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.lock`,
  );
  await fs.writeFile(lockPath, JSON.stringify(lockPayload('read', dbPath)), {
    encoding: 'utf-8',
    flag: 'wx',
  });

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await fs.unlink(lockPath);
    } catch (err) {
      if (!isMissingFileError(err)) throw err;
    }
  };

  if (await activeWriteLock(dbPath)) {
    await release();
    throw new Error(DB_WRITE_IN_PROGRESS_MESSAGE);
  }

  return { lockPath, release };
}

export const _dbAccessGuardPathsForTest = (dbPath: string) => ({
  writeLockPath: writeLockPath(normalizeDbPath(dbPath)),
  readLockDir: readLockDir(normalizeDbPath(dbPath)),
});

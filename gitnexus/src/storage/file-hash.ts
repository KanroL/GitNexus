/**
 * Per-file content hashing for incremental DB writeback.
 *
 * On every analyze run we compute SHA-256 of every file's content and
 * store the map in meta.json. The next run compares disk against the
 * stored map and produces:
 *   - `changed` — content differs (re-emit DB rows for this file)
 *   - `added`   — file is new on disk (insert DB rows)
 *   - `deleted` — file was in last meta but no longer on disk (drop rows)
 *
 * The pipeline still parses every file (correctness invariant: cross-file
 * resolution needs full data). What this enables is a SELECTIVE DB
 * writeback: instead of wipe-and-reload of the whole graph (~50s of CSV
 * COPY on a 25K-node repo), we only delete-and-rewrite rows for the
 * changed/added/deleted set.
 *
 * See docs/superpowers/specs/2026-05-10-incremental-indexing-design.md
 * (Option B revision).
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const GENERATED_CONTEXT_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);
const GENERATED_CONTEXT_DIRS = ['.gitnexus/', '.claude/', '.cursor/'];

const normalizeRelPath = (relPath: string): string => relPath.replace(/\\/g, '/');

/**
 * Whether a repo-relative path participates in incremental/status hash diffing.
 *
 * GitNexus writes `.gitnexus/` internals and AI-context files after the parse
 * snapshot. Tracking those generated files would make a successful analyze look
 * stale immediately. Real source and config files remain tracked, including
 * critical config files such as package.json.
 */
export const shouldTrackFileHash = (relPath: string): boolean => {
  const normalized = normalizeRelPath(relPath);
  if (GENERATED_CONTEXT_FILES.has(normalized)) return false;
  return !GENERATED_CONTEXT_DIRS.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
};

export const filterTrackedFilePaths = (relPaths: readonly string[]): string[] =>
  relPaths.map(normalizeRelPath).filter(shouldTrackFileHash);

const filterStoredFileHashes = (
  stored: Readonly<Record<string, string>> | undefined,
): Map<string, string> => {
  const out = new Map<string, string>();
  if (!stored) return out;
  for (const [p, h] of Object.entries(stored)) {
    const normalized = normalizeRelPath(p);
    if (shouldTrackFileHash(normalized)) out.set(normalized, h);
  }
  return out;
};

/**
 * Compute SHA-256 of a single file. Returns null when the file can't be
 * read — caller treats that as "no signature, assume changed".
 */
export const computeFileHash = async (absPath: string): Promise<string | null> => {
  try {
    const buf = await fs.readFile(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
};

/**
 * Compute SHA-256 hashes for many files in parallel batches. Files that
 * fail to read are omitted from the result map.
 */
export const computeFileHashes = async (
  repoPath: string,
  relPaths: readonly string[],
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const trackedPaths = filterTrackedFilePaths(relPaths);
  const BATCH = 100;
  for (let i = 0; i < trackedPaths.length; i += BATCH) {
    const batch = trackedPaths.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (rel) => {
        const h = await computeFileHash(path.join(repoPath, rel));
        return h ? ([rel, h] as const) : null;
      }),
    );
    for (const r of results) if (r) out.set(r[0], r[1]);
  }
  return out;
};

/** Result of comparing the current on-disk hashes against stored ones. */
export interface FileHashDiff {
  /** Files whose content hash differs from stored. */
  changed: string[];
  /** Files in the current scan that weren't in the stored map. */
  added: string[];
  /** Files in the stored map that aren't in the current scan. */
  deleted: string[];
  /** All files whose DB rows must be replaced (changed ∪ added). */
  toWrite: string[];
}

/**
 * Diff a current hash map against a previously stored one.
 *
 * Sorted output so two runs produce identical diff arrays for the same
 * changes — useful for stable logging / equivalence checks.
 */
export const diffFileHashes = (
  current: ReadonlyMap<string, string>,
  stored: Readonly<Record<string, string>> | undefined,
): FileHashDiff => {
  const currentMap = new Map<string, string>();
  for (const [p, h] of current) {
    const normalized = normalizeRelPath(p);
    if (shouldTrackFileHash(normalized)) currentMap.set(normalized, h);
  }
  const storedMap = filterStoredFileHashes(stored);
  const changed: string[] = [];
  const added: string[] = [];
  for (const [p, h] of currentMap) {
    const prev = storedMap.get(p);
    if (prev === undefined) added.push(p);
    else if (prev !== h) changed.push(p);
  }
  const deleted: string[] = [];
  for (const p of storedMap.keys()) {
    if (!currentMap.has(p)) deleted.push(p);
  }
  changed.sort();
  added.sort();
  deleted.sort();
  return {
    changed,
    added,
    deleted,
    toWrite: [...changed, ...added].sort(),
  };
};

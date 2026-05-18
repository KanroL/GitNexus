/**
 * Per-file parse artifact cache.
 *
 * This cache is infrastructure for changed-file-only parsing. It stores a
 * worker-equivalent `ParseWorkerResult` for a single file, keyed by file path
 * and content hash, but is not consumed by the ingestion pipeline yet.
 */

import { createHash } from 'crypto';
import { createRequire } from 'module';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SupportedLanguages } from 'gitnexus-shared';
import type { ParseWorkerResult } from '../core/ingestion/workers/parse-worker.js';

const ARTIFACT_SCHEMA_VERSION = 1;
const GITNEXUS_PKG_VERSION = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, '..', '..', 'package.json'),
      path.join(here, '..', '..', '..', 'package.json'),
    ];
    const requireCJS = createRequire(import.meta.url);
    for (const c of candidates) {
      try {
        const pkg = requireCJS(c);
        if (typeof pkg?.version === 'string') return pkg.version;
      } catch {
        /* try next candidate */
      }
    }
  } catch {
    /* fall through */
  }
  return '0.0.0-unknown';
})();

export const FILE_ARTIFACT_CACHE_VERSION = `${ARTIFACT_SCHEMA_VERSION}+${GITNEXUS_PKG_VERSION}`;
export const FILE_ARTIFACT_SCHEMA_VERSION = ARTIFACT_SCHEMA_VERSION;

const CACHE_DIRNAME = 'file-artifact-cache';
const INDEX_FILENAME = 'index.json';
const SHARD_REL_RE = /^[a-f0-9]{2}\/[a-f0-9]{64}\.json$/;

export interface FileParseArtifact {
  version: string;
  artifactSchemaVersion: number;
  filePath: string;
  contentHash: string;
  language?: SupportedLanguages | string;
  parserKey?: string;
  payload: ParseWorkerResult;
}

export interface SaveFileParseArtifactInput {
  filePath: string;
  contentHash: string;
  language?: SupportedLanguages | string;
  parserKey?: string;
  payload: ParseWorkerResult;
}

export interface LoadFileParseArtifactInput {
  filePath: string;
  contentHash: string;
  language?: SupportedLanguages | string;
  parserKey?: string;
}

interface FileArtifactCacheIndexEntry {
  filePath: string;
  contentHash: string;
  language?: SupportedLanguages | string;
  parserKey?: string;
  shard: string;
}

interface FileArtifactCacheIndex {
  version: string;
  artifacts: FileArtifactCacheIndexEntry[];
}

const MAP_TAG = '__$mapEntries$__';
const SET_TAG = '__$setValues$__';

const mapReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) return { [MAP_TAG]: Array.from(value.entries()) };
  if (value instanceof Set) return { [SET_TAG]: Array.from(value.values()) };
  return value;
};

const mapReviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v[MAP_TAG])) return new Map(v[MAP_TAG] as [unknown, unknown][]);
    if (Array.isArray(v[SET_TAG])) return new Set(v[SET_TAG] as unknown[]);
  }
  return value;
};

const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');

export const getFileArtifactCacheDir = (storagePath: string): string =>
  path.join(storagePath, CACHE_DIRNAME);

const getIndexPath = (storagePath: string): string =>
  path.join(getFileArtifactCacheDir(storagePath), INDEX_FILENAME);

const artifactKey = (input: LoadFileParseArtifactInput): string =>
  sha256Hex(
    [
      FILE_ARTIFACT_CACHE_VERSION,
      input.filePath,
      input.contentHash,
      input.language ?? '',
      input.parserKey ?? '',
    ].join('\0'),
  );

const shardForKey = (key: string): string => `${key.slice(0, 2)}/${key}.json`;

const shardPath = (storagePath: string, shard: string): string | null => {
  if (!SHARD_REL_RE.test(shard)) return null;
  return path.join(getFileArtifactCacheDir(storagePath), shard);
};

const emptyIndex = (): FileArtifactCacheIndex => ({
  version: FILE_ARTIFACT_CACHE_VERSION,
  artifacts: [],
});

const isIndexEntry = (value: unknown): value is FileArtifactCacheIndexEntry => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.filePath === 'string' &&
    typeof v.contentHash === 'string' &&
    typeof v.shard === 'string' &&
    SHARD_REL_RE.test(v.shard) &&
    (v.language === undefined || typeof v.language === 'string') &&
    (v.parserKey === undefined || typeof v.parserKey === 'string')
  );
};

const isParseWorkerResult = (value: unknown): value is ParseWorkerResult => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.nodes) &&
    Array.isArray(v.relationships) &&
    Array.isArray(v.symbols) &&
    Array.isArray(v.imports) &&
    Array.isArray(v.calls) &&
    Array.isArray(v.assignments) &&
    Array.isArray(v.heritage) &&
    Array.isArray(v.routes) &&
    Array.isArray(v.fetchCalls) &&
    Array.isArray(v.decoratorRoutes) &&
    Array.isArray(v.toolDefs) &&
    Array.isArray(v.ormQueries) &&
    Array.isArray(v.constructorBindings) &&
    Array.isArray(v.fileScopeBindings) &&
    Array.isArray(v.parsedFiles) &&
    typeof v.skippedLanguages === 'object' &&
    v.skippedLanguages !== null &&
    typeof v.fileCount === 'number'
  );
};

const isFileParseArtifact = (value: unknown): value is FileParseArtifact => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === FILE_ARTIFACT_CACHE_VERSION &&
    v.artifactSchemaVersion === FILE_ARTIFACT_SCHEMA_VERSION &&
    typeof v.filePath === 'string' &&
    typeof v.contentHash === 'string' &&
    (v.language === undefined || typeof v.language === 'string') &&
    (v.parserKey === undefined || typeof v.parserKey === 'string') &&
    isParseWorkerResult(v.payload)
  );
};

const loadIndex = async (storagePath: string): Promise<FileArtifactCacheIndex> => {
  try {
    const raw = await fs.readFile(getIndexPath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw) as FileArtifactCacheIndex;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== FILE_ARTIFACT_CACHE_VERSION ||
      !Array.isArray(parsed.artifacts)
    ) {
      return emptyIndex();
    }
    return {
      version: FILE_ARTIFACT_CACHE_VERSION,
      artifacts: parsed.artifacts.filter(isIndexEntry),
    };
  } catch {
    return emptyIndex();
  }
};

const saveIndex = async (storagePath: string, index: FileArtifactCacheIndex): Promise<void> => {
  const cacheDir = getFileArtifactCacheDir(storagePath);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(getIndexPath(storagePath), JSON.stringify(index), 'utf-8');
};

export const loadFileParseArtifact = async (
  storagePath: string,
  input: LoadFileParseArtifactInput,
): Promise<FileParseArtifact | null> => {
  const index = await loadIndex(storagePath);
  const entry = index.artifacts.find(
    (artifact) =>
      artifact.filePath === input.filePath &&
      artifact.contentHash === input.contentHash &&
      (input.language === undefined || artifact.language === input.language) &&
      (input.parserKey === undefined || artifact.parserKey === input.parserKey),
  );
  if (!entry) return null;

  const absShardPath = shardPath(storagePath, entry.shard);
  if (!absShardPath) return null;
  try {
    const raw = await fs.readFile(absShardPath, 'utf-8');
    const parsed = JSON.parse(raw, mapReviver) as FileParseArtifact;
    if (!isFileParseArtifact(parsed)) return null;
    if (parsed.filePath !== input.filePath || parsed.contentHash !== input.contentHash) return null;
    if (input.language !== undefined && parsed.language !== input.language) return null;
    if (input.parserKey !== undefined && parsed.parserKey !== input.parserKey) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveFileParseArtifact = async (
  storagePath: string,
  input: SaveFileParseArtifactInput,
): Promise<FileParseArtifact> => {
  const key = artifactKey(input);
  const shard = shardForKey(key);
  const artifact: FileParseArtifact = {
    version: FILE_ARTIFACT_CACHE_VERSION,
    artifactSchemaVersion: FILE_ARTIFACT_SCHEMA_VERSION,
    filePath: input.filePath,
    contentHash: input.contentHash,
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.parserKey !== undefined ? { parserKey: input.parserKey } : {}),
    payload: input.payload,
  };

  const absShardPath = shardPath(storagePath, shard)!;
  await fs.mkdir(path.dirname(absShardPath), { recursive: true });
  await fs.writeFile(absShardPath, JSON.stringify(artifact, mapReplacer), 'utf-8');

  const index = await loadIndex(storagePath);
  const nextArtifacts = index.artifacts.filter(
    (entry) =>
      !(
        entry.filePath === input.filePath &&
        entry.contentHash === input.contentHash &&
        entry.language === input.language &&
        entry.parserKey === input.parserKey
      ),
  );
  nextArtifacts.push({
    filePath: input.filePath,
    contentHash: input.contentHash,
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.parserKey !== undefined ? { parserKey: input.parserKey } : {}),
    shard,
  });
  await saveIndex(storagePath, { version: FILE_ARTIFACT_CACHE_VERSION, artifacts: nextArtifacts });
  return artifact;
};

export const pruneFileArtifactCache = async (
  storagePath: string,
  liveFileHashes: ReadonlyMap<string, string>,
): Promise<number> => {
  const index = await loadIndex(storagePath);
  const kept: FileArtifactCacheIndexEntry[] = [];
  let removed = 0;

  for (const entry of index.artifacts) {
    if (liveFileHashes.get(entry.filePath) === entry.contentHash) {
      kept.push(entry);
      continue;
    }
    removed++;
    const absShardPath = shardPath(storagePath, entry.shard);
    if (absShardPath) await fs.rm(absShardPath, { force: true });
  }

  await saveIndex(storagePath, { version: FILE_ARTIFACT_CACHE_VERSION, artifacts: kept });
  return removed;
};

export const clearFileArtifactCache = async (storagePath: string): Promise<void> => {
  await fs.rm(getFileArtifactCacheDir(storagePath), { recursive: true, force: true });
};

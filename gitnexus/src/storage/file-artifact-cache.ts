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
import { getLanguageFromFilename, type SupportedLanguages } from 'gitnexus-shared';
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

export interface SaveFileParseArtifactsBatchResult {
  saved: number;
  pruned: number;
}

export interface CapturedFileParseArtifact {
  filePath: string;
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

export type FileParseArtifactLoadMissReason =
  | 'missing-index-entry'
  | 'missing-shard'
  | 'invalid-artifact'
  | 'language-mismatch'
  | 'parser-key-mismatch'
  | 'corrupt-index';

export type LoadFileParseArtifactResult =
  | { status: 'hit'; artifact: FileParseArtifact; recoveredLanguageMetadata: boolean }
  | { status: 'miss'; reason: FileParseArtifactLoadMissReason };

export interface LoadFileParseArtifactsBatchStats {
  artifactLoadMs: number;
  artifactIndexLoadMs: number;
  artifactShardLoadMs: number;
  artifactShardReads: number;
}

export interface LoadFileParseArtifactsBatchResult {
  results: LoadFileParseArtifactResult[];
  stats: LoadFileParseArtifactsBatchStats;
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

const elapsedMs = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1_000_000;

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

const indexLookupKey = (filePath: string, contentHash: string): string => `${filePath}\0${contentHash}`;

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

const emptyParseWorkerResult = (): ParseWorkerResult => ({
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
  fileCount: 0,
});

const ensureSplitPayload = (
  byFile: Map<string, ParseWorkerResult>,
  filePath: string,
): ParseWorkerResult => {
  let payload = byFile.get(filePath);
  if (!payload) {
    payload = emptyParseWorkerResult();
    byFile.set(filePath, payload);
  }
  return payload;
};

const filePathFromNode = (node: ParseWorkerResult['nodes'][number]): string | undefined => {
  const filePath = node.properties?.filePath;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
};

const filePathForEndpoint = (
  nodeFilePaths: ReadonlyMap<string, string>,
  endpointId: string,
): string | undefined => {
  const nodeFilePath = nodeFilePaths.get(endpointId);
  if (nodeFilePath !== undefined) return nodeFilePath;
  return endpointId.startsWith('File:') ? endpointId.slice('File:'.length) : undefined;
};

const pushByFilePath = <T extends { filePath: string }>(
  byFile: Map<string, ParseWorkerResult>,
  items: readonly T[],
  push: (payload: ParseWorkerResult, item: T) => void,
): void => {
  for (const item of items) {
    if (typeof item.filePath !== 'string' || item.filePath.length === 0) continue;
    push(ensureSplitPayload(byFile, item.filePath), item);
  }
};

/**
 * Split worker-batch output into worker-equivalent per-file artifacts.
 *
 * Relationships are retained only when both endpoints resolve to the same file.
 * Cross-file relationships are intentionally skipped because replay will rebuild
 * global import/call/heritage edges from extracted per-file seeds.
 */
export const splitParseWorkerResultsByFile = (
  results: readonly ParseWorkerResult[],
): CapturedFileParseArtifact[] => {
  const byFile = new Map<string, ParseWorkerResult>();

  for (const result of results) {
    const nodeFilePaths = new Map<string, string>();
    for (const node of result.nodes) {
      const filePath = filePathFromNode(node);
      if (!filePath) continue;
      nodeFilePaths.set(node.id, filePath);
      ensureSplitPayload(byFile, filePath).nodes.push(node);
    }

    for (const relationship of result.relationships) {
      const sourceFile = filePathForEndpoint(nodeFilePaths, relationship.sourceId);
      const targetFile = filePathForEndpoint(nodeFilePaths, relationship.targetId);
      if (!sourceFile || sourceFile !== targetFile) continue;
      ensureSplitPayload(byFile, sourceFile).relationships.push(relationship);
    }

    pushByFilePath(byFile, result.symbols, (payload, item) => payload.symbols.push(item));
    pushByFilePath(byFile, result.imports, (payload, item) => payload.imports.push(item));
    pushByFilePath(byFile, result.calls, (payload, item) => payload.calls.push(item));
    pushByFilePath(byFile, result.assignments, (payload, item) => payload.assignments.push(item));
    pushByFilePath(byFile, result.heritage, (payload, item) => payload.heritage.push(item));
    pushByFilePath(byFile, result.routes, (payload, item) => payload.routes.push(item));
    pushByFilePath(byFile, result.fetchCalls, (payload, item) => payload.fetchCalls.push(item));
    pushByFilePath(byFile, result.decoratorRoutes, (payload, item) =>
      payload.decoratorRoutes.push(item),
    );
    pushByFilePath(byFile, result.toolDefs, (payload, item) => payload.toolDefs.push(item));
    pushByFilePath(byFile, result.ormQueries, (payload, item) => payload.ormQueries.push(item));
    pushByFilePath(byFile, result.constructorBindings, (payload, item) =>
      payload.constructorBindings.push(item),
    );
    pushByFilePath(byFile, result.fileScopeBindings, (payload, item) =>
      payload.fileScopeBindings.push(item),
    );
    pushByFilePath(byFile, result.parsedFiles, (payload, item) => payload.parsedFiles.push(item));

    // `skippedLanguages` is batch-level and does not identify specific files,
    // so it cannot be safely assigned to a per-file artifact during splitting.
  }

  return [...byFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([filePath, payload]) => ({
      filePath,
      language: payload.nodes[0]?.properties.language ?? getLanguageFromFilename(filePath),
      payload: {
        ...payload,
        fileCount: 1,
      },
    }));
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

const loadIndexWithReason = async (
  storagePath: string,
): Promise<{ index: FileArtifactCacheIndex } | { reason: 'corrupt-index' }> => {
  try {
    const raw = await fs.readFile(getIndexPath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw) as FileArtifactCacheIndex;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== FILE_ARTIFACT_CACHE_VERSION ||
      !Array.isArray(parsed.artifacts)
    ) {
      return { reason: 'corrupt-index' };
    }
    return {
      index: {
        version: FILE_ARTIFACT_CACHE_VERSION,
        artifacts: parsed.artifacts.filter(isIndexEntry),
      },
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { index: emptyIndex() };
    return { reason: 'corrupt-index' };
  }
};

const saveIndex = async (storagePath: string, index: FileArtifactCacheIndex): Promise<void> => {
  const cacheDir = getFileArtifactCacheDir(storagePath);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(getIndexPath(storagePath), JSON.stringify(index), 'utf-8');
};

const selectCompatibleEntries = (
  indexByFileHash: ReadonlyMap<string, readonly FileArtifactCacheIndexEntry[]>,
  input: LoadFileParseArtifactInput,
):
  | { status: 'entries'; entries: readonly FileArtifactCacheIndexEntry[] }
  | { status: 'miss'; reason: FileParseArtifactLoadMissReason } => {
  const candidates = indexByFileHash.get(indexLookupKey(input.filePath, input.contentHash)) ?? [];
  if (candidates.length === 0) return { status: 'miss', reason: 'missing-index-entry' };

  const languageCompatible = candidates.filter(
    (artifact) =>
      input.language === undefined ||
      artifact.language === undefined ||
      artifact.language === input.language,
  );
  if (languageCompatible.length === 0) return { status: 'miss', reason: 'language-mismatch' };

  const parserCompatible = languageCompatible.filter(
    (artifact) => input.parserKey === undefined || artifact.parserKey === input.parserKey,
  );
  if (parserCompatible.length === 0) return { status: 'miss', reason: 'parser-key-mismatch' };
  return { status: 'entries', entries: parserCompatible };
};

const loadArtifactFromEntries = async (
  storagePath: string,
  input: LoadFileParseArtifactInput,
  entries: readonly FileArtifactCacheIndexEntry[],
): Promise<LoadFileParseArtifactResult> => {
  for (const entry of entries) {
    const absShardPath = shardPath(storagePath, entry.shard);
    if (!absShardPath) continue;
    let parsed: FileParseArtifact;
    try {
      const raw = await fs.readFile(absShardPath, 'utf-8');
      parsed = JSON.parse(raw, mapReviver) as FileParseArtifact;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { status: 'miss', reason: 'missing-shard' };
      return { status: 'miss', reason: 'invalid-artifact' };
    }
    if (!isFileParseArtifact(parsed)) return { status: 'miss', reason: 'invalid-artifact' };
    if (parsed.filePath !== input.filePath || parsed.contentHash !== input.contentHash) {
      return { status: 'miss', reason: 'invalid-artifact' };
    }
    if (
      input.language !== undefined &&
      parsed.language !== undefined &&
      parsed.language !== input.language
    ) {
      return { status: 'miss', reason: 'language-mismatch' };
    }
    if (input.parserKey !== undefined && parsed.parserKey !== input.parserKey) {
      return { status: 'miss', reason: 'parser-key-mismatch' };
    }
    return {
      status: 'hit',
      artifact: parsed,
      recoveredLanguageMetadata: input.language !== undefined && parsed.language === undefined,
    };
  }

  return { status: 'miss', reason: 'missing-shard' };
};

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
};

export const loadFileParseArtifact = async (
  storagePath: string,
  input: LoadFileParseArtifactInput,
): Promise<FileParseArtifact | null> => {
  const result = await loadFileParseArtifactWithReason(storagePath, input);
  return result.status === 'hit' ? result.artifact : null;
};

export const loadFileParseArtifactWithReason = async (
  storagePath: string,
  input: LoadFileParseArtifactInput,
): Promise<LoadFileParseArtifactResult> => {
  const batch = await loadFileParseArtifactsBatchWithReason(storagePath, [input]);
  return batch.results[0] ?? { status: 'miss', reason: 'missing-index-entry' };
};

export const loadFileParseArtifactsBatchWithReason = async (
  storagePath: string,
  inputs: readonly LoadFileParseArtifactInput[],
  options?: { concurrency?: number },
): Promise<LoadFileParseArtifactsBatchResult> => {
  const totalStart = process.hrtime.bigint();
  const indexStart = process.hrtime.bigint();
  const loadedIndex = await loadIndexWithReason(storagePath);
  const artifactIndexLoadMs = elapsedMs(indexStart);
  if ('reason' in loadedIndex) {
    return {
      results: inputs.map(() => ({ status: 'miss', reason: loadedIndex.reason }) as const),
      stats: {
        artifactLoadMs: elapsedMs(totalStart),
        artifactIndexLoadMs,
        artifactShardLoadMs: 0,
        artifactShardReads: 0,
      },
    };
  }

  const indexByFileHash = new Map<string, FileArtifactCacheIndexEntry[]>();
  for (const entry of loadedIndex.index.artifacts) {
    const key = indexLookupKey(entry.filePath, entry.contentHash);
    let entries = indexByFileHash.get(key);
    if (!entries) {
      entries = [];
      indexByFileHash.set(key, entries);
    }
    entries.push(entry);
  }

  const selected = inputs.map((input) => selectCompatibleEntries(indexByFileHash, input));
  const results = new Array<LoadFileParseArtifactResult>(inputs.length);
  let artifactShardReads = 0;
  const shardJobs: Array<{ input: LoadFileParseArtifactInput; entries: readonly FileArtifactCacheIndexEntry[]; index: number }> = [];
  for (let index = 0; index < selected.length; index++) {
    const item = selected[index];
    if (item.status === 'miss') {
      results[index] = { status: 'miss', reason: item.reason };
      continue;
    }
    artifactShardReads++;
    shardJobs.push({ input: inputs[index], entries: item.entries, index });
  }

  const shardStart = process.hrtime.bigint();
  const loadedArtifacts = await mapWithConcurrency(
    shardJobs,
    options?.concurrency ?? 32,
    async (job) => ({ index: job.index, result: await loadArtifactFromEntries(storagePath, job.input, job.entries) }),
  );
  const artifactShardLoadMs = elapsedMs(shardStart);
  for (const loaded of loadedArtifacts) results[loaded.index] = loaded.result;

  return {
    results,
    stats: {
      artifactLoadMs: elapsedMs(totalStart),
      artifactIndexLoadMs,
      artifactShardLoadMs,
      artifactShardReads,
    },
  };
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

export const saveFileParseArtifactsBatch = async (
  storagePath: string,
  inputs: readonly SaveFileParseArtifactInput[],
  liveFileHashes: ReadonlyMap<string, string>,
): Promise<SaveFileParseArtifactsBatchResult> => {
  const index = await loadIndex(storagePath);
  let nextArtifacts = index.artifacts.slice();
  let saved = 0;

  for (const input of inputs) {
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
    nextArtifacts = nextArtifacts.filter(
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
    saved++;
  }

  const kept: FileArtifactCacheIndexEntry[] = [];
  let pruned = 0;
  for (const entry of nextArtifacts) {
    if (liveFileHashes.get(entry.filePath) === entry.contentHash) {
      kept.push(entry);
      continue;
    }
    pruned++;
    const absShardPath = shardPath(storagePath, entry.shard);
    if (absShardPath) await fs.rm(absShardPath, { force: true });
  }

  await saveIndex(storagePath, { version: FILE_ARTIFACT_CACHE_VERSION, artifacts: kept });
  return { saved, pruned };
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

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type {
  BindingRef,
  FinalizedScc,
  FinalizeStats,
  ImportEdge,
  ParsedFile,
  ScopeId,
  SupportedLanguages,
} from 'gitnexus-shared';

const SCOPE_FINALIZE_CACHE_SCHEMA_VERSION = 3;
export const SCOPE_FINALIZE_CACHE_VERSION = String(SCOPE_FINALIZE_CACHE_SCHEMA_VERSION);

const CACHE_DIRNAME = 'scope-finalize-cache';

type SerializedImports = Array<[ScopeId, readonly ImportEdge[]]>;
type SerializedBindings = Array<[ScopeId, Array<[string, readonly BindingRef[]]>]>;

export interface ScopeFinalizeCacheEntry {
  version: string;
  language: SupportedLanguages | string;
  providerId: string;
  resolutionConfigHash: string;
  filePaths: string[];
  surfaceHashes: Record<string, string>;
  semanticSurfaces?: Record<string, SemanticFinalizeSurface>;
  imports: SerializedImports;
  bindings: SerializedBindings;
  sccs: readonly FinalizedScc[];
  stats: FinalizeStats;
}

interface ScopeFinalizeSurfaceHashEntry {
  version: string;
  language: SupportedLanguages | string;
  surfaceHashes: Record<string, string>;
}

export interface ScopeFinalizeCachedOutput {
  imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>;
  bindings: ReadonlyMap<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>;
  sccs: readonly FinalizedScc[];
  stats: FinalizeStats;
}

export interface ScopeFinalizeCacheMetadata {
  language: SupportedLanguages | string;
  providerId: string;
  resolutionConfigHash: string;
  filePaths: string[];
  surfaceHashes: Record<string, string>;
  semanticSurfaces: Record<string, SemanticFinalizeSurface>;
}

export interface SemanticFinalizeSurface {
  filePath: string;
  imports: unknown[];
  moduleVisibleDefs: unknown[];
  counts: {
    imports: number;
    moduleVisibleDefs: number;
    callableSignatures: number;
    typeSignatures: number;
  };
}

export interface ScopeFinalizeCacheHit {
  hit: true;
  output: ScopeFinalizeCachedOutput;
}

export interface ScopeFinalizeCacheMiss {
  hit: false;
  reason: string;
}

export type ScopeFinalizeCacheLoadResult = ScopeFinalizeCacheHit | ScopeFinalizeCacheMiss;

const MAP_TAG = '__$mapEntries$__';
const SET_TAG = '__$setValues$__';

const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Map) return { [MAP_TAG]: Array.from(value.entries()) };
  if (value instanceof Set) return { [SET_TAG]: Array.from(value.values()) };
  return value;
};

const jsonReviver = (_key: string, value: unknown): unknown => {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v[MAP_TAG])) return new Map(v[MAP_TAG] as [unknown, unknown][]);
    if (Array.isArray(v[SET_TAG])) return new Set(v[SET_TAG] as unknown[]);
  }
  return value;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(normalizeForStableJson(value), jsonReplacer);

const normalizeForStableJson = (value: unknown): unknown => {
  if (value instanceof Map) {
    return new Map(
      Array.from(value.entries())
        .map(([k, v]) => [k, normalizeForStableJson(v)] as const)
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  }
  if (value instanceof Set) {
    return new Set(Array.from(value.values()).map(normalizeForStableJson).sort());
  }
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeForStableJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
};

const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');

const cacheFilePath = (storagePath: string, language: SupportedLanguages | string): string =>
  path.join(storagePath, CACHE_DIRNAME, `${String(language).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

const surfaceHashesCacheFilePath = (storagePath: string, language: SupportedLanguages | string): string =>
  path.join(
    storagePath,
    CACHE_DIRNAME,
    `${String(language).replace(/[^a-zA-Z0-9_-]/g, '_')}.surface-hashes.json`,
  );

export const computeScopeFinalizeSurfaceHash = (parsed: ParsedFile): string =>
  sha256Hex(stableJson(computeSemanticFinalizeSurface(parsed)));

export const computeSemanticFinalizeSurface = (parsed: ParsedFile): SemanticFinalizeSurface => {
  const moduleVisibleDefs = collectSemanticModuleSurfaceDefs(parsed);
  return {
    filePath: parsed.filePath,
    imports: [...parsed.parsedImports]
      .map(normalizeParsedImport)
      .sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
    moduleVisibleDefs,
    counts: {
      imports: parsed.parsedImports.length,
      moduleVisibleDefs: moduleVisibleDefs.length,
      callableSignatures: moduleVisibleDefs.filter(isCallableSurfaceDef).length,
      typeSignatures: moduleVisibleDefs.filter(isTypeSurfaceDef).length,
    },
  };
};

export const semanticDefKey = (def: BindingRef['def']): string =>
  stableJson({
    filePath: def.filePath,
    type: def.type,
    qualifiedName: def.qualifiedName,
    parameterCount: def.parameterCount,
    requiredParameterCount: def.requiredParameterCount,
    parameterTypes: def.parameterTypes,
    returnType: def.returnType,
    declaredType: def.declaredType,
    templateArguments: def.templateArguments,
  });

const collectSemanticModuleSurfaceDefs = (parsed: ParsedFile): unknown[] => {
  const moduleScope = parsed.scopes.find((scope) => scope.id === parsed.moduleScope);
  const defs = new Map<string, BindingRef['def']>();
  if (moduleScope !== undefined) {
    const bindingValues = moduleScope.bindings instanceof Map
      ? moduleScope.bindings.values()
      : Object.values(moduleScope.bindings as unknown as Record<string, readonly BindingRef[]>);
    for (const refs of bindingValues) {
      for (const ref of refs) defs.set(semanticDefKey(ref.def), ref.def);
    }
  }
  if (defs.size === 0) {
    for (const def of parsed.localDefs) defs.set(semanticDefKey(def), def);
  }
  const moduleDefs = Array.from(defs.values());
  const surfaceDefs = [
    ...moduleDefs.map(normalizeSurfaceDef),
    ...collectModuleVisibleMemberDefs(parsed, moduleDefs),
  ];
  return surfaceDefs.sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
};

const normalizeSurfaceDef = (def: BindingRef['def']): unknown => ({
  type: def.type,
  qualifiedName: def.qualifiedName,
  parameterCount: def.parameterCount,
  requiredParameterCount: def.requiredParameterCount,
  parameterTypes: def.parameterTypes ?? [],
  returnType: def.returnType,
  declaredType: def.declaredType,
  templateArguments: def.templateArguments ?? [],
});

const collectModuleVisibleMemberDefs = (
  parsed: ParsedFile,
  moduleDefs: readonly BindingRef['def'][],
): unknown[] => {
  const visibleTypeNames = new Set(
    moduleDefs
      .filter(isContainerSurfaceDef)
      .map((def) => def.qualifiedName)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
  if (visibleTypeNames.size === 0) return [];
  const memberDefs: unknown[] = [];
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Class') continue;
    const owner = scope.ownedDefs.find((def) => def.qualifiedName !== undefined && visibleTypeNames.has(def.qualifiedName));
    if (owner?.qualifiedName === undefined) continue;
    for (const def of scope.ownedDefs) {
      if (def === owner || !isMemberSurfaceDef(def)) continue;
      memberDefs.push({ owner: owner.qualifiedName, ...(normalizeSurfaceDef(def) as Record<string, unknown>) });
    }
  }
  return memberDefs;
};

const isContainerSurfaceDef = (def: BindingRef['def']): boolean =>
  def.type === 'Class' || def.type === 'Interface' || def.type === 'Struct' || def.type === 'Enum';

const isMemberSurfaceDef = (def: BindingRef['def']): boolean =>
  def.type === 'Property' || def.type === 'Method' || def.type === 'Constructor';

const normalizeParsedImport = (parsedImport: unknown): unknown => normalizeForStableJson(parsedImport);

const isCallableSurfaceDef = (value: unknown): boolean => {
  const def = value as { type?: unknown };
  return def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor';
};

const isTypeSurfaceDef = (value: unknown): boolean => {
  const def = value as { type?: unknown };
  return def.type === 'Class' || def.type === 'Interface' || def.type === 'Type' || def.type === 'Enum' || def.type === 'Struct' || def.type === 'Union';
};

export const computeResolutionConfigHash = (resolutionConfig: unknown): string =>
  sha256Hex(stableJson(resolutionConfig ?? null));

const serializeImports = (
  imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>,
): SerializedImports => Array.from(imports.entries()).sort(([a], [b]) => a.localeCompare(b));

const serializeBindings = (
  bindings: ReadonlyMap<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>,
): SerializedBindings =>
  Array.from(bindings.entries())
    .map(([scopeId, byName]) => [
      scopeId,
      Array.from(byName.entries()).sort(([a], [b]) => a.localeCompare(b)),
    ] as [ScopeId, Array<[string, readonly BindingRef[]]>])
    .sort(([a], [b]) => a.localeCompare(b));

const deserializeImports = (
  imports: SerializedImports,
): ReadonlyMap<ScopeId, readonly ImportEdge[]> => new Map(imports);

const deserializeBindings = (
  bindings: SerializedBindings,
): ReadonlyMap<ScopeId, ReadonlyMap<string, readonly BindingRef[]>> => {
  const out = new Map<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>();
  for (const [scopeId, entries] of bindings) out.set(scopeId, new Map(entries));
  return out;
};

const isCacheEntry = (value: unknown): value is ScopeFinalizeCacheEntry => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === SCOPE_FINALIZE_CACHE_VERSION &&
    typeof v.language === 'string' &&
    typeof v.providerId === 'string' &&
    typeof v.resolutionConfigHash === 'string' &&
    Array.isArray(v.filePaths) &&
    typeof v.surfaceHashes === 'object' &&
    v.surfaceHashes !== null &&
    Array.isArray(v.imports) &&
    Array.isArray(v.bindings) &&
    Array.isArray(v.sccs) &&
    typeof v.stats === 'object' &&
    v.stats !== null
  );
};

const isSurfaceHashEntry = (value: unknown): value is ScopeFinalizeSurfaceHashEntry => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === SCOPE_FINALIZE_CACHE_VERSION &&
    typeof v.language === 'string' &&
    typeof v.surfaceHashes === 'object' &&
    v.surfaceHashes !== null
  );
};

export const buildScopeFinalizeCacheMetadata = (
  language: SupportedLanguages | string,
  providerId: string,
  resolutionConfigHash: string,
  parsedFiles: readonly ParsedFile[],
): ScopeFinalizeCacheMetadata => {
  const filePaths = parsedFiles.map((f) => f.filePath).sort();
  const surfaceHashes: Record<string, string> = {};
  const semanticSurfaces: Record<string, SemanticFinalizeSurface> = {};
  for (const parsed of parsedFiles) {
    const surface = computeSemanticFinalizeSurface(parsed);
    semanticSurfaces[parsed.filePath] = surface;
    surfaceHashes[parsed.filePath] = sha256Hex(stableJson(surface));
  }
  return { language, providerId, resolutionConfigHash, filePaths, surfaceHashes, semanticSurfaces };
};

export const loadScopeFinalizeCache = async (
  storagePath: string,
  metadata: ScopeFinalizeCacheMetadata,
): Promise<ScopeFinalizeCacheLoadResult> => {
  let entry: ScopeFinalizeCacheEntry;
  try {
    entry = JSON.parse(
      await fs.readFile(cacheFilePath(storagePath, metadata.language), 'utf-8'),
      jsonReviver,
    ) as ScopeFinalizeCacheEntry;
  } catch {
    return { hit: false, reason: 'missing cache' };
  }
  if (!isCacheEntry(entry)) return { hit: false, reason: 'invalid cache' };
  if (entry.language !== metadata.language) return { hit: false, reason: 'language mismatch' };
  if (entry.providerId !== metadata.providerId) return { hit: false, reason: 'provider mismatch' };
  if (entry.resolutionConfigHash !== metadata.resolutionConfigHash) {
    return { hit: false, reason: 'resolution config changed' };
  }
  if (entry.filePaths.length !== metadata.filePaths.length) {
    return { hit: false, reason: 'file set changed' };
  }
  for (let i = 0; i < metadata.filePaths.length; i++) {
    if (entry.filePaths[i] !== metadata.filePaths[i]) return { hit: false, reason: 'file set changed' };
  }
  for (const filePath of metadata.filePaths) {
    if (entry.surfaceHashes[filePath] !== metadata.surfaceHashes[filePath]) {
      return { hit: false, reason: 'finalize surface changed' };
    }
  }
  return {
    hit: true,
    output: {
      imports: deserializeImports(entry.imports),
      bindings: deserializeBindings(entry.bindings),
      sccs: entry.sccs,
      stats: entry.stats,
    },
  };
};

export const loadScopeFinalizeSurfaceHashes = async (
  storagePath: string,
  language: SupportedLanguages | string,
): Promise<Record<string, string> | null> => {
  const mainCachePath = cacheFilePath(storagePath, language);
  const hashCachePath = surfaceHashesCacheFilePath(storagePath, language);
  try {
    const [mainStat, hashStat] = await Promise.all([
      fs.stat(mainCachePath),
      fs.stat(hashCachePath),
    ]);
    if (hashStat.mtimeMs >= mainStat.mtimeMs) {
      const entry = JSON.parse(
        await fs.readFile(hashCachePath, 'utf-8'),
      ) as ScopeFinalizeSurfaceHashEntry;
      if (isSurfaceHashEntry(entry) && entry.language === language) {
        return entry.surfaceHashes;
      }
    }
  } catch {
    // Fall through to the full cache for compatibility with existing indexes.
  }

  try {
    const entry = JSON.parse(
      await fs.readFile(mainCachePath, 'utf-8'),
      jsonReviver,
    ) as ScopeFinalizeCacheEntry;
    if (!isCacheEntry(entry)) return null;
    if (entry.language !== language) return null;
    return entry.surfaceHashes;
  } catch {
    return null;
  }
};

export const loadScopeFinalizeSemanticSurfaces = async (
  storagePath: string,
  language: SupportedLanguages | string,
): Promise<{ hashes: Record<string, string>; surfaces: Record<string, SemanticFinalizeSurface> } | null> => {
  try {
    const entry = JSON.parse(
      await fs.readFile(cacheFilePath(storagePath, language), 'utf-8'),
      jsonReviver,
    ) as ScopeFinalizeCacheEntry;
    if (!isCacheEntry(entry)) return null;
    if (entry.language !== language) return null;
    return { hashes: entry.surfaceHashes, surfaces: entry.semanticSurfaces ?? {} };
  } catch {
    return null;
  }
};

export const saveScopeFinalizeCache = async (
  storagePath: string,
  metadata: ScopeFinalizeCacheMetadata,
  output: ScopeFinalizeCachedOutput,
): Promise<void> => {
  const cachePath = cacheFilePath(storagePath, metadata.language);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const entry: ScopeFinalizeCacheEntry = {
    version: SCOPE_FINALIZE_CACHE_VERSION,
    language: metadata.language,
    providerId: metadata.providerId,
    resolutionConfigHash: metadata.resolutionConfigHash,
    filePaths: metadata.filePaths,
    surfaceHashes: metadata.surfaceHashes,
    semanticSurfaces: metadata.semanticSurfaces,
    imports: serializeImports(output.imports),
    bindings: serializeBindings(output.bindings),
    sccs: output.sccs,
    stats: output.stats,
  };
  await fs.writeFile(`${cachePath}.tmp`, JSON.stringify(entry, jsonReplacer), 'utf-8');
  await fs.rename(`${cachePath}.tmp`, cachePath);

  const hashCachePath = surfaceHashesCacheFilePath(storagePath, metadata.language);
  const hashEntry: ScopeFinalizeSurfaceHashEntry = {
    version: SCOPE_FINALIZE_CACHE_VERSION,
    language: metadata.language,
    surfaceHashes: metadata.surfaceHashes,
  };
  await fs.writeFile(`${hashCachePath}.tmp`, JSON.stringify(hashEntry), 'utf-8');
  await fs.rename(`${hashCachePath}.tmp`, hashCachePath);
};

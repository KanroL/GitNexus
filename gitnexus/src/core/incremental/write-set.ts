import type { FileHashDiff } from '../../storage/file-hash.js';
import type { KnowledgeGraph } from '../graph/types.js';
import { computeEffectiveWriteSet } from './subgraph-extract.js';
import { shadowCandidatesFor } from './shadow-candidates.js';

export const DEFAULT_IMPORTER_BFS_DEPTH = 4;
export const DEFAULT_MAX_EFFECTIVE_WRITE_SET_RATIO = 0.4;
export const DEFAULT_MIN_FILES_FOR_WRITE_SET_RATIO = 20;

export interface IncrementalWriteSetDiagnostics {
  directWriteSetSize: number;
  importerExpandedSetSize: number;
  effectiveWriteSetSize: number;
  deletedFilesSize: number;
  shadowCandidatesSize: number;
  importerExpansionSize: number;
  importerBfsDepth: number;
}

export interface IncrementalWriteSetSuccessPlan {
  mode: 'incremental';
  /** Changed/added files plus importer expansion, before edge-boundary expansion. */
  importerExpandedSet: Set<string>;
  /** Final file set fed to deleteNodesForFile and extractChangedSubgraph. */
  effectiveWriteSet: Set<string>;
  /** Effective write set plus deleted files, deduped, matching prior behavior. */
  filesToDelete: string[];
  /** Shadow seeds derived from added files and present in the prior file set. */
  shadowCandidates: string[];
  diagnostics: IncrementalWriteSetDiagnostics;
}

export interface IncrementalWriteSetFallbackPlan {
  mode: 'full';
  reason: string;
  diagnostics?: Partial<IncrementalWriteSetDiagnostics>;
}

export type IncrementalWriteSetPlan =
  | IncrementalWriteSetSuccessPlan
  | IncrementalWriteSetFallbackPlan;

export interface DeriveIncrementalWriteSetOptions {
  hashDiff: FileHashDiff;
  fullGraph: KnowledgeGraph;
  priorFileHashes?: Readonly<Record<string, string>>;
  queryImporters: (targetFilePath: string) => Promise<string[]>;
  maxImporterBfsDepth?: number;
  maxEffectiveWriteSetRatio?: number;
  minFilesForWriteSetRatio?: number;
}

const countFileNodes = (graph: KnowledgeGraph): number => {
  let count = 0;
  graph.forEachNode((node) => {
    if (node.label === 'File') count++;
  });
  return count;
};

export const deriveIncrementalWriteSet = async ({
  hashDiff,
  fullGraph,
  priorFileHashes,
  queryImporters,
  maxImporterBfsDepth = DEFAULT_IMPORTER_BFS_DEPTH,
  maxEffectiveWriteSetRatio = DEFAULT_MAX_EFFECTIVE_WRITE_SET_RATIO,
  minFilesForWriteSetRatio = DEFAULT_MIN_FILES_FOR_WRITE_SET_RATIO,
}: DeriveIncrementalWriteSetOptions): Promise<IncrementalWriteSetPlan> => {
  const writableFiles = new Set<string>(hashDiff.toWrite);
  const directlyChangedCount = writableFiles.size;

  const priorFileSet = new Set<string>(priorFileHashes ? Object.keys(priorFileHashes) : []);
  const shadowCandidates: string[] = [];
  for (const added of hashDiff.added) {
    for (const cand of shadowCandidatesFor(added)) {
      if (priorFileSet.has(cand) && !writableFiles.has(cand)) {
        shadowCandidates.push(cand);
      }
    }
  }

  let frontier: string[] = [...hashDiff.toWrite, ...hashDiff.deleted, ...shadowCandidates];
  for (let depth = 0; depth < maxImporterBfsDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    for (const f of frontier) {
      try {
        const importers = await queryImporters(f);
        for (const i of importers) {
          if (!writableFiles.has(i)) {
            writableFiles.add(i);
            nextFrontier.push(i);
          }
        }
      } catch {
        return {
          mode: 'full',
          reason: 'importer query failed',
          diagnostics: {
            directWriteSetSize: directlyChangedCount,
            importerExpandedSetSize: writableFiles.size,
            deletedFilesSize: hashDiff.deleted.length,
            shadowCandidatesSize: shadowCandidates.length,
            importerExpansionSize: writableFiles.size - directlyChangedCount,
            importerBfsDepth: maxImporterBfsDepth,
          },
        };
      }
    }
    frontier = nextFrontier;
  }

  if (frontier.length > 0) {
    return {
      mode: 'full',
      reason: 'importer expansion exceeded max depth',
      diagnostics: {
        directWriteSetSize: directlyChangedCount,
        importerExpandedSetSize: writableFiles.size,
        deletedFilesSize: hashDiff.deleted.length,
        shadowCandidatesSize: shadowCandidates.length,
        importerExpansionSize: writableFiles.size - directlyChangedCount,
        importerBfsDepth: maxImporterBfsDepth,
      },
    };
  }

  const importerExpandedSet = new Set<string>(writableFiles);
  const effectiveWriteSet = computeEffectiveWriteSet(fullGraph, importerExpandedSet);
  const filesToDelete = [...new Set([...effectiveWriteSet, ...hashDiff.deleted])];
  const indexedFileCount = Math.max(
    priorFileHashes ? Object.keys(priorFileHashes).length : 0,
    countFileNodes(fullGraph),
  );
  const affectedFileCount = Math.max(effectiveWriteSet.size, filesToDelete.length);
  if (
    indexedFileCount >= minFilesForWriteSetRatio &&
    affectedFileCount / indexedFileCount > maxEffectiveWriteSetRatio
  ) {
    return {
      mode: 'full',
      reason: 'write set exceeds threshold',
      diagnostics: {
        directWriteSetSize: directlyChangedCount,
        importerExpandedSetSize: importerExpandedSet.size,
        effectiveWriteSetSize: effectiveWriteSet.size,
        deletedFilesSize: hashDiff.deleted.length,
        shadowCandidatesSize: shadowCandidates.length,
        importerExpansionSize: importerExpandedSet.size - directlyChangedCount,
        importerBfsDepth: maxImporterBfsDepth,
      },
    };
  }

  return {
    mode: 'incremental',
    importerExpandedSet,
    effectiveWriteSet,
    filesToDelete,
    shadowCandidates,
    diagnostics: {
      directWriteSetSize: directlyChangedCount,
      importerExpandedSetSize: importerExpandedSet.size,
      effectiveWriteSetSize: effectiveWriteSet.size,
      deletedFilesSize: hashDiff.deleted.length,
      shadowCandidatesSize: shadowCandidates.length,
      importerExpansionSize: importerExpandedSet.size - directlyChangedCount,
      importerBfsDepth: maxImporterBfsDepth,
    },
  };
};

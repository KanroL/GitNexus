import { NODE_TABLES } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';

export type GraphWideLabel = 'Community' | 'Process';

export interface IncrementalValidationOperations {
  countNodesForFile: (label: string, filePath: string) => Promise<number>;
  countFileNodes: (filePath: string) => Promise<number>;
  countGraphWideNodes: (label: GraphWideLabel) => Promise<number>;
  countRelationships: () => Promise<number>;
}

export interface IncrementalValidationInput {
  deletedFiles: readonly string[];
  effectiveWriteSet: ReadonlySet<string>;
  fullGraph: KnowledgeGraph;
  finalFileHashes: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  operations: IncrementalValidationOperations;
  fileBoundNodeLabels?: readonly string[];
}

export type IncrementalValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
    };

export const DEFAULT_FILE_BOUND_NODE_LABELS = NODE_TABLES.filter(
  (label) => label !== 'Community' && label !== 'Process',
);

const countGraphNodes = (graph: KnowledgeGraph, label: string): number => {
  let count = 0;
  graph.forEachNode((node) => {
    if (node.label === label) count++;
  });
  return count;
};

const collectGraphFilePaths = (graph: KnowledgeGraph): Set<string> => {
  const out = new Set<string>();
  graph.forEachNode((node) => {
    if (node.label !== 'File') return;
    const filePath = node.properties?.filePath;
    if (typeof filePath === 'string' && filePath.length > 0) out.add(filePath);
  });
  return out;
};

const collectGraphFolderPaths = (graph: KnowledgeGraph): Set<string> => {
  const out = new Set<string>();
  graph.forEachNode((node) => {
    if (node.label !== 'Folder') return;
    const filePath = node.properties?.filePath;
    if (typeof filePath === 'string' && filePath.length > 0) out.add(filePath);
  });
  return out;
};

const collectFolderAncestors = (filePath: string): string[] => {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    ancestors.push(parts.slice(0, i + 1).join('/'));
  }
  return ancestors;
};

const hasHashForPath = (
  hashes: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  filePath: string,
): boolean => (hashes instanceof Map ? hashes.has(filePath) : filePath in hashes);

const failureMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const validateIncrementalGraphConsistency = async ({
  deletedFiles,
  effectiveWriteSet,
  fullGraph,
  finalFileHashes,
  operations,
  fileBoundNodeLabels = DEFAULT_FILE_BOUND_NODE_LABELS,
}: IncrementalValidationInput): Promise<IncrementalValidationResult> => {
  for (const deleted of deletedFiles) {
    if (hasHashForPath(finalFileHashes, deleted)) {
      return { ok: false, reason: `final hashes still contain deleted path ${deleted}` };
    }
  }

  for (const deleted of deletedFiles) {
    for (const label of fileBoundNodeLabels) {
      let count: number;
      try {
        count = await operations.countNodesForFile(label, deleted);
      } catch (err) {
        return {
          ok: false,
          reason: `deleted-file node count query failed for ${deleted} (${label}): ${failureMessage(err)}`,
        };
      }
      if (count > 0) {
        return {
          ok: false,
          reason: `deleted file ${deleted} still has ${count} ${label} node(s)`,
        };
      }
    }
  }

  const graphFolderPaths = collectGraphFolderPaths(fullGraph);
  for (const deleted of deletedFiles) {
    for (const folderPath of collectFolderAncestors(deleted)) {
      if (graphFolderPaths.has(folderPath)) continue;
      let count: number;
      try {
        count = await operations.countNodesForFile('Folder', folderPath);
      } catch (err) {
        return {
          ok: false,
          reason: `deleted-folder node count query failed for ${folderPath}: ${failureMessage(err)}`,
        };
      }
      if (count > 0) {
        return {
          ok: false,
          reason: `deleted file ${deleted} left stale Folder node ${folderPath}`,
        };
      }
    }
  }

  const graphFilePaths = collectGraphFilePaths(fullGraph);
  for (const filePath of effectiveWriteSet) {
    if (!graphFilePaths.has(filePath)) continue;
    let count: number;
    try {
      count = await operations.countFileNodes(filePath);
    } catch (err) {
      return {
        ok: false,
        reason: `File node count query failed for ${filePath}: ${failureMessage(err)}`,
      };
    }
    if (count === 0) {
      return { ok: false, reason: `write-set file ${filePath} is missing its File node` };
    }
  }

  for (const label of ['Community', 'Process'] as const) {
    const expected = countGraphNodes(fullGraph, label);
    let actual: number;
    try {
      actual = await operations.countGraphWideNodes(label);
    } catch (err) {
      return {
        ok: false,
        reason: `${label} count query failed: ${failureMessage(err)}`,
      };
    }
    if (actual !== expected) {
      return { ok: false, reason: `${label} count mismatch: expected ${expected}, got ${actual}` };
    }
  }

  try {
    await operations.countRelationships();
  } catch (err) {
    return {
      ok: false,
      reason: `relationship count query failed: ${failureMessage(err)}`,
    };
  }

  return { ok: true };
};

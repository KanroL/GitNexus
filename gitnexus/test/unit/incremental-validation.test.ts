import { describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  validateIncrementalGraphConsistency,
  type GraphWideLabel,
  type IncrementalValidationOperations,
} from '../../src/core/incremental/validation.js';

const makeGraph = (filePaths: string[] = ['src/a.ts'], graphWide = { Community: 1, Process: 1 }) => {
  const graph = createKnowledgeGraph();
  for (const filePath of filePaths) {
    graph.addNode({
      id: `file:${filePath}`,
      label: 'File',
      properties: { filePath, name: filePath },
    } as unknown as GraphNode);
  }
  for (let i = 0; i < graphWide.Community; i++) {
    graph.addNode({ id: `community:${i}`, label: 'Community', properties: {} } as unknown as GraphNode);
  }
  for (let i = 0; i < graphWide.Process; i++) {
    graph.addNode({ id: `process:${i}`, label: 'Process', properties: {} } as unknown as GraphNode);
  }
  return graph;
};

const makeOps = (
  overrides: Partial<IncrementalValidationOperations> = {},
): IncrementalValidationOperations => ({
  countNodesForFile: async () => 0,
  countFileNodes: async () => 1,
  countGraphWideNodes: async (label: GraphWideLabel) => (label === 'Community' ? 1 : 1),
  countRelationships: async () => 3,
  ...overrides,
});

describe('validateIncrementalGraphConsistency', () => {
  it('passes when deleted files are absent and graph-wide counts match', async () => {
    const result = await validateIncrementalGraphConsistency({
      deletedFiles: ['src/deleted.ts'],
      effectiveWriteSet: new Set(['src/a.ts']),
      fullGraph: makeGraph(['src/a.ts']),
      finalFileHashes: new Map([['src/a.ts', 'hash-a']]),
      operations: makeOps(),
      fileBoundNodeLabels: ['File', 'Function'],
    });

    expect(result).toEqual({ ok: true });
  });

  it('fails when deleted-file nodes remain', async () => {
    const result = await validateIncrementalGraphConsistency({
      deletedFiles: ['src/deleted.ts'],
      effectiveWriteSet: new Set(),
      fullGraph: makeGraph([]),
      finalFileHashes: new Map(),
      operations: makeOps({
        countNodesForFile: async (label) => (label === 'Function' ? 2 : 0),
        countGraphWideNodes: async () => 0,
      }),
      fileBoundNodeLabels: ['File', 'Function'],
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('deleted file src/deleted.ts still has 2 Function');
  });

  it('fails when an expected write-set File node is missing', async () => {
    const result = await validateIncrementalGraphConsistency({
      deletedFiles: [],
      effectiveWriteSet: new Set(['src/a.ts']),
      fullGraph: makeGraph(['src/a.ts'], { Community: 0, Process: 0 }),
      finalFileHashes: new Map([['src/a.ts', 'hash-a']]),
      operations: makeOps({
        countFileNodes: async () => 0,
        countGraphWideNodes: async () => 0,
      }),
      fileBoundNodeLabels: ['File'],
    });

    expect(result).toEqual({ ok: false, reason: 'write-set file src/a.ts is missing its File node' });
  });

  it('fails when Community or Process counts mismatch', async () => {
    const result = await validateIncrementalGraphConsistency({
      deletedFiles: [],
      effectiveWriteSet: new Set(['src/a.ts']),
      fullGraph: makeGraph(['src/a.ts'], { Community: 2, Process: 1 }),
      finalFileHashes: new Map([['src/a.ts', 'hash-a']]),
      operations: makeOps({
        countGraphWideNodes: async (label) => (label === 'Community' ? 1 : 1),
      }),
      fileBoundNodeLabels: ['File'],
    });

    expect(result).toEqual({ ok: false, reason: 'Community count mismatch: expected 2, got 1' });
  });

  it('fails when final hashes still contain deleted paths', async () => {
    const result = await validateIncrementalGraphConsistency({
      deletedFiles: ['src/deleted.ts'],
      effectiveWriteSet: new Set(),
      fullGraph: makeGraph([], { Community: 0, Process: 0 }),
      finalFileHashes: new Map([['src/deleted.ts', 'stale-hash']]),
      operations: makeOps({ countGraphWideNodes: async () => 0 }),
      fileBoundNodeLabels: ['File'],
    });

    expect(result).toEqual({
      ok: false,
      reason: 'final hashes still contain deleted path src/deleted.ts',
    });
  });

  it('fails when the relationship count query fails', async () => {
    const result = await validateIncrementalGraphConsistency({
      deletedFiles: [],
      effectiveWriteSet: new Set(['src/a.ts']),
      fullGraph: makeGraph(['src/a.ts'], { Community: 0, Process: 0 }),
      finalFileHashes: new Map([['src/a.ts', 'hash-a']]),
      operations: makeOps({
        countGraphWideNodes: async () => 0,
        countRelationships: async () => {
          throw new Error('db unavailable');
        },
      }),
      fileBoundNodeLabels: ['File'],
    });

    expect(result).toEqual({
      ok: false,
      reason: 'relationship count query failed: db unavailable',
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { deriveIncrementalWriteSet } from '../../src/core/incremental/write-set.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { FileHashDiff } from '../../src/storage/file-hash.js';

const emptyDiff = (overrides: Partial<FileHashDiff> = {}): FileHashDiff => ({
  changed: [],
  added: [],
  deleted: [],
  toWrite: [],
  ...overrides,
});

const graphWithFiles = (paths: string[] = []) => {
  const graph = createKnowledgeGraph();
  for (const filePath of paths) {
    graph.addNode({
      id: `file:${filePath}`,
      label: 'File',
      properties: { filePath, name: filePath },
    } as unknown as GraphNode);
  }
  return graph;
};

describe('deriveIncrementalWriteSet', () => {
  it('includes changed files in the write set', async () => {
    const plan = await deriveIncrementalWriteSet({
      hashDiff: emptyDiff({ changed: ['src/a.ts'], toWrite: ['src/a.ts'] }),
      fullGraph: graphWithFiles(['src/a.ts']),
      queryImporters: async () => [],
    });

    expect([...plan.effectiveWriteSet]).toEqual(['src/a.ts']);
    expect(plan.diagnostics.directWriteSetSize).toBe(1);
  });

  it('includes added files in the write set', async () => {
    const plan = await deriveIncrementalWriteSet({
      hashDiff: emptyDiff({ added: ['src/new.ts'], toWrite: ['src/new.ts'] }),
      fullGraph: graphWithFiles(['src/new.ts']),
      queryImporters: async () => [],
    });

    expect(plan.effectiveWriteSet.has('src/new.ts')).toBe(true);
  });

  it('uses deleted files for importer lookup without writing them', async () => {
    const queried: string[] = [];
    const plan = await deriveIncrementalWriteSet({
      hashDiff: emptyDiff({ deleted: ['src/deleted.ts'] }),
      fullGraph: graphWithFiles([]),
      queryImporters: async (filePath) => {
        queried.push(filePath);
        return [];
      },
    });

    expect(queried).toEqual(['src/deleted.ts']);
    expect(plan.effectiveWriteSet.has('src/deleted.ts')).toBe(false);
    expect(plan.filesToDelete).toEqual(['src/deleted.ts']);
    expect(plan.diagnostics.deletedFilesSize).toBe(1);
  });

  it('expands the write set with direct importers', async () => {
    const plan = await deriveIncrementalWriteSet({
      hashDiff: emptyDiff({ changed: ['src/provider.ts'], toWrite: ['src/provider.ts'] }),
      fullGraph: graphWithFiles(['src/provider.ts', 'src/consumer.ts']),
      queryImporters: async (filePath) =>
        filePath === 'src/provider.ts' ? ['src/consumer.ts'] : [],
    });

    expect([...plan.importerExpandedSet].sort()).toEqual(['src/consumer.ts', 'src/provider.ts']);
    expect(plan.diagnostics.importerExpansionSize).toBe(1);
  });

  it('expands the write set with transitive importers up to the current depth', async () => {
    const imports = new Map<string, string[]>([
      ['src/provider.ts', ['src/consumer-a.ts']],
      ['src/consumer-a.ts', ['src/consumer-b.ts']],
      ['src/consumer-b.ts', ['src/consumer-c.ts']],
      ['src/consumer-c.ts', ['src/consumer-d.ts']],
    ]);

    const plan = await deriveIncrementalWriteSet({
      hashDiff: emptyDiff({ changed: ['src/provider.ts'], toWrite: ['src/provider.ts'] }),
      fullGraph: graphWithFiles([
        'src/provider.ts',
        'src/consumer-a.ts',
        'src/consumer-b.ts',
        'src/consumer-c.ts',
        'src/consumer-d.ts',
      ]),
      queryImporters: async (filePath) => imports.get(filePath) ?? [],
    });

    expect([...plan.importerExpandedSet].sort()).toEqual([
      'src/consumer-a.ts',
      'src/consumer-b.ts',
      'src/consumer-c.ts',
      'src/consumer-d.ts',
      'src/provider.ts',
    ]);
    expect(plan.diagnostics.importerBfsDepth).toBe(4);
  });

  it('uses shadow candidates from added files to seed importer expansion', async () => {
    const queried: string[] = [];
    const plan = await deriveIncrementalWriteSet({
      hashDiff: emptyDiff({ added: ['src/foo.ts'], toWrite: ['src/foo.ts'] }),
      fullGraph: graphWithFiles(['src/foo.ts', 'src/importer.ts']),
      priorFileHashes: { 'src/foo/index.ts': 'old-hash' },
      queryImporters: async (filePath) => {
        queried.push(filePath);
        return filePath === 'src/foo/index.ts' ? ['src/importer.ts'] : [];
      },
    });

    expect(queried).toContain('src/foo/index.ts');
    expect(plan.shadowCandidates).toContain('src/foo/index.ts');
    expect(plan.importerExpandedSet.has('src/importer.ts')).toBe(true);
    expect(plan.diagnostics.shadowCandidatesSize).toBe(1);
  });

  it('expands effective write set across new graph boundary edges', async () => {
    const graph = graphWithFiles(['src/provider.ts', 'src/consumer.ts']);
    graph.addRelationship({
      id: 'rel:consumer-provider',
      sourceId: 'file:src/consumer.ts',
      targetId: 'file:src/provider.ts',
      type: 'CALLS',
      properties: {},
    } as unknown as GraphRelationship);

    const plan = await deriveIncrementalWriteSet({
      hashDiff: emptyDiff({ changed: ['src/provider.ts'], toWrite: ['src/provider.ts'] }),
      fullGraph: graph,
      queryImporters: async () => [],
    });

    expect([...plan.effectiveWriteSet].sort()).toEqual(['src/consumer.ts', 'src/provider.ts']);
  });
});

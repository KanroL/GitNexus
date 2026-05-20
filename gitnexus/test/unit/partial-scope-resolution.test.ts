import { describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type ReferenceSite,
  type Scope,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { resolveReferenceSites } from '../../src/core/ingestion/resolve-references.js';
import { emitImportEdges } from '../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';
import type { ScopeResolutionIndexes } from '../../src/core/ingestion/model/scope-resolution-indexes.js';

const range = { startLine: 1, startCol: 0, endLine: 1, endCol: 10 };

const moduleScope = (filePath: string): Scope => ({
  id: `scope:${filePath}#1:0-1:10:module`,
  parent: null,
  kind: 'Module',
  range,
  filePath,
  bindings: new Map(),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(),
});

const indexesFor = (
  scopes: Scope[],
  defs: SymbolDefinition[],
  referenceSites: ReferenceSite[],
): ScopeResolutionIndexes => ({
  scopeTree: buildScopeTree(scopes),
  defs: buildDefIndex(defs),
  qualifiedNames: buildQualifiedNameIndex(defs),
  moduleScopes: buildModuleScopeIndex(scopes.map((scope) => ({ filePath: scope.filePath, moduleScopeId: scope.id }))),
  methodDispatch: buildMethodDispatchIndex({ owners: [], computeMro: () => [] }),
  imports: new Map(),
  bindings: new Map(scopes.map((scope) => [scope.id, scope.bindings] as const)),
  bindingAugmentations: new Map(),
  referenceSites,
  sccs: [],
  stats: { totalFiles: scopes.length, totalEdges: 0, linkedEdges: 0, unresolvedEdges: 0, sccCount: 0, largestSccSize: 0 },
});

describe('partial scope resolution', () => {
  it('resolves only selected source files while keeping global targets visible', () => {
    const targetDef: SymbolDefinition = { nodeId: 'Function:src/b.ts:foo', filePath: 'src/b.ts', type: 'Function' };
    const scopeA = moduleScope('src/a.ts');
    const scopeC = moduleScope('src/c.ts');
    const scopeB = moduleScope('src/b.ts');
    const bindings = new Map([['foo', [{ def: targetDef, origin: 'import' as const }]]]);
    const scopedA = { ...scopeA, bindings };
    const scopedC = { ...scopeC, bindings };
    const siteA: ReferenceSite = { name: 'foo', inScope: scopeA.id, kind: 'call', callForm: 'free', atRange: range };
    const siteC: ReferenceSite = { name: 'foo', inScope: scopeC.id, kind: 'call', callForm: 'free', atRange: range };

    const output = resolveReferenceSites({
      scopes: indexesFor([scopedA, scopeB, scopedC], [targetDef], [siteA, siteC]),
      sourceFiles: new Set(['src/a.ts']),
    });

    expect(output.stats.sitesProcessed).toBe(1);
    expect(output.stats.referencesEmitted).toBe(1);
    expect(output.referenceIndex.byTargetDef.get(targetDef.nodeId)).toHaveLength(1);
  });

  it('emits import edges only for selected source files', () => {
    const graph = createKnowledgeGraph();
    const scopeA = moduleScope('src/a.ts');
    const scopeB = moduleScope('src/b.ts');
    const scopeC = moduleScope('src/c.ts');
    const scopeTree = buildScopeTree([scopeA, scopeB, scopeC]);
    const imports = new Map([
      [scopeA.id, [{ localName: 'b', targetFile: 'src/b.ts', targetExportedName: 'b', kind: 'named' as const }]],
      [scopeC.id, [{ localName: 'b', targetFile: 'src/b.ts', targetExportedName: 'b', kind: 'named' as const }]],
    ]);

    const emitted = emitImportEdges(graph, imports, scopeTree, 'test', new Set(['src/a.ts']));

    expect(emitted).toBe(1);
    const relationships = [...graph.iterRelationships()];
    expect(relationships).toHaveLength(1);
    expect(relationships[0].sourceId).toBe('File:src/a.ts');
  });
});

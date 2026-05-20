import { describe, expect, it } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  SupportedLanguages,
  type ReferenceSite,
  type Scope,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { resolveReferenceSites } from '../../src/core/ingestion/resolve-references.js';
import type { PipelineOptions } from '../../src/core/ingestion/pipeline.js';
import { emitImportEdges } from '../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';
import type { ScopeResolver } from '../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';
import { buildPartialScopeResolutionInput } from '../../src/core/ingestion/scope-resolution/pipeline/phase.js';
import type { ScopeResolutionIndexes } from '../../src/core/ingestion/model/scope-resolution-indexes.js';

const range = { startLine: 1, startCol: 0, endLine: 1, endCol: 10 };
const repoPath = '/repo/project';

const partialStats = () => ({
  scopePartialEnabled: false,
  scopePartialAffectedFiles: 0,
  scopePartialRawAffectedFiles: 0,
  scopePartialMatchedAffectedFiles: 0,
  scopePartialUnmatchedAffectedFiles: [] as string[],
  scopeFinalizePatchedFiles: 0,
  scopeFinalizeReusedFiles: 0,
  scopeFinalizePatchEnabled: false,
  scopeReferenceSitesResolved: 0,
  scopeReferenceSitesTotal: 0,
  scopeEmitFiles: 0,
});

const partialOptions = (input: {
  affectedFiles?: Iterable<string>;
  artifactMissFiles?: string[];
  stats?: ReturnType<typeof partialStats>;
}): PipelineOptions => ({
  fileArtifactReplay: {
    storagePath: '/tmp/gitnexus-test',
    currentFileHashes: new Map(),
    freshFiles: new Set(),
    stats: {
      artifactReplayEnabled: true,
      fileArtifactHits: 1,
      fileArtifactMisses: input.artifactMissFiles?.length ?? 0,
      artifactMissFiles: input.artifactMissFiles ?? [],
      replayedFiles: 1,
      freshParsedFiles: input.artifactMissFiles?.length ?? 0,
    },
  },
  partialScopeResolution: {
    enabled: true,
    affectedFiles: new Set(input.affectedFiles ?? []),
    stats: input.stats ?? partialStats(),
  },
});

const tsProvider = { language: SupportedLanguages.TypeScript } as ScopeResolver;

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
  it('includes fresh artifact misses in the partial affected set', () => {
    const stats = partialStats();
    const options = partialOptions({
      affectedFiles: ['src/changed.ts'],
      artifactMissFiles: ['src/fresh.ts', 'src/ignored.py'],
      stats,
    });

    const partial = buildPartialScopeResolutionInput(
      options,
      SupportedLanguages.TypeScript,
      tsProvider,
      [
        { path: 'src/changed.ts', content: '' },
        { path: 'src/fresh.ts', content: '' },
      ],
      true,
    );

    expect(partial?.disabledReason).toBeUndefined();
    expect(partial?.sourceFiles).toEqual(new Set(['src/changed.ts', 'src/fresh.ts']));
    expect(stats.scopePartialEnabled).toBe(true);
    expect(stats.scopePartialAffectedFiles).toBe(2);
    expect(stats.scopePartialRawAffectedFiles).toBe(3);
    expect(stats.scopePartialMatchedAffectedFiles).toBe(2);
    expect(stats.scopePartialUnmatchedAffectedFiles).toEqual(['src/ignored.py']);
  });

  it('matches affected repo-relative paths against parsed file paths', () => {
    const stats = partialStats();
    const partial = buildPartialScopeResolutionInput(
      partialOptions({ affectedFiles: ['./src/changed.ts'], stats }),
      SupportedLanguages.TypeScript,
      tsProvider,
      [{ path: 'src/changed.ts', content: '' }],
      true,
      repoPath,
    );

    expect(partial?.sourceFiles).toEqual(new Set(['src/changed.ts']));
    expect(stats.scopePartialMatchedAffectedFiles).toBe(1);
  });

  it('matches absolute affected paths against parsed file paths', () => {
    const stats = partialStats();
    const partial = buildPartialScopeResolutionInput(
      partialOptions({ affectedFiles: [`${repoPath}/src/changed.ts`], stats }),
      SupportedLanguages.TypeScript,
      tsProvider,
      [{ path: 'src/changed.ts', content: '' }],
      true,
      repoPath,
    );

    expect(partial?.sourceFiles).toEqual(new Set(['src/changed.ts']));
    expect(stats.scopePartialMatchedAffectedFiles).toBe(1);
  });

  it('matches artifact-miss paths for provider language files', () => {
    const stats = partialStats();
    const partial = buildPartialScopeResolutionInput(
      partialOptions({ artifactMissFiles: [`${repoPath}/src/fresh.ts`], stats }),
      SupportedLanguages.TypeScript,
      tsProvider,
      [{ path: 'src/fresh.ts', content: '' }],
      true,
      repoPath,
    );

    expect(partial?.sourceFiles).toEqual(new Set(['src/fresh.ts']));
    expect(stats.scopePartialMatchedAffectedFiles).toBe(1);
  });

  it('falls back when no affected files match provider language files', () => {
    const stats = partialStats();
    const partial = buildPartialScopeResolutionInput(
      partialOptions({ affectedFiles: ['src/changed.py'], stats }),
      SupportedLanguages.TypeScript,
      tsProvider,
      [{ path: 'src/changed.ts', content: '' }],
      true,
      repoPath,
    );

    expect(partial?.disabledReason).toBe('no affected files for language');
    expect(partial?.sourceFiles).toEqual(new Set());
    expect(stats.scopePartialEnabled).toBe(false);
    expect(stats.scopePartialRawAffectedFiles).toBe(1);
    expect(stats.scopePartialMatchedAffectedFiles).toBe(0);
    expect(stats.scopePartialUnmatchedAffectedFiles).toEqual(['src/changed.py']);
  });

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

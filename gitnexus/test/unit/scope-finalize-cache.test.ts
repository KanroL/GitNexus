import { describe, expect, it } from 'vitest';
import type { BindingRef, ParsedFile, Scope, SymbolDefinition } from 'gitnexus-shared';
import { computeScopeFinalizeSurfaceHash } from '../../src/storage/scope-finalize-cache.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { typescriptProvider } from '../../src/core/ingestion/languages/typescript.js';

const range = { startLine: 1, startCol: 0, endLine: 1, endCol: 1 };

const def = (name: string, overrides: Partial<SymbolDefinition> = {}): SymbolDefinition => ({
  nodeId: `Function:src/mod.ts:${name}:1`,
  filePath: 'src/mod.ts',
  type: 'Function',
  qualifiedName: name,
  parameterCount: 0,
  requiredParameterCount: 0,
  ...overrides,
});

const parsed = (input: {
  filePath?: string;
  moduleDefs?: SymbolDefinition[];
  localDefs?: SymbolDefinition[];
  parsedImports?: ParsedFile['parsedImports'];
  referenceSites?: ParsedFile['referenceSites'];
  functionBodyDef?: SymbolDefinition;
}): ParsedFile => {
  const filePath = input.filePath ?? 'src/mod.ts';
  const moduleScopeId = `scope:${filePath}#1:0-1:1:module`;
  const functionScopeId = `scope:${filePath}#2:0-2:1:function`;
  const moduleBindings = new Map<string, readonly BindingRef[]>();
  for (const item of input.moduleDefs ?? []) {
    moduleBindings.set(item.qualifiedName ?? item.nodeId, [{ def: item, origin: 'local' }]);
  }
  const scopes: Scope[] = [
    {
      id: moduleScopeId,
      parent: null,
      kind: 'Module',
      range,
      filePath,
      bindings: moduleBindings,
      ownedDefs: input.moduleDefs ?? [],
      imports: [],
      typeBindings: new Map(),
    },
  ];
  if (input.functionBodyDef !== undefined) {
    scopes.push({
      id: functionScopeId,
      parent: moduleScopeId,
      kind: 'Function',
      range,
      filePath,
      bindings: new Map([[input.functionBodyDef.qualifiedName ?? 'inner', [{ def: input.functionBodyDef, origin: 'local' }]]]),
      ownedDefs: [input.functionBodyDef],
      imports: [],
      typeBindings: new Map(),
    });
  }
  return {
    filePath,
    moduleScope: moduleScopeId,
    scopes,
    parsedImports: input.parsedImports ?? [],
    localDefs: input.localDefs ?? [...(input.moduleDefs ?? []), ...(input.functionBodyDef ? [input.functionBodyDef] : [])],
    referenceSites: input.referenceSites ?? [],
  };
};

const parseTs = (source: string): ParsedFile => {
  const parsedFile = extractParsedFile(typescriptProvider, source, 'src/mod.ts');
  expect(parsedFile).toBeDefined();
  return parsedFile!;
};

const hashTs = (source: string): string => computeScopeFinalizeSurfaceHash(parseTs(source));

describe('scope finalize semantic surface hash', () => {
  it('ignores implementation-only body changes', () => {
    const exported = def('value', { nodeId: 'Function:src/mod.ts:value:1-3' });
    const bodyOnly = def('value', { nodeId: 'Function:src/mod.ts:value:1-10' });

    expect(computeScopeFinalizeSurfaceHash(parsed({ moduleDefs: [exported] }))).toBe(
      computeScopeFinalizeSurfaceHash(parsed({ moduleDefs: [bodyOnly] })),
    );
  });

  it('ignores comments, literals, and local expressions', () => {
    const exported = def('value');
    const base = parsed({ moduleDefs: [exported] });
    const changed = parsed({
      moduleDefs: [exported],
      functionBodyDef: def('localHelper', { qualifiedName: 'localHelper', nodeId: 'Function:src/mod.ts:localHelper:99' }),
      referenceSites: [{ name: 'console', inScope: base.moduleScope, kind: 'read', atRange: range }],
    });

    expect(computeScopeFinalizeSurfaceHash(changed)).toBe(computeScopeFinalizeSurfaceHash(base));
  });

  it('changes on export rename, import addition, and interface/type signature changes', () => {
    const base = parsed({ moduleDefs: [def('value')] });
    expect(computeScopeFinalizeSurfaceHash(parsed({ moduleDefs: [def('renamedValue')] }))).not.toBe(
      computeScopeFinalizeSurfaceHash(base),
    );
    expect(
      computeScopeFinalizeSurfaceHash(
        parsed({
          moduleDefs: [def('value')],
          parsedImports: [{ kind: 'named', localName: 'other', importedName: 'other', targetRaw: './other' }],
        }),
      ),
    ).not.toBe(computeScopeFinalizeSurfaceHash(base));
    expect(
      computeScopeFinalizeSurfaceHash(
        parsed({ moduleDefs: [def('User', { type: 'Interface', qualifiedName: 'User', declaredType: '{ id: string }' })] }),
      ),
    ).not.toBe(
      computeScopeFinalizeSurfaceHash(
        parsed({ moduleDefs: [def('User', { type: 'Interface', qualifiedName: 'User', declaredType: '{ id: number }' })] }),
      ),
    );
  });

  it('keeps real TypeScript body, comment, literal, whitespace, and local rename edits stable', () => {
    const base = `export function value(name: string): string {
  const local = 'one';
  return name + local;
}
`;
    expect(hashTs(`// changed comment
${base}`)).toBe(hashTs(base));
    expect(hashTs(base.replace("'one'", "'two'"))).toBe(hashTs(base));
    expect(hashTs(base.replace('const local', 'const renamed').replace('local;', 'renamed;'))).toBe(hashTs(base));
    expect(hashTs(base.replace('return name + local;', 'return `${name}${local}`;'))).toBe(hashTs(base));
    expect(hashTs(base.replace('  const local', '    const local'))).toBe(hashTs(base));
  });

  it('changes real TypeScript surface for imports, export names, signatures, and type shapes', () => {
    const base = `import { a } from './a';
export function value(name: string): string {
  return name + a();
}
export class User { id = 'x' }
`;
    expect(hashTs(base.replace("{ a }", "{ b as a }"))).not.toBe(hashTs(base));
    expect(hashTs(base.replace('value', 'renamedValue'))).not.toBe(hashTs(base));
    expect(hashTs(base.replace('name: string', 'name: number'))).not.toBe(hashTs(base));
    expect(hashTs(base.replace('id', 'name'))).not.toBe(hashTs(base));
  });
});

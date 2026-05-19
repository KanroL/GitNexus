import { describe, expect, it } from 'vitest';
import { splitFreshAndReplayFiles } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';

const files = (...paths: string[]) => paths.map((path) => ({ path, size: 1 }));

describe('file artifact replay eligibility', () => {
  it('does not require artifacts for added source files', () => {
    const result = splitFreshAndReplayFiles(files('src/existing.ts', 'src/added.ts'), {
      currentFileHashes: new Map([
        ['src/existing.ts', 'same'],
        ['src/added.ts', 'new'],
      ]),
      priorFileHashes: { 'src/existing.ts': 'same' },
      freshFiles: new Set(['src/added.ts']),
    });

    expect(result.freshCandidates.map((file) => file.path)).toEqual(['src/added.ts']);
    expect(result.replayCandidates.map((file) => file.path)).toEqual(['src/existing.ts']);
  });

  it('parses changed source files fresh even when their artifact is absent', () => {
    const result = splitFreshAndReplayFiles(files('src/changed.ts', 'src/unchanged.ts'), {
      currentFileHashes: new Map([
        ['src/changed.ts', 'after'],
        ['src/unchanged.ts', 'same'],
      ]),
      priorFileHashes: {
        'src/changed.ts': 'before',
        'src/unchanged.ts': 'same',
      },
      freshFiles: new Set<string>(),
    });

    expect(result.freshCandidates.map((file) => file.path)).toEqual(['src/changed.ts']);
    expect(result.replayCandidates.map((file) => file.path)).toEqual(['src/unchanged.ts']);
  });

  it('keeps unchanged files in the replay set so missing artifacts disable replay safely', () => {
    const result = splitFreshAndReplayFiles(files('src/unchanged.ts'), {
      currentFileHashes: new Map([['src/unchanged.ts', 'same']]),
      priorFileHashes: { 'src/unchanged.ts': 'same' },
      freshFiles: new Set<string>(),
    });

    expect(result.freshCandidates).toEqual([]);
    expect(result.replayCandidates.map((file) => file.path)).toEqual(['src/unchanged.ts']);
  });
});

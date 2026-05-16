import { describe, expect, it } from 'vitest';
import { deriveIncrementalPlan } from '../../src/core/incremental/plan.js';
import { INCREMENTAL_SCHEMA_VERSION, type RepoMeta } from '../../src/storage/repo-manager.js';

const baseMeta = (overrides: Partial<RepoMeta> = {}): RepoMeta => ({
  repoPath: '/repo',
  lastCommit: 'abc123',
  indexedAt: '2026-05-16T00:00:00.000Z',
  schemaVersion: INCREMENTAL_SCHEMA_VERSION,
  fileHashes: {
    'src/a.ts': 'hash-a',
    'src/b.ts': 'hash-b',
  },
  ...overrides,
});

const validInput = (overrides: Partial<Parameters<typeof deriveIncrementalPlan>[0]> = {}) => ({
  force: false,
  existingMeta: baseMeta(),
  repoHasGit: true,
  allFilePaths: ['src/a.ts', 'src/b.ts'],
  currentFileHashes: new Map<string, string>([
    ['src/a.ts', 'hash-a'],
    ['src/b.ts', 'hash-b'],
  ]),
  ...overrides,
});

describe('deriveIncrementalPlan', () => {
  it('falls back to full rebuild when forced', () => {
    expect(deriveIncrementalPlan(validInput({ force: true }))).toEqual({
      mode: 'full',
      reason: 'forced rebuild',
    });
  });

  it('falls back to full rebuild for dirty recovery', () => {
    expect(
      deriveIncrementalPlan(
        validInput({
          existingMeta: baseMeta({
            incrementalInProgress: { startedAt: 1, toWriteCount: 2 },
          }),
        }),
      ),
    ).toEqual({ mode: 'full', reason: 'dirty recovery' });
  });

  it('falls back to full rebuild when prior hashes are missing', () => {
    expect(
      deriveIncrementalPlan(
        validInput({
          existingMeta: baseMeta({ fileHashes: undefined }),
        }),
      ),
    ).toEqual({ mode: 'full', reason: 'no prior hashes' });
  });

  it('falls back to full rebuild on schema mismatch', () => {
    expect(
      deriveIncrementalPlan(
        validInput({
          existingMeta: baseMeta({ schemaVersion: INCREMENTAL_SCHEMA_VERSION + 1 }),
        }),
      ),
    ).toEqual({ mode: 'full', reason: 'schema mismatch' });
  });

  it('returns an incremental plan with hash diff', () => {
    const plan = deriveIncrementalPlan(
      validInput({
        allFilePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        currentFileHashes: new Map<string, string>([
          ['src/a.ts', 'hash-a'],
          ['src/b.ts', 'hash-b-new'],
          ['src/c.ts', 'hash-c'],
        ]),
      }),
    );

    expect(plan.mode).toBe('incremental');
    if (plan.mode === 'incremental') {
      expect(plan.hashDiff.changed).toEqual(['src/b.ts']);
      expect(plan.hashDiff.added).toEqual(['src/c.ts']);
      expect(plan.hashDiff.deleted).toEqual([]);
    }
  });

  it('returns diagnostics counts for incremental plans', () => {
    const plan = deriveIncrementalPlan(
      validInput({
        allFilePaths: ['src/a.ts', 'src/c.ts'],
        currentFileHashes: new Map<string, string>([
          ['src/a.ts', 'hash-a-new'],
          ['src/c.ts', 'hash-c'],
        ]),
      }),
    );

    expect(plan).toMatchObject({
      mode: 'incremental',
      diagnostics: {
        added: 1,
        modified: 1,
        deleted: 1,
      },
    });
  });
});

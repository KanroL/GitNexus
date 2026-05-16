import { describe, expect, it } from 'vitest';
import {
  calculateStatusChangeStats,
  formatStatusReport,
  getIncrementalEligibility,
} from '../../src/cli/status.js';
import { INCREMENTAL_SCHEMA_VERSION } from '../../src/storage/repo-manager.js';

describe('status change stats', () => {
  it('calculates added, modified, deleted, and unchanged counts', () => {
    const current = new Map<string, string>([
      ['unchanged.ts', 'h1'],
      ['modified.ts', 'h2-new'],
      ['added.ts', 'h4'],
    ]);
    const stored = {
      'unchanged.ts': 'h1',
      'modified.ts': 'h2-old',
      'deleted.ts': 'h3',
    };

    expect(calculateStatusChangeStats(current, stored)).toEqual({
      added: 1,
      modified: 1,
      deleted: 1,
      unchanged: 1,
    });
  });
});

describe('incremental eligibility', () => {
  it('is eligible when schema and hashes are present', () => {
    expect(
      getIncrementalEligibility({
        schemaVersion: INCREMENTAL_SCHEMA_VERSION,
        fileHashes: { 'a.ts': 'h1' },
      }),
    ).toEqual({ eligible: true });
  });

  it('reports fallback reason for dirty recovery', () => {
    const eligibility = getIncrementalEligibility({
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      fileHashes: { 'a.ts': 'h1' },
      incrementalInProgress: { startedAt: 1, toWriteCount: 1 },
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toContain('previous incremental run did not complete');
  });

  it('reports fallback reason for missing hashes', () => {
    const eligibility = getIncrementalEligibility({
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toContain('no stored file hashes');
  });
});

describe('status output formatting', () => {
  it('formats file stats, commits, eligibility, and stale status', () => {
    const lines = formatStatusReport({
      repoPath: '/repo',
      indexedAt: '2026-05-16T10:00:00.000Z',
      indexedCommit: 'abcdef123456',
      currentCommit: '123456abcdef',
      isUpToDate: false,
      changes: { added: 1, modified: 2, deleted: 3, unchanged: 4 },
      incremental: { eligible: false, reason: 'schema mismatch' },
    });

    expect(lines).toContain('Indexed commit: abcdef1');
    expect(lines).toContain('Current commit: 123456a');
    expect(lines).toContain('File changes: 1 added, 2 modified, 3 deleted, 4 unchanged');
    expect(lines).toContain('Incremental: not eligible');
    expect(lines).toContain('Fallback reason: schema mismatch');
    expect(lines).toContain('Status: stale (run gitnexus analyze)');
  });
});

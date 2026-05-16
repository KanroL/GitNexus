import { describe, expect, it } from 'vitest';
import { parseAnalyzeModeOptions, shouldUseIncremental } from '../../src/cli/analyze.js';

describe('analyze --incremental option', () => {
  it('parses --incremental as an explicit opt-in alias', () => {
    expect(parseAnalyzeModeOptions(['--incremental'])).toMatchObject({ incremental: true });
  });

  it('parses --force and --incremental together', () => {
    expect(parseAnalyzeModeOptions(['--incremental', '--force'])).toMatchObject({
      incremental: true,
      force: true,
    });
  });

  it('keeps incremental disabled as an explicit signal when omitted', () => {
    expect(shouldUseIncremental(parseAnalyzeModeOptions([]))).toBe(false);
  });

  it('lets --force override --incremental', () => {
    expect(shouldUseIncremental(parseAnalyzeModeOptions(['--incremental', '--force']))).toBe(false);
  });
});

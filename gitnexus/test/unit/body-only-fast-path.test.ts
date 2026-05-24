import { describe, expect, it } from 'vitest';
import {
  DB_FILE_CONTENT_TRUNCATION_MARKER,
  bodyOnlyContentGuardReason,
  callExpressionSignature,
  isBodyOnlyFastPathLanguage,
} from '../../src/core/incremental/body-only-fast-path.js';

describe('body-only fast path guards', () => {
  it('allows supported TS/JS files with unchanged line and call shape', () => {
    const before = `export function value(): string {
  const msg = 'old token';
  return msg.trim();
}
`;
    const after = `export function value(): string {
  const msg = 'new token';
  return msg.trim();
}
`;

    expect(isBodyOnlyFastPathLanguage('src/value.ts')).toBe(true);
    expect(isBodyOnlyFastPathLanguage('src/value.js')).toBe(true);
    expect(bodyOnlyContentGuardReason('src/value.ts', before, after)).toBeUndefined();
  });

  it('rejects unsupported languages', () => {
    expect(isBodyOnlyFastPathLanguage('src/value.py')).toBe(false);
    expect(bodyOnlyContentGuardReason('src/value.py', 'print("old")\n', 'print("new")\n')).toMatch(
      /unsupported language/,
    );
  });

  it('rejects truncated or oversized content', () => {
    expect(
      bodyOnlyContentGuardReason(
        'src/value.ts',
        `export const value = 'old';${DB_FILE_CONTENT_TRUNCATION_MARKER}`,
        "export const value = 'new';\n",
      ),
    ).toMatch(/truncated or too large/);

    expect(
      bodyOnlyContentGuardReason(
        'src/value.ts',
        "export const value = 'old';\n",
        'x'.repeat(10001),
      ),
    ).toMatch(/truncated or too large/);
  });

  it('rejects line-count changes', () => {
    expect(
      bodyOnlyContentGuardReason(
        'src/value.ts',
        "export const value = 'old';\n",
        "export const value = 'new';\nconsole.log(value);\n",
      ),
    ).toMatch(/line count changed/);
  });

  it('rejects call-expression shape changes while ignoring strings and comments', () => {
    const before = `export function value(): string {
  // fakeCall();
  const text = 'alsoFakeCall()';
  return normalize(text);
}
`;
    const sameCalls = `export function value(): string {
  // changedFakeCall();
  const text = 'otherFakeCall()';
  return normalize(text);
}
`;
    const changedCalls = `export function value(): string {
  // fakeCall();
  const text = 'alsoFakeCall()';
  return format(text);
}
`;

    expect(callExpressionSignature(before)).toBe('value\nnormalize');
    expect(callExpressionSignature(sameCalls)).toBe('value\nnormalize');
    expect(bodyOnlyContentGuardReason('src/value.ts', before, sameCalls)).toBeUndefined();
    expect(bodyOnlyContentGuardReason('src/value.ts', before, changedCalls)).toMatch(
      /call expression surface changed/,
    );
  });
});

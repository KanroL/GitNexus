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

    expect(callExpressionSignature(before)).toBe('value/0\nnormalize/1');
    expect(callExpressionSignature(sameCalls)).toBe('value/0\nnormalize/1');
    expect(bodyOnlyContentGuardReason('src/value.ts', before, sameCalls)).toBeUndefined();
    expect(bodyOnlyContentGuardReason('src/value.ts', before, changedCalls)).toMatch(
      /call expression surface changed/,
    );
  });

  it('allows constructor super message literal changes', () => {
    const before = `export class HTTPError extends Error {
  constructor(response: Response) {
    super(\`Request failed with status code \${response.status}\`);
    this.name = 'HTTPError';
  }
}
`;
    const after = before.replace(
      'Request failed with status code',
      'HTTP request failed with status code',
    );

    expect(callExpressionSignature(before)).toBe('constructor/1\nsuper/1');
    expect(callExpressionSignature(after)).toBe('constructor/1\nsuper/1');
    expect(bodyOnlyContentGuardReason('source/errors/HTTPError.ts', before, after)).toBeUndefined();
  });

  it('rejects call arity changes', () => {
    const before = `export function value(message: string): string {
  return format(message);
}
`;
    const after = `export function value(message: string): string {
  return format(message, 'suffix');
}
`;

    expect(callExpressionSignature(before)).toBe('value/1\nformat/1');
    expect(callExpressionSignature(after)).toBe('value/1\nformat/2');
    expect(bodyOnlyContentGuardReason('src/value.ts', before, after)).toMatch(
      /call expression surface changed/,
    );
  });
});

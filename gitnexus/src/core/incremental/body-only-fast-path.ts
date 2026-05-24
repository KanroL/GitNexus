import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';

export const BODY_ONLY_FAST_PATH_MAX_CHANGED_FILES = 5;
export const DB_FILE_CONTENT_TRUNCATION_MARKER = '\n... [truncated]';
export const DB_FILE_CONTENT_MAX_CHARS = 10000;

const CALL_KEYWORDS = new Set([
  'catch',
  'do',
  'for',
  'function',
  'if',
  'new',
  'return',
  'switch',
  'typeof',
  'while',
]);

export const isBodyOnlyFastPathDisabled = (): boolean =>
  process.env.GITNEXUS_DISABLE_BODY_ONLY_FAST_PATH === '1';

export const isBodyOnlyFastPathLanguage = (filePath: string): boolean => {
  const language = getLanguageFromFilename(filePath);
  return language === SupportedLanguages.TypeScript || language === SupportedLanguages.JavaScript;
};

export const lineCount = (content: string): number => content.split('\n').length;

const stripCommentsAndStrings = (content: string): string => {
  let out = '';
  let state: 'normal' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' =
    'normal';

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (state === 'line-comment') {
      if (ch === '\n') {
        state = 'normal';
        out += '\n';
      } else {
        out += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        out += '  ';
        i++;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'single' || state === 'double' || state === 'template') {
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (ch === '\\') {
        out += ' ';
        if (next !== undefined) {
          out += next === '\n' ? '\n' : ' ';
          i++;
        }
        continue;
      }
      if (ch === quote) state = 'normal';
      out += ch === '\n' ? '\n' : ' ';
      continue;
    }

    if (ch === '/' && next === '/') {
      state = 'line-comment';
      out += '  ';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block-comment';
      out += '  ';
      i++;
      continue;
    }
    if (ch === "'") {
      state = 'single';
      out += '0';
      continue;
    }
    if (ch === '"') {
      state = 'double';
      out += '0';
      continue;
    }
    if (ch === '`') {
      state = 'template';
      out += '0';
      continue;
    }

    out += ch;
  }

  return out;
};

export const callExpressionSignature = (content: string): string => {
  const stripped = stripCommentsAndStrings(content);
  const calls: string[] = [];
  const re = /\b([A-Za-z_$][\w$]*(?:\s*(?:\.|\?\.)\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const raw = match[1] ?? '';
    const normalized = raw.replace(/\s+/g, '').replace(/\?\./g, '.');
    const lastSegment = normalized.split('.').pop() ?? normalized;
    if (!normalized || CALL_KEYWORDS.has(lastSegment)) continue;
    calls.push(`${normalized}/${callArgumentCount(stripped, re.lastIndex - 1)}`);
  }
  return calls.join('\n');
};

const callArgumentCount = (content: string, openParenIndex: number): number => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let count = 0;
  let hasCurrentArgument = false;

  for (let i = openParenIndex + 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') {
      parenDepth++;
      hasCurrentArgument = true;
      continue;
    }
    if (ch === ')') {
      if (parenDepth === 0) {
        return hasCurrentArgument ? count + 1 : count;
      }
      parenDepth--;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      hasCurrentArgument = true;
      continue;
    }
    if (ch === '}') {
      if (braceDepth > 0) braceDepth--;
      continue;
    }
    if (ch === '[') {
      bracketDepth++;
      hasCurrentArgument = true;
      continue;
    }
    if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--;
      continue;
    }
    if (ch === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      if (hasCurrentArgument) count++;
      hasCurrentArgument = false;
      continue;
    }
    if (!/\s/.test(ch)) hasCurrentArgument = true;
  }

  return hasCurrentArgument ? count + 1 : count;
};

export const bodyOnlyContentGuardReason = (
  filePath: string,
  previousDbContent: string,
  currentContent: string,
): string | undefined => {
  if (!isBodyOnlyFastPathLanguage(filePath)) {
    return `unsupported language for ${filePath}`;
  }
  if (
    previousDbContent.endsWith(DB_FILE_CONTENT_TRUNCATION_MARKER) ||
    previousDbContent.length >= DB_FILE_CONTENT_MAX_CHARS ||
    currentContent.length > DB_FILE_CONTENT_MAX_CHARS
  ) {
    return `file content is truncated or too large for ${filePath}`;
  }
  if (lineCount(previousDbContent) !== lineCount(currentContent)) {
    return `line count changed for ${filePath}`;
  }
  if (callExpressionSignature(previousDbContent) !== callExpressionSignature(currentContent)) {
    return `call expression surface changed for ${filePath}`;
  }
  return undefined;
};

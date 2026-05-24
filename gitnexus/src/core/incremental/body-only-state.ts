import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import {
  DB_FILE_CONTENT_MAX_CHARS,
  callExpressionSignature,
  isBodyOnlyFastPathLanguage,
  lineCount,
} from './body-only-fast-path.js';
import { loadMeta } from '../../storage/repo-manager.js';

const BODY_ONLY_STATE_VERSION = 1;
const STATE_DIRNAME = 'incremental';
const STATE_FILENAME = 'body-only-state.json';

export interface BodyOnlyStateEntry {
  contentHash: string;
  lineCount: number;
  callExpressionSignature: string;
  content?: string;
  updatedAt?: string;
}

export interface BodyOnlyState {
  version: number;
  entries: Record<string, BodyOnlyStateEntry>;
}

export interface BodyOnlyContentOverlay {
  filePath: string;
  contentHash: string;
  content: string;
}

const statePath = (storagePath: string): string =>
  path.join(storagePath, STATE_DIRNAME, STATE_FILENAME);

const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');

export const loadBodyOnlyState = async (storagePath: string): Promise<BodyOnlyState | null> => {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(storagePath), 'utf-8')) as BodyOnlyState;
    if (parsed.version !== BODY_ONLY_STATE_VERSION || typeof parsed.entries !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const saveBodyOnlyState = async (
  storagePath: string,
  state: BodyOnlyState,
): Promise<void> => {
  const target = statePath(storagePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(`${target}.tmp`, JSON.stringify(state), 'utf-8');
  await fs.rename(`${target}.tmp`, target);
};

export const bodyOnlyStateEntryForContent = (
  content: string,
  contentHash?: string,
  includeContent = false,
): BodyOnlyStateEntry | undefined => {
  if (content.length > DB_FILE_CONTENT_MAX_CHARS) return undefined;
  return {
    contentHash: contentHash ?? sha256Hex(content),
    lineCount: lineCount(content),
    callExpressionSignature: callExpressionSignature(content),
    ...(includeContent ? { content, updatedAt: new Date().toISOString() } : {}),
  };
};

export const saveMaterializedBodyOnlyStateFromRepo = async (input: {
  repoPath: string;
  storagePath: string;
  filePaths: readonly string[];
  fileHashes: ReadonlyMap<string, string>;
}): Promise<void> => {
  const entries: Record<string, BodyOnlyStateEntry> = {};
  for (const filePath of input.filePaths) {
    if (!isBodyOnlyFastPathLanguage(filePath)) continue;
    const contentHash = input.fileHashes.get(filePath);
    if (!contentHash) continue;
    try {
      const content = await fs.readFile(path.join(input.repoPath, filePath), 'utf-8');
      const entry = bodyOnlyStateEntryForContent(content, contentHash, false);
      if (entry !== undefined) entries[filePath.replace(/\\/g, '/')] = entry;
    } catch {
      // Missing/unreadable files are not eligible for the body-only fast path.
    }
  }
  await saveBodyOnlyState(input.storagePath, { version: BODY_ONLY_STATE_VERSION, entries });
};

export const updateBodyOnlyOverlayState = async (input: {
  storagePath: string;
  updates: readonly { filePath: string; content: string }[];
  fileHashes: ReadonlyMap<string, string>;
}): Promise<void> => {
  const existing = await loadBodyOnlyState(input.storagePath);
  const entries: Record<string, BodyOnlyStateEntry> = { ...(existing?.entries ?? {}) };

  for (const key of Object.keys(entries)) {
    if (!input.fileHashes.has(key)) delete entries[key];
  }

  for (const update of input.updates) {
    const filePath = update.filePath.replace(/\\/g, '/');
    const contentHash = input.fileHashes.get(filePath);
    if (!contentHash) {
      throw new Error(`Missing file hash for body-only overlay update ${filePath}`);
    }
    const entry = bodyOnlyStateEntryForContent(update.content, contentHash, true);
    if (entry === undefined) {
      throw new Error(`Body-only overlay content is too large for ${filePath}`);
    }
    entries[filePath] = entry;
  }

  await saveBodyOnlyState(input.storagePath, { version: BODY_ONLY_STATE_VERSION, entries });
};

export const loadFreshBodyOnlyContentOverlays = async (
  storagePath: string,
): Promise<Map<string, BodyOnlyContentOverlay>> => {
  const [state, meta] = await Promise.all([loadBodyOnlyState(storagePath), loadMeta(storagePath)]);
  const overlays = new Map<string, BodyOnlyContentOverlay>();
  if (!state || !meta?.fileHashes || meta.incrementalInProgress) return overlays;

  for (const [filePath, entry] of Object.entries(state.entries)) {
    if (typeof entry.content !== 'string') continue;
    if (meta.fileHashes[filePath] !== entry.contentHash) continue;
    overlays.set(filePath, {
      filePath,
      contentHash: entry.contentHash,
      content: entry.content,
    });
  }
  return overlays;
};

export const overlayContentForNode = (
  overlay: BodyOnlyContentOverlay | undefined,
  startLine?: unknown,
  endLine?: unknown,
): string | undefined => {
  if (!overlay) return undefined;
  const startLineNumber = Number(startLine);
  const endLineNumber = Number(endLine);
  if (!Number.isFinite(startLineNumber) || !Number.isFinite(endLineNumber)) {
    return overlay.content;
  }
  const lines = overlay.content.split('\n');
  const start = Math.max(0, startLineNumber - 2);
  const end = Math.min(lines.length - 1, endLineNumber + 2);
  return lines.slice(start, end + 1).join('\n');
};

export const contentMatchesSearchQuery = (content: string, query: string): boolean => {
  const normalizedContent = content.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return false;
  if (normalizedContent.includes(normalizedQuery)) return true;
  const terms = normalizedQuery
    .split(/[^a-z0-9_$]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  return terms.length > 0 && terms.every((term) => normalizedContent.includes(term));
};

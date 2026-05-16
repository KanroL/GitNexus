import type { RepoMeta } from '../../storage/repo-manager.js';
import { INCREMENTAL_SCHEMA_VERSION } from '../../storage/repo-manager.js';
import { diffFileHashes, type FileHashDiff } from '../../storage/file-hash.js';

export type IncrementalPlan =
  | {
      mode: 'full';
      reason: string;
    }
  | {
      mode: 'incremental';
      hashDiff: FileHashDiff;
      diagnostics?: {
        added: number;
        modified: number;
        deleted: number;
      };
    };

export interface DeriveIncrementalPlanOptions {
  force?: boolean;
  existingMeta: RepoMeta | null;
  repoHasGit: boolean;
  allFilePaths: readonly string[];
  currentFileHashes: ReadonlyMap<string, string>;
}

export const deriveIncrementalPlan = ({
  force,
  existingMeta,
  repoHasGit,
  allFilePaths,
  currentFileHashes,
}: DeriveIncrementalPlanOptions): IncrementalPlan => {
  if (existingMeta?.incrementalInProgress) {
    return { mode: 'full', reason: 'dirty recovery' };
  }

  if (force) {
    return { mode: 'full', reason: 'forced rebuild' };
  }

  if (!existingMeta) {
    return { mode: 'full', reason: 'no prior metadata' };
  }

  if (existingMeta.schemaVersion !== INCREMENTAL_SCHEMA_VERSION) {
    return { mode: 'full', reason: 'schema mismatch' };
  }

  if (!existingMeta.fileHashes || Object.keys(existingMeta.fileHashes).length === 0) {
    return { mode: 'full', reason: 'no prior hashes' };
  }

  if (!repoHasGit) {
    return { mode: 'full', reason: 'non-git repository' };
  }

  if (allFilePaths.length === 0) {
    return { mode: 'full', reason: 'no file nodes produced' };
  }

  const hashDiff = diffFileHashes(currentFileHashes, existingMeta.fileHashes);
  return {
    mode: 'incremental',
    hashDiff,
    diagnostics: {
      added: hashDiff.added.length,
      modified: hashDiff.changed.length,
      deleted: hashDiff.deleted.length,
    },
  };
};

/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import {
  findRepo,
  getStoragePaths,
  hasKuzuIndex,
  INCREMENTAL_SCHEMA_VERSION,
  type IndexedRepo,
  type RepoMeta,
} from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot } from '../storage/git.js';
import { computeFileHashes, diffFileHashes, type FileHashDiff } from '../storage/file-hash.js';
import { walkRepositoryPaths } from '../core/ingestion/filesystem-walker.js';

export interface StatusChangeStats {
  added: number;
  modified: number;
  deleted: number;
  unchanged: number;
}

export interface IncrementalEligibility {
  eligible: boolean;
  reason?: string;
}

export interface StatusReport {
  repoPath: string;
  indexedAt: string;
  indexedCommit: string;
  currentCommit: string;
  isUpToDate: boolean;
  changes: StatusChangeStats;
  incremental: IncrementalEligibility;
}

export const calculateStatusChangeStats = (
  currentHashes: ReadonlyMap<string, string>,
  storedHashes: Readonly<Record<string, string>> | undefined,
): StatusChangeStats => {
  const diff = diffFileHashes(currentHashes, storedHashes);
  return statusChangeStatsFromDiff(currentHashes.size, diff);
};

const statusChangeStatsFromDiff = (
  currentFileCount: number,
  diff: FileHashDiff,
): StatusChangeStats => ({
  added: diff.added.length,
  modified: diff.changed.length,
  deleted: diff.deleted.length,
  unchanged: Math.max(0, currentFileCount - diff.added.length - diff.changed.length),
});

export const getIncrementalEligibility = (
  meta: Pick<RepoMeta, 'schemaVersion' | 'fileHashes' | 'incrementalInProgress'>,
): IncrementalEligibility => {
  if (meta.incrementalInProgress) {
    return {
      eligible: false,
      reason: 'previous incremental run did not complete; next analyze will run a full rebuild',
    };
  }
  if (meta.schemaVersion !== INCREMENTAL_SCHEMA_VERSION) {
    return {
      eligible: false,
      reason: 'incremental schema version mismatch; next analyze will run a full rebuild',
    };
  }
  if (!meta.fileHashes || Object.keys(meta.fileHashes).length === 0) {
    return {
      eligible: false,
      reason: 'no stored file hashes; next analyze will run a full rebuild',
    };
  }
  return { eligible: true };
};

const shortCommit = (commit: string | undefined): string => (commit ? commit.slice(0, 7) : '(none)');

export const formatStatusReport = (report: StatusReport): string[] => {
  const lines = [
    `Repository: ${report.repoPath}`,
    `Indexed: ${new Date(report.indexedAt).toLocaleString()}`,
    `Indexed commit: ${shortCommit(report.indexedCommit)}`,
    `Current commit: ${shortCommit(report.currentCommit)}`,
    `File changes: ${report.changes.added} added, ${report.changes.modified} modified, ${report.changes.deleted} deleted, ${report.changes.unchanged} unchanged`,
    `Incremental: ${report.incremental.eligible ? 'eligible' : 'not eligible'}`,
  ];
  if (report.incremental.reason) lines.push(`Fallback reason: ${report.incremental.reason}`);
  lines.push(`Status: ${report.isUpToDate ? 'up-to-date' : 'stale (run gitnexus analyze)'}`);
  return lines;
};

export const buildStatusReport = async (repo: IndexedRepo): Promise<StatusReport> => {
  const currentCommit = getCurrentCommit(repo.repoPath);
  const scannedFiles = await walkRepositoryPaths(repo.repoPath);
  const currentHashes = await computeFileHashes(
    repo.repoPath,
    scannedFiles.map((f) => f.path),
  );
  const changes = calculateStatusChangeStats(currentHashes, repo.meta.fileHashes);
  const incremental = getIncrementalEligibility(repo.meta);
  const hasFileChanges = changes.added > 0 || changes.modified > 0 || changes.deleted > 0;

  return {
    repoPath: repo.repoPath,
    indexedAt: repo.meta.indexedAt,
    indexedCommit: repo.meta.lastCommit,
    currentCommit,
    isUpToDate: currentCommit === repo.meta.lastCommit && !hasFileChanges,
    changes,
    incremental,
  };
};

export const statusCommand = async () => {
  const cwd = process.cwd();

  if (!isGitRepo(cwd)) {
    console.log('Not a git repository.');
    return;
  }

  const repo = await findRepo(cwd);
  if (!repo) {
    // Check if there's a stale KuzuDB index that needs migration
    const repoRoot = getGitRoot(cwd) ?? cwd;
    const { storagePath } = getStoragePaths(repoRoot);
    if (await hasKuzuIndex(storagePath)) {
      console.log('Repository has a stale KuzuDB index from a previous version.');
      console.log('Run: gitnexus analyze   (rebuilds the index with LadybugDB)');
    } else {
      console.log('Repository not indexed.');
      console.log('Run: gitnexus analyze');
    }
    return;
  }

  const report = await buildStatusReport(repo);
  for (const line of formatStatusReport(report)) console.log(line);
};

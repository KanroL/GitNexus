import type { KnowledgeGraph } from '../core/graph/types.js';
import { CommunityDetectionResult } from '../core/ingestion/community-processor.js';
import { ProcessDetectionResult } from '../core/ingestion/process-processor.js';
import type { CapturedFileParseArtifact } from '../storage/file-artifact-cache.js';

// CLI-specific: in-memory result with graph + detection results
export interface PipelineResult {
  graph: KnowledgeGraph;
  /** Absolute path to the repo root — used for lazy file reads during LadybugDB loading */
  repoPath: string;
  /** Total files scanned (for stats) */
  totalFileCount: number;
  communityResult?: CommunityDetectionResult;
  processResult?: ProcessDetectionResult;
  /**
   * True if the parse phase spawned a worker pool for this run. False means
   * the sequential fallback handled every chunk. Primarily a test affordance
   * so regression suites can prove which path executed.
   */
  usedWorkerPool: boolean;
  /** Wall-clock duration by ingestion phase, in milliseconds. */
  phaseTimings: Record<string, number>;
  /** Parse/cache counters surfaced for analyze profiling. */
  parseStats: {
    parseCacheHits: number;
    parseCacheMisses: number;
    parsedFiles: number;
    fileArtifactHits: number;
    fileArtifactMisses: number;
    artifactMissFiles?: string[];
    artifactMissReasons?: Record<string, number>;
    freshParseReasons?: Record<string, number>;
    artifactLanguageMetadataRecovered?: number;
    artifactLoadMs?: number;
    artifactIndexLoadMs?: number;
    artifactShardLoadMs?: number;
    artifactShardReads?: number;
    replayedFiles: number;
    workerEligibleFiles: number;
    workerEligibleBytes: number;
    freshParsedFiles: number;
    artifactReplayEnabled: boolean;
    artifactReplayMode?: 'disabled' | 'full' | 'partial';
    artifactReplayDisabledReason?: string;
  };
  scopeStats: {
    preExtractedHits: number;
    preExtractedMisses: number;
    filesExtracted: number;
    filesResolved: number;
    finalizeCacheHits: number;
    finalizeCacheMisses: number;
    finalizeCacheDisabledReason?: string;
    partialEnabled: boolean;
    partialDisabledReason?: string;
    partialAffectedFiles: number;
    partialRawAffectedFiles: number;
    partialMatchedAffectedFiles: number;
    partialUnmatchedAffectedFiles: readonly string[];
    finalizePatchedFiles: number;
    finalizeReusedFiles: number;
    finalizePatchEnabled: boolean;
    finalizePatchDisabledReason?: string;
    referenceSitesResolved: number;
    referenceSitesTotal: number;
    emitFiles: number;
    extractMs: number;
    finalizeMs: number;
    propagateMs: number;
    resolveMs: number;
    emitMs: number;
  };
  /** Worker-equivalent per-file artifacts captured for optional cache persistence. */
  fileParseArtifacts: readonly CapturedFileParseArtifact[];
}

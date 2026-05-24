/**
 * Benchmark full analyze vs incremental analyze on a deterministic TypeScript fixture.
 *
 * Usage:
 *   npm run bench:incremental -- --files 200
 *
 * The script creates a temporary git repo, isolates GITNEXUS_HOME, runs a warmup
 * force analyze, then measures:
 *   - force rebuild baseline
 *   - no-change incremental
 *   - one body-only changed file
 *   - five body-only changed files
 *   - exported surface change in a heavily imported file
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { runFullAnalysis, type AnalyzeOptions, type AnalyzeResult } from '../src/core/run-analyze.js';
import { getStoragePaths } from '../src/storage/repo-manager.js';

interface BenchConfig {
  fileCount: number;
  filesPerDirectory: number;
  keepFixture: boolean;
  workRoot?: string;
}

interface ScenarioResult {
  scenario: string;
  durationMs: number;
  speedupVsFull?: number;
  planMode?: 'full' | 'incremental';
  fallbackReason?: string;
  changed?: number;
  added?: number;
  deleted?: number;
  alreadyUpToDate: boolean;
  stats: AnalyzeResult['stats'];
  profileTimings: Record<string, number>;
  phaseTimings: Record<string, number>;
  parseStats?: Record<string, unknown>;
  scopeStats?: Record<string, unknown>;
  diagnosticLogs: string[];
}

const DEFAULT_FILE_COUNT = 200;
const DEFAULT_FILES_PER_DIRECTORY = 50;

function usage(): string {
  return [
    'Usage: npm run bench:incremental -- [options]',
    '',
    'Options:',
    `  --files <n>              Number of generated TypeScript modules (default ${DEFAULT_FILE_COUNT})`,
    `  --files-per-dir <n>      Modules per generated directory (default ${DEFAULT_FILES_PER_DIRECTORY})`,
    '  --workdir <path>         Directory to create the fixture in (must not already contain the fixture)',
    '  --cleanup                Delete the generated fixture after the run',
    '  --help                   Show this help',
    '',
    'Environment aliases:',
    '  BENCH_FILES=<n>',
  ].join('\n');
}

function parseArgs(argv: string[]): BenchConfig {
  const config: BenchConfig = {
    fileCount: Number(process.env.BENCH_FILES ?? DEFAULT_FILE_COUNT),
    filesPerDirectory: DEFAULT_FILES_PER_DIRECTORY,
    keepFixture: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--files') {
      config.fileCount = Number(argv[++i]);
      continue;
    }
    if (arg === '--files-per-dir') {
      config.filesPerDirectory = Number(argv[++i]);
      continue;
    }
    if (arg === '--workdir') {
      config.workRoot = path.resolve(String(argv[++i]));
      continue;
    }
    if (arg === '--cleanup') {
      config.keepFixture = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (!Number.isInteger(config.fileCount) || config.fileCount < 15) {
    throw new Error('--files must be an integer >= 15 so the five-file scenario is available');
  }
  if (!Number.isInteger(config.filesPerDirectory) || config.filesPerDirectory < 1) {
    throw new Error('--files-per-dir must be a positive integer');
  }
  return config;
}

function toPlatformPath(repoPath: string, relativePath: string): string {
  return path.join(repoPath, ...relativePath.split('/'));
}

function modulePath(index: number, filesPerDirectory: number): string {
  return `src/group${Math.floor(index / filesPerDirectory)}/module${index}.ts`;
}

function relativeImport(fromFile: string, toFile: string): string {
  let rel = path.posix.relative(path.posix.dirname(fromFile), toFile).replace(/\.ts$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function renderSharedFile(extraExport = false): string {
  return [
    'export const sharedVersion = 1;',
    extraExport ? 'export const sharedFeatureFlag = true;' : undefined,
    '',
    'export function sharedOffset(input: number): number {',
    '  return input + sharedVersion;',
    '}',
    '',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function renderModule(index: number, config: BenchConfig, bodyMarker = 0): string {
  const filePath = modulePath(index, config.filesPerDirectory);
  const lines: string[] = [];
  lines.push(`import { sharedOffset, sharedVersion } from '${relativeImport(filePath, 'src/shared.ts')}';`);
  lines.push('');
  lines.push(`export interface Value${index} {`);
  lines.push('  value: number;');
  lines.push('  label: string;');
  lines.push('}');
  lines.push('');
  lines.push(`export function compute${index}(input: number): number {`);
  lines.push(`  const bodyOnlyMarker = ${bodyMarker};`);
  lines.push(`  let total = sharedOffset(input) + bodyOnlyMarker + ${index};`);
  lines.push('  for (let step = 0; step < 3; step++) {');
  lines.push(`    total += (input + step + ${index}) % 7;`);
  lines.push('  }');
  lines.push('  return total;');
  lines.push('}');
  lines.push('');
  lines.push(`export function compose${index}(input: number): number {`);
  lines.push(`  return compute${index}(input) + sharedVersion;`);
  lines.push('}');
  lines.push('');
  lines.push(`export class Worker${index} {`);
  lines.push('  run(value: number): number {');
  lines.push(`    return compose${index}(value);`);
  lines.push('  }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

async function writeFixtureFile(repoPath: string, relativePath: string, content: string): Promise<void> {
  const filePath = toPlatformPath(repoPath, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

async function createFixture(repoPath: string, config: BenchConfig): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await writeFixtureFile(
    repoPath,
    'package.json',
    JSON.stringify({ name: 'gitnexus-incremental-bench', private: true, type: 'module' }, null, 2) + '\n',
  );
  await writeFixtureFile(
    repoPath,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n',
  );
  await writeFixtureFile(repoPath, 'src/shared.ts', renderSharedFile(false));
  for (let i = 0; i < config.fileCount; i++) {
    await writeFixtureFile(repoPath, modulePath(i, config.filesPerDirectory), renderModule(i, config));
  }
}

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
}

function initializeGitRepo(repoPath: string): void {
  runGit(repoPath, ['init', '-q']);
  runGit(repoPath, ['config', 'user.name', 'GitNexus Benchmark']);
  runGit(repoPath, ['config', 'user.email', 'benchmark@gitnexus.local']);
  runGit(repoPath, ['config', 'commit.gpgsign', 'false']);
  runGit(repoPath, ['add', '-A']);
  runGit(repoPath, ['commit', '-q', '-m', 'initial fixture']);
}

async function replaceInFile(repoPath: string, relativePath: string, search: string, replacement: string): Promise<void> {
  const filePath = toPlatformPath(repoPath, relativePath);
  const content = await readFile(filePath, 'utf-8');
  if (!content.includes(search)) {
    throw new Error(`Could not find expected text in ${relativePath}: ${search}`);
  }
  await writeFile(filePath, content.replace(search, replacement), 'utf-8');
}

async function changeModuleBody(repoPath: string, config: BenchConfig, index: number, marker: number): Promise<void> {
  await replaceInFile(
    repoPath,
    modulePath(index, config.filesPerDirectory),
    'const bodyOnlyMarker = 0;',
    `const bodyOnlyMarker = ${marker};`,
  );
}

async function changeSharedExport(repoPath: string): Promise<void> {
  await replaceInFile(
    repoPath,
    'src/shared.ts',
    'export const sharedVersion = 1;\n',
    'export const sharedVersion = 1;\nexport const sharedFeatureFlag = true;\n',
  );
}

function extractMs(line: string): Array<[string, number]> {
  const matches: Array<[string, number]> = [];
  const regex = /\b([A-Za-z][A-Za-z0-9]*)=(-?\d+)ms/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    matches.push([match[1], Number(match[2])]);
  }
  return matches;
}

function parseProfileTimings(logs: string[]): Record<string, number> {
  const timings: Record<string, number> = {};
  for (const raw of logs) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const section = line.slice(0, colon).replace(/\s+/g, '-');
    for (const [key, value] of extractMs(line)) {
      timings[`${section}.${key}`] = value;
    }
  }
  return timings;
}

function parsePlan(logs: string[]): Pick<ScenarioResult, 'planMode' | 'fallbackReason' | 'changed' | 'added' | 'deleted'> {
  const out: Pick<ScenarioResult, 'planMode' | 'fallbackReason' | 'changed' | 'added' | 'deleted'> = {};
  const plan = logs.find((line) => line.startsWith('Incremental plan:'));
  if (plan?.includes('mode=incremental')) {
    out.planMode = 'incremental';
    const match = /changed=(\d+), added=(\d+), deleted=(\d+)/.exec(plan);
    if (match) {
      out.changed = Number(match[1]);
      out.added = Number(match[2]);
      out.deleted = Number(match[3]);
    }
  } else if (plan?.includes('mode=full')) {
    out.planMode = 'full';
    out.fallbackReason = /reason=(.+)$/.exec(plan)?.[1];
  }

  const writeback = logs.find((line) => line.startsWith('Incremental: changed='));
  const writebackMatch = writeback
    ? /changed=(\d+),\s+added=(\d+),\s+deleted=(\d+)/.exec(writeback)
    : null;
  if (writebackMatch) {
    out.changed = Number(writebackMatch[1]);
    out.added = Number(writebackMatch[2]);
    out.deleted = Number(writebackMatch[3]);
  }

  const fallback = logs.find((line) => line.startsWith('Incremental fallback: '));
  if (fallback) {
    out.planMode = 'full';
    out.fallbackReason = fallback.slice('Incremental fallback: '.length);
  }
  return out;
}

function diagnosticLogs(logs: string[]): string[] {
  return logs.filter(
    (line) =>
      line.startsWith('Incremental') ||
      line.startsWith('File artifact replay') ||
      line.startsWith('Analyze profile') ||
      line.startsWith('  '),
  );
}

async function runScenario(
  scenario: string,
  repoPath: string,
  options: AnalyzeOptions,
): Promise<ScenarioResult> {
  const logs: string[] = [];
  const start = performance.now();
  const result = await runFullAnalysis(repoPath, options, {
    onProgress: () => {},
    onLog: (message) => logs.push(message),
  });
  const durationMs = Math.round(performance.now() - start);
  const pipelineResult = result.pipelineResult as
    | {
        phaseTimings?: Record<string, number>;
        parseStats?: Record<string, unknown>;
        scopeStats?: Record<string, unknown>;
      }
    | undefined;
  return {
    scenario,
    durationMs,
    ...parsePlan(logs),
    alreadyUpToDate: result.alreadyUpToDate === true,
    stats: result.stats,
    profileTimings: parseProfileTimings(logs),
    phaseTimings: pipelineResult?.phaseTimings ?? {},
    parseStats: pipelineResult?.parseStats,
    scopeStats: pipelineResult?.scopeStats,
    diagnosticLogs: diagnosticLogs(logs),
  };
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function formatSpeedup(value: number | undefined): string {
  return value === undefined ? '-' : `${value.toFixed(2)}x`;
}

function printTable(results: ScenarioResult[]): void {
  const rows = results.map((result) => ({
    scenario: result.scenario,
    duration: formatMs(result.durationMs),
    speedup: formatSpeedup(result.speedupVsFull),
    mode: result.planMode ?? '-',
    delta: `${result.changed ?? '-'} / ${result.added ?? '-'} / ${result.deleted ?? '-'}`,
    pipeline: formatMs(result.profileTimings['pipeline.total'] ?? result.phaseTimings.total ?? 0),
    hash: formatMs(result.profileTimings['orchestration.hash'] ?? 0),
    plan: formatMs(result.profileTimings['orchestration.incrementalPlanning'] ?? 0),
    guard: formatMs((result.profileTimings['bodyOnlyDb.guardAcquire'] ?? 0) +
      (result.profileTimings['bodyOnlyDb.guardRelease'] ?? 0)),
    db: formatMs(result.profileTimings['db.writeback'] ?? 0),
    body: formatMs(result.profileTimings['bodyOnly.total'] ?? 0),
    classify: formatMs(result.profileTimings['bodyOnly.classify'] ?? 0),
    contentRead: formatMs(result.profileTimings['bodyOnly.contentRead'] ?? 0),
    previousRows: formatMs(result.profileTimings['bodyOnly.previousRows'] ?? 0),
    row: formatMs(result.profileTimings['bodyOnly.rowUpdate'] ?? 0),
    open: formatMs(result.profileTimings['bodyOnlyDb.open'] ?? 0),
    schema: formatMs(result.profileTimings['bodyOnlyDb.schema'] ?? 0),
    ftsLoad: formatMs(result.profileTimings['bodyOnlyDb.ftsLoad'] ?? 0),
    checkpoint: formatMs(result.profileTimings['bodyOnlyDb.checkpoint'] ?? 0),
    close: formatMs((result.profileTimings['bodyOnlyDb.connectionClose'] ?? 0) +
      (result.profileTimings['bodyOnlyDb.databaseClose'] ?? 0) +
      (result.profileTimings['bodyOnlyDb.windowsRelease'] ?? 0)),
    metadata: formatMs(result.profileTimings['postDb.metadata'] ?? 0),
    commProc: formatMs(
      (result.profileTimings['pipeline.communities'] ?? 0) +
        (result.profileTimings['pipeline.processes'] ?? 0),
    ),
    fallback: result.fallbackReason ?? '-',
  }));
  const headers = {
    scenario: 'Scenario',
    duration: 'Duration',
    speedup: 'Speedup',
    mode: 'Mode',
    delta: 'Chg/Add/Del',
    pipeline: 'Pipeline',
    hash: 'Hash',
    plan: 'Plan',
    guard: 'Guard',
    db: 'DB',
    body: 'Body',
    classify: 'Classify',
    contentRead: 'Read',
    previousRows: 'Prev',
    row: 'Row',
    open: 'Open',
    schema: 'Schema',
    ftsLoad: 'FTSLoad',
    checkpoint: 'Ckpt',
    close: 'Close',
    metadata: 'Meta',
    commProc: 'Comm+Proc',
    fallback: 'Fallback',
  };
  const widths = Object.fromEntries(
    Object.keys(headers).map((key) => [
      key,
      Math.max(headers[key as keyof typeof headers].length, ...rows.map((row) => row[key as keyof typeof row].length)),
    ]),
  ) as Record<keyof typeof headers, number>;
  const formatRow = (row: typeof headers | (typeof rows)[number]) =>
    Object.keys(headers)
      .map((key) => String(row[key as keyof typeof row]).padEnd(widths[key as keyof typeof widths]))
      .join('  ');

  console.log(formatRow(headers));
  console.log(Object.keys(headers).map((key) => '-'.repeat(widths[key as keyof typeof widths])).join('  '));
  for (const row of rows) console.log(formatRow(row));
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const workRoot =
    config.workRoot ?? (await mkdtemp(path.join(os.tmpdir(), 'gitnexus-incremental-bench-')));
  const repoPath = path.join(workRoot, 'fixture');
  const gitnexusHome = path.join(workRoot, 'gitnexus-home');
  const registryName = `gitnexus-bench-${Date.now()}`;

  process.env.GITNEXUS_HOME = gitnexusHome;
  process.env.GITNEXUS_VERBOSE = '1';

  console.log(`Generating fixture: ${config.fileCount} TypeScript modules`);
  console.log(`Fixture root: ${repoPath}`);
  await createFixture(repoPath, config);
  initializeGitRepo(repoPath);

  const analyzeOptions: AnalyzeOptions = {
    skipAgentsMd: true,
    skipSkills: true,
    noStats: true,
    dropEmbeddings: true,
    registryName,
    allowDuplicateName: true,
  };

  console.log('\nWarmup: force analyze to populate metadata and caches...');
  const warmup = await runScenario('warmup force analyze', repoPath, {
    ...analyzeOptions,
    force: true,
  });
  console.log(`Warmup completed in ${formatMs(warmup.durationMs)}\n`);

  const results: ScenarioResult[] = [];

  results.push(
    await runScenario('full rebuild (--force)', repoPath, {
      ...analyzeOptions,
      force: true,
    }),
  );

  results.push(
    await runScenario('no-change incremental', repoPath, {
      ...analyzeOptions,
      incremental: true,
    }),
  );

  await changeModuleBody(repoPath, config, 0, 1);
  results.push(
    await runScenario('1 body-only file', repoPath, {
      ...analyzeOptions,
      incremental: true,
    }),
  );

  for (const index of [10, 11, 12, 13, 14].filter((value) => value < config.fileCount)) {
    await changeModuleBody(repoPath, config, index, 5);
  }
  results.push(
    await runScenario('5 body-only files', repoPath, {
      ...analyzeOptions,
      incremental: true,
    }),
  );

  await changeSharedExport(repoPath);
  results.push(
    await runScenario('shared export change', repoPath, {
      ...analyzeOptions,
      incremental: true,
    }),
  );

  const fullDuration = results[0]?.durationMs;
  if (fullDuration !== undefined && fullDuration > 0) {
    for (const result of results) {
      result.speedupVsFull = fullDuration / result.durationMs;
    }
  }

  console.log('\nIncremental performance benchmark');
  console.log(`Files: ${config.fileCount}`);
  console.log('Delta column is changed / added / deleted files.');
  printTable(results);

  const outputPath = path.join(getStoragePaths(repoPath).storagePath, 'benchmarks', 'incremental-performance.json');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config,
        repoPath,
        gitnexusHome,
        warmup,
        results,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  console.log(`\nWrote JSON results: ${outputPath}`);
  console.log(`Scale up with: npm run bench:incremental -- --files 500`);

  if (!config.keepFixture) {
    await rm(workRoot, { recursive: true, force: true });
    console.log('Removed generated fixture (--cleanup).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

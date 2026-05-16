# AGENTS.md

Agent-facing guidance for working in the GitNexus repository. Keep changes small, preserve graph correctness, and prefer explicit validation over assumptions.

## Environment

- Assume a Linux or POSIX-like development environment. CI and local development primarily run on Linux.
- Use Node.js and npm for the TypeScript packages. Install dependencies from the relevant package directory before running package scripts.
- The core CLI and indexing code live under `gitnexus/` and are written in TypeScript.
- Tests use Vitest. Prefer package scripts over invoking test internals directly.
- LadybugDB is the persistence layer for graph data. Treat database writes, dirty flags, metadata, and recovery paths as correctness-sensitive.
- Kuzu-related graph behavior should preserve existing schema assumptions and query compatibility.
- Native dependencies and parser packages may require standard build tools such as `python3`, `make`, and `g++` during install.

## Build And Run

Run commands from the package directory shown unless noted otherwise.

- Install CLI/core dependencies: `cd gitnexus && npm install`
- Build CLI/core: `cd gitnexus && npm run build`
- Run a full analyze from a repository root: `npx gitnexus analyze --force`
- Run incremental analyze from a repository root: `npx gitnexus analyze`
- Run all CLI/core tests: `cd gitnexus && npm test`
- Run CLI/core unit tests: `cd gitnexus && npm run test:unit`
- Run CLI/core integration tests: `cd gitnexus && npm run test:integration`
- Typecheck CLI/core: `cd gitnexus && npx tsc --noEmit`
- Run Web UI tests when touching `gitnexus-web/`: `cd gitnexus-web && npm test`
- Typecheck Web UI when touching `gitnexus-web/`: `cd gitnexus-web && npx tsc -b --noEmit`

## Repository Architecture

- CLI layer: `gitnexus/` contains the command-line entry points, user-facing commands, MCP server, and orchestration for repository analysis.
- Ingestion pipeline: source files are parsed, language providers extract symbols and relationships, call resolution runs, and graph-ready records are produced.
- Graph construction: symbol, relationship, execution-flow, API, and metadata records must remain deterministic across equivalent full and incremental runs.
- LadybugDB adapter: persistence code writes graph rows, metadata, dirty state, and incremental updates. Preserve atomicity and recovery behavior.
- Incremental indexing components: change detection, importer invalidation, retained unchanged rows, dirty flag recovery, and writeback logic work together to avoid unnecessary full rewrites.
- Parse cache: tree-sitter parse output is cached by content/version so unchanged file parsing can be reused safely.
- Metadata persistence: `.gitnexus/meta.json` and related database metadata track stats, versions, embeddings state, and recovery information.

## Coding Guidelines

- Preserve graph consistency above performance optimizations. If correctness is uncertain, fall back to a full rebuild path.
- Prefer additive, minimal changes that keep existing behavior stable.
- Do not break graph schema compatibility unless the change includes an intentional schema version migration.
- Preserve deterministic graph generation. Equivalent inputs should produce equivalent nodes, relationships, IDs, ordering, and metadata.
- Avoid changing node IDs unless the change explicitly requires a new identity model or schema migration.
- Keep language-specific behavior in language providers or scoped hooks, not shared ingestion code.
- Maintain importer invalidation and dependency propagation when changing symbol, import, or relationship extraction.
- Keep database dirty flags, validation, and recovery paths intact when changing writeback behavior.

## Testing Guidelines

- Use Vitest for TypeScript tests.
- Add unit tests for incremental helpers, cache-key logic, invalidation decisions, metadata updates, and dirty flag recovery when those areas change.
- Add integration tests that compare incremental output with full rebuild output for changes that affect graph construction or persistence.
- Avoid flaky timing-based tests. Prefer deterministic fixtures, explicit file contents, controlled clocks, and direct assertions.
- When modifying graph generation, assert both nodes and relationships where possible.
- When modifying fallback behavior, test the fallback trigger and the resulting full rebuild correctness.

## Incremental Indexing Notes

- The current architecture performs full in-memory recomputation while using incremental database writeback for changed files and affected importers.
- Importer invalidation exists and must be preserved when changing import resolution, symbol references, or dependency edges.
- Parse cache exists and should remain content-addressed and version-aware so stale parser output is not reused incorrectly.
- Graph validation should be preserved. Do not bypass validation to make incremental paths faster.
- Dirty flag recovery exists to protect against interrupted writes. Preserve dirty marking before risky writes and cleanup after successful writes.
- Incremental results should remain equivalent to a full rebuild. If equivalence cannot be guaranteed, use a documented full rebuild fallback.

## Documentation Expectations

- Document fallback conditions when adding or changing incremental behavior.
- Document schema version changes, migration requirements, and compatibility implications.
- Explain graph consistency assumptions in nearby code comments when the invariant is not obvious from the implementation.
- Keep command documentation aligned with actual npm scripts and CLI behavior.
- Update architecture notes when changing ingestion, graph construction, persistence, parse cache, or incremental indexing behavior.

# integration-commoncrawl

## Purpose

Common Crawl hyperlink-graph backlinks extractor. Downloads the domain-level vertex + edge gzip files that Common Crawl publishes quarterly, runs a multi-target DuckDB query over them, and returns backlink rows ready to persist into SQLite. DuckDB is an **opt-in plugin** installed at runtime into `~/.canonry/plugins/` — it is not a canonry dependency.

## Key Files

| File | Role |
|------|------|
| `src/constants.ts` | `CC_BASE_URL`, `PLUGIN_DIR`, `DUCKDB_SPEC`, release-slug regex |
| `src/release-id.ts` | `isValidReleaseId()` validator |
| `src/release-discovery.ts` | `probeLatestRelease()` — HEAD-probes quarterly slugs |
| `src/reverse-domain.ts` | `reverseDomain()` / `forwardDomain()` — `roots.io` ↔ `io.roots` |
| `src/downloader.ts` | Streaming download with SHA-256 + sidecar cache + atomic rename |
| `src/plugin-resolver.ts` | `loadDuckdb()` via `createRequire` against the plugin dir; throws `MISSING_DEPENDENCY` |
| `src/plugin-installer.ts` | `installDuckdb()` — spawns `npm install` into the plugin dir |
| `src/duckdb-query.ts` | `queryBacklinks()` — multi-target join over cached gzip files |
| `src/types.ts` | `BacklinkRow`, `ReleasePaths` |
| `src/index.ts` | Barrel |

## Patterns

### Opt-in DuckDB

- `@duckdb/node-api` is **not** a canonry dependency. It ships as a devDependency in this package so unit tests can exercise the query path, and is bundled as `external` by canonry's tsup config.
- Runtime resolution goes through `loadDuckdb()`, which calls `createRequire` against `~/.canonry/plugins/package.json`. If the module is absent, `loadDuckdb()` throws `missingDependency()` with a hint pointing at `canonry backlinks install`.
- The installer (`installDuckdb()`) spawns `npm install @duckdb/node-api@<DUCKDB_SPEC> --prefix ~/.canonry/plugins/`. Override the version via `CANONRY_DUCKDB_SPEC`.

### Releases

- Common Crawl publishes ~quarterly: `cc-main-YYYY-{jan-feb-mar,apr-may-jun,jul-aug-sep,oct-nov-dec}`.
- Files live at `https://data.commoncrawl.org/projects/hyperlinkgraph/<release>/domain/<release>-domain-{vertices,edges}.txt.gz` (verified 2026-04).
- `probeLatestRelease()` issues HEAD requests working backward from the current quarter to find the newest published release.

### Downloads

- Gzip files are large (vertices ~4 GB, edges ~13 GB). Never buffer whole files in memory.
- Downloads write to `<dest>.partial` first, then atomic-rename on success.
- A sidecar `<dest>.sha256` file is written after a successful fresh download so subsequent cache hits skip the multi-second re-hash.
- `stream/promises.pipeline()` is used to avoid accumulating per-chunk `error` listeners.

### DuckDB query

- Uses `DuckDBInstance.create(':memory:')` — DuckDB is an ephemeral query engine over the CSVs, not a persistent database.
- Target list is bound via a prepared statement (no string interpolation into the SQL) to avoid injection if a project's canonical domain ever contains quotes.
- Returned rows are already in **forward** domain form (`reddit.com`, not `com.reddit`), ready to persist.

## Common Mistakes

- **Importing `@duckdb/node-api` directly** at the top of a module — it must be resolved via `loadDuckdb()` so the missing-dependency path works.
- **Adding `@duckdb/node-api` to canonry's `dependencies`** — it is an opt-in plugin. It belongs in this package's `devDependencies` (for tests) and in canonry's tsup `external` list.
- **Assuming cached files are valid** — always check the `.sha256` sidecar; fall back to re-hashing if the sidecar is missing or mismatched.

## See Also

- `.context/commoncrawl-spike/` — standalone spike that validated the architecture against real Common Crawl data (2026-04)
- `packages/canonry/src/commoncrawl-sync.ts` — orchestrator that calls into this package for the workspace-wide release sync
- `packages/canonry/src/backlink-extract.ts` — per-project extract runner

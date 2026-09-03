import { defineConfig } from 'tsup'
import { readGitCommit } from './scripts/build-commit.js'

// Stamp the build's git commit into the bundle; GET /health reports it as
// `commit`. Omitted, never fatal, when git or the repository is absent: the
// server then falls back to CANONRY_COMMIT at runtime.
const buildCommit = readGitCommit()

export default defineConfig({
  define: buildCommit ? { __CANONRY_BUILD_COMMIT__: JSON.stringify(buildCommit) } : {},
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    mcp: 'src/mcp/cli.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: true,
  clean: true,
  dts: {
    entry: { index: 'src/index.ts' },
    // tsup's DTS step invokes tsc internally; `incremental` inherited from
    // tsconfig.base.json triggers TS5074 here because there's no emit target
    // and no tsBuildInfoFile in this path. Force it off — typecheck still
    // benefits from incremental via the standalone `tsc --noEmit` script.
    compilerOptions: { incremental: false },
  },
  // Real npm deps — keep as external (installed by end user)
  external: [
    'better-sqlite3',
    'drizzle-orm',
    'fastify',
    // api-routes registers this at runtime. Its CommonJS graph requires
    // node:net dynamically, which an ESM bundle cannot emulate safely.
    '@fastify/rate-limit',
    '@fastify/static',
    'openai',
    '@google/genai',
    '@anthropic-ai/sdk',
    'node-cron',
    // Publish-time Site Health layout runs in a worker and resolves these
    // pinned packages through createRequire. Keep them external in the npm
    // artifact so the worker receives real filesystem module paths.
    'graphology',
    'graphology-layout-forceatlas2',
    // cron-parser computes the scheduler's nextRunAt (node-cron's own
    // getNextRun() is broken for weekday crons). Keep external in lockstep
    // with the entry in `packages/canonry/package.json`.
    'cron-parser',
    'yaml',
    'pino-pretty',
    'zod',
    'pino',
    // undici has internal `require('node:assert')` / dynamic requires that
    // tsup's ESM bundler turns into the `Dynamic require of "assert" is not
    // supported` error at runtime. Resolve it from node_modules at runtime
    // — must stay in lockstep with the entry in `packages/canonry/package.json`.
    'undici',
    // Opt-in plugin resolved at runtime via createRequire against ~/.canonry/plugins/
    '@duckdb/node-api',
  ],
  // Workspace packages — bundle into dist/
  noExternal: [
    '@ainyc/canonry-api-client',
    '@ainyc/canonry-contracts',
    '@ainyc/canonry-config',
    '@ainyc/canonry-db',
    '@ainyc/canonry-intelligence',
    '@ainyc/canonry-api-routes',
    '@ainyc/canonry-provider-gemini',
    '@ainyc/canonry-provider-openai',
    '@ainyc/canonry-provider-claude',
    '@ainyc/canonry-provider-local',
    '@ainyc/canonry-provider-cdp',
    '@ainyc/canonry-provider-perplexity',
    '@ainyc/canonry-integration-google',
    '@ainyc/canonry-integration-google-ads',
    '@ainyc/canonry-integration-google-tag-manager',
    '@ainyc/canonry-integration-bing',
    '@ainyc/canonry-integration-cloudflare-queue',
    '@ainyc/canonry-integration-cloudflare-worker',
    '@ainyc/canonry-integration-commoncrawl',
  ],
})

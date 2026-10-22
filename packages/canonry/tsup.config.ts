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
    // benefits from incremental via the standalone `typecheck` script.
    compilerOptions: {
      incremental: false,
      // Resolve private workspace types as source so declarations are bundled,
      // rather than requiring unpublished packages in consumer installations.
      rootDir: '../..',
      paths: { '@canonry/canonry-*': ['../*/src/index.ts'] },
    },
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
    '@canonry/canonry-api-client',
    '@canonry/canonry-contracts',
    '@canonry/canonry-config',
    '@canonry/canonry-db',
    '@canonry/canonry-intelligence',
    '@canonry/canonry-api-routes',
    '@canonry/canonry-provider-gemini',
    '@canonry/canonry-provider-openai',
    '@canonry/canonry-provider-openrouter',
    '@canonry/canonry-provider-claude',
    '@canonry/canonry-provider-local',
    '@canonry/canonry-provider-cdp',
    '@canonry/canonry-provider-perplexity',
    '@canonry/canonry-provider-muse',
    '@canonry/canonry-integration-google',
    '@canonry/canonry-integration-google-ads',
    '@canonry/canonry-integration-google-tag-manager',
    '@canonry/canonry-integration-bing',
    '@canonry/canonry-integration-typesafe',
    '@canonry/canonry-integration-cloudflare-queue',
    '@canonry/canonry-integration-cloudflare-worker',
    '@canonry/canonry-integration-commoncrawl',
  ],
})

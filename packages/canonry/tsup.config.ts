import { defineConfig } from 'tsup'

export default defineConfig({
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
  dts: { entry: { index: 'src/index.ts' } },
  // Real npm deps — keep as external (installed by end user)
  external: [
    'better-sqlite3',
    'drizzle-orm',
    'fastify',
    '@fastify/static',
    'openai',
    '@google/genai',
    '@anthropic-ai/sdk',
    'node-cron',
    'yaml',
    'pino-pretty',
    'zod',
    'pino',
    // Opt-in plugin resolved at runtime via createRequire against ~/.canonry/plugins/
    '@duckdb/node-api',
  ],
  // Workspace packages — bundle into dist/
  noExternal: [
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
    '@ainyc/canonry-integration-bing',
    '@ainyc/canonry-integration-commoncrawl',
  ],
})

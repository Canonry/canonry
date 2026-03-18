import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
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
    '@google/generative-ai',
    '@anthropic-ai/sdk',
    'node-cron',
    'yaml',
    'pino-pretty',
    'zod',
    'pino',
  ],
  // Workspace packages — bundle into dist/
  noExternal: [
    '@ainyc/canonry-contracts',
    '@ainyc/canonry-config',
    '@ainyc/canonry-db',
    '@ainyc/canonry-api-routes',
    '@ainyc/canonry-provider-gemini',
    '@ainyc/canonry-provider-openai',
    '@ainyc/canonry-provider-claude',
    '@ainyc/canonry-provider-local',
    '@ainyc/canonry-provider-cdp',
    '@ainyc/canonry-integration-google',
  ],
})

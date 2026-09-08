/**
 * Codegen entry point. Builds the canonry OpenAPI document in-process,
 * writes it to a temp file, and hands the path to `@hey-api/openapi-ts`.
 * Output lands in `src/generated/` (committed; CI checks for drift).
 *
 * Run via `pnpm gen` from inside this package, or from the workspace root:
 *   pnpm --filter @ainyc/canonry-api-client gen
 *
 * `pnpm gen:check` compares temporary output without changing the SDK or Git.
 */
import { buildOpenApiDocument } from '@ainyc/canonry-api-routes'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, runArtifactTask } from '../../scripts/artifact-cache.js'
import { assertGeneratedFilesIncluded } from '../../scripts/generated-git-check.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--check', '--force', '--committed'].includes(arg)) || (args.includes('--committed') && !args.includes('--check'))) {
    throw new Error('Usage: codegen.ts [--check [--committed]] [--force]')
  }
  const spec = buildOpenApiDocument({
    title: 'canonry HTTP API',
    description: 'Generated from packages/api-routes — do not hand-edit clients.',
    // Match canonry's own server (`packages/canonry/src/server.ts`) so the
    // SDK includes every route the production `/openapi.json` exposes —
    // notably the Aero agent endpoints (`/projects/:name/agent/*`).
    // Without this flag the SDK silently drops those routes and consumers
    // have to fall back to hand-typed `fetch()` calls.
    includeCanonryLocal: true,
  })
  stripSseRoutes(spec)

  const repoRoot = path.resolve(__dirname, '../..')
  const outputDir = path.join(__dirname, 'src', 'generated')
  const specJson = JSON.stringify(spec, null, 2)
  const inputHash = fingerprint([
    fileURLToPath(import.meta.url),
    path.join(repoRoot, 'scripts/artifact-cache.ts'),
    path.join(repoRoot, 'pnpm-lock.yaml'),
    path.join(__dirname, 'package.json'),
  ], { spec: specJson, node: process.version })
  const result = await runArtifactTask({
    inputHash,
    outputDir,
    cacheFile: path.join(repoRoot, '.tmp/codegen/cache.json'),
    check: args.includes('--check'),
    force: args.includes('--force'),
    generate: async (tempOutput) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canonry-codegen-'))
      try {
        const specPath = path.join(tmpDir, 'openapi.json')
        await fs.writeFile(specPath, specJson, 'utf8')
        const { createClient } = await import('@hey-api/openapi-ts')
        await createClient({
          input: specPath,
          output: {
            path: tempOutput,
            format: 'prettier',
            lint: false,
          },
          plugins: [
            {
              name: '@hey-api/client-fetch',
              runtimeConfigPath: undefined,
            },
            '@hey-api/sdk',
            '@hey-api/typescript',
            // Generates `<operation>Options` / `<operation>QueryKey` /
            // `<operation>Mutation` helpers for TanStack Query v5. Consumed by
            // apps/web in components via `useQuery(getApiV1ProjectsOptions({ client }))`.
            // Cache keys are derived from path + query params — no hand-curated
            // key registry needed.
            '@tanstack/react-query',
          ],
        })
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true })
      }
    },
  })

  if (args.includes('--check')) assertGeneratedFilesIncluded(outputDir, args.includes('--committed'))
  console.log(`Generated client ${result.cached ? 'unchanged (cached)' : args.includes('--check') ? 'matches' : `updated (${result.changedFiles.length} files)`}`)
}

/**
 * Strip operations whose 2xx response is `text/event-stream` (SSE).
 *
 * The hey-api TanStack-Query plugin emits a `*Mutation` helper that
 * destructures `{ data }` from the underlying SDK call's return value.
 * For SSE endpoints the call returns a `ServerSentEventsResult`, which
 * has no `data` field — so the generated wrapper fails to typecheck.
 *
 * We only have one SSE endpoint (`POST /agent/prompt`); the dashboard's
 * Aero bar consumes it directly via `EventSource` rather than through
 * the SDK, so dropping it from codegen is a clean way to ship the rest
 * of the canonry-local routes (`/agent/providers`, `/agent/transcript`,
 * `/agent/memory`) which DO benefit from typed SDK access.
 */
function stripSseRoutes(spec: { paths?: Record<string, Record<string, unknown>> }) {
  if (!spec.paths) return
  for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      const op = operation as { responses?: Record<string, { content?: Record<string, unknown> }> }
      const ok = op.responses?.['200']
      if (ok?.content?.['text/event-stream']) {
        delete (pathItem as Record<string, unknown>)[method]
      }
    }
    if (Object.keys(pathItem).length === 0) {
      delete spec.paths[pathKey]
    }
  }
}

main().catch((err) => {
  console.error('Codegen failed:', err)
  if (process.argv.includes('--check')) console.error('Run pnpm gen to update the SDK.')
  process.exit(1)
})

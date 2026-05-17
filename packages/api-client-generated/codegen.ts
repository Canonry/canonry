/**
 * Codegen entry point. Builds the canonry OpenAPI document in-process,
 * writes it to a temp file, and hands the path to `@hey-api/openapi-ts`.
 * Output lands in `src/generated/` (committed; CI checks for drift).
 *
 * Run via `pnpm gen` from inside this package, or from the workspace root:
 *   pnpm --filter @ainyc/canonry-api-client gen
 *
 * The drift check is `pnpm gen:check` which runs this script then
 * `git diff --exit-code -- src/generated`. CI invokes it.
 */
import { createClient } from '@hey-api/openapi-ts'
import { buildOpenApiDocument } from '@ainyc/canonry-api-routes'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function main() {
  const spec = buildOpenApiDocument({
    title: 'canonry HTTP API',
    description: 'Generated from packages/api-routes — do not hand-edit clients.',
  })

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canonry-codegen-'))
  const specPath = path.join(tmpDir, 'openapi.json')
  await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8')

  const outputDir = path.join(__dirname, 'src', 'generated')
  await fs.rm(outputDir, { recursive: true, force: true })

  await createClient({
    input: specPath,
    output: {
      path: outputDir,
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

  await fs.rm(tmpDir, { recursive: true, force: true })

  // eslint-disable-next-line no-console
  console.log(`Generated client written to ${path.relative(process.cwd(), outputDir)}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Codegen failed:', err)
  process.exit(1)
})

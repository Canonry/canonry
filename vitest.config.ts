import fs from 'node:fs'
import path from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Workspace-level vitest config — defines every package + app as a project
 * inline so we don't need a `vitest.config.ts` per package. Each project
 * inherits the shared `setupFiles` (telemetry-disable + non-localhost fetch
 * block) from `test-setup/vitest-defaults.ts`.
 *
 * Projects can still be filtered: `pnpm test -- --project canonry`.
 *
 * Special cases:
 *   - `apps/web` runs in a jsdom environment and relies on its own
 *     `apps/web/vite.config.ts` for the React + Tailwind plugins. Vitest
 *     auto-merges that file when `root` points at the package.
 *   - `integration-commoncrawl` only has `.test.ts` (no `.test.tsx`), but
 *     including the broader glob is harmless and keeps every project shape
 *     identical.
 */

const SHARED_INCLUDE = ['test/**/*.test.ts', 'test/**/*.test.tsx']
// Absolute path: when a project sets `root`, vitest resolves relative
// `setupFiles` against THAT root. Resolve to the workspace once here so every
// project points at the same shared file.
const SHARED_SETUP = [path.resolve(import.meta.dirname, 'test-setup/vitest-defaults.ts')]
const WEB_SETUP = [...SHARED_SETUP, path.resolve(import.meta.dirname, 'apps/web/test/testing-library-defaults.ts')]
// The aggregate run executes every package's suite in one process, so tests
// that spawn git, oxlint or npm, or seed a database, routinely pass 5s under
// load while finishing in 1-3s on their own. Applies only to this root run;
// each package's own `pnpm test` keeps Vitest's defaults.
const AGGREGATE_TIMEOUTS = { testTimeout: 30_000, hookTimeout: 30_000 }

const NODE_PACKAGES = [
  'api-client-generated',
  'api-routes',
  'canonry',
  'config',
  'contracts',
  'db',
  'integration-bing',
  'integration-cloud-run',
  'integration-cloudflare-queue',
  'integration-cloudflare-worker',
  'integration-commoncrawl',
  'integration-dataforseo',
  'integration-google',
  'integration-google-ads',
  'integration-google-analytics',
  'integration-google-business-profile',
  'integration-google-places',
  'integration-google-tag-manager',
  'integration-openai-ads',
  'integration-traffic',
  'integration-typesafe',
  'integration-vercel',
  'integration-wordpress',
  'integration-wordpress-traffic',
  'intelligence',
  'provider-answer-services',
  'provider-cdp',
  'provider-claude',
  'provider-gemini',
  'provider-local',
  'provider-muse',
  'provider-openai',
  'provider-openrouter',
  'provider-perplexity',
  'val-kit',
] as const

const NODE_APPS = ['api', 'worker'] as const

/**
 * Projects whose test files share a worker, and its module cache, instead of
 * each file starting in a fresh process: the package graph is imported once
 * per worker rather than once per file. The shared setup file puts back
 * process state between files (see test-setup/vitest-defaults.ts).
 *
 * Vitest keeps module mocks across the files of a shared worker, so a file
 * that calls `vi.mock` or `vi.doMock` still gets a fresh process: a project
 * with such files runs as `<name>:shared` and `<name>:isolated`. Select both
 * with `--project '<name>:*'`.
 *
 * Not listed: `canonry`, which holds process-wide state such as the provider
 * rate-limit gates; `web`, whose files would share one jsdom document; and
 * `intelligence` and `integration-commoncrawl`, where one mocking file would
 * split a small suite for little gain.
 */
const SHARED_WORKER_PROJECTS: ReadonlySet<string> = new Set([
  'api-client-generated',
  'api-routes',
  'config',
  'contracts',
  'db',
  'integration-bing',
  'integration-cloud-run',
  'integration-cloudflare-queue',
  'integration-cloudflare-worker',
  'integration-google',
  'integration-google-ads',
  'integration-google-analytics',
  'integration-google-business-profile',
  'integration-google-places',
  'integration-google-tag-manager',
  'integration-openai-ads',
  'integration-traffic',
  'integration-typesafe',
  'integration-vercel',
  'integration-wordpress',
  'integration-wordpress-traffic',
  'provider-cdp',
  'provider-claude',
  'provider-gemini',
  'provider-local',
  'provider-muse',
  'provider-openai',
  'provider-perplexity',
  'val-kit',
  'api',
  'worker',
])

const MODULE_MOCK = /\bvi\.(?:mock|doMock)\(/
const TEST_FILE = /\.test\.tsx?$/

/** Test files under `root` that mock a module, relative to `root`. */
function moduleMockingTests(root: string): string[] {
  const testDir = path.resolve(import.meta.dirname, root, 'test')
  const files: string[] = []
  for (const file of fs.readdirSync(testDir, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file) || !MODULE_MOCK.test(fs.readFileSync(path.join(testDir, file), 'utf8'))) continue
    // A helper that mocks would leak into every shared file that imports it.
    if (!TEST_FILE.test(file)) {
      throw new Error(`vitest.config.ts: ${path.join(root, 'test', file)} mocks a module outside a test file.`)
    }
    files.push(['test', ...file.split(path.sep)].join('/'))
  }
  return files
}

function nodeProjects(name: string, root: string) {
  const base = { root, include: SHARED_INCLUDE, setupFiles: SHARED_SETUP, ...AGGREGATE_TIMEOUTS }
  if (!SHARED_WORKER_PROJECTS.has(name)) return [{ test: { ...base, name } }]
  const mocking = moduleMockingTests(root)
  if (mocking.length === 0) return [{ test: { ...base, name, isolate: false } }]
  return [
    { test: { ...base, name: `${name}:shared`, isolate: false, exclude: [...configDefaults.exclude, ...mocking] } },
    { test: { ...base, name: `${name}:isolated`, include: mocking } },
  ]
}

export default defineConfig({
  test: {
    // Migrates one database per run for the tests to replay; see
    // test-setup/migrated-database.ts.
    globalSetup: [path.resolve(import.meta.dirname, 'test-setup/global-setup.ts')],
    projects: [
      ...NODE_PACKAGES.flatMap((name) => nodeProjects(name, `./packages/${name}`)),
      ...NODE_APPS.flatMap((name) => nodeProjects(name, `./apps/${name}`)),
      {
        test: {
          name: 'web',
          root: './apps/web',
          include: SHARED_INCLUDE,
          setupFiles: WEB_SETUP,
          ...AGGREGATE_TIMEOUTS,
          environment: 'jsdom',
        },
      },
      {
        // Workspace-level concerns that belong to no single package — today the
        // lint-config guards, which span five trees across packages/ and apps/.
        test: {
          name: 'workspace',
          root: '.',
          include: ['test/*.test.ts'],
          setupFiles: SHARED_SETUP,
          ...AGGREGATE_TIMEOUTS,
        },
      },
    ],
  },
})

import path from 'node:path'
import { defineConfig } from 'vitest/config'

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
// that spawn git, ESLint or npm, or seed a database, routinely pass 5s under
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
  'provider-cdp',
  'provider-claude',
  'provider-gemini',
  'provider-local',
  'provider-muse',
  'provider-openai',
  'provider-perplexity',
  'val-kit',
] as const

const NODE_APPS = ['api', 'worker'] as const

export default defineConfig({
  test: {
    projects: [
      ...NODE_PACKAGES.map((name) => ({
        test: {
          name,
          root: `./packages/${name}`,
          include: SHARED_INCLUDE,
          setupFiles: SHARED_SETUP,
          ...AGGREGATE_TIMEOUTS,
        },
      })),
      ...NODE_APPS.map((name) => ({
        test: {
          name,
          root: `./apps/${name}`,
          include: SHARED_INCLUDE,
          setupFiles: SHARED_SETUP,
          ...AGGREGATE_TIMEOUTS,
        },
      })),
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

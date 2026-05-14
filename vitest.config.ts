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

const NODE_PACKAGES = [
  'api-routes',
  'canonry',
  'config',
  'contracts',
  'db',
  'integration-bing',
  'integration-cloud-run',
  'integration-commoncrawl',
  'integration-google',
  'integration-google-analytics',
  'integration-traffic',
  'integration-vercel',
  'integration-wordpress',
  'integration-wordpress-traffic',
  'intelligence',
  'provider-cdp',
  'provider-claude',
  'provider-gemini',
  'provider-local',
  'provider-openai',
  'provider-perplexity',
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
        },
      })),
      ...NODE_APPS.map((name) => ({
        test: {
          name,
          root: `./apps/${name}`,
          include: SHARED_INCLUDE,
          setupFiles: SHARED_SETUP,
        },
      })),
      {
        test: {
          name: 'web',
          root: './apps/web',
          include: SHARED_INCLUDE,
          setupFiles: SHARED_SETUP,
          environment: 'jsdom',
        },
      },
    ],
  },
})

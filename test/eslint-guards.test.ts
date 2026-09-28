import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint, RuleTester } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'
import { createRestrictedSyntaxRule } from '../eslint-rules/restricted-syntax.js'

/**
 * The workspace lint config's guards must actually RUN in every tree they name.
 *
 * This is not a hypothetical. Every guard used to be options on the core
 * `no-restricted-syntax` rule, and ESLint flat config resolves rules by id with
 * LAST-WINS OVERRIDE across overlapping config objects — so a second block
 * naming the same tree replaced the first block's options and the first guard
 * silently stopped reporting. Four of five blocks were dead that way: the
 * vocabulary literal ban fired in NONE of the four trees it named, the GA4
 * dimension drift guard fired nowhere, and the AI-hostname ban was clobbered in
 * apps/web/src and packages/canonry/src. `pnpm lint` was green throughout, and
 * the AGENTS.md rules citing those guards had been false for as long.
 *
 * A dead guard is invisible from the outside: it looks exactly like a clean
 * tree. The only way to see it is to ask what is enabled for a given file, so
 * that is what this asserts — per tree, per guard, at error severity.
 */

/** Rule ids expected at `error` severity for a representative file in each guarded tree. */
const GUARD_COVERAGE: Array<{ file: string, rules: string[] }> = [
  {
    // Aero's tool text and the server-side insight copy show percentages too.
    file: 'packages/canonry/src/agent/tool-result-units.ts',
    rules: ['canonry-guards/no-inline-percent', 'canonry-guards/no-inline-ai-hostname'],
  },
  {
    file: 'packages/intelligence/src/mention-share.ts',
    rules: ['canonry-guards/no-inline-percent', 'canonry-guards/no-inline-ai-hostname'],
  },
  {
    // Three guards overlap here, plus the two web-only ratchets. This is the
    // tree where the clobbering was worst — only the raw-HTTP guard survived.
    file: 'apps/web/src/pages/ProjectPage.tsx',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-vocabulary/no-question-ui-copy',
      'canonry-guards/no-inline-ai-hostname',
      'canonry-guards/no-raw-http-web',
      'design-tokens/no-literal-palette',
    ],
  },
  {
    file: 'packages/api-routes/src/report-renderer.ts',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-guards/no-inline-ai-hostname',
    ],
  },
  {
    // The report copy module holds the UI copy both report renderers show, so
    // it carries the vocabulary guards the web tree does.
    file: 'packages/contracts/src/report-sections.ts',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-vocabulary/no-question-ui-copy',
    ],
  },
  {
    file: 'packages/canonry/src/commands/run.ts',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-guards/no-inline-ai-hostname',
      'canonry-guards/no-raw-http-cli',
    ],
  },
  {
    file: 'packages/canonry/src/cli-commands/query.ts',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-guards/no-inline-ai-hostname',
      'canonry-guards/no-raw-http-cli',
    ],
  },
  {
    // The AI-hostname guard's `packages/integration-*` glob covers this tree
    // too — that overlap is what silently killed the GA4 guard.
    file: 'packages/integration-google-analytics/src/ga4-client.ts',
    rules: [
      'canonry-guards/no-inline-ga4-dimension',
      'canonry-guards/no-inline-ai-hostname',
    ],
  },
]

/** Files each guard deliberately exempts. A dead guard passes the coverage matrix above trivially if the exemptions are wrong. */
const GUARD_EXEMPTIONS: Array<{ file: string, rule: string }> = [
  { file: 'apps/web/src/api.ts', rule: 'canonry-guards/no-raw-http-web' },
  { file: 'apps/web/src/api-aero.ts', rule: 'canonry-guards/no-raw-http-web' },
  { file: 'apps/web/src/mock-data.ts', rule: 'canonry-vocabulary/no-question-ui-copy' },
  { file: 'apps/web/src/components/project/DiscoverySection.tsx', rule: 'canonry-vocabulary/no-question-ui-copy' },
  { file: 'apps/web/src/components/shared/ProviderBadge.tsx', rule: 'design-tokens/no-literal-palette' },
  { file: 'packages/canonry/src/client.ts', rule: 'canonry-guards/no-raw-http-cli' },
  { file: 'packages/integration-google-analytics/src/constants.ts', rule: 'canonry-guards/no-inline-ga4-dimension' },
  { file: 'packages/contracts/src/ai-engines.ts', rule: 'canonry-guards/no-inline-ai-hostname' },
  { file: 'packages/contracts/src/formatting.ts', rule: 'canonry-guards/no-inline-percent' },
]

const severityOf = (entry: unknown): number | undefined => {
  const value = Array.isArray(entry) ? entry[0] : entry
  if (typeof value === 'number') return value
  if (value === 'error') return 2
  if (value === 'warn') return 1
  if (value === 'off') return 0
  return undefined
}

describe('workspace lint guards', () => {
  const workspaceRoot = path.resolve(fileURLToPath(import.meta.url), '../..')
  const eslint = new ESLint({ cwd: workspaceRoot })
  const resolveConfig = async (file: string) =>
    await eslint.calculateConfigForFile(file) as { rules?: Record<string, unknown> }

  // Warm the config resolver once, as SETUP rather than inside a test.
  //
  // The first `calculateConfigForFile` loads `eslint.config.js` and every
  // plugin it imports (typescript-eslint, the local rule files, the whole
  // flat-config graph). Measured: that first call is ~675ms and every later
  // one is 0-8ms, because the result is cached. Without this hook that cost
  // lands on whichever test runs first, under the 5s default timeout.
  //
  // This was observed three times as `enables every guard that names
  // apps/web/src/pages/ProjectPage.tsx` timing out at 5s while a full
  // `pnpm verify` ran concurrently — always that test, never the four
  // identically-shaped ones after it, which is the signature of shared setup
  // rather than of anything about that file (`calculateConfigForFile` never
  // opens it, so its size is irrelevant). It does NOT reproduce on an idle
  // machine or under pure CPU saturation, so the exact contention is not
  // pinned down; what is certain is that a multi-second one-time cost had no
  // business inside a 5s per-test budget.
  //
  // Paying it here leaves each assertion below measuring only its own
  // marginal work, so the tight default timeout still catches a real
  // regression in config resolution.
  beforeAll(async () => {
    await resolveConfig(GUARD_COVERAGE[0]!.file)
  }, 120_000)

  // `calculateConfigForFile` answers for any path, real or not, so a renamed
  // file would leave the matrix asserting about nothing. Fail on that instead.
  it('names real files', () => {
    for (const { file } of [...GUARD_COVERAGE, ...GUARD_EXEMPTIONS]) {
      expect(existsSync(path.join(workspaceRoot, file)), `${file} no longer exists — update this test`).toBe(true)
    }
  })

  for (const { file, rules } of GUARD_COVERAGE) {
    it(`enables every guard that names ${file}`, async () => {
      const config = await resolveConfig(file)
      for (const rule of rules) {
        expect(severityOf(config.rules?.[rule]), `${rule} must be an error for ${file}`).toBe(2)
      }
    })
  }

  it('keeps each guard OFF for the files it deliberately exempts', async () => {
    for (const { file, rule } of GUARD_EXEMPTIONS) {
      const config = await resolveConfig(file)
      const severity = severityOf(config.rules?.[rule])
      expect(severity === undefined || severity === 0, `${rule} must not apply to ${file}`).toBe(true)
    }
  })

  it('has no `no-restricted-syntax` options left to clobber each other', async () => {
    for (const { file } of GUARD_COVERAGE) {
      const config = await resolveConfig(file)
      expect(severityOf(config.rules?.['no-restricted-syntax']) ?? 0, file).toBe(0)
    }
  })

  // `no-restricted-imports` is the other core rule this config configures from
  // more than one block (CLI readline ban, web chart-library ban, ChartPrimitives
  // carve-out). Those blocks target disjoint trees today, so nothing is
  // clobbered — this asserts a future block doesn't quietly take one away.
  it('keeps every `no-restricted-imports` ban reachable', async () => {
    const cli = await resolveConfig('packages/canonry/src/commands/run.ts')
    expect(JSON.stringify(cli.rules?.['no-restricted-imports'])).toContain('node:readline')

    const web = await resolveConfig('apps/web/src/pages/ProjectPage.tsx')
    expect(JSON.stringify(web.rules?.['no-restricted-imports'])).toContain('recharts')

    const chartPrimitives = await resolveConfig('apps/web/src/components/shared/ChartPrimitives.tsx')
    const chartBans = JSON.stringify(chartPrimitives.rules?.['no-restricted-imports'])
    expect(chartBans).toContain('highcharts')
    // The one file allowed to import recharts directly.
    expect(chartBans).not.toContain('"recharts"')
  })
})

/**
 * The factory behind those ids. Two restrictions in one rule must BOTH report —
 * including when they share a selector, which is the in-rule version of the same
 * clobber (the later visitor key would overwrite the earlier one).
 */
describe('createRestrictedSyntaxRule', () => {
  RuleTester.describe = describe
  RuleTester.it = it

  // `RuleTester.run` declares its own suite, so it has to be called at describe
  // scope — vitest rejects a nested `describe` inside a running test.
  new RuleTester().run('restricted-syntax', createRestrictedSyntaxRule({
    description: 'test rule',
    restrictions: [
      { selector: "Literal[value='banned']", message: 'first message' },
      { selector: "Literal[value='banned']", message: 'second message' },
      { selector: "CallExpression[callee.name='fetch']", message: 'third message' },
    ],
  }), {
    valid: [{ code: "const ok = 'allowed'" }, { code: 'request()' }],
    invalid: [
      { code: "const bad = 'banned'", errors: [{ message: 'first message' }, { message: 'second message' }] },
      { code: "fetch('/x')", errors: [{ message: 'third message' }] },
    ],
  })

  it('refuses a malformed restriction instead of silently enforcing nothing', () => {
    expect(() => createRestrictedSyntaxRule({ description: 'd', restrictions: [] }))
      .toThrow(/non-empty array/)
    // The JSDoc types reject a message-less restriction statically, but
    // eslint.config.js is plain JS and never typechecked — the runtime throw is
    // what actually stops a guard from being registered with nothing to say.
    const missingMessage = { selector: 'Literal' } as { selector: string, message: string }
    expect(() => createRestrictedSyntaxRule({ description: 'd', restrictions: [missingMessage] }))
      .toThrow(/needs both/)
  })
})

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuleTester } from 'oxlint/plugins-dev'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRestrictedSyntaxRule } from '../eslint-rules/restricted-syntax.js'

/**
 * The workspace lint config's guards must actually RUN in every tree they name.
 *
 * This is not a hypothetical. Every guard used to be options on the core
 * `no-restricted-syntax` rule, and the linter resolves rules by id with
 * LAST-WINS OVERRIDE across overlapping config blocks — so a second block
 * naming the same tree replaced the first block's options and the first guard
 * silently stopped reporting. Four of five blocks were dead that way: the
 * vocabulary literal ban fired in NONE of the four trees it named, the GA4
 * dimension drift guard fired nowhere, and the AI-hostname ban was clobbered in
 * apps/web/src and packages/canonry/src. `pnpm lint` was green throughout, and
 * the AGENTS.md rules citing those guards had been false for as long.
 *
 * A dead guard is invisible from the outside: it looks exactly like a clean
 * tree. So this lints a probe that breaks every guard at once, placed at a
 * representative path in each guarded tree (inside a temporary copy, never the
 * checkout), and asserts which guards report — per tree, per guard, at error
 * severity. That also proves the oxlint JS plugins load and run the rules.
 */

/** Rule ids that must report at `error` severity for a representative file in each guarded tree. */
const GUARD_COVERAGE: Array<{ file: string, rules: string[] }> = [
  {
    // Aero's tool text and the server-side insight copy show percentages too.
    file: 'packages/canonry/src/agent/tool-result-units.ts',
    rules: ['canonry-guards/no-inline-percent', 'canonry-guards/no-inline-ai-hostname', 'canonry-guards/no-second-query-classifier'],
  },
  {
    file: 'packages/intelligence/src/mention-share.ts',
    rules: ['canonry-guards/no-inline-percent', 'canonry-guards/no-inline-ai-hostname', 'canonry-guards/no-second-query-classifier'],
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
      'canonry-guards/no-second-query-classifier',
    ],
  },
  {
    // The Queries tab exempts one file (see GUARD_EXEMPTIONS); its host and
    // the tracked pages beside it are guarded.
    file: 'apps/web/src/components/project/DiscoverySection.tsx',
    rules: ['canonry-vocabulary/no-question-ui-copy'],
  },
  {
    file: 'apps/web/src/components/project/queries/SimpleTrackedQueries.tsx',
    rules: ['canonry-vocabulary/no-question-ui-copy'],
  },
  {
    // The Add query form says "query", so it is guarded like the pages that draw it.
    file: 'apps/web/src/components/project/queries/TrackingComposer.tsx',
    rules: ['canonry-vocabulary/no-question-ui-copy'],
  },
  {
    file: 'apps/web/src/components/project/queries/advanced/AdvancedTrackedPage.tsx',
    rules: ['canonry-vocabulary/no-question-ui-copy'],
  },
  {
    file: 'packages/api-routes/src/traffic-analytics.ts',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-guards/no-inline-ai-hostname',
      'canonry-guards/no-second-query-classifier',
    ],
  },
  {
    // The query list and the advanced class proposal: the two server modules
    // most likely to grow a classifier of their own.
    file: 'packages/api-routes/src/queries.ts',
    rules: ['canonry-guards/no-second-query-classifier'],
  },
  {
    file: 'packages/api-routes/src/measurement-draft-compile.ts',
    rules: ['canonry-guards/no-second-query-classifier'],
  },
  {
    // Shared visibility labels carry the vocabulary guards the web tree does.
    file: 'packages/contracts/src/visibility-display.ts',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-vocabulary/no-question-ui-copy',
      'canonry-guards/no-second-query-classifier',
    ],
  },
  {
    file: 'packages/canonry/src/commands/run.ts',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-guards/no-inline-ai-hostname',
      'canonry-guards/no-raw-http-cli',
      'canonry-guards/no-second-query-classifier',
    ],
  },
  {
    file: 'packages/canonry/src/cli-commands/query.ts',
    rules: [
      'canonry-guards/no-inline-percent',
      'canonry-vocabulary/no-banned-metric-literal',
      'canonry-guards/no-inline-ai-hostname',
      'canonry-guards/no-raw-http-cli',
      'canonry-guards/no-second-query-classifier',
    ],
  },
  {
    // The AI-hostname guard's `packages/integration-*` glob covers this tree
    // too — that overlap is what silently killed the GA4 guard.
    file: 'packages/integration-google-analytics/src/ga4-client.ts',
    rules: [
      'canonry-guards/no-inline-ga4-dimension',
      'canonry-guards/no-inline-ai-hostname',
      'canonry-guards/no-second-query-classifier',
    ],
  },
]

/** Files each guard deliberately exempts. A dead guard passes the coverage matrix above trivially if the exemptions are wrong. */
const GUARD_EXEMPTIONS: Array<{ file: string, rule: string }> = [
  { file: 'apps/web/src/api.ts', rule: 'canonry-guards/no-raw-http-web' },
  { file: 'apps/web/src/api-aero.ts', rule: 'canonry-guards/no-raw-http-web' },
  { file: 'apps/web/src/mock-data.ts', rule: 'canonry-vocabulary/no-question-ui-copy' },
  { file: 'apps/web/src/components/project/queries/FindQueriesSection.tsx', rule: 'canonry-vocabulary/no-question-ui-copy' },
  { file: 'apps/web/src/components/shared/ProviderBadge.tsx', rule: 'design-tokens/no-literal-palette' },
  { file: 'apps/web/src/components/shared/ChartPrimitives.tsx', rule: 'design-tokens/no-literal-palette' },
  { file: 'packages/canonry/src/client.ts', rule: 'canonry-guards/no-raw-http-cli' },
  { file: 'packages/canonry/src/commands/daemon.ts', rule: 'canonry-guards/no-raw-http-cli' },
  { file: 'packages/canonry/src/telemetry.ts', rule: 'canonry-guards/no-raw-http-cli' },
  { file: 'packages/canonry/src/update-check.ts', rule: 'canonry-guards/no-raw-http-cli' },
  { file: 'packages/canonry/src/commands/init.ts', rule: 'no-restricted-imports' },
  { file: 'packages/integration-google-analytics/src/constants.ts', rule: 'canonry-guards/no-inline-ga4-dimension' },
  { file: 'packages/contracts/src/ai-engines.ts', rule: 'canonry-guards/no-inline-ai-hostname' },
  { file: 'packages/contracts/src/formatting.ts', rule: 'canonry-guards/no-inline-percent' },
  { file: 'packages/contracts/src/query-class.ts', rule: 'canonry-guards/no-second-query-classifier' },
  { file: 'packages/intelligence/src/query-categorize.ts', rule: 'canonry-guards/no-second-query-classifier' },
]

const IMPORT_BAN_FILES = ['apps/web/src/components/shared/ChartPrimitives.tsx']

/** Breaks every guard and both import bans at once. */
const PROBE = `import readline from 'node:readline'
import { LineChart } from 'recharts'
import Highcharts from 'highcharts'

declare const share: number
declare const text: string
export const probes = [
  readline, LineChart, Highcharts,
  'answerRate',
  'Assign each question to a Property',
  'openai.com',
  'sessionSource',
  'flex bg-zinc-900 text-zinc-50',
  \`\${(share * 100).toFixed(1)}%\`,
  fetch('https://example.com'),
]
export const queryClass = /example/i.test(text) ? 'branded' : 'non-brand'
`

const workspaceRoot = path.resolve(fileURLToPath(import.meta.url), '../..')
const CONFIG = '.oxlintrc.json'

interface Finding { rule: string, severity: string, message: string }

/** `canonry-guards(no-raw-http-web)` → `canonry-guards/no-raw-http-web`; `eslint(x)` → `x`. */
function ruleId(code: string): string {
  const match = /^([^(]+)\((.+)\)$/.exec(code)
  if (!match) return code
  return match[1] === 'eslint' ? match[2]! : `${match[1]}/${match[2]}`
}

/** Strips `//` and block comments outside strings, so the JSONC config parses as JSON. */
function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (char === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      out += text.slice(start, i + 1)
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
    } else {
      out += char
    }
  }
  return JSON.parse(out)
}

describe('workspace lint guards', () => {
  const files = [...new Set([...GUARD_COVERAGE.map(entry => entry.file), ...GUARD_EXEMPTIONS.map(entry => entry.file), ...IMPORT_BAN_FILES])]
  const findings = new Map<string, Finding[]>()
  let root = ''

  // One oxlint run over every probe (it loads the JS plugins once), as setup.
  beforeAll(() => {
    // Real path, and the config passed relative to it: oxlint 1.89 silently skips
    // JS plugin rules when `-c` is an absolute path through a symlink (macOS's
    // temp directory is one), which would make every guard look dead here.
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'canonry-lint-guards-')))
    copyFileSync(path.join(workspaceRoot, CONFIG), path.join(root, CONFIG))
    for (const link of ['node_modules', 'eslint-rules']) symlinkSync(path.join(workspaceRoot, link), path.join(root, link))
    for (const file of files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), PROBE)
    }
    const manifest = createRequire(import.meta.url).resolve('oxlint/package.json')
    const bin = path.join(path.dirname(manifest), (JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { oxlint: string } }).bin.oxlint)
    const result = spawnSync(process.execPath, [bin, '-c', CONFIG, '--format', 'json', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const report = JSON.parse(result.stdout) as { diagnostics: Array<{ code: string, severity: string, message: string, help?: string, filename: string }> }
    for (const diagnostic of report.diagnostics) {
      const list = findings.get(diagnostic.filename) ?? []
      // oxlint reports a rule's configured message (an import ban's, say) as `help`.
      list.push({ rule: ruleId(diagnostic.code), severity: diagnostic.severity, message: [diagnostic.message, diagnostic.help].filter(Boolean).join(' ') })
      findings.set(diagnostic.filename, list)
    }
  }, 120_000)

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const errorsAt = (file: string) => (findings.get(file) ?? []).filter(finding => finding.severity === 'error')

  // A probe at a path that no longer exists would assert about nothing. Fail on that instead.
  it('names real files', () => {
    for (const file of files) {
      expect(existsSync(path.join(workspaceRoot, file)), `${file} no longer exists — update this test`).toBe(true)
    }
  })

  for (const { file, rules } of GUARD_COVERAGE) {
    it(`runs every guard that names ${file}`, () => {
      const reported = new Set(errorsAt(file).map(finding => finding.rule))
      for (const rule of rules) expect(reported.has(rule), `${rule} must report an error in ${file}`).toBe(true)
    })
  }

  it('keeps each guard OFF for the files it deliberately exempts', () => {
    for (const { file, rule } of GUARD_EXEMPTIONS) {
      expect((findings.get(file) ?? []).some(finding => finding.rule === rule), `${rule} must not apply to ${file}`).toBe(false)
    }
  })

  it('has no `no-restricted-syntax` options left to clobber each other', () => {
    const config = parseJsonc(readFileSync(path.join(workspaceRoot, CONFIG), 'utf8')) as {
      rules?: Record<string, unknown>
      overrides?: Array<{ rules?: Record<string, unknown> }>
    }
    for (const rules of [config.rules ?? {}, ...(config.overrides ?? []).map(override => override.rules ?? {})]) {
      const entry = rules['no-restricted-syntax']
      expect(entry === undefined || entry === 'off' || (Array.isArray(entry) && entry[0] === 'off')).toBe(true)
    }
  })

  // `no-restricted-imports` is the other core rule this config sets from more
  // than one block (CLI readline ban, web chart-library ban, ChartPrimitives
  // carve-out). Those blocks target disjoint trees today, so nothing is
  // clobbered — this asserts a future block doesn't quietly take one away.
  it('keeps every `no-restricted-imports` ban reachable', () => {
    // Matched on the ban messages this config defines, so a format change in
    // oxlint's own wording cannot make an assertion pass vacuously.
    const importBans = (file: string) => errorsAt(file).filter(finding => finding.rule === 'no-restricted-imports').map(finding => finding.message).join('\n')
    expect(importBans('packages/canonry/src/commands/run.ts')).toContain('CLI commands must be non-interactive')
    const web = importBans('apps/web/src/pages/ProjectPage.tsx')
    expect(web).toContain('instead of recharts directly')
    expect(web).toContain('Use Recharts via ChartPrimitives instead.')
    const chartPrimitives = importBans('apps/web/src/components/shared/ChartPrimitives.tsx')
    expect(chartPrimitives).toContain('Use Recharts via ChartPrimitives instead.')
    // The one file allowed to import recharts directly.
    expect(chartPrimitives).not.toContain('instead of recharts directly')
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
    // The JSDoc types reject a message-less restriction statically, but the
    // plugin modules are plain JS and never typechecked — the runtime throw is
    // what actually stops a guard from being registered with nothing to say.
    const missingMessage = { selector: 'Literal' } as { selector: string, message: string }
    expect(() => createRestrictedSyntaxRule({ description: 'd', restrictions: [missingMessage] }))
      .toThrow(/needs both/)
  })
})

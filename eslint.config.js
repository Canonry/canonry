import js from '@eslint/js'
import globals from 'globals'
import regexpPlugin from 'eslint-plugin-regexp'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { noLiteralPaletteRule } from './eslint-rules/no-literal-palette.js'
import { createRestrictedSyntaxRule } from './eslint-rules/restricted-syntax.js'

const ALT_CHART_LIB_PATHS = [
  { name: 'chart.js', message: 'Use Recharts via ChartPrimitives instead.' },
  { name: 'highcharts', message: 'Use Recharts via ChartPrimitives instead.' },
  { name: 'd3', message: 'Use Recharts via ChartPrimitives instead.' },
  { name: 'victory', message: 'Use Recharts via ChartPrimitives instead.' },
  { name: '@nivo/core', message: 'Use Recharts via ChartPrimitives instead.' },
  { name: 'plotly.js', message: 'Use Recharts via ChartPrimitives instead.' },
]

const ALT_CHART_LIB_PATTERNS = [
  { group: ['chart.js/*'], message: 'Use Recharts via ChartPrimitives instead.' },
  { group: ['highcharts/*'], message: 'Use Recharts via ChartPrimitives instead.' },
  { group: ['d3-*'], message: 'Use Recharts via ChartPrimitives instead.' },
  { group: ['victory-*'], message: 'Use Recharts via ChartPrimitives instead.' },
  { group: ['@nivo/*'], message: 'Use Recharts via ChartPrimitives instead.' },
  { group: ['plotly.js-*'], message: 'Use Recharts via ChartPrimitives instead.' },
]

// EVERY GUARD IN THIS FILE HAS ITS OWN RULE ID. That is load-bearing, not
// stylistic. ESLint flat config resolves rules by id with LAST-WINS OVERRIDE
// across overlapping config objects, so two blocks that both put options on the
// core `no-restricted-syntax` rule and both name the same tree do not compose:
// the later block REPLACES the earlier one's options and the earlier guard stops
// reporting — silently, with a green `pnpm lint` and no diagnostic at any
// verbosity. This file had five such blocks and four were dead (verified
// 2026-08-05 by dropping a probe file into each tree): the vocabulary literal ban
// fired in NONE of the four trees it named, the GA4 dimension drift guard fired
// nowhere, and the AI-hostname ban was clobbered in apps/web/src and
// packages/canonry/src by the two raw-`fetch()` guards. The AGENTS.md rules
// citing them had been false for as long.
//
// So: no `no-restricted-syntax` blocks. Selector bans go through
// `createRestrictedSyntaxRule` (./eslint-rules/restricted-syntax.js), which is
// the same behavior under a unique id, and each plugin object is defined ONCE
// and shared by reference (flat config rejects a namespace redefined with a
// different object). Two ids are two rules; they both run, whatever the overlap.
//
// Design-token migration ratchet (engine issue #767, Phase 3). Flags raw Tailwind
// palette color utilities in themeable web code so a migrated file can't regress.
// The rule + its regex live in ./eslint-rules/no-literal-palette.js (shared with
// the scanner + its test). Phase 3 is COMPLETE: every apps/web/src file is
// migrated, so the rule now covers the whole tree with only the two permanent
// exclusions below (the migration allowlist has been emptied and removed).

// PERMANENT exclusions: ProviderBadge encodes engine identity (not tone) and
// ChartPrimitives carries the `var(--chart-*, #hex)` fallbacks. Both stay literal.
const RAW_PALETTE_PERMANENT_EXCLUSIONS = [
  'apps/web/src/components/shared/ProviderBadge.tsx',
  'apps/web/src/components/shared/ChartPrimitives.tsx',
]

// Vocabulary ratchet: the tracked entity is a QUERY, never a "question". See
// AGENTS.md "Vocabulary (Critical) → Query vs question". Advanced measurement
// was the only surface that called it a question; the copy is now query
// everywhere and this keeps it there.
//
// It deliberately does NOT read comments: "question" has plenty of honest
// prose uses in a comment ("both questions go out together"), and flagging
// them would only buy a run of eslint-disable lines.
const QUESTION_WORD_RE = /\bquestions?\b/i

// Machine tokens carry the word without being copy: the frozen route paths
// (`/measurement-property-questions`), DOM ids (`property-questions`), and
// busy-state keys (`create-and-pair-questions`). None of them contain a space.
// Prose always does — the one exception being a bare one-word label, which is
// exactly the wizard step that read "Questions".
export function isQuestionUiCopy(text) {
  if (typeof text !== 'string' || !QUESTION_WORD_RE.test(text)) return false
  const trimmed = text.trim()
  return /\s/.test(trimmed) || /^questions?$/i.test(trimmed)
}

// Attributes whose value is an identifier or a class list, never prose. A
// `className` is the realistic one: it is the only non-copy attribute that
// routinely holds spaces, so the heuristic above cannot see it is not a
// sentence.
const QUESTION_COPY_EXEMPT_ATTRIBUTES = new Set([
  'className', 'id', 'htmlFor', 'key', 'name',
  'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns',
])

function isExemptJsxAttributeValue(node) {
  const parent = node.parent
  if (!parent || parent.type !== 'JSXAttribute' || parent.value !== node) return false
  const attribute = parent.name
  const attributeName = attribute?.type === 'JSXNamespacedName'
    ? `${attribute.namespace.name}:${attribute.name.name}`
    : attribute?.name
  return typeof attributeName === 'string'
    && (QUESTION_COPY_EXEMPT_ATTRIBUTES.has(attributeName) || attributeName.startsWith('data-'))
}

export const noQuestionUiCopyRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow "question" in web UI copy — the tracked entity is a query.' },
    schema: [],
    messages: {
      questionCopy:
        'The tracked entity is a QUERY, not a "question" — say query in UI copy (labels, headings, ' +
        'buttons, tooltips, aria-labels, placeholders). Mind the plural: "questions" → "queries". ' +
        'The wire names (/measurement-property-questions, /measurement-question-result, the ' +
        'canonry_measurement_* MCP tools, and the SDK symbols derived from them) are FROZEN and ' +
        'exempt. See AGENTS.md "Vocabulary (Critical) → Query vs question".',
    },
  },
  create(context) {
    const report = node => context.report({ node, messageId: 'questionCopy' })
    return {
      // JS strings + JSX attribute values (`text="…"`, `aria-label="…"`, `placeholder="…"`).
      Literal(node) {
        if (isQuestionUiCopy(node.value) && !isExemptJsxAttributeValue(node)) report(node)
      },
      // Visible JSX children — `<h2>Query type</h2>`. Invisible to a `Literal`
      // selector, which is most of what a heading or a table header actually is.
      JSXText(node) {
        if (isQuestionUiCopy(node.value)) report(node)
      },
      // Interpolated copy — `${n} query assignments`.
      TemplateElement(node) {
        if (isQuestionUiCopy(node.value.raw)) report(node)
      },
    }
  },
}

// The two exclusions, both permanent:
// - DiscoverySection is discovery's GENERATIVE framing ("questions your
//   customers might ask", "Questions tested"). That is what a person asks
//   before anything is tracked — a genuinely different noun, not a row in
//   `queries`. No regex separates "Generate customer questions" from "Assign
//   each question to a Property", so the boundary is the file.
// - mock-data.ts is a test fixture: `createDashboardFixture` has no production
//   consumer (App.tsx imports only `findEvidenceForModal` / `findRunById`).
const QUESTION_COPY_PERMANENT_EXCLUSIONS = [
  'apps/web/src/components/project/DiscoverySection.tsx',
  'apps/web/src/mock-data.ts',
]

// Vocabulary enforcement: per AGENTS.md "Vocabulary (Critical)", user-facing
// labels for `answer_mentioned` must say "mentioned" / "not-mentioned" and
// labels for `citation_state` must say "cited" / "not-cited". The legacy
// umbrella term "visibility" is permitted only when explicitly disambiguated
// (e.g. "Visibility Gap (Citations + Mentions)"). The literals below are
// unambiguous user-facing labels that conflate the two signals — bare
// `'visible'` is excluded because it has legitimate uses (DOM API, the
// legacy `VisibilityState` enum value) that lint cannot disambiguate.
const bannedMetricLiteralRule = createRestrictedSyntaxRule({
  description: 'Disallow legacy / conflated AEO metric literals in operator-facing code.',
  restrictions: [{
    selector: "Literal[value=/^(not-vis|visibility run|visibility sweep|visibility report|answer rate|answer-rate|answerRate)$/]",
    message: 'Use canonical AEO vocabulary: "mentioned" / "not-mentioned" for answer-text presence, "cited" / "not-cited" for source-list presence. See AGENTS.md "Vocabulary (Critical)".',
  }, {
    selector: "Literal[value=/^(paid mentions|paid citations|ad mentions|ad citations|sponsored mentions|sponsored citations|paid-mention|paid-citation)$/]",
    message: 'Paid-surface metrics are "paid" / "sponsored" (impressions, clicks, spend) — never combined with "mentioned"/"cited", which mean organic answer-text / source-list presence. See AGENTS.md "Vocabulary (Critical)".',
  }],
})

// Drift guard: GA4 dimension/metric names must come from `GA4_DIMENSIONS` /
// `GA4_METRICS` in `packages/integration-google-analytics/src/constants.ts`.
// CI broke once when source and test drifted on `sessionDefaultChannelGroup`
// vs `…Grouping`; the constant makes that class of failure impossible.
const inlineGa4DimensionRule = createRestrictedSyntaxRule({
  description: 'Disallow inline GA4 dimension/metric name literals outside constants.ts.',
  restrictions: [{
    selector: "Literal[value=/^(sessionSource|sessionMedium|sessionManualSource|sessionManualMedium|firstUserSource|firstUserMedium|sessionDefaultChannelGroup|sessionDefaultChannelGrouping|landingPagePlusQueryString)$/]",
    message: 'Use GA4_DIMENSIONS from ./constants.ts — never inline raw dimension names. See packages/integration-google-analytics/src/constants.ts.',
  }],
})

// Drift guard: AI-engine hostnames in production code must come from
// `AI_ENGINE_DOMAINS` in `packages/contracts/src/ai-engines.ts`. Tests are
// exempt because fixtures are local to their assertions and don't drift
// across files.
const inlineAiHostnameRule = createRestrictedSyntaxRule({
  description: 'Disallow raw AI-provider hostname literals in production code.',
  restrictions: [{
    selector: "Literal[value=/^(openai\\.com|chatgpt\\.com|claude\\.ai|perplexity\\.ai|gemini\\.google\\.com|bard\\.google\\.com|copilot\\.microsoft\\.com|meta\\.ai|grok\\.com|you\\.com|phind\\.com|anthropic\\.com|googleapis\\.com|vertexaisearch\\.cloud\\.google\\.com)$/]",
    message: 'Use AI_ENGINE_DOMAINS / AI_PROVIDER_INFRA_DOMAINS / ANTHROPIC_API_DOMAIN / GOOGLE_APIS_DOMAIN / VERTEX_AI_SEARCH_PROXY_DOMAIN from @ainyc/canonry-contracts — never inline raw AI-provider hostnames in production code.',
  }],
})

// SDK enforcement (web): every web call into the canonry API must flow through
// the generated `@ainyc/canonry-api-client` SDK (raw call or TanStack helper),
// with auth + 401/403 handling provided by the shared `heyClient` from
// `apps/web/src/api.ts`. Raw `fetch()` to API URLs bypasses every spec-derived
// contract and the auth interceptor.
const rawHttpWebRule = createRestrictedSyntaxRule({
  description: 'Disallow raw fetch() / XMLHttpRequest in web code — call the generated SDK.',
  restrictions: [{
    selector: "CallExpression[callee.name='fetch']",
    message: 'Use the generated `@ainyc/canonry-api-client` SDK (via `heyClient` from `apps/web/src/api.ts`) instead of raw `fetch()`. Spec drift + auth interceptor bypass is silent and pernicious. For an endpoint missing a typed DTO, add a Zod schema in `packages/contracts` and flip the route to `jsonResponse(...)` first.',
  }, {
    selector: "NewExpression[callee.name='XMLHttpRequest']",
    message: 'Use the generated `@ainyc/canonry-api-client` SDK (via `heyClient` from `apps/web/src/api.ts`) instead of `XMLHttpRequest`.',
  }],
})

// Analog of the web SDK enforcement, for the CLI. Every CLI / job runner /
// server-internal call into the canonry API must go through `ApiClient` (which
// delegates to the generated SDK via `invoke()`), not raw `fetch()`.
const rawHttpCliRule = createRestrictedSyntaxRule({
  description: 'Disallow raw fetch() in CLI code — call the canonry API through ApiClient.',
  restrictions: [{
    selector: "CallExpression[callee.name='fetch']",
    message: 'Use the generated `@ainyc/canonry-api-client` SDK via `ApiClient` / `createApiClient()` (which routes through `invoke()` for tracing, CliError mapping, and the base-path probe) instead of raw `fetch()`. If you genuinely need raw `fetch()` for an external (non-canonry) HTTP call, add the file to the `ignores` list in `eslint.config.js` with a one-line comment naming the external service.',
  }],
})

// One object per plugin namespace, shared BY REFERENCE across every config
// block that uses it: flat config throws `Cannot redefine plugin` when the same
// namespace is given two different objects, and both namespaces below back more
// than one block.
const canonryVocabularyPlugin = {
  rules: {
    'no-banned-metric-literal': bannedMetricLiteralRule,
    'no-question-ui-copy': noQuestionUiCopyRule,
  },
}

const canonryGuardsPlugin = {
  rules: {
    'no-inline-ga4-dimension': inlineGa4DimensionRule,
    'no-inline-ai-hostname': inlineAiHostnameRule,
    'no-raw-http-web': rawHttpWebRule,
    'no-raw-http-cli': rawHttpCliRule,
  },
}

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'apps/**/dist/',
      'packages/**/dist/',
      // Auto-generated hey-api client — never hand-edited; lint warnings
      // would only show up to be regenerated away on the next `pnpm gen`.
      'packages/api-client-generated/src/generated/**',
    ],
  },
  {
    // CLI commands must be fully non-interactive. readline is only allowed in
    // init.ts as a human convenience — all init values are also passable via flags.
    files: ['packages/canonry/src/commands/**/*.ts', 'packages/canonry/src/cli-commands/**/*.ts'],
    ignores: ['packages/canonry/src/commands/init.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'node:readline', message: 'CLI commands must be non-interactive. Accept values via flags, env vars, or config.yaml.' },
          { name: 'readline', message: 'CLI commands must be non-interactive. Accept values via flags, env vars, or config.yaml.' },
        ],
      }],
    },
  },
  {
    // Vocabulary enforcement — see `bannedMetricLiteralRule` above for what and
    // why. Overlaps the AI-hostname guard on all four trees, the CLI raw-HTTP
    // guard on the two packages/canonry trees, and the web raw-HTTP guard on
    // apps/web/src. It composes with all three: each has its own rule id.
    files: [
      'packages/canonry/src/commands/**/*.ts',
      'packages/canonry/src/cli-commands/**/*.ts',
      'packages/api-routes/src/**/*.ts',
      'apps/web/src/**/*.ts',
      'apps/web/src/**/*.tsx',
    ],
    plugins: { 'canonry-vocabulary': canonryVocabularyPlugin },
    rules: { 'canonry-vocabulary/no-banned-metric-literal': 'error' },
  },
  {
    // GA4 dimension drift guard — see `inlineGa4DimensionRule` above. This tree
    // is also matched by the AI-hostname guard's `packages/integration-*` glob.
    files: ['packages/integration-google-analytics/src/**/*.ts'],
    ignores: ['packages/integration-google-analytics/src/constants.ts'],
    plugins: { 'canonry-guards': canonryGuardsPlugin },
    rules: { 'canonry-guards/no-inline-ga4-dimension': 'error' },
  },
  {
    // AI-provider hostname drift guard — see `inlineAiHostnameRule` above. Tests
    // are exempt because fixtures are local to their assertions and don't drift
    // across files.
    files: [
      'packages/canonry/src/**/*.ts',
      'packages/api-routes/src/**/*.ts',
      'packages/provider-*/src/**/*.ts',
      'packages/integration-*/src/**/*.ts',
      'packages/intelligence/src/**/*.ts',
      'apps/**/src/**/*.ts',
      'apps/**/src/**/*.tsx',
    ],
    ignores: ['packages/contracts/src/ai-engines.ts'],
    plugins: { 'canonry-guards': canonryGuardsPlugin },
    rules: { 'canonry-guards/no-inline-ai-hostname': 'error' },
  },
  {
    files: ['**/*.js', '**/*.ts', '**/*.tsx'],
    extends: [regexpPlugin.configs['flat/recommended']],
  },
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme', 'hack', 'xxx'], location: 'start' }],
    },
  },
  {
    // Type-aware rules — limited to `src/` because test files aren't in package tsconfigs'
    // `include` and would trigger projectService parsing errors. Adds @typescript-eslint/no-unnecessary-condition
    // to catch always-true/always-false comparisons (e.g. checking !== undefined on a narrowed type).
    files: ['**/src/**/*.ts', '**/src/**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Kept as `warn`: 363 pre-existing findings, mostly defensive `?.`/`??` noise. Drain
      // incrementally before flipping to `error`.
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      // Soundness rules promoted to error — catch real bug classes (forgotten awaits,
      // misused promises, `any` leaking into typed code, broken template-string output,
      // unbound methods, awaiting non-thenables).
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/unbound-method': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
      // Lower-value or noisy — left off for now; revisit after the soundness set is drained.
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    // Rules of Hooks. A hook called after an early return changes the hook
    // count between renders and throws at runtime; the embed shell hit this on
    // every cold load because it always renders the loading branch first.
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    plugins: { 'react-hooks': reactHooksPlugin },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // ChartPrimitives is the only file allowed to import directly from recharts.
    // All other web files must use ChartPrimitives and may not use alternative chart libs.
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    ignores: ['apps/web/src/components/shared/ChartPrimitives.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          ...ALT_CHART_LIB_PATHS,
          { name: 'recharts', message: 'Import from ChartPrimitives.js instead of recharts directly.' },
        ],
        patterns: [
          ...ALT_CHART_LIB_PATTERNS,
          { group: ['recharts/*'], message: 'Import from ChartPrimitives.js instead of recharts directly.' },
        ],
      }],
    },
  },
  {
    // ChartPrimitives itself can import recharts but not alternative chart libs
    files: ['apps/web/src/components/shared/ChartPrimitives.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-restricted-imports': ['error', {
        paths: ALT_CHART_LIB_PATHS,
        patterns: ALT_CHART_LIB_PATTERNS,
      }],
    },
  },
  {
    // Web SDK enforcement — see `rawHttpWebRule` above.
    //
    // The two thin shim files (`api.ts` for the typed wrappers around SDK
    // calls; `api-aero.ts` for the SSE prompt stream + transcript reads
    // that ride on `EventSource`) are excluded — those are the only places
    // raw `fetch()` is legitimate. Tests are also excluded because they
    // stub `globalThis.fetch` via `vi.stubGlobal`.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    ignores: [
      'apps/web/src/api.ts',
      'apps/web/src/api-aero.ts',
    ],
    plugins: { 'canonry-guards': canonryGuardsPlugin },
    rules: { 'canonry-guards/no-raw-http-web': 'error' },
  },
  {
    // CLI SDK enforcement — see `rawHttpCliRule` above. The only legitimate raw
    // fetches are inside `client.ts` itself: the `/health` probe (bootstrap
    // check that lives outside `/api/v1`) and the SSE `streamPost()` (the SDK
    // can't represent text/event-stream cleanly). Both are bounded by file.
    files: ['packages/canonry/src/**/*.ts'],
    ignores: [
      // `ApiClient`'s `/health` probe + SSE prompt stream.
      'packages/canonry/src/client.ts',
      // External HTTP — not the canonry API:
      // - daemon.ts probes localhost `/health` for serve-readiness
      // - sitemap-parser.ts fetches the user's own sitemap.xml URL
      // - telemetry.ts POSTs to the public telemetry collector
      // - update-check.ts polls npm dist-tags
      // - engine-routes.ts reads a configured OpenAI-compatible `/models` catalog
      'packages/canonry/src/commands/daemon.ts',
      'packages/canonry/src/engine-routes.ts',
      'packages/canonry/src/sitemap-parser.ts',
      'packages/canonry/src/telemetry.ts',
      'packages/canonry/src/update-check.ts',
    ],
    plugins: { 'canonry-guards': canonryGuardsPlugin },
    rules: { 'canonry-guards/no-raw-http-cli': 'error' },
  },
  {
    // Design-token ratchet (Phase 3 COMPLETE): no raw Tailwind palette utilities
    // anywhere in themeable web code. Only the two permanent exclusions are
    // ignored — the migration allowlist is empty and has been removed.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    ignores: [...RAW_PALETTE_PERMANENT_EXCLUSIONS],
    plugins: { 'design-tokens': { rules: { 'no-literal-palette': noLiteralPaletteRule } } },
    rules: { 'design-tokens/no-literal-palette': 'error' },
  },
  {
    // Vocabulary ratchet: web UI copy says "query", never "question". Scoped to
    // apps/web/src: the frozen route paths and MCP tool names live in
    // packages/api-routes + packages/canonry, so keeping the rule off those
    // trees exempts them structurally instead of by regex.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    ignores: [...QUESTION_COPY_PERMANENT_EXCLUSIONS],
    plugins: { 'canonry-vocabulary': canonryVocabularyPlugin },
    rules: { 'canonry-vocabulary/no-question-ui-copy': 'error' },
  },
)

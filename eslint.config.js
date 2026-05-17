import js from '@eslint/js'
import globals from 'globals'
import regexpPlugin from 'eslint-plugin-regexp'
import tseslint from 'typescript-eslint'

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
    // Vocabulary enforcement: per AGENTS.md "Vocabulary (Critical)", user-facing
    // labels for `answer_mentioned` must say "mentioned" / "not-mentioned" and
    // labels for `citation_state` must say "cited" / "not-cited". The legacy
    // umbrella term "visibility" is permitted only when explicitly disambiguated
    // (e.g. "Visibility Gap (Citations + Mentions)"). The literals below are
    // unambiguous user-facing labels that conflate the two signals — bare
    // `'visible'` is excluded because it has legitimate uses (DOM API, the
    // legacy `VisibilityState` enum value) that lint cannot disambiguate.
    files: [
      'packages/canonry/src/commands/**/*.ts',
      'packages/canonry/src/cli-commands/**/*.ts',
      'packages/api-routes/src/**/*.ts',
      'apps/web/src/**/*.ts',
      'apps/web/src/**/*.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "Literal[value=/^(not-vis|visibility run|visibility sweep|visibility report|answer rate|answer-rate|answerRate)$/]",
        message: 'Use canonical AEO vocabulary: "mentioned" / "not-mentioned" for answer-text presence, "cited" / "not-cited" for source-list presence. See AGENTS.md "Vocabulary (Critical)".',
      }],
    },
  },
  {
    // Drift guard: GA4 dimension/metric names must come from `GA4_DIMENSIONS` /
    // `GA4_METRICS` in `packages/integration-google-analytics/src/constants.ts`.
    // CI broke once when source and test drifted on `sessionDefaultChannelGroup`
    // vs `…Grouping`; the constant makes that class of failure impossible.
    files: ['packages/integration-google-analytics/src/**/*.ts'],
    ignores: ['packages/integration-google-analytics/src/constants.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "Literal[value=/^(sessionSource|sessionMedium|sessionManualSource|sessionManualMedium|firstUserSource|firstUserMedium|sessionDefaultChannelGroup|sessionDefaultChannelGrouping|landingPagePlusQueryString)$/]",
        message: 'Use GA4_DIMENSIONS from ./constants.ts — never inline raw dimension names. See packages/integration-google-analytics/src/constants.ts.',
      }],
    },
  },
  {
    // Drift guard: AI-engine hostnames in production code must come from
    // `AI_ENGINE_DOMAINS` in `packages/contracts/src/ai-engines.ts`. Tests are
    // exempt because fixtures are local to their assertions and don't drift
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
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "Literal[value=/^(openai\\.com|chatgpt\\.com|claude\\.ai|perplexity\\.ai|gemini\\.google\\.com|bard\\.google\\.com|copilot\\.microsoft\\.com|meta\\.ai|grok\\.com|you\\.com|phind\\.com|anthropic\\.com|googleapis\\.com|vertexaisearch\\.cloud\\.google\\.com)$/]",
        message: 'Use AI_ENGINE_DOMAINS / AI_PROVIDER_INFRA_DOMAINS / ANTHROPIC_API_DOMAIN / GOOGLE_APIS_DOMAIN / VERTEX_AI_SEARCH_PROXY_DOMAIN from @ainyc/canonry-contracts — never inline raw AI-provider hostnames in production code.',
      }],
    },
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
)

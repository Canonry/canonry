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
    ignores: ['dist/', 'node_modules/', 'apps/**/dist/', 'packages/**/dist/'],
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
      // Surfaced as `warn` to ship the rule without breaking CI on the ~360 pre-existing findings
      // (mostly defensive `?.` chains on already-narrowed types). Plan: clean up warns incrementally,
      // then flip to `error`. The original always-true `selectedRun !== undefined` bug class is
      // already caught — warnings show up in CI output, so new regressions are visible.
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      // The recommendedTypeChecked preset turns on a lot of opinionated rules. We only want the one above
      // for now — disable the rest to avoid landing a giant cleanup we didn't scope for.
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-duplicate-type-constituents': 'off',
      '@typescript-eslint/no-implied-eval': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
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

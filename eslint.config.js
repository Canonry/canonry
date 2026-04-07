import js from '@eslint/js'
import globals from 'globals'
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
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^[_A-Z]' }],
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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^[_A-Z]' }],
      'no-warning-comments': ['warn', { terms: ['todo', 'fixme', 'hack', 'xxx'], location: 'start' }],
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

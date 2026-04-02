import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'apps/**/dist/', 'packages/**/dist/'],
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
    },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'chart.js', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'highcharts', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'd3', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'victory', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: '@nivo/core', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'plotly.js', message: 'Use Recharts via ChartPrimitives instead.' },
        ],
        patterns: [
          { group: ['chart.js/*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['highcharts/*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['d3-*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['victory-*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['@nivo/*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['plotly.js-*'], message: 'Use Recharts via ChartPrimitives instead.' },
        ],
      }],
    },
  },
  {
    // ChartPrimitives is the only file allowed to import directly from recharts
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    ignores: ['apps/web/src/components/shared/ChartPrimitives.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'chart.js', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'highcharts', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'd3', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'victory', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: '@nivo/core', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'plotly.js', message: 'Use Recharts via ChartPrimitives instead.' },
          { name: 'recharts', message: 'Import from ChartPrimitives.js instead of recharts directly.' },
        ],
        patterns: [
          { group: ['chart.js/*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['highcharts/*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['d3-*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['victory-*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['@nivo/*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['plotly.js-*'], message: 'Use Recharts via ChartPrimitives instead.' },
          { group: ['recharts/*'], message: 'Import from ChartPrimitives.js instead of recharts directly.' },
        ],
      }],
    },
  },
)

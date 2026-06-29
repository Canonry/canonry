import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: [path.resolve(import.meta.dirname, '../../test-setup/vitest-defaults.ts')],
  },
})

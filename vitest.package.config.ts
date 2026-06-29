import path from 'node:path'
import { defineConfig } from 'vitest/config'

const rootDir = import.meta.dirname

export default defineConfig({
  test: {
    root: process.cwd(),
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: [path.resolve(rootDir, 'test-setup/vitest-defaults.ts')],
  },
})

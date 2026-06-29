import path from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: [path.resolve(import.meta.dirname, '../../test-setup/vitest-defaults.ts')],
    environment: 'jsdom',
  },
}))

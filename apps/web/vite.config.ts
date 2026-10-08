import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// In dev mode, proxy API requests to canonry serve (default port 4100)
const cannonryTarget = process.env.CANONRY_API_URL ?? 'http://127.0.0.1:4100'
const thirdPartyNotices = readFileSync(
  resolve(import.meta.dirname, '../../packages/canonry/THIRD_PARTY_NOTICES.md'),
  'utf8',
)

export default defineConfig({
  // Use relative asset paths so the build works at any sub-path.
  // The server injects a <base href="..."> tag at runtime via --base-path.
  base: './',
  plugins: [
    tailwindcss(),
    react(),
    {
      name: 'bundle-third-party-notices',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'THIRD_PARTY_NOTICES.md',
          source: thirdPartyNotices,
        })
      },
    },
  ],
  resolve: {
    // Force recharts (and its redux deps) to resolve from apps/web/node_modules,
    // not from the pnpm store peer-dep variant which has incomplete ESM files.
    dedupe: ['recharts', '@reduxjs/toolkit', 'react-redux', 'redux'],
  },
  build: {
    rollupOptions: {
      output: {
        // Split large vendors into separate chunks so the main bundle stays
        // below the 500 kB warning threshold and big libs cache independently
        // of app code.
        manualChunks(id) {
          if (id.includes('lucide-react')) return 'vendor-lucide'
          if (id.includes('yaml')) return 'vendor-yaml'
          if (!id.includes('node_modules')) return undefined
          if (id.includes('recharts')) return 'vendor-recharts'
          if (id.includes('@tanstack')) return 'vendor-tanstack'
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('micromark') || id.includes('mdast') || id.includes('unist')) return 'vendor-markdown'
          if (id.includes('@radix-ui')) return 'vendor-radix'
          return undefined
        },
      },
    },
  },
  server: {
    // `dev` listens on every interface and reaches canonry serve over
    // loopback with Host rewritten to the target. `xfwd` adds X-Forwarded-For,
    // so a LAN visitor's call never looks like a direct local request (which
    // may set the first dashboard password without the root API key).
    proxy: {
      '/api/v1': {
        target: cannonryTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/health': {
        target: cannonryTarget,
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
})

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// In dev mode, proxy API requests to canonry serve (default port 4100)
const cannonryTarget = process.env.CANONRY_API_URL ?? 'http://127.0.0.1:4100'

export default defineConfig({
  // Use relative asset paths so the build works at any sub-path.
  // The server injects a <base href="..."> tag at runtime via --base-path.
  base: './',
  plugins: [tailwindcss(), react()],
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
    proxy: {
      '/api/v1': {
        target: cannonryTarget,
        changeOrigin: true,
      },
      '/health': {
        target: cannonryTarget,
        changeOrigin: true,
      },
    },
  },
})

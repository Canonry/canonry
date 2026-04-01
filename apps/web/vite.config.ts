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

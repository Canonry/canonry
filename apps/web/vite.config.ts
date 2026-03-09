import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.API_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000'
const workerTarget = process.env.WORKER_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3001'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api-health': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: () => '/health',
      },
      '/worker-health': {
        target: workerTarget,
        changeOrigin: true,
        rewrite: () => '/health',
      },
    },
  },
})

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// In dev mode, proxy API requests to canonry serve (default port 4100)
const cannonryTarget = process.env.CANONRY_API_URL ?? 'http://127.0.0.1:4100'

export default defineConfig({
  plugins: [tailwindcss(), react()],
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

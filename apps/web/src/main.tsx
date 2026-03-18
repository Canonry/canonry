import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'

import { App } from './App.js'
import { createQueryClient } from './queries/query-client.js'
import './styles.css'

const queryClient = createQueryClient()

const root = document.getElementById('root')

if (!root) {
  throw new Error('Expected #root element for web app bootstrap.')
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)

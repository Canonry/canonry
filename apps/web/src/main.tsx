import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createQueryClient } from './queries/query-client.js'
import { createAppRouter } from './router/router.js'
import { Toaster } from './components/layout/Toaster.js'
import './styles.css'

const queryClient = createQueryClient()
const router = createAppRouter(queryClient)

const root = document.getElementById('root')

if (!root) {
  throw new Error('Expected #root element for web app bootstrap.')
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AuthGate } from './components/auth/AuthGate.js'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Expected #root element for web app bootstrap.')
}

createRoot(root).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
)

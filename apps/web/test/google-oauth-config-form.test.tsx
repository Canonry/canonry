import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { GoogleOAuthConfigForm } from '../src/components/settings/GoogleOAuthConfigForm.js'

afterEach(() => {
  cleanup()
})

test('Google OAuth settings shows both local redirect URIs to register', () => {
  const previousConfig = window.__CANONRY_CONFIG__
  window.__CANONRY_CONFIG__ = { basePath: '/canonry/' }
  onTestFinished(() => {
    window.__CANONRY_CONFIG__ = previousConfig
  })

  render(<GoogleOAuthConfigForm onSaved={() => {}} />)

  expect(window.location.origin, 'native Vitest jsdom fixture origin').toBe('http://localhost:3000')
  expect(screen.getByText('Authorized redirect URIs')).toBeTruthy()
  expect(screen.getByText('Search Console and Business Profile')).toBeTruthy()
  expect(screen.getByText('Google Ads and Tag Manager')).toBeTruthy()
  expect(screen.getByText('http://localhost:3000/canonry/api/v1/google/callback')).toBeTruthy()
  expect(screen.getByText('http://localhost:3000/canonry/api/v1/google-marketing/callback')).toBeTruthy()
})

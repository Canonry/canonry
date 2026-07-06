import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { buildGoogleRedirectUri, resolveLocalGooglePublicUrl } from '../src/api.js'
import { GoogleOAuthConfigForm } from '../src/components/settings/GoogleOAuthConfigForm.js'

afterEach(() => {
  cleanup()
})

test('Google OAuth settings shows the local redirect URI to register', () => {
  const previousConfig = window.__CANONRY_CONFIG__
  window.__CANONRY_CONFIG__ = { basePath: '/canonry/' }
  onTestFinished(() => {
    window.__CANONRY_CONFIG__ = previousConfig
  })

  render(<GoogleOAuthConfigForm onSaved={() => {}} />)

  const publicUrl = resolveLocalGooglePublicUrl(window.location, '/canonry/')
  if (!publicUrl) throw new Error('expected jsdom to run on a loopback URL')
  expect(screen.getByText('Authorized redirect URI')).toBeTruthy()
  expect(screen.getByText(buildGoogleRedirectUri(publicUrl))).toBeTruthy()
})

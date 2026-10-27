import { useState } from 'react'

import { Button } from '../ui/button.js'
import {
  buildGoogleMarketingRedirectUri,
  buildGoogleRedirectUri,
  resolveLocalGooglePublicUrl,
  updateGoogleAuthConfig,
} from '../../api.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'

export function GoogleOAuthConfigForm({ onSaved }: { onSaved: () => void }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0
  const localPublicUrl = typeof window === 'undefined'
    ? undefined
    : resolveLocalGooglePublicUrl(window.location, window.__CANONRY_CONFIG__?.basePath)
  const redirectUri = localPublicUrl ? buildGoogleRedirectUri(localPublicUrl) : undefined
  const marketingRedirectUri = localPublicUrl ? buildGoogleMarketingRedirectUri(localPublicUrl) : undefined

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      await updateGoogleAuthConfig({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      })
      setClientId('')
      setClientSecret('')
      setSuccess(true)
      addToast({
        title: 'Google OAuth app updated',
        detail: 'Dashboard Google credentials were saved.',
        tone: 'positive',
        dedupeKey: 'settings:google-oauth',
        dedupeMode: 'replace',
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Google OAuth credentials')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 material-base p-3 space-y-2">
      <div>
        <div className="flex items-center justify-between">
          <label className="text-label-14 text-secondary" htmlFor="google-client-id">Client ID</label>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            className="text-label-14 text-secondary hover:text-neutral underline underline-offset-2"
          >
            Google Cloud {'\u2197'}
          </a>
        </div>
        <input
          id="google-client-id"
          type="text"
          className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none"
          placeholder="Google OAuth client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </div>
      <div>
        <label className="text-label-14 text-secondary" htmlFor="google-client-secret">Client secret</label>
        <input
          id="google-client-secret"
          type="password"
          className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none"
          placeholder="Google OAuth client secret"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </div>
      {redirectUri && marketingRedirectUri && (
        <div className="material-base px-3 py-2">
          <p className="text-copy-14 text-secondary">Authorized redirect URIs</p>
          <dl className="mt-1 space-y-2 text-label-12">
            <div>
              <dt className="text-muted">Search Console and Business Profile</dt>
              <dd><code className="block break-all text-strong">{redirectUri}</code></dd>
            </div>
            <div>
              <dt className="text-muted">Google Ads and Tag Manager</dt>
              <dd><code className="block break-all text-strong">{marketingRedirectUri}</code></dd>
            </div>
          </dl>
        </div>
      )}
      {error && <p className="text-copy-14 text-negative-400">{error}</p>}
      {success && <p className="text-copy-14 text-positive-400">Google OAuth credentials updated.</p>}
      <Button type="button" size="sm" disabled={!canSave || saving} onClick={asyncHandler(handleSave)}>
        {saving ? 'Saving...' : 'Save Google OAuth app'}
      </Button>
    </div>
  )
}

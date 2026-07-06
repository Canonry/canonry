import { useState } from 'react'

import { Button } from '../ui/button.js'
import { buildGoogleRedirectUri, resolveLocalGooglePublicUrl, updateGoogleAuthConfig } from '../../api.js'
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
    <div className="mt-3 rounded-lg border border-base bg-bg-elevated/40 p-3 space-y-2">
      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs text-muted" htmlFor="google-client-id">Client ID</label>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-muted hover:text-neutral underline underline-offset-2"
          >
            Google Cloud {'\u2197'}
          </a>
        </div>
        <input
          id="google-client-id"
          type="text"
          className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
          placeholder="Google OAuth client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs text-muted" htmlFor="google-client-secret">Client secret</label>
        <input
          id="google-client-secret"
          type="password"
          className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
          placeholder="Google OAuth client secret"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </div>
      <p className="text-[11px] text-muted">
        These credentials are stored in <code>~/.canonry/config.yaml</code>. Project-level Search Console connections are created separately per canonical domain.
      </p>
      {redirectUri && (
        <div className="rounded border border-default bg-surface px-3 py-2">
          <p className="text-[11px] text-muted">Authorized redirect URI</p>
          <code className="mt-1 block break-all text-xs text-strong">{redirectUri}</code>
        </div>
      )}
      {error && <p className="text-xs text-negative-400">{error}</p>}
      {success && <p className="text-xs text-positive-400">Google OAuth credentials updated.</p>}
      <Button type="button" size="sm" disabled={!canSave || saving} onClick={asyncHandler(handleSave)}>
        {saving ? 'Saving...' : 'Save Google OAuth app'}
      </Button>
    </div>
  )
}

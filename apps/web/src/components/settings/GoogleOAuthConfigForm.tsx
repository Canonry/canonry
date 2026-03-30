import { useState } from 'react'

import { Button } from '../ui/button.js'
import { updateGoogleAuthConfig } from '../../api.js'
import { addToast } from '../../lib/toast-store.js'

export function GoogleOAuthConfigForm({ onSaved }: { onSaved: () => void }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0

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
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs text-zinc-500" htmlFor="google-client-id">Client ID</label>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
          >
            Google Cloud {'\u2197'}
          </a>
        </div>
        <input
          id="google-client-id"
          type="text"
          className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          placeholder="Google OAuth client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs text-zinc-500" htmlFor="google-client-secret">Client secret</label>
        <input
          id="google-client-secret"
          type="password"
          className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          placeholder="Google OAuth client secret"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </div>
      <p className="text-[11px] text-zinc-500">
        These credentials are stored in <code>~/.canonry/config.yaml</code>. Project-level Search Console connections are created separately per canonical domain.
      </p>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">Google OAuth credentials updated.</p>}
      <Button type="button" size="sm" disabled={!canSave || saving} onClick={handleSave}>
        {saving ? 'Saving...' : 'Save Google OAuth app'}
      </Button>
    </div>
  )
}

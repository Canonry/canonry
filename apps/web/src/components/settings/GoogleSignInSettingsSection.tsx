import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError, fetchGoogleSignInSettings, updateGoogleSignInSettings } from '../../api.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { Button } from '../ui/button.js'
import { ToneBadge } from '../shared/ToneBadge.js'

const GOOGLE_SETTINGS_KEY = ['people-access', 'google-settings'] as const
const AUTH_PROVIDERS_KEY = ['account', 'providers'] as const

export const GOOGLE_SIGN_IN_COPY = {
  heading: 'Google sign-in',
  configured: 'Configured, disabled',
  disabled: 'Not configured',
  enabled: 'Enabled',
  changeSettings: 'Change settings',
  saveAndEnable: 'Save and enable Google sign-in',
  enable: 'Enable Google sign-in',
  disable: 'Disable Google sign-in',
  callback: 'Authorized redirect URI',
  copyCallback: 'Copy callback URL',
  clientIdLabel: 'Client ID',
  clientSecretLabel: 'Client secret',
  replaceClientSecretLabel: 'Replace client secret',
  environmentManaged: 'Configured by the environment. Client credentials are read-only here.',
  callbackUnavailable: 'The authorized redirect URI is unavailable. Set publicUrl in Canonry config, restart the instance, then return here.',
  setupGuide: 'Google sign-in setup guide',
  ownerLinkInstruction: 'Google sign-in is ready for invitations. To use it with your current account, open Account from your name in the sidebar and link Google after confirming your password.',
} as const

export const GOOGLE_SIGN_IN_TEST_IDS = {
  section: 'google-sign-in-settings',
  callback: 'google-sign-in-callback',
  callbackUnavailable: 'google-sign-in-callback-unavailable',
  editor: 'google-sign-in-editor',
  ownerLinkInstruction: 'google-sign-in-owner-link-instruction',
  status: 'google-sign-in-status',
} as const

async function copy(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

function statusCopy(settings: { enabled: boolean; configured: boolean }): string {
  if (settings.enabled) return GOOGLE_SIGN_IN_COPY.enabled
  return settings.configured ? GOOGLE_SIGN_IN_COPY.configured : GOOGLE_SIGN_IN_COPY.disabled
}

/** Google dashboard sign-in is independent from project Google integrations. */
export function GoogleSignInSettingsSection() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: GOOGLE_SETTINGS_KEY, queryFn: fetchGoogleSignInSettings })
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const settings = settingsQuery.data
  const canEdit = settings?.editable === true
  const requiresCredentials = !settings?.configured
  const hasCallback = Boolean(settings?.callbackUrl)
  const canSave = canEdit && hasCallback && !saving && (!requiresCredentials || (clientId.trim().length > 0 && clientSecret.length > 0))

  async function refreshAuthConfiguration() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: GOOGLE_SETTINGS_KEY }),
      queryClient.invalidateQueries({ queryKey: AUTH_PROVIDERS_KEY }),
    ])
  }

  async function saveAndEnable() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await updateGoogleSignInSettings({
        enabled: true,
        clientId: clientId.trim() || undefined,
        clientSecret: clientSecret || undefined,
      })
      setClientId('')
      setClientSecret('')
      setShowEditor(false)
      await refreshAuthConfiguration()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Google sign-in settings could not be saved. Try again.')
    } finally {
      setSaving(false)
    }
  }

  async function changeEnabled(enabled: boolean) {
    if (!canEdit || saving) return
    setSaving(true)
    setError(null)
    try {
      await updateGoogleSignInSettings({ enabled })
      await refreshAuthConfiguration()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Google sign-in settings could not be saved. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="page-section-divider max-w-3xl" aria-labelledby="google-sign-in-heading" data-testid={GOOGLE_SIGN_IN_TEST_IDS.section}>
      <div className="section-head">
        <div><p className="eyebrow eyebrow-soft">Instance access</p><h2 id="google-sign-in-heading">{GOOGLE_SIGN_IN_COPY.heading}</h2></div>
        {settings ? <ToneBadge tone={settings.enabled ? 'positive' : settings.configured ? 'caution' : 'neutral'} data-testid={GOOGLE_SIGN_IN_TEST_IDS.status}>{statusCopy(settings)}</ToneBadge> : null}
      </div>
      <p className="max-w-prose text-sm text-secondary">Use a separate Google OAuth app for dashboard sign-in. Project Google connections stay in Connections.</p>

      {settingsQuery.isLoading ? <p className="mt-4 text-sm text-secondary" role="status">Loading Google sign-in settings…</p> : null}
      {settingsQuery.isError ? <p className="mt-4 text-sm text-negative" role="alert">Google sign-in settings could not be loaded.</p> : null}
      {settings ? <div className="mt-5 space-y-4">
        {settings.callbackUrl ? <div className="max-w-2xl space-y-1"><label className="text-sm font-medium text-secondary" htmlFor="google-sign-in-callback">{GOOGLE_SIGN_IN_COPY.callback}</label><div className="flex flex-wrap gap-2"><input id="google-sign-in-callback" data-testid={GOOGLE_SIGN_IN_TEST_IDS.callback} className="min-w-0 flex-1 rounded-md border border-base bg-bg px-3 py-2 font-mono text-sm text-heading" readOnly value={settings.callbackUrl} /><Button type="button" variant="outline" size="sm" disabled={saving} onClick={asyncHandler(async () => { if (!(await copy(settings.callbackUrl!))) setError('The callback URL could not be copied.') })}>{GOOGLE_SIGN_IN_COPY.copyCallback}</Button></div></div> : null}
        {!settings.callbackUrl ? <p className="max-w-prose text-sm text-caution" data-testid={GOOGLE_SIGN_IN_TEST_IDS.callbackUnavailable}>{GOOGLE_SIGN_IN_COPY.callbackUnavailable} <a className="underline underline-offset-2 hover:text-heading" href="https://github.com/Canonry/canonry/blob/main/docs/google-sign-in.md#set-up-an-instance" target="_blank" rel="noopener noreferrer">{GOOGLE_SIGN_IN_COPY.setupGuide}</a>.</p> : null}
        {settings.enabled ? <p className="max-w-prose text-sm text-secondary" data-testid={GOOGLE_SIGN_IN_TEST_IDS.ownerLinkInstruction}>{GOOGLE_SIGN_IN_COPY.ownerLinkInstruction}</p> : null}

        {settings.environmentOverride ? <div className="space-y-2"><p className="text-sm text-secondary">{GOOGLE_SIGN_IN_COPY.environmentManaged}</p>{settings.clientId ? <label className="block max-w-2xl space-y-1" htmlFor="google-sign-in-client-id"><span className="text-sm font-medium text-secondary">{GOOGLE_SIGN_IN_COPY.clientIdLabel}</span><input id="google-sign-in-client-id" className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading" readOnly value={settings.clientId} /></label> : null}<p className="text-sm text-secondary">Client secret: {settings.hasClientSecret ? 'Stored by this environment' : 'Not configured'}</p></div> : <>
          {(!settings.configured || showEditor) ? <div className="max-w-2xl space-y-3 border-t border-default pt-4" data-testid={GOOGLE_SIGN_IN_TEST_IDS.editor}>
            {!settings.configured && settings.callbackUrl ? <p className="text-sm text-secondary">Register the redirect URI in <a className="underline underline-offset-2 hover:text-heading" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud</a>, then enter the OAuth app credentials below.</p> : null}
            <label className="block space-y-1" htmlFor="google-sign-in-client-id"><span className="text-sm font-medium text-secondary">{GOOGLE_SIGN_IN_COPY.clientIdLabel}</span><input id="google-sign-in-client-id" className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading" value={clientId} placeholder={settings.clientId ?? undefined} onChange={event => setClientId(event.target.value)} /></label>
            <label className="block space-y-1" htmlFor="google-sign-in-client-secret"><span className="text-sm font-medium text-secondary">{settings.hasClientSecret ? GOOGLE_SIGN_IN_COPY.replaceClientSecretLabel : GOOGLE_SIGN_IN_COPY.clientSecretLabel}</span><input id="google-sign-in-client-secret" className="w-full rounded-md border border-base bg-bg px-3 py-2 text-sm text-heading" type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} /></label>
            <Button type="button" disabled={!canSave} onClick={asyncHandler(saveAndEnable)}>{saving ? 'Saving…' : GOOGLE_SIGN_IN_COPY.saveAndEnable}</Button>
          </div> : null}
          <div className="flex flex-wrap gap-2">
            {settings.configured && !settings.enabled ? <Button type="button" disabled={!canEdit || saving || !hasCallback} onClick={asyncHandler(() => changeEnabled(true))}>{saving ? 'Saving…' : GOOGLE_SIGN_IN_COPY.enable}</Button> : null}
            {settings.configured && !showEditor ? <Button type="button" variant="outline" disabled={!canEdit || saving} onClick={() => setShowEditor(true)}>{GOOGLE_SIGN_IN_COPY.changeSettings}</Button> : null}
            {settings.enabled ? <Button type="button" variant="outline" disabled={!canEdit || saving} onClick={asyncHandler(() => changeEnabled(false))}>{saving ? 'Saving…' : GOOGLE_SIGN_IN_COPY.disable}</Button> : null}
          </div>
        </>}
        {error ? <p className="text-sm text-negative" role="alert">{error}</p> : null}
      </div> : null}
    </section>
  )
}

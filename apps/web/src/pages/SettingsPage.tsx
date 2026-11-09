import { useState } from 'react'

import { Button } from '../components/ui/button.js'
import { AdminOnly } from '../components/shared/AccessControls.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { ProviderConnectionsSection } from '../components/settings/ProviderConfigForm.js'
import { GoogleOAuthConfigForm } from '../components/settings/GoogleOAuthConfigForm.js'
import { updateBingApiKey } from '../api.js'
import { CdpConfigCard } from '../components/settings/CdpConfigCard.js'
import { SettingsConnectionRow } from '../components/settings/SettingsConnectionRow.js'
import { asyncHandler } from '../lib/async-handler.js'
import { serviceStatusTooltip } from '../lib/health-helpers.js'
import { toneFromService } from '../lib/tone-helpers.js'
import { addToast } from '../lib/toast-store.js'
import { useDashboardOverview as useDashboard } from '../queries/use-dashboard-overview.js'
import { useHealth } from '../queries/use-health.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import type { HealthSnapshot } from '../view-models.js'

const defaultHealthSnapshot: HealthSnapshot = {
  apiStatus: { label: 'API', state: 'checking', detail: 'Checking service health' },
  workerStatus: { label: 'Worker', state: 'checking', detail: 'Checking service health' },
}

/**
 * Settings holds provider credentials, the Google/Bing connections and the API
 * keys. The server refuses this whole surface to a view-only account; the
 * wrapper below is so a viewer gets an explanation rather than an empty page.
 */
export function SettingsPage() {
  return (
    <AdminOnly title="Settings">
      <SettingsPageBody />
    </AdminOnly>
  )
}

function SettingsPageBody() {
  const contextDashboard = useInitialDashboard()
  const { dashboard } = useDashboard()
  const settings = dashboard?.settings ?? contextDashboard?.dashboard?.settings
  const enableLiveStatus = !contextDashboard
  const healthQuery = useHealth(enableLiveStatus, contextDashboard?.health)
  const healthSnapshot = healthQuery.data ?? contextDashboard?.health ?? defaultHealthSnapshot

  const [configuringGoogle, setConfiguringGoogle] = useState(false)
  const [configuringBing, setConfiguringBing] = useState(false)
  const [bingApiKey, setBingApiKey] = useState('')
  const [bingSaving, setBingSaving] = useState(false)
  const [bingError, setBingError] = useState<string | null>(null)

  if (!settings) return null
  const projects = dashboard?.projects ?? contextDashboard?.dashboard?.projects ?? []
  const googleReady = settings.google.state === 'ready'
  const bingReady = settings.bing.state === 'ready'

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Connections and answer engines.</p>
        </div>
      </div>

      <div className="space-y-8">
        <ProviderConnectionsSection projects={projects.map(project => project.project)} />

        <section aria-labelledby="search-connections-title" className="border-t border-default pt-6">
          <div className="section-head">
            <h2 id="search-connections-title" className="text-heading-16 text-heading">Search and browser connections</h2>
          </div>
          <div className="divide-y divide-default">
            <SettingsConnectionRow
              title="Google OAuth"
              purpose="One app credential for Search Console, Business Profile, Google Ads and Tag Manager."
              status={<ToneBadge tone={googleReady ? 'neutral' : 'caution'}>{googleReady ? 'Configured' : 'Not configured'}</ToneBadge>}
              action={(
                <Button type="button" variant="outline" size="sm" onClick={() => setConfiguringGoogle(!configuringGoogle)}>
                  {configuringGoogle ? 'Cancel' : googleReady ? 'Update OAuth app' : 'Configure Google OAuth'}
                </Button>
              )}
            >
              {configuringGoogle && <GoogleOAuthConfigForm onSaved={() => { setConfiguringGoogle(false) }} />}
            </SettingsConnectionRow>

            <SettingsConnectionRow
              title="Bing Webmaster Tools"
              purpose="One API key for project Bing connections. OAuth is not required."
              status={<ToneBadge tone={bingReady ? 'neutral' : 'caution'}>{bingReady ? 'Configured' : 'Not configured'}</ToneBadge>}
              action={(
                <Button type="button" variant="outline" size="sm" onClick={() => setConfiguringBing(!configuringBing)}>
                  {configuringBing ? 'Cancel' : bingReady ? 'Update API key' : 'Configure Bing'}
                </Button>
              )}
            >
              {configuringBing && (
                <div className="mt-3 max-w-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-label-14 text-secondary" htmlFor="bing-api-key">API key</label>
                    <a
                      href="https://www.bing.com/webmasters/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-label-14 text-secondary hover:text-neutral underline underline-offset-2"
                    >
                      Bing Webmaster Tools
                    </a>
                  </div>
                  <input
                    id="bing-api-key"
                    type="password"
                    className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none"
                    placeholder="Bing Webmaster Tools API key"
                    value={bingApiKey}
                    onChange={(e) => setBingApiKey(e.target.value)}
                  />
                  {bingError && <p role="alert" className="text-copy-14 text-negative-400">{bingError}</p>}
                  <Button type="button" size="sm" disabled={!bingApiKey.trim() || bingSaving} onClick={asyncHandler(async () => {
                    if (!bingApiKey.trim()) return
                    setBingSaving(true)
                    setBingError(null)
                    try {
                      await updateBingApiKey(bingApiKey.trim())
                      setBingApiKey('')
                      setConfiguringBing(false)
                      addToast({
                        title: 'Bing API key updated',
                        detail: 'Dashboard Bing credentials were saved.',
                        tone: 'positive',
                        dedupeKey: 'settings:bing',
                        dedupeMode: 'replace',
                      })
                    } catch (err) {
                      setBingError(err instanceof Error ? err.message : 'Failed to update Bing API key')
                    } finally {
                      setBingSaving(false)
                    }
                  })}>
                    {bingSaving ? 'Saving…' : 'Save Bing API key'}
                  </Button>
                </div>
              )}
            </SettingsConnectionRow>

            <CdpConfigCard />
          </div>
        </section>

        <section aria-labelledby="service-health-title" className="border-t border-default pt-6">
          <div className="section-head">
            <h2 id="service-health-title" className="text-heading-16 text-heading">Service health</h2>
          </div>
          <div className="divide-y divide-default">
            <div className="health-row py-3">
              <div>
                <p className="text-copy-14-strong text-heading">API</p>
                {healthSnapshot.apiStatus.state !== 'ok' && (
                  <p className="mt-1 whitespace-pre-line text-copy-14 text-secondary">{serviceStatusTooltip(healthSnapshot.apiStatus)}</p>
                )}
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.apiStatus)} title={serviceStatusTooltip(healthSnapshot.apiStatus)}>
                {healthSnapshot.apiStatus.state === 'ok' ? 'Healthy' : 'Attention'}
              </ToneBadge>
            </div>
            <div className="health-row py-3">
              <div>
                <p className="text-copy-14-strong text-heading">Worker</p>
                {healthSnapshot.workerStatus.state !== 'ok' && (
                  <p className="mt-1 whitespace-pre-line text-copy-14 text-secondary">{serviceStatusTooltip(healthSnapshot.workerStatus)}</p>
                )}
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.workerStatus)} title={serviceStatusTooltip(healthSnapshot.workerStatus)}>
                {healthSnapshot.workerStatus.state === 'ok' ? 'Healthy' : healthSnapshot.workerStatus.state === 'disabled' ? 'Disabled' : 'Attention'}
              </ToneBadge>
            </div>
          </div>
        </section>

        {/* File locations and storage are diagnostics, not settings, so they stay closed. */}
        <details className="border-t border-default pt-6">
          <summary className="cursor-pointer text-label-14 text-secondary hover:text-strong">Self-hosting details</summary>
          <div className="mt-3 max-w-prose">
            <ul className="detail-list">
              {settings.selfHostNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <p className="supporting-copy">{settings.bootstrapNote}</p>
          </div>
        </details>
      </div>
    </div>
  )
}

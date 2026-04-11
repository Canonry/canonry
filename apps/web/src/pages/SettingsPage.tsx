import { useState } from 'react'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { ProviderConfigForm } from '../components/settings/ProviderConfigForm.js'
import { GoogleOAuthConfigForm } from '../components/settings/GoogleOAuthConfigForm.js'
import { updateBingApiKey } from '../api.js'
import { CdpConfigCard } from '../components/settings/CdpConfigCard.js'
import { serviceStatusTooltip } from '../lib/health-helpers.js'
import { toneFromService } from '../lib/tone-helpers.js'
import { addToast } from '../lib/toast-store.js'
import { useDashboard } from '../queries/use-dashboard.js'
import { useHealth } from '../queries/use-health.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import type { HealthSnapshot } from '../view-models.js'

const defaultHealthSnapshot: HealthSnapshot = {
  apiStatus: { label: 'API', state: 'checking', detail: 'Checking service health' },
  workerStatus: { label: 'Worker', state: 'checking', detail: 'Checking service health' },
}

export function SettingsPage() {
  const contextDashboard = useInitialDashboard()
  const { dashboard } = useDashboard()
  const settings = dashboard?.settings ?? contextDashboard?.dashboard?.settings
  const enableLiveStatus = !contextDashboard
  const healthQuery = useHealth(enableLiveStatus, contextDashboard?.health)
  const healthSnapshot = healthQuery.data ?? contextDashboard?.health ?? defaultHealthSnapshot

  const [configuringProvider, setConfiguringProvider] = useState<string | null>(null)
  const [configuringGoogle, setConfiguringGoogle] = useState(false)
  const [configuringBing, setConfiguringBing] = useState(false)
  const [bingApiKey, setBingApiKey] = useState('')
  const [bingSaving, setBingSaving] = useState(false)
  const [bingError, setBingError] = useState<string | null>(null)
  const [bingSuccess, setBingSuccess] = useState(false)

  if (!settings) return null

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Provider state, Google OAuth, Bing WMT setup, and service health.</p>
        </div>
      </div>

      <section className="settings-grid">
        {settings.providerStatuses.map((provider) => (
          <Card key={provider.name} className="surface-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Provider</p>
                <h2>{provider.displayName ?? provider.name}</h2>
              </div>
              <ToneBadge tone={provider.state === 'ready' ? 'positive' : 'caution'}>
                {provider.state === 'ready' ? 'Ready' : 'Needs config'}
              </ToneBadge>
            </div>
            <dl className="definition-list mt-3">
              <div>
                <dt>Model</dt>
                <dd className="font-mono text-xs">{provider.model}</dd>
              </div>
              {provider.quota && (
                <>
                  <div>
                    <dt>Concurrency</dt>
                    <dd>{provider.quota.maxConcurrency}</dd>
                  </div>
                  <div>
                    <dt>Rate limit</dt>
                    <dd>{provider.quota.maxRequestsPerMinute}/min · {provider.quota.maxRequestsPerDay}/day</dd>
                  </div>
                </>
              )}
            </dl>
            <p className="mt-2 text-sm text-zinc-500">{provider.detail}</p>
            <div className="mt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfiguringProvider(configuringProvider === provider.name ? null : provider.name)}
              >
                {configuringProvider === provider.name ? 'Cancel' : provider.state === 'ready' ? (provider.name.toLowerCase() === 'local' ? 'Update config' : 'Update key') : 'Configure'}
              </Button>
            </div>
            {configuringProvider === provider.name && (
              <ProviderConfigForm
                providerName={provider.name}
                keyUrl={provider.keyUrl}
                modelHint={provider.modelHint}
                onSaved={() => {
                  setConfiguringProvider(null)
                }}
              />
            )}
          </Card>
        ))}

        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Google</p>
              <h2>Search Console OAuth</h2>
            </div>
            <ToneBadge tone={settings.google.state === 'ready' ? 'positive' : 'caution'}>
              {settings.google.state === 'ready' ? 'Ready' : 'Needs config'}
            </ToneBadge>
          </div>
          <dl className="definition-list mt-3">
            <div>
              <dt>Auth model</dt>
              <dd>One app credential set, then one OAuth connection per project domain</dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd className="font-mono text-xs">~/.canonry/config.yaml</dd>
            </div>
          </dl>
          <p className="mt-2 text-sm text-zinc-500">{settings.google.detail}</p>
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfiguringGoogle(!configuringGoogle)}
            >
              {configuringGoogle ? 'Cancel' : settings.google.state === 'ready' ? 'Update OAuth app' : 'Configure Google OAuth'}
            </Button>
          </div>
          {configuringGoogle && (
            <GoogleOAuthConfigForm
              onSaved={() => {
                setConfiguringGoogle(false)
              }}
            />
          )}
        </Card>

        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Bing</p>
              <h2>Webmaster Tools</h2>
            </div>
            <ToneBadge tone={settings.bing.state === 'ready' ? 'positive' : 'caution'}>
              {settings.bing.state === 'ready' ? 'Ready' : 'Needs config'}
            </ToneBadge>
          </div>
          <dl className="definition-list mt-3">
            <div>
              <dt>Auth model</dt>
              <dd>API key authentication — no OAuth needed</dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd className="font-mono text-xs">~/.canonry/config.yaml</dd>
            </div>
          </dl>
          <p className="mt-2 text-sm text-zinc-500">{settings.bing.detail}</p>
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfiguringBing(!configuringBing)}
            >
              {configuringBing ? 'Cancel' : settings.bing.state === 'ready' ? 'Update API key' : 'Configure Bing'}
            </Button>
          </div>
          {configuringBing && (
            <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs text-zinc-500" htmlFor="bing-api-key">API Key</label>
                  <a
                    href="https://www.bing.com/webmasters/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
                  >
                    Bing Webmaster Tools
                  </a>
                </div>
                <input
                  id="bing-api-key"
                  type="password"
                  className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                  placeholder="Bing Webmaster Tools API key"
                  value={bingApiKey}
                  onChange={(e) => setBingApiKey(e.target.value)}
                />
              </div>
              <p className="text-[11px] text-zinc-500">
                This key is stored in <code>~/.canonry/config.yaml</code>. Project-level Bing connections are created separately per canonical domain.
              </p>
              {bingError && <p className="text-xs text-rose-400">{bingError}</p>}
              {bingSuccess && <p className="text-xs text-emerald-400">Bing API key updated.</p>}
              <Button type="button" size="sm" disabled={!bingApiKey.trim() || bingSaving} onClick={async () => {
                if (!bingApiKey.trim()) return
                setBingSaving(true)
                setBingError(null)
                setBingSuccess(false)
                try {
                  await updateBingApiKey(bingApiKey.trim())
                  setBingApiKey('')
                  setBingSuccess(true)
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
              }}>
                {bingSaving ? 'Saving...' : 'Save Bing API key'}
              </Button>
            </div>
          )}
        </Card>

        <CdpConfigCard />

        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Service health</p>
              <h2>API and worker</h2>
            </div>
          </div>
          <div className="compact-stack">
            <div className="health-row">
              <div>
                <p className="run-row-title">API</p>
                <p className="supporting-copy">{healthSnapshot.apiStatus.detail}</p>
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.apiStatus)} title={serviceStatusTooltip(healthSnapshot.apiStatus)}>
                {healthSnapshot.apiStatus.state === 'ok' ? 'Healthy' : 'Attention'}
              </ToneBadge>
            </div>
            <div className="health-row">
              <div>
                <p className="run-row-title">Worker</p>
                <p className="supporting-copy">{healthSnapshot.workerStatus.detail}</p>
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.workerStatus)} title={serviceStatusTooltip(healthSnapshot.workerStatus)}>
                {healthSnapshot.workerStatus.state === 'ok' ? 'Healthy' : 'Attention'}
              </ToneBadge>
            </div>
          </div>
        </Card>
      </section>

      <section className="page-section">
        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Self-host notes</p>
              <h2>Operational guidance</h2>
            </div>
          </div>
          <ul className="detail-list">
            {settings.selfHostNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <p className="supporting-copy">{settings.bootstrapNote}</p>
        </Card>
      </section>
    </div>
  )
}

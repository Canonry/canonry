import { useState } from 'react'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { ProviderConfigForm } from '../components/settings/ProviderConfigForm.js'
import { GoogleOAuthConfigForm } from '../components/settings/GoogleOAuthConfigForm.js'
import { CdpConfigCard } from '../components/settings/CdpConfigCard.js'
import { toneFromService } from '../lib/tone-helpers.js'
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

  if (!settings) return null

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Provider state, Google OAuth setup, and service health.</p>
        </div>
      </div>

      <section className="settings-grid">
        {settings.providerStatuses.map((provider) => (
          <Card key={provider.name} className="surface-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Provider</p>
                <h2>{provider.name}</h2>
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
              <ToneBadge tone={toneFromService(healthSnapshot.apiStatus)}>
                {healthSnapshot.apiStatus.state === 'ok' ? 'Healthy' : 'Attention'}
              </ToneBadge>
            </div>
            <div className="health-row">
              <div>
                <p className="run-row-title">Worker</p>
                <p className="supporting-copy">{healthSnapshot.workerStatus.detail}</p>
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.workerStatus)}>
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

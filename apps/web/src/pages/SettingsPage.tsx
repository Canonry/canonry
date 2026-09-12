import { useState } from 'react'
import { Link, useSearch } from '@tanstack/react-router'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { AdminOnly } from '../components/shared/AccessControls.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { ProviderConfigForm } from '../components/settings/ProviderConfigForm.js'
import { GoogleOAuthConfigForm } from '../components/settings/GoogleOAuthConfigForm.js'
import { PeopleAccessSection } from '../components/settings/PeopleAccessSection.js'
import { GoogleSignInSettingsSection } from '../components/settings/GoogleSignInSettingsSection.js'
import { updateBingApiKey } from '../api.js'
import { CdpConfigCard } from '../components/settings/CdpConfigCard.js'
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

export const SETTINGS_SECTIONS = ['connections', 'people', 'sign-in'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const SETTINGS_SECTION_COPY = {
  navigationLabel: 'Settings sections',
  connections: 'Connections',
  people: 'People',
  signIn: 'Sign-in',
} as const

export const SETTINGS_SECTION_TEST_IDS = {
  navigation: 'settings-section-navigation',
  connections: 'settings-section-connections',
  people: 'settings-section-people',
  signIn: 'settings-section-sign-in',
} as const

function resolveSettingsSection(value: unknown): SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection) ? value as SettingsSection : 'connections'
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
  const search = useSearch({ strict: false }) as { section?: unknown }
  const section = resolveSettingsSection(search.section)
  const contextDashboard = useInitialDashboard()
  const { dashboard } = useDashboard()
  const settings = dashboard === null ? undefined : dashboard.settings
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

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">People, connections and answer engines.</p>
        </div>
      </div>

      <nav className="mb-6 flex gap-5 border-b border-default" aria-label={SETTINGS_SECTION_COPY.navigationLabel} data-testid={SETTINGS_SECTION_TEST_IDS.navigation}>
        {SETTINGS_SECTIONS.map(item => {
          const label = item === 'sign-in' ? SETTINGS_SECTION_COPY.signIn : SETTINGS_SECTION_COPY[item]
          const active = section === item
          return <Link
            key={item}
            to="/settings"
            search={{ section: item }}
            data-testid={SETTINGS_SECTION_TEST_IDS[item === 'sign-in' ? 'signIn' : item]}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px min-h-11 border-b-2 px-1 pt-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${active ? 'border-strong text-heading' : 'border-transparent text-secondary hover:border-base hover:text-heading'}`}
          >
            {label}
          </Link>
        })}
      </nav>

      {section === 'people' ? <PeopleAccessSection /> : null}
      {section === 'sign-in' ? <GoogleSignInSettingsSection /> : null}

      {section === 'connections' ? <section className="space-y-6">

        {!settings ? (
          <p className="text-sm text-secondary" role="status">Loading connection settings…</p>
        ) : <>
        <section>
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Answer engines</p>
              <h2>Providers</h2>
            </div>
          </div>
          <div className="divide-y divide-default border-y border-default">
            {settings.providerStatuses.map((provider) => (
              <div key={provider.name} className="py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-heading">{provider.displayName ?? provider.name}</p>
                    <p className="text-sm text-secondary">{provider.detail}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ToneBadge tone={provider.state === 'ready' ? 'positive' : 'caution'}>
                      {provider.state === 'ready' ? 'Ready' : 'Needs config'}
                    </ToneBadge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setConfiguringProvider(configuringProvider === provider.name ? null : provider.name)}
                    >
                      {configuringProvider === provider.name
                        ? 'Cancel'
                        : provider.state === 'ready'
                          ? 'Update'
                          : 'Configure'}
                    </Button>
                  </div>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-secondary hover:text-strong">Advanced</summary>
                  <dl className="definition-list mt-2">
                    <div>
                      <dt>Model</dt>
                      <dd className="font-mono text-xs">
                        {provider.model ?? provider.defaultModel ?? 'unknown'}
                        {!provider.model && provider.defaultModel && (
                          <span className="ml-1 font-sans text-muted">(default)</span>
                        )}
                      </dd>
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
                </details>
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
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Connections</p>
              <h2>Search and browser</h2>
            </div>
          </div>
          <div className="settings-grid">
            <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Google</p>
              <h2>Google OAuth</h2>
            </div>
            <ToneBadge tone={settings.google.state === 'ready' ? 'positive' : 'caution'}>
              {settings.google.state === 'ready' ? 'Ready' : 'Needs config'}
            </ToneBadge>
          </div>
          <p className="mt-2 text-sm text-secondary">{settings.google.detail}</p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-secondary hover:text-strong">Advanced</summary>
            <dl className="definition-list mt-2">
              <div>
                <dt>Auth model</dt>
                <dd>One app credential set for Search Console, Business Profile, Google Ads, and Tag Manager</dd>
              </div>
              <div>
                <dt>Storage</dt>
                <dd className="font-mono text-xs">~/.canonry/config.yaml</dd>
              </div>
            </dl>
          </details>
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
          <p className="mt-2 text-sm text-secondary">{settings.bing.detail}</p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-secondary hover:text-strong">Advanced</summary>
            <dl className="definition-list mt-2">
              <div>
                <dt>Auth model</dt>
                <dd>API key authentication. OAuth is not required.</dd>
              </div>
              <div>
                <dt>Storage</dt>
                <dd className="font-mono text-xs">~/.canonry/config.yaml</dd>
              </div>
            </dl>
          </details>
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
            <div className="mt-3 rounded-lg border border-base bg-bg-elevated/40 p-3 space-y-2">
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-sm text-secondary" htmlFor="bing-api-key">API key</label>
                  <a
                    href="https://www.bing.com/webmasters/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-secondary hover:text-neutral underline underline-offset-2"
                  >
                    Bing Webmaster Tools
                  </a>
                </div>
                <input
                  id="bing-api-key"
                  type="password"
                  className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  placeholder="Bing Webmaster Tools API key"
                  value={bingApiKey}
                  onChange={(e) => setBingApiKey(e.target.value)}
                />
              </div>
              <p className="text-sm text-secondary">Used for project-level Bing connections.</p>
              {bingError && <p className="text-sm text-negative-400">{bingError}</p>}
              {bingSuccess && <p className="text-sm text-positive-400">Bing API key updated.</p>}
              <Button type="button" size="sm" disabled={!bingApiKey.trim() || bingSaving} onClick={asyncHandler(async () => {
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
              })}>
                {bingSaving ? 'Saving...' : 'Save Bing API key'}
              </Button>
            </div>
          )}
        </Card>

            <CdpConfigCard />
          </div>
        </section>

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
                {healthSnapshot.apiStatus.state !== 'ok' && (
                  <p className="mt-1 text-sm text-secondary">{serviceStatusTooltip(healthSnapshot.apiStatus)}</p>
                )}
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.apiStatus)} title={serviceStatusTooltip(healthSnapshot.apiStatus)}>
                {healthSnapshot.apiStatus.state === 'ok' ? 'Healthy' : 'Attention'}
              </ToneBadge>
            </div>
            <div className="health-row">
              <div>
                <p className="run-row-title">Worker</p>
                {healthSnapshot.workerStatus.state !== 'ok' && (
                  <p className="mt-1 text-sm text-secondary">{serviceStatusTooltip(healthSnapshot.workerStatus)}</p>
                )}
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.workerStatus)} title={serviceStatusTooltip(healthSnapshot.workerStatus)}>
                {healthSnapshot.workerStatus.state === 'ok' ? 'Healthy' : 'Attention'}
              </ToneBadge>
            </div>
          </div>
        </Card>
        </>}
      </section> : null}

      {section === 'connections' && settings ? <details className="page-section">
        <summary className="cursor-pointer text-sm font-medium text-secondary hover:text-strong">Self-hosting details</summary>
        <Card className="surface-card mt-3">
          <ul className="detail-list">
            {settings.selfHostNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <p className="supporting-copy">{settings.bootstrapNote}</p>
        </Card>
      </details> : null}
    </div>
  )
}

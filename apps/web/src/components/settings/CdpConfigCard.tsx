import { useEffect, useState } from 'react'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { fetchCdpStatus, configureCdp, type ApiCdpStatus } from '../../api.js'
import { describeError } from '@canonry/canonry-contracts'

function shortCdpError(error: string): string {
  const summary = error.replace(/^Error:\s*/, '').replace(/\s+/g, ' ').trim()
  if (!summary) return 'Unknown error'
  return summary.length > 140 ? `${summary.slice(0, 137)}...` : summary
}

export function CdpConfigCard() {
  const [cdpStatus, setCdpStatus] = useState<ApiCdpStatus | null>(null)
  const [cdpStatusError, setCdpStatusError] = useState<string | null>(null)
  const [configuringCdp, setConfiguringCdp] = useState(false)
  const [cdpHost, setCdpHost] = useState('localhost')
  const [cdpPort, setCdpPort] = useState('9222')
  const [cdpSaving, setCdpSaving] = useState(false)

  useEffect(() => {
    fetchCdpStatus()
      .then((status) => {
        setCdpStatus(status)
        setCdpStatusError(null)
      })
      .catch((err: unknown) => {
        const msg = describeError(err)
        if (!msg.includes('501')) setCdpStatusError(msg)
      })
  }, [])

  return (
    <Card className="surface-card">
      <div className="section-head">
        <div>
          <p className="eyebrow eyebrow-soft">Browser provider</p>
          <h2>ChatGPT (CDP)</h2>
        </div>
        <ToneBadge tone={cdpStatus?.connected ? 'positive' : 'caution'}>
          {cdpStatus?.connected ? 'Connected' : 'Not connected'}
        </ToneBadge>
      </div>
      <p
        className={`mt-2 text-sm ${cdpStatusError ? 'text-negative' : 'text-secondary'}`}
        role={cdpStatusError ? 'alert' : undefined}
      >
        {cdpStatusError ? (
          <>
            Could not check Chrome: {shortCdpError(cdpStatusError)}. Check that Chrome is running with remote debugging, then configure the endpoint.
          </>
        ) : cdpStatus?.connected ? 'Chrome is available for this provider.' : 'Connect Chrome to enable this provider.'}
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-secondary hover:text-strong">Advanced</summary>
        <dl className="definition-list mt-2">
          {cdpStatus?.endpoint && (
            <div>
              <dt>Endpoint</dt>
              <dd className="font-mono text-xs">{cdpStatus.endpoint}</dd>
            </div>
          )}
          {cdpStatus?.browserVersion && (
            <div>
              <dt>Browser</dt>
              <dd className="text-xs">{cdpStatus.browserVersion}</dd>
            </div>
          )}
          {cdpStatus?.targets && cdpStatus.targets.length > 0 && (
            <div>
              <dt>Tabs</dt>
              <dd>
                {cdpStatus.targets.map(t => (
                  <span key={t.name} className="mr-2">
                    {t.name}: {t.alive ? '● alive' : '○ idle'}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </details>
      <div className="mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConfiguringCdp(!configuringCdp)}
        >
          {configuringCdp ? 'Cancel' : cdpStatus?.connected ? 'Update endpoint' : 'Configure'}
        </Button>
      </div>
      {configuringCdp && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={asyncHandler(async (e: React.FormEvent) => {
            e.preventDefault()
            setCdpSaving(true)
            try {
              await configureCdp(cdpHost, parseInt(cdpPort, 10) || 9222)
              const status = await fetchCdpStatus()
              setCdpStatus(status)
              setCdpStatusError(null)
              setConfiguringCdp(false)
              addToast({
                title: 'CDP endpoint saved',
                detail: `${cdpHost}:${parseInt(cdpPort, 10) || 9222} is now configured.`,
                tone: 'positive',
                dedupeKey: 'settings:cdp',
                dedupeMode: 'replace',
              })
            } catch (err) {
              setCdpStatusError(describeError(err))
            } finally {
              setCdpSaving(false)
            }
          })}
        >
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-strong bg-bg-elevated px-2 py-1 text-sm text-heading placeholder-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
              placeholder="localhost"
              value={cdpHost}
              onChange={e => setCdpHost(e.target.value)}
              aria-label="CDP host"
            />
            <input
              className="w-24 rounded border border-strong bg-bg-elevated px-2 py-1 text-sm text-heading placeholder-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
              placeholder="9222"
              value={cdpPort}
              onChange={e => setCdpPort(e.target.value)}
              aria-label="CDP port"
            />
          </div>
          <div>
            <Button type="submit" size="sm" disabled={cdpSaving}>
              {cdpSaving ? 'Saving…' : 'Save endpoint'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

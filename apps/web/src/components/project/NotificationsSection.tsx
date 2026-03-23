import { useEffect, useState } from 'react'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { listNotifications, addNotification, removeNotification, sendTestNotification, type ApiNotification } from '../../api.js'

// --- Notification events ---
const NOTIFICATION_EVENTS = [
  { value: 'citation.lost', label: 'Citation lost' },
  { value: 'citation.gained', label: 'Citation gained' },
  { value: 'run.completed', label: 'Run completed' },
  { value: 'run.failed', label: 'Run failed' },
] as const

export function NotificationsSection({ projectName }: { projectName: string }) {
  const [notifs, setNotifs] = useState<ApiNotification[] | 'loading'>('loading')
  const [adding, setAdding] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['citation.lost', 'citation.gained'])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testStates, setTestStates] = useState<Record<string, { state: 'testing' | 'ok' | 'fail'; status?: number }>>({})

  useEffect(() => {
    listNotifications(projectName).then(setNotifs).catch(() => setNotifs([]))
  }, [projectName])

  const toggleEvent = (evt: string) => {
    setSelectedEvents(prev => prev.includes(evt) ? prev.filter(e => e !== evt) : [...prev, evt])
  }

  const handleAdd = async () => {
    if (!webhookUrl.trim() || selectedEvents.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const result = await addNotification(projectName, {
        channel: 'webhook',
        url: webhookUrl.trim(),
        events: selectedEvents,
      })
      setNotifs(prev => prev === 'loading' ? [result] : [...prev, result])
      setWebhookUrl('')
      setSelectedEvents(['citation.lost', 'citation.gained'])
      setAdding(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add webhook')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await removeNotification(projectName, id)
      setNotifs(prev => prev === 'loading' ? prev : prev.filter(n => n.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove webhook')
    }
  }

  const handleTest = async (id: string) => {
    setTestStates(prev => ({ ...prev, [id]: { state: 'testing' } }))
    try {
      const result = await sendTestNotification(projectName, id)
      setTestStates(prev => ({ ...prev, [id]: { state: result.ok ? 'ok' : 'fail', status: result.status } }))
    } catch {
      setTestStates(prev => ({ ...prev, [id]: { state: 'fail' } }))
    }
  }

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Automation</p>
          <h2>Notifications</h2>
        </div>
        {notifs !== 'loading' && (
          <Button type="button" variant="outline" size="sm" onClick={() => { setAdding(!adding); setError(null) }}>
            {adding ? 'Cancel' : '+ Add webhook'}
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Webhook URL</label>
            <input
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              type="url"
              placeholder="https://hooks.example.com/canonry"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Trigger on</label>
            <div className="flex flex-wrap gap-3">
              {NOTIFICATION_EVENTS.map(evt => (
                <label key={evt.value} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="rounded border-zinc-600 bg-zinc-800"
                    checked={selectedEvents.includes(evt.value)}
                    onChange={() => toggleEvent(evt.value)}
                  />
                  <span className="text-sm text-zinc-300">{evt.label}</span>
                </label>
              ))}
            </div>
          </div>
          {error && <p className="text-rose-400 text-sm">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => { setAdding(false); setError(null) }}>Cancel</Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || !webhookUrl.trim() || selectedEvents.length === 0}
              onClick={handleAdd}
            >
              {saving ? 'Adding...' : 'Add webhook'}
            </Button>
          </div>
        </div>
      )}

      {notifs === 'loading' && <p className="supporting-copy">Loading...</p>}

      {notifs !== 'loading' && notifs.length === 0 && !adding && (
        <Card className="surface-card compact-card">
          <p className="supporting-copy">No webhooks configured. Add one to get alerted when citations change or runs complete.</p>
        </Card>
      )}

      {notifs !== 'loading' && notifs.length > 0 && (
        <div className="evidence-table-wrap">
          <table className="evidence-table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Events</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {notifs.map(n => (
                <tr key={n.id}>
                  <td className="evidence-keyword-cell">
                    <span className="font-mono text-xs text-zinc-300 break-all" title={n.urlHost}>
                      {n.urlDisplay ?? n.url}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {n.events.map(evt => (
                        <span key={evt} className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-medium text-zinc-400 uppercase tracking-wide">
                          {evt.replace('.', ' ')}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <ToneBadge tone={n.enabled ? 'positive' : 'neutral'}>
                      {n.enabled ? 'Active' : 'Paused'}
                    </ToneBadge>
                  </td>
                  <td>
                    <div className="flex items-center gap-1 justify-end">
                      {testStates[n.id] && (() => {
                        const t = testStates[n.id]
                        const label = t.state === 'testing' ? 'Sending\u2026'
                          : t.state === 'ok' ? `Delivered${t.status ? ` (${t.status})` : ''}`
                          : `Failed${t.status ? ` (${t.status})` : ''}`
                        return (
                          <ToneBadge tone={t.state === 'ok' ? 'positive' : t.state === 'fail' ? 'negative' : 'neutral'}>
                            {label}
                          </ToneBadge>
                        )
                      })()}
                      <Button variant="ghost" size="sm" type="button" disabled={testStates[n.id]?.state === 'testing'} onClick={() => handleTest(n.id)}>
                        Test
                      </Button>
                      <Button variant="ghost" size="sm" type="button" onClick={() => handleRemove(n.id)}>
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <p className="text-rose-400 text-sm mt-2">{error}</p>}
        </div>
      )}
    </section>
  )
}

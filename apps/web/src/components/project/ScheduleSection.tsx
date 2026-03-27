import { useEffect, useState } from 'react'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { formatHour, buildPreset, parsePreset, scheduleLabel } from '../../lib/format-helpers.js'
import { addToast } from '../../lib/toast-store.js'
import { fetchSchedule, saveSchedule, removeSchedule, type ApiSchedule } from '../../api.js'

// --- Schedule helpers ---
const FREQ_OPTIONS = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly@mon', label: 'Every Monday' },
  { value: 'weekly@wed', label: 'Every Wednesday' },
  { value: 'weekly@fri', label: 'Every Friday' },
  { value: 'twice-daily', label: 'Twice a day (6am & 6pm)' },
  { value: 'custom', label: 'Custom cron expression' },
] as const

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
] as const


export function ScheduleSection({ projectName }: { projectName: string }) {
  const [schedule, setSchedule] = useState<ApiSchedule | null | 'loading'>('loading')
  const [editing, setEditing] = useState(false)
  const [freq, setFreq] = useState('daily')
  const [hour, setHour] = useState(6)
  const [customCron, setCustomCron] = useState('')
  const [timezone, setTimezone] = useState('UTC')
  const [tzOther, setTzOther] = useState(false)
  const [tzOtherValue, setTzOtherValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSchedule(projectName).then(setSchedule).catch(() => setSchedule(null))
  }, [projectName])

  const startEditing = () => {
    if (schedule && schedule !== 'loading') {
      const parsed = parsePreset(schedule.preset ?? null, schedule.cronExpr)
      setFreq(parsed.freq)
      setHour(parsed.hour)
      setCustomCron(parsed.customCron)
      const isKnownTz = (COMMON_TIMEZONES as readonly string[]).includes(schedule.timezone)
      setTimezone(isKnownTz ? schedule.timezone : 'Other')
      setTzOther(!isKnownTz)
      setTzOtherValue(isKnownTz ? '' : schedule.timezone)
    } else {
      setFreq('daily')
      setHour(6)
      setCustomCron('')
      setTimezone('UTC')
      setTzOther(false)
      setTzOtherValue('')
    }
    setError(null)
    setEditing(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const effectiveTz = tzOther ? tzOtherValue.trim() || 'UTC' : timezone
      const body: Parameters<typeof saveSchedule>[1] = { timezone: effectiveTz }
      if (freq === 'custom') body.cron = customCron.trim()
      else body.preset = buildPreset(freq, hour)
      const result = await saveSchedule(projectName, body)
      setSchedule(result)
      setEditing(false)
      addToast({
        title: 'Schedule saved',
        detail: scheduleLabel(result.preset ?? null, result.cronExpr, result.timezone),
        tone: 'positive',
        dedupeKey: `schedule:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save schedule')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!schedule || schedule === 'loading') return
    setSaving(true)
    setError(null)
    try {
      const body: Parameters<typeof saveSchedule>[1] = {
        timezone: schedule.timezone,
        enabled: !schedule.enabled,
      }
      if (schedule.preset) body.preset = schedule.preset
      else body.cron = schedule.cronExpr
      const nextSchedule = await saveSchedule(projectName, body)
      setSchedule(nextSchedule)
      addToast({
        title: nextSchedule.enabled ? 'Schedule resumed' : 'Schedule paused',
        detail: scheduleLabel(nextSchedule.preset ?? null, nextSchedule.cronExpr, nextSchedule.timezone),
        tone: 'positive',
        dedupeKey: `schedule:toggle:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update schedule')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    setRemoving(true)
    setError(null)
    try {
      await removeSchedule(projectName)
      setSchedule(null)
      setEditing(false)
      addToast({
        title: 'Schedule removed',
        detail: `${projectName} will no longer run automatically.`,
        tone: 'positive',
        dedupeKey: `schedule:remove:${projectName}`,
        dedupeMode: 'drop',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove schedule')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Automation</p>
          <h2>Scheduled runs</h2>
        </div>
        {schedule !== 'loading' && !editing && (
          <Button type="button" variant="outline" size="sm" onClick={startEditing}>
            {schedule ? 'Edit schedule' : '+ Set schedule'}
          </Button>
        )}
      </div>

      {schedule === 'loading' && <p className="supporting-copy">Loading...</p>}

      {schedule !== 'loading' && !editing && schedule === null && (
        <Card className="surface-card compact-card">
          <p className="supporting-copy">No schedule configured. Set one to automatically trigger visibility sweeps.</p>
        </Card>
      )}

      {schedule !== 'loading' && !editing && schedule !== null && (
        <Card className="surface-card compact-card">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-zinc-200">{scheduleLabel(schedule.preset ?? null, schedule.cronExpr, schedule.timezone)}</p>
              <p className="text-xs text-zinc-500">Cron: <span className="font-mono">{schedule.cronExpr}</span></p>
              {schedule.nextRunAt && (
                <p className="text-xs text-zinc-500">Next run: {new Date(schedule.nextRunAt).toLocaleString()}</p>
              )}
              {schedule.lastRunAt && (
                <p className="text-xs text-zinc-500">Last run: {new Date(schedule.lastRunAt).toLocaleString()}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ToneBadge tone={schedule.enabled ? 'positive' : 'neutral'}>
                {schedule.enabled ? 'Active' : 'Paused'}
              </ToneBadge>
              <Button type="button" variant="outline" size="sm" disabled={saving} onClick={handleToggleEnabled}>
                {schedule.enabled ? 'Pause' : 'Resume'}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={removing} onClick={handleRemove}>
                {removing ? 'Removing...' : 'Remove'}
              </Button>
            </div>
          </div>
          {error && <p className="text-rose-400 text-sm mt-2">{error}</p>}
        </Card>
      )}

      {editing && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Frequency</label>
              <select
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
                value={freq}
                onChange={(e) => setFreq(e.target.value)}
              >
                {FREQ_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Time</label>
              <select
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none disabled:opacity-40"
                value={hour}
                disabled={freq === 'twice-daily' || freq === 'custom'}
                onChange={(e) => setHour(parseInt(e.target.value))}
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{formatHour(i)}</option>
                ))}
              </select>
            </div>
          </div>
          {freq === 'custom' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Cron expression</label>
              <input
                className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 font-mono focus:border-zinc-500 focus:outline-none"
                type="text"
                placeholder="0 9 * * 1-5"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Timezone</label>
            <select
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
              value={tzOther ? 'Other' : timezone}
              onChange={(e) => {
                if (e.target.value === 'Other') { setTzOther(true); setTimezone('Other') }
                else { setTzOther(false); setTimezone(e.target.value) }
              }}
            >
              {COMMON_TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
              <option value="Other">Other (enter manually)\u2026</option>
            </select>
            {tzOther && (
              <input
                className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                type="text"
                placeholder="e.g. America/New_York"
                value={tzOtherValue}
                onChange={(e) => setTzOtherValue(e.target.value)}
              />
            )}
          </div>
          {error && <p className="text-rose-400 text-sm">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(false); setError(null) }}>Cancel</Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || (freq === 'custom' && !customCron.trim())}
              onClick={handleSave}
            >
              {saving ? 'Saving...' : 'Save schedule'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

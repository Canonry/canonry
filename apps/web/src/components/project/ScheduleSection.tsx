import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getApiV1ProjectsByNameSchedulesOptions, getApiV1ProjectsByNameSchedulesQueryKey } from '@ainyc/canonry-api-client/react-query'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { formatHour, buildPreset, parsePreset, scheduleLabel } from '../../lib/format-helpers.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { ApiError, heyClient, saveSchedule, removeSchedule, isEmbed, type ApiSchedule } from '../../api.js'

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
  const queryClient = useQueryClient()
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
  const [editingVersion, setEditingVersion] = useState<string | null | undefined>(undefined)

  const schedulesQueryKey = getApiV1ProjectsByNameSchedulesQueryKey({
    client: heyClient,
    path: { name: projectName },
  })
  const schedulesQuery = useQuery({
    ...getApiV1ProjectsByNameSchedulesOptions({
      client: heyClient,
      path: { name: projectName },
    }),
    // The settings form can overwrite this server state, so an old cache entry
    // is never authoritative enough to unlock editing on mount or after the
    // operator returns from another tab or the CLI.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: false,
  })
  const scheduleLoading = schedulesQuery.isPending || schedulesQuery.isFetching
  const loadFailed = schedulesQuery.isError
  const schedule = schedulesQuery.data?.find(item => item.kind === 'answer-visibility') ?? null
  const scheduleChangedElsewhere = editing
    && editingVersion !== undefined
    && (schedule?.updatedAt ?? null) !== editingVersion

  const updateScheduleCache = (nextSchedule: ApiSchedule | null) => {
    queryClient.setQueryData<ApiSchedule[]>(schedulesQueryKey, currentSchedules => {
      const otherSchedules = (currentSchedules ?? []).filter(item => item.kind !== 'answer-visibility')
      return nextSchedule ? [...otherSchedules, nextSchedule] : otherSchedules
    })
  }

  const loadScheduleIntoEditor = (nextSchedule: ApiSchedule | null) => {
    if (nextSchedule) {
      const parsed = parsePreset(nextSchedule.preset ?? null, nextSchedule.cronExpr)
      setFreq(parsed.freq)
      setHour(parsed.hour)
      setCustomCron(parsed.customCron)
      const isKnownTz = (COMMON_TIMEZONES as readonly string[]).includes(nextSchedule.timezone)
      setTimezone(isKnownTz ? nextSchedule.timezone : 'Other')
      setTzOther(!isKnownTz)
      setTzOtherValue(isKnownTz ? '' : nextSchedule.timezone)
    } else {
      setFreq('daily')
      setHour(6)
      setCustomCron('')
      setTimezone('UTC')
      setTzOther(false)
      setTzOtherValue('')
    }
    setEditingVersion(nextSchedule?.updatedAt ?? null)
  }

  const startEditing = () => {
    loadScheduleIntoEditor(schedule)
    setError(null)
    setEditing(true)
  }

  const loadLatestSchedule = () => {
    loadScheduleIntoEditor(schedule)
    setError(null)
  }

  const recoverFromConflict = async () => {
    const latest = await schedulesQuery.refetch()
    if (latest.isError) {
      setError('The schedule changed, but Canonry could not load the latest version. Retry the schedule check.')
    } else if (!editing) {
      setError('This schedule changed elsewhere. The latest version is now shown; review it and try again.')
    } else {
      setError(null)
    }
  }

  const handleMutationError = async (caught: unknown, fallback: string) => {
    if (caught instanceof ApiError && caught.code === 'SCHEDULE_VERSION_CONFLICT') {
      await recoverFromConflict()
      return
    }
    setError(caught instanceof Error ? caught.message : fallback)
  }

  const handleSave = async () => {
    if (scheduleChangedElsewhere || editingVersion === undefined) return
    setSaving(true)
    setError(null)
    try {
      // Revalidate immediately before the write as well as on focus. This
      // catches an external update made after this editor opened; the server
      // remains authoritative if a still-later write races this request.
      const latestResult = await schedulesQuery.refetch()
      if (latestResult.isError || latestResult.data === undefined) {
        setError('Canonry could not verify the latest schedule. Try again before saving.')
        return
      }
      const latestSchedule = latestResult.data.find(item => item.kind === 'answer-visibility') ?? null
      if ((latestSchedule?.updatedAt ?? null) !== editingVersion) return

      const effectiveTz = tzOther ? tzOtherValue.trim() || 'UTC' : timezone
      const body: Parameters<typeof saveSchedule>[1] = {
        timezone: effectiveTz,
        expectedUpdatedAt: editingVersion,
      }
      if (freq === 'custom') body.cron = customCron.trim()
      else body.preset = buildPreset(freq, hour)
      const result = await saveSchedule(projectName, body)
      setEditing(false)
      setEditingVersion(undefined)
      updateScheduleCache(result)
      addToast({
        title: 'Schedule saved',
        detail: scheduleLabel(result.preset ?? null, result.cronExpr, result.timezone),
        tone: 'positive',
        dedupeKey: `schedule:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (e) {
      await handleMutationError(e, 'Failed to save schedule')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!schedule) return
    const editingScheduleVersion = schedule.updatedAt
    setSaving(true)
    setError(null)
    try {
      const latestResult = await schedulesQuery.refetch()
      if (latestResult.isError || latestResult.data === undefined) {
        setError('Canonry could not verify the latest schedule. Try again before updating it.')
        return
      }
      const latestSchedule = latestResult.data.find(item => item.kind === 'answer-visibility') ?? null
      if (!latestSchedule || latestSchedule.updatedAt !== editingScheduleVersion) {
        setError('This schedule changed elsewhere. Review the latest version and try again.')
        return
      }
      const body: Parameters<typeof saveSchedule>[1] = {
        timezone: latestSchedule.timezone,
        enabled: !latestSchedule.enabled,
        expectedUpdatedAt: editingScheduleVersion,
      }
      if (latestSchedule.preset) body.preset = latestSchedule.preset
      else body.cron = latestSchedule.cronExpr
      const nextSchedule = await saveSchedule(projectName, body)
      updateScheduleCache(nextSchedule)
      addToast({
        title: nextSchedule.enabled ? 'Schedule resumed' : 'Schedule paused',
        detail: scheduleLabel(nextSchedule.preset ?? null, nextSchedule.cronExpr, nextSchedule.timezone),
        tone: 'positive',
        dedupeKey: `schedule:toggle:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (e) {
      await handleMutationError(e, 'Failed to update schedule')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    if (!schedule) return
    const removingScheduleVersion = schedule.updatedAt
    setRemoving(true)
    setError(null)
    try {
      await removeSchedule(projectName, removingScheduleVersion)
      updateScheduleCache(null)
      setEditing(false)
      setEditingVersion(undefined)
      addToast({
        title: 'Schedule removed',
        detail: `${projectName} will no longer run automatically.`,
        tone: 'positive',
        dedupeKey: `schedule:remove:${projectName}`,
        dedupeMode: 'drop',
      })
    } catch (e) {
      await handleMutationError(e, 'Failed to remove schedule')
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
        {!isEmbed() && !scheduleLoading && !loadFailed && !editing && (
          <Button type="button" variant="outline" size="sm" onClick={startEditing}>
            {schedule ? 'Edit schedule' : '+ Set schedule'}
          </Button>
        )}
      </div>

      {scheduleLoading && <p className="supporting-copy">Loading...</p>}

      {error && !editing && <p className="mt-2 text-sm text-negative" role="alert">{error}</p>}

      {!scheduleLoading && loadFailed && (
        <Card className="surface-card compact-card">
          <p className="supporting-copy">Canonry could not verify this schedule.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => { void schedulesQuery.refetch() }}
          >
            Retry
          </Button>
        </Card>
      )}

      {!scheduleLoading && !loadFailed && !editing && schedule === null && (
        <Card className="surface-card compact-card">
          <p className="supporting-copy">No schedule configured. Set one to automatically trigger visibility sweeps.</p>
        </Card>
      )}

      {!scheduleLoading && !loadFailed && !editing && schedule !== null && (
        <Card className="surface-card compact-card">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-strong">{scheduleLabel(schedule.preset ?? null, schedule.cronExpr, schedule.timezone)}</p>
              <p className="text-xs text-muted">Cron: <span className="font-mono">{schedule.cronExpr}</span></p>
              {schedule.nextRunAt && (
                <p className="text-xs text-muted">Next run: {new Date(schedule.nextRunAt).toLocaleString()}</p>
              )}
              {schedule.lastRunAt && (
                <p className="text-xs text-muted">Last run: {new Date(schedule.lastRunAt).toLocaleString()}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ToneBadge tone={schedule.enabled ? 'positive' : 'neutral'}>
                {schedule.enabled ? 'Active' : 'Paused'}
              </ToneBadge>
              {!isEmbed() && (
                <Button type="button" variant="outline" size="sm" disabled={saving} onClick={asyncHandler(handleToggleEnabled)}>
                  {schedule.enabled ? 'Pause' : 'Resume'}
                </Button>
              )}
              {!isEmbed() && (
                <Button type="button" variant="ghost" size="sm" disabled={removing} onClick={asyncHandler(handleRemove)}>
                  {removing ? 'Removing...' : 'Remove'}
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}

      {!isEmbed() && editing && (
        <div className="rounded-lg border border-base bg-bg-elevated/40 p-4 space-y-3">
          {scheduleChangedElsewhere && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-caution bg-caution-soft px-3 py-2 text-sm text-caution" role="alert">
              <p>This schedule changed elsewhere. Load the latest version before saving.</p>
              <Button type="button" variant="outline" size="sm" onClick={loadLatestSchedule}>
                Load latest schedule
              </Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-secondary">Frequency</label>
              <select
                className="w-full rounded border border-strong bg-bg-elevated px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none"
                value={freq}
                onChange={(e) => setFreq(e.target.value)}
              >
                {FREQ_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-secondary">Time</label>
              <select
                className="w-full rounded border border-strong bg-bg-elevated px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none disabled:opacity-40"
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
              <label className="text-xs font-medium text-secondary">Cron expression</label>
              <input
                className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 font-mono focus:border-mono-500 focus:outline-none"
                type="text"
                placeholder="0 9 * * 1-5"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-secondary">Timezone</label>
            <select
              className="w-full rounded border border-strong bg-bg-elevated px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none"
              value={tzOther ? 'Other' : timezone}
              onChange={(e) => {
                if (e.target.value === 'Other') { setTzOther(true); setTimezone('Other') }
                else { setTzOther(false); setTimezone(e.target.value) }
              }}
            >
              {COMMON_TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
              <option value="Other">Other (enter manually){'\u2026'}</option>
            </select>
            {tzOther && (
              <input
                className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                type="text"
                placeholder="e.g. America/New_York"
                value={tzOtherValue}
                onChange={(e) => setTzOtherValue(e.target.value)}
              />
            )}
          </div>
          {error && <p className="text-negative-400 text-sm" role="alert">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(false); setEditingVersion(undefined); setError(null) }}>Cancel</Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || schedulesQuery.isFetching || loadFailed || scheduleChangedElsewhere || (freq === 'custom' && !customCron.trim())}
              onClick={asyncHandler(handleSave)}
            >
              {saving ? 'Saving...' : 'Save schedule'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

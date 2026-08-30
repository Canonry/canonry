import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ScheduleDto } from '@ainyc/canonry-contracts'
import {
  deleteApiV1ProjectsByNameScheduleMutation,
  getApiV1ProjectsByNameScheduleQueryKey,
  putApiV1ProjectsByNameScheduleMutation,
} from '@ainyc/canonry-api-client/react-query'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { formatHour, buildPreset, parsePreset, scheduleLabel } from '../../lib/format-helpers.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { heyClient, isEmbed } from '../../api.js'
import { useAccount } from '../../contexts/account-context.js'
import { assertCanWrite } from '../../lib/write-guard.js'
import { projectScheduleQueryOptions } from '../../queries/schedule-query.js'

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

export function ScheduleSection({
  projectName,
  scheduleEditRequested = false,
  onScheduleEditHandled,
  isActiveV2 = false,
}: {
  projectName: string
  /** A one-time Settings handoff from the project header. */
  scheduleEditRequested?: boolean
  /** Clears the portable `schedule=edit` marker after a terminal editor action. */
  onScheduleEditHandled?: () => void
  isActiveV2?: boolean
}) {
  const account = useAccount()
  const queryClient = useQueryClient()
  const scheduleOptions = { client: heyClient, path: { name: projectName } } as const
  const scheduleKey = getApiV1ProjectsByNameScheduleQueryKey(scheduleOptions)
  const scheduleQuery = useQuery({
    ...projectScheduleQueryOptions(projectName),
    retry: false,
  })
  const saveMutation = useMutation({
    ...putApiV1ProjectsByNameScheduleMutation(),
    onMutate: () => assertCanWrite(account),
  })
  const removeMutation = useMutation({
    ...deleteApiV1ProjectsByNameScheduleMutation(),
    onMutate: () => assertCanWrite(account),
  })
  const [editing, setEditing] = useState(false)
  const [freq, setFreq] = useState('daily')
  const [hour, setHour] = useState(6)
  const [customCron, setCustomCron] = useState('')
  const [timezone, setTimezone] = useState('UTC')
  const [tzOther, setTzOther] = useState(false)
  const [tzOtherValue, setTzOtherValue] = useState('')
  const [mutationError, setMutationError] = useState<string | null>(null)
  const consumedScheduleEdit = useRef(false)

  const schedule = scheduleQuery.data ?? null
  const scheduleReadError = scheduleQuery.isError
  const canEdit = account.canWrite && !isEmbed()
  const editorReady = scheduleQuery.data !== undefined

  const consumeScheduleEdit = useCallback(() => {
    if (scheduleEditRequested) onScheduleEditHandled?.()
  }, [onScheduleEditHandled, scheduleEditRequested])

  const startEditing = useCallback(() => {
    if (!canEdit) return
    if (schedule) {
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
    setMutationError(null)
    setEditing(true)
  }, [canEdit, schedule])

  useEffect(() => {
    if (!scheduleEditRequested) {
      consumedScheduleEdit.current = false
      return
    }
    if (consumedScheduleEdit.current || !editorReady) return
    consumedScheduleEdit.current = true
    if (canEdit) startEditing()
    else consumeScheduleEdit()
  }, [canEdit, consumeScheduleEdit, editorReady, scheduleEditRequested, startEditing])

  const invalidateSchedule = useCallback(async (next: ScheduleDto | null | undefined) => {
    if (next !== undefined) queryClient.setQueryData(scheduleKey, next)
    await queryClient.invalidateQueries({ queryKey: scheduleKey })
  }, [queryClient, scheduleKey])

  const handleSave = async () => {
    if (!canEdit || saveMutation.isPending) return
    setMutationError(null)
    try {
      const effectiveTz = tzOther ? tzOtherValue.trim() || 'UTC' : timezone
      const body: { timezone: string; preset?: string; cron?: string } = { timezone: effectiveTz }
      if (freq === 'custom') body.cron = customCron.trim()
      else body.preset = buildPreset(freq, hour)
      const result = await saveMutation.mutateAsync({ client: heyClient, path: { name: projectName }, body })
      await invalidateSchedule(result)
      setEditing(false)
      consumeScheduleEdit()
      addToast({
        title: 'Schedule saved',
        detail: scheduleLabel(result.preset ?? null, result.cronExpr, result.timezone),
        tone: 'positive',
        dedupeKey: `schedule:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to save schedule')
    }
  }

  const handleToggleEnabled = async () => {
    if (!canEdit || !schedule || saveMutation.isPending) return
    setMutationError(null)
    try {
      const body: { timezone: string; enabled: boolean; preset?: string; cron?: string } = {
        timezone: schedule.timezone,
        enabled: !schedule.enabled,
      }
      if (schedule.preset) body.preset = schedule.preset
      else body.cron = schedule.cronExpr
      const nextSchedule = await saveMutation.mutateAsync({ client: heyClient, path: { name: projectName }, body })
      await invalidateSchedule(nextSchedule)
      addToast({
        title: nextSchedule.enabled ? 'Schedule resumed' : 'Schedule paused',
        detail: scheduleLabel(nextSchedule.preset ?? null, nextSchedule.cronExpr, nextSchedule.timezone),
        tone: 'positive',
        dedupeKey: `schedule:toggle:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to update schedule')
    }
  }

  const handleRemove = async () => {
    if (!canEdit || removeMutation.isPending) return
    setMutationError(null)
    try {
      await removeMutation.mutateAsync({ client: heyClient, path: { name: projectName } })
      await invalidateSchedule(null)
      setEditing(false)
      consumeScheduleEdit()
      addToast({
        title: 'Schedule removed',
        detail: `${projectName} will no longer run automatically.`,
        tone: 'positive',
        dedupeKey: `schedule:remove:${projectName}`,
        dedupeMode: 'drop',
      })
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Failed to remove schedule')
    }
  }

  const cancelEditing = () => {
    setEditing(false)
    setMutationError(null)
    consumeScheduleEdit()
  }

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Automation</p>
          <h2>AI visibility sweep</h2>
          {isActiveV2 ? (
            <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">One schedule runs the full published plan. Groups and Properties inherit its official results; they do not have separate schedules.</p>
          ) : null}
        </div>
        {canEdit && !scheduleQuery.isPending && !scheduleReadError && !editing ? (
          <Button type="button" variant="outline" size="sm" onClick={startEditing}>
            {schedule ? 'Edit schedule' : '+ Set schedule'}
          </Button>
        ) : null}
      </div>

      {scheduleQuery.isPending ? <p role="status" className="supporting-copy">Loading AI visibility sweep…</p> : null}

      {scheduleReadError ? (
        <div role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-3 text-sm text-negative">
          <p>Could not load the AI visibility sweep schedule.</p>
          <Button className="mt-3" type="button" size="sm" variant="outline" onClick={() => { void scheduleQuery.refetch() }}>Retry</Button>
        </div>
      ) : null}

      {!scheduleQuery.isPending && !scheduleReadError && !editing && schedule === null ? (
        <Card className="surface-card compact-card">
          <p className="supporting-copy">No AI visibility sweep is scheduled. Set one to automatically trigger visibility sweeps.</p>
        </Card>
      ) : null}

      {!scheduleQuery.isPending && !scheduleReadError && !editing && schedule !== null ? (
        <Card className="surface-card compact-card">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-strong">{scheduleLabel(schedule.preset ?? null, schedule.cronExpr, schedule.timezone)}</p>
              <p className="text-xs text-muted">Cron: <span className="font-mono">{schedule.cronExpr}</span></p>
              {schedule.nextRunAt ? <p className="text-xs text-muted">Next run: {new Date(schedule.nextRunAt).toLocaleString()}</p> : null}
              {schedule.lastRunAt ? <p className="text-xs text-muted">Last run: {new Date(schedule.lastRunAt).toLocaleString()}</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ToneBadge tone={schedule.enabled ? 'positive' : 'neutral'}>{schedule.enabled ? 'Active' : 'Paused'}</ToneBadge>
              {canEdit ? (
                <Button type="button" variant="outline" size="sm" disabled={saveMutation.isPending} onClick={asyncHandler(handleToggleEnabled)}>
                  {schedule.enabled ? 'Pause' : 'Resume'}
                </Button>
              ) : null}
              {canEdit ? (
                <Button type="button" variant="ghost" size="sm" disabled={removeMutation.isPending} onClick={asyncHandler(handleRemove)}>
                  {removeMutation.isPending ? 'Removing...' : 'Remove'}
                </Button>
              ) : null}
            </div>
          </div>
          {mutationError ? <p className="mt-2 text-sm text-negative-400">{mutationError}</p> : null}
        </Card>
      ) : null}

      {canEdit && editing ? (
        <div className="mt-4 space-y-3 rounded-lg border border-base bg-bg-elevated/40 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-secondary" htmlFor="schedule-frequency">Frequency</label>
              <select
                id="schedule-frequency"
                className="w-full rounded border border-strong bg-bg-elevated px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none"
                value={freq}
                onChange={(event) => setFreq(event.target.value)}
              >
                {FREQ_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-secondary" htmlFor="schedule-hour">Time</label>
              <select
                id="schedule-hour"
                className="w-full rounded border border-strong bg-bg-elevated px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none disabled:opacity-40"
                value={hour}
                disabled={freq === 'twice-daily' || freq === 'custom'}
                onChange={(event) => setHour(parseInt(event.target.value, 10))}
              >
                {Array.from({ length: 24 }, (_, index) => <option key={index} value={index}>{formatHour(index)}</option>)}
              </select>
            </div>
          </div>
          {freq === 'custom' ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-secondary" htmlFor="schedule-cron">Cron expression</label>
              <input
                id="schedule-cron"
                className="w-full rounded border border-strong bg-transparent px-2 py-1.5 font-mono text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                type="text"
                placeholder="0 9 * * 1-5"
                value={customCron}
                onChange={(event) => setCustomCron(event.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-secondary" htmlFor="schedule-timezone">Timezone</label>
            <select
              id="schedule-timezone"
              className="w-full rounded border border-strong bg-bg-elevated px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none"
              value={tzOther ? 'Other' : timezone}
              onChange={(event) => {
                if (event.target.value === 'Other') {
                  setTzOther(true)
                  setTimezone('Other')
                } else {
                  setTzOther(false)
                  setTimezone(event.target.value)
                }
              }}
            >
              {COMMON_TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              <option value="Other">Other (enter manually)…</option>
            </select>
            {tzOther ? (
              <input
                aria-label="Other timezone"
                className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                type="text"
                placeholder="e.g. America/New_York"
                value={tzOtherValue}
                onChange={(event) => setTzOtherValue(event.target.value)}
              />
            ) : null}
          </div>
          {mutationError ? <p className="text-sm text-negative-400">{mutationError}</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            {schedule ? (
              <Button type="button" variant="ghost" size="sm" disabled={removeMutation.isPending} onClick={asyncHandler(handleRemove)}>
                {removeMutation.isPending ? 'Removing...' : 'Remove schedule'}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={cancelEditing}>Cancel</Button>
            <Button type="button" size="sm" disabled={saveMutation.isPending || (freq === 'custom' && !customCron.trim())} onClick={asyncHandler(handleSave)}>
              {saveMutation.isPending ? 'Saving...' : 'Save schedule'}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

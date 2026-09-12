import { afterEach, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { SCHEDULE_CLI_COMMANDS } from '../src/cli-commands/schedule.js'
import { NOTIFY_CLI_COMMANDS } from '../src/cli-commands/notify.js'
import { SYSTEM_CLI_COMMANDS } from '../src/cli-commands/system.js'

const state = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock('../src/client.js', async original => ({ ...await original(), createApiClient: () => state.client }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('lists all schedules through the generated client and CLI', async () => {
  const rows = [{ id: 'schedule-1', projectId: 'project-1', kind: 'traffic-sync' }]
  const fetch = vi.fn(async () => new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  state.client = new ApiClient('https://fixture.invalid', 'fake', { skipProbe: true })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  await dispatchRegisteredCommand(['schedule', 'list', 'demo'], 'json', SCHEDULE_CLI_COMMANDS)
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual(rows)
  expect(new URL((fetch.mock.calls[0] as unknown as [Request])[0].url).pathname).toBe('/api/v1/projects/demo/schedules')
})

it('can discover the server notification catalog without replacing the offline default', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(['run.failed']), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  state.client = new ApiClient('https://fixture.invalid', 'fake', { skipProbe: true })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  await dispatchRegisteredCommand(['notify', 'events', '--target', 'server'], 'json', NOTIFY_CLI_COMMANDS)
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual([{ event: 'run.failed', description: 'An AEO sweep failed' }])
  expect(new URL((fetch.mock.calls[0] as unknown as [Request])[0].url).pathname).toBe('/api/v1/notifications/events')
})

it('reads bounded diagnostic logs through the CLI without losing pagination metadata', async () => {
  const result = { entries: [], nextCursor: null, truncated: 0, dropped: 3, retention: 'process', observedAt: '2026-09-11T00:00:00.000Z' }
  const fetch = vi.fn(async () => new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  state.client = new ApiClient('https://fixture.invalid', 'fake', { skipProbe: true })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  await dispatchRegisteredCommand(['logs', '--limit', '5', '--run-id', 'run-1'], 'json', SYSTEM_CLI_COMMANDS)
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual(result)
  const url = new URL((fetch.mock.calls[0] as unknown as [Request])[0].url)
  expect(url.pathname).toBe('/api/v1/operations/logs')
  expect(url.searchParams.get('runId')).toBe('run-1')
  expect(url.searchParams.get('limit')).toBe('5')
})

it('forwards runtime identity and time filters without dropping durable retention metadata', async () => {
  const result = { entries: [], nextCursor: null, truncated: 0, dropped: 3, retention: 'durable', retentionPolicy: { maxEntries: 10_000, maxAgeSeconds: 604_800 }, captureErrors: 0, observedAt: '2026-09-11T00:00:00.000Z' }
  const fetch = vi.fn(async () => new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  state.client = new ApiClient('https://fixture.invalid', 'fake', { skipProbe: true })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  await dispatchRegisteredCommand(['logs', '--actor', 'user:fixture', '--request-id', 'req-fixture', '--since', '2026-09-10T00:00:00.000Z', '--until', '2026-09-11T00:00:00.000Z', '--level', 'fatal'], 'json', SYSTEM_CLI_COMMANDS)
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual(result)
  const url = new URL((fetch.mock.calls[0] as unknown as [Request])[0].url)
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ actor: 'user:fixture', requestId: 'req-fixture', since: '2026-09-10T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z', level: 'fatal' })
})

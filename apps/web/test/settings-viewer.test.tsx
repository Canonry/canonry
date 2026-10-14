/**
 * Project Settings for a view-only account.
 *
 * The server refuses a viewer's save either way. These pin that the three
 * sections that change settings never offer one: no button, no form, and no
 * empty state that tells a viewer to set something up. Each section says
 * "View only" where its button would be.
 */
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'

import { NotificationsSection } from '../src/components/project/NotificationsSection.js'
import { ProjectSettingsSection } from '../src/components/project/ProjectSettingsSection.js'
import { ScheduleSection } from '../src/components/project/ScheduleSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(cleanup)

const project = {
  name: 'acme-homes',
  displayName: 'Acme Homes',
  canonicalDomain: 'example.com',
  ownedDomains: [],
  aliases: [],
  country: 'US',
  language: 'en',
  locations: [
    { label: 'north', city: 'Northbridge', region: 'NY', country: 'US', timezone: 'America/New_York' },
    { label: 'harbor', city: 'Harbor Point', region: 'NY', country: 'US' },
  ],
  defaultLocation: 'north',
}
const schedule = {
  id: 'schedule-1', projectId: 'project-1', kind: 'answer-visibility', cronExpr: '0 6 * * *', preset: 'daily', timezone: 'UTC', enabled: true, providers: [],
  nextRunAt: '2026-08-07T06:00:00.000Z', lastRunAt: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
}
const webhook = {
  id: 'hook-1', projectId: 'project-1', channel: 'webhook', url: 'https://hooks.example.com/canonry', urlDisplay: 'hooks.example.com/canonry', urlHost: 'hooks.example.com',
  events: ['citation.lost'], enabled: true, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
}

const VIEW_ONLY = 'View only. Your account cannot change this.'
/** Every control of the three sections that changes something, by accessible name. */
const WRITE_CONTROLS = [
  /^Edit settings$/, /^\+ Add search location$/, /^Set harbor as default search location$/, /^Remove search location north$/,
  /^\+ Set schedule$/, /^Edit schedule$/, /^Pause$/, /^Remove$/, /^\+ Add webhook$/, /^Test$/,
]

function renderSettings(role: 'admin' | 'viewer', stored: { schedule?: boolean; webhook?: boolean } = {}) {
  const methods: string[] = []
  onTestFinished(mockFetch((url, init) => {
    methods.push(init?.method ?? 'GET')
    const path = pathOf(url).split('?')[0]!
    if (path === '/api/v1/projects/acme-homes/schedules') return jsonResponse(stored.schedule ? [schedule] : [])
    if (path === '/api/v1/projects/acme-homes/notifications') return jsonResponse(stored.webhook ? [webhook] : [])
    throw new Error(`Unexpected fetch: ${path}`)
  }))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  render(
    <AccountProvider account={{ name: 'someone', role }}>
      <QueryClientProvider client={queryClient}>
        <ProjectSettingsSection project={project} onUpdateProject={vi.fn()} />
        <ScheduleSection projectName="acme-homes" />
        <NotificationsSection projectName="acme-homes" />
      </QueryClientProvider>
    </AccountProvider>,
  )
  return methods
}

const section = (heading: string) => within(screen.getByRole('heading', { name: heading }).closest('section')!)

describe('Settings as a view-only account', () => {
  test('nothing stored: each section says View only, and no empty state tells a viewer to set something up', async () => {
    const methods = renderSettings('viewer')
    // Plain words, not a note with a sentence behind it: the sentence is an instruction to someone who can act on it.
    expect((await section('Scheduled sweeps').findByText('No schedule')).closest('button')).toBeNull()
    expect((await section('Notifications').findByText('No webhooks')).closest('button')).toBeNull()

    for (const heading of ['Project settings', 'Scheduled sweeps', 'Notifications']) {
      expect(section(heading).getByRole('button', { name: VIEW_ONLY }).textContent, heading).toBe('View only')
    }
    for (const name of WRITE_CONTROLS) expect(screen.queryByRole('button', { name }), String(name)).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    // The stored settings stay readable.
    expect(section('Project settings').getByText('Harbor Point')).toBeTruthy()
    expect(methods.every(method => method === 'GET')).toBe(true)
  })

  test('a stored schedule and webhook are read with no Pause, Remove or Test', async () => {
    renderSettings('viewer', { schedule: true, webhook: true })
    expect(await section('Scheduled sweeps').findByText('0 6 * * *')).toBeTruthy()
    expect(section('Scheduled sweeps').getByText('Active')).toBeTruthy()
    expect(await section('Notifications').findByText('hooks.example.com/canonry')).toBeTruthy()

    for (const name of WRITE_CONTROLS) expect(screen.queryByRole('button', { name }), String(name)).toBeNull()
    expect(screen.getAllByRole('button', { name: VIEW_ONLY })).toHaveLength(3)
  })
})

describe('Settings as an administrator', () => {
  test('nothing stored: every control is offered, and each empty state says what setting one does', async () => {
    renderSettings('admin')
    expect((await screen.findByRole('button', { name: 'No schedule. Set a schedule to run sweeps automatically.' })).textContent).toBe('No schedule')
    expect((await screen.findByRole('button', { name: 'No webhooks. Add a webhook to get alerted when citations change or runs complete.' })).textContent).toBe('No webhooks')

    for (const name of [/^Edit settings$/, /^\+ Add search location$/, /^Set harbor as default search location$/, /^Remove search location north$/, /^\+ Set schedule$/, /^\+ Add webhook$/]) {
      expect(screen.getByRole('button', { name }), String(name)).toBeTruthy()
    }
    expect(screen.queryByText('View only')).toBeNull()
  })

  test('a stored schedule and webhook keep Edit, Pause, Remove and Test', async () => {
    renderSettings('admin', { schedule: true, webhook: true })
    await waitFor(() => expect(section('Scheduled sweeps').getByRole('button', { name: 'Edit schedule' })).toBeTruthy())
    expect(section('Scheduled sweeps').getByRole('button', { name: 'Pause' })).toBeTruthy()
    expect(section('Scheduled sweeps').getByRole('button', { name: 'Remove' })).toBeTruthy()
    expect(await section('Notifications').findByRole('button', { name: 'Test' })).toBeTruthy()
    expect(section('Notifications').getByRole('button', { name: 'Remove' })).toBeTruthy()
  })
})

describe('Project settings empty values', () => {
  test('a value that is not set reads None, never a dash', () => {
    render(<ProjectSettingsSection project={{ ...project, displayName: '' }} onUpdateProject={vi.fn()} />)
    const rows = Object.fromEntries([...document.querySelectorAll('table.w-full.text-sm > tbody > tr')].map(row => [row.children[0]!.textContent, row.children[1]!.textContent]))
    expect([rows['Display name'], rows['Owned domains'], rows.Aliases]).toEqual(['None', 'None', 'None'])
    // The engines' locations are "Search locations", as everywhere else. One with no timezone says None.
    const locations = within(screen.getByText('Search locations').closest('tr')!).getAllByRole('row').slice(1)
    expect(locations.map(row => within(row).getAllByRole('cell').slice(0, 5).map(cell => cell.textContent))).toEqual([
      ['north ★', 'Northbridge', 'NY', 'US', 'America/New_York'],
      ['harbor', 'Harbor Point', 'NY', 'US', 'None'],
    ])
    expect(document.body.textContent).not.toContain('—')
  })
})

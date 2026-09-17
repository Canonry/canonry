import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough, ComposedChart: passthrough, BarChart: passthrough,
    Area: () => null, Line: () => null, Bar: () => null, Cell: () => null, CartesianGrid: () => null,
    ReferenceArea: () => null, ReferenceLine: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, Legend: () => null,
  }
})

import { ActivitySection } from '../src/components/project/ActivitySection.js'
import { NotificationsSection } from '../src/components/project/NotificationsSection.js'
import { ProjectSettingsSection } from '../src/components/project/ProjectSettingsSection.js'
import { ScheduleSection } from '../src/components/project/ScheduleSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const DEMO = { enabled: true, readOnly: true, sampleData: true } as const

function trackReads(respond: (path: string) => Response) {
  const methods: string[] = []
  const restore = mockFetch((url, init) => {
    methods.push(init?.method ?? 'GET')
    return respond(pathOf(url).split('?')[0]!)
  })
  onTestFinished(restore)
  return methods
}

function withQueryClient(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('project settings tab', () => {
  const project = {
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    ownedDomains: [],
    aliases: [],
    country: 'US',
    language: 'en',
    locations: [
      { label: 'nyc', city: 'New York', region: 'NY', country: 'US', timezone: 'America/New_York' },
      { label: 'sf', city: 'San Francisco', region: 'CA', country: 'US', timezone: 'America/Los_Angeles' },
    ],
    defaultLocation: 'nyc',
  }
  const changeControls = [/^Edit settings$/, /^\+ Add location$/, /^Set sf as default location$/, /^Remove location nyc$/, /^\+ Set schedule$/, /^\+ Add webhook$/]

  function renderSettingsTab() {
    const methods = trackReads((path) => {
      if (path === '/api/v1/projects/test-project/schedules') return jsonResponse([])
      if (path === '/api/v1/projects/test-project/notifications') return jsonResponse([])
      throw new Error(`Unexpected fetch: ${path}`)
    })
    render(withQueryClient(<>
      <ProjectSettingsSection project={project} onUpdateProject={vi.fn()} onRefresh={vi.fn()} />
      <ScheduleSection projectName="test-project" />
      <NotificationsSection projectName="test-project" />
    </>))
    return methods
  }

  test('public demo shows stored settings without any control that would change them', async () => {
    window.__CANONRY_CONFIG__ = { demo: DEMO }
    const methods = renderSettingsTab()
    await waitFor(() => expect(screen.getByText(/No schedule configured/)).toBeTruthy())
    await waitFor(() => expect(screen.getByText(/No webhooks configured/)).toBeTruthy())
    expect(screen.getByText('San Francisco')).toBeTruthy()
    for (const name of changeControls) expect(screen.queryByRole('button', { name }), String(name)).toBeNull()
    expect(methods.every((method) => method === 'GET')).toBe(true)
  })

  test('outside the public demo every settings control stays available', async () => {
    renderSettingsTab()
    await waitFor(() => expect(screen.getByRole('button', { name: '+ Set schedule' })).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: '+ Add webhook' })).toBeTruthy())
    for (const name of changeControls) expect(screen.getByRole('button', { name }), String(name)).toBeTruthy()
  })
})

describe('Google Analytics on the Activity tab', () => {
  function renderConnectedActivity() {
    const methods = trackReads((path) => {
      if (path.endsWith('/ga/status')) {
        return jsonResponse({
          connected: true, propertyId: '999888', clientEmail: null, authMethod: 'service-account',
          lastSyncedAt: '2026-03-31T12:00:00.000Z', createdAt: '2026-03-31T12:00:00.000Z', updatedAt: '2026-03-31T12:00:00.000Z',
        })
      }
      if (path.endsWith('/ga/traffic')) {
        return jsonResponse({
          totalSessions: 120, totalOrganicSessions: 70, totalDirectSessions: 30, totalUsers: 95,
          topPages: [], aiReferrals: [], aiReferralLandingPages: [], socialReferrals: [],
          aiSessionsDeduped: 0, paidAiSessionsDeduped: 0, organicAiSessionsDeduped: 0,
          aiSessionsBySession: 0, paidAiSessionsBySession: 0, organicAiSessionsBySession: 0,
          socialSessions: 0, socialUsers: 0,
          organicSharePct: 58, aiSharePct: 0, aiSharePctBySession: 0, paidAiSharePct: 0, paidAiSharePctBySession: 0,
          organicAiSharePct: 0, organicAiSharePctBySession: 0, directSharePct: 25, socialSharePct: 0,
          organicSharePctDisplay: '58%', aiSharePctDisplay: '0%', aiSharePctBySessionDisplay: '0%', paidAiSharePctDisplay: '0%',
          paidAiSharePctBySessionDisplay: '0%', organicAiSharePctDisplay: '0%', organicAiSharePctBySessionDisplay: '0%',
          directSharePctDisplay: '25%', socialSharePctDisplay: '0%', otherSessions: 20, otherSharePct: 17, otherSharePctDisplay: '17%',
          lastSyncedAt: '2026-03-31T12:00:00.000Z',
        })
      }
      if (path.endsWith('/ga/ai-referral-daily')) return jsonResponse({ days: [], sources: [], totalSessions: 0, totalPaidSessions: 0, totalOrganicSessions: 0 })
      if (path.endsWith('/ga/session-history') || path.endsWith('/ga/social-referral-history')) return jsonResponse([])
      if (path.endsWith('/traffic/sources')) return jsonResponse({ sources: [] })
      throw new Error(`Unexpected fetch: ${path}`)
    })
    render(withQueryClient(<ActivitySection projectName="test-project" />))
    return methods
  }

  test('public demo shows the connected property without sync or disconnect', async () => {
    window.__CANONRY_CONFIG__ = { demo: DEMO }
    const methods = renderConnectedActivity()
    await waitFor(() => expect(screen.getByText('999888')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /sync/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull()
    expect(methods.every((method) => method === 'GET')).toBe(true)
  })

  test('outside the public demo sync and disconnect stay available', async () => {
    renderConnectedActivity()
    await waitFor(() => expect(screen.getByText('999888')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Sync' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
  })
})

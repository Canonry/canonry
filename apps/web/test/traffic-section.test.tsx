// @vitest-environment jsdom
import React from 'react'
import { expect, onTestFinished, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    Area: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
  }
})

import { TrafficSection } from '../src/components/project/TrafficSection.js'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = handler as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('loads connected GA4 data without changing hook order', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/ga/status')) {
      return jsonResponse({
        connected: true,
        propertyId: '999888',
        clientEmail: 'sa@test.iam.gserviceaccount.com',
        authMethod: 'service-account',
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
        createdAt: '2026-03-31T12:00:00.000Z',
        updatedAt: '2026-03-31T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/traffic')) {
      return jsonResponse({
        totalSessions: 120,
        totalOrganicSessions: 70,
        totalUsers: 95,
        topPages: [
          { landingPage: '/pricing', sessions: 80, organicSessions: 50, users: 60 },
        ],
        aiReferrals: [
          { source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 12, users: 9 },
        ],
        aiSessionsDeduped: 12,
        aiUsersDeduped: 9,
        socialReferrals: [
          { source: 'facebook.com', medium: 'social', channelGroup: 'Organic Social', sessions: 8, users: 6 },
        ],
        socialSessions: 8,
        socialUsers: 6,
        lastSyncedAt: '2026-03-31T12:00:00.000Z',
      })
    }
    if (urlPath.endsWith('/projects/test-project/ga/ai-referral-history')) {
      return jsonResponse([
        { date: '2026-03-30', source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 5, users: 4 },
        { date: '2026-03-31', source: 'chatgpt.com', medium: 'referral', sourceDimension: 'session', sessions: 7, users: 5 },
      ])
    }
    if (urlPath.endsWith('/projects/test-project/ga/session-history')) {
      return jsonResponse([
        { date: '2026-03-30', sessions: 50, organicSessions: 30, users: 40 },
        { date: '2026-03-31', sessions: 70, organicSessions: 40, users: 55 },
      ])
    }
    if (urlPath.endsWith('/projects/test-project/ga/social-referral-history')) {
      return jsonResponse([])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  onTestFinished(() => consoleErrorSpy.mockRestore())

  render(<TrafficSection projectName="test-project" />)

  await waitFor(() => {
    expect(screen.getByText('AI vs. total sessions')).toBeTruthy()
  })

  expect(screen.getByText(/Top AI referrer:/)).toBeTruthy()
  expect(
    consoleErrorSpy.mock.calls.flat().some((arg) =>
      String(arg).includes('change in the order of Hooks')
      || String(arg).includes('Rendered more hooks than during the previous render'),
    ),
  ).toBe(false)
})

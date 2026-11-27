import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { trafficFetchKind, EventsTable } from '../src/pages/TrafficSourceDetailPage.js'

afterEach(() => {
  cleanup()
})

/**
 * Regression for a chart you could click that always returned nothing.
 *
 * Measured on a live project: 2,199 crawler rows against 8 AI-referral rows in
 * a 24h window, fetched with `kind: 'all'` under a 500-row cap. Every
 * AI-referral row sat at position 640 or later, so none were ever fetched. The
 * chart aggregates server-side and drew the bar correctly; clicking it filtered
 * a client-side set that had never contained the rows.
 */
test('a single selected series is fetched as that series, not as everything', () => {
  expect(trafficFetchKind(new Set(['ai-referral']))).toBe('ai-referral')
  expect(trafficFetchKind(new Set(['ai-user-fetch']))).toBe('ai-user-fetch')
  expect(trafficFetchKind(new Set(['crawler']))).toBe('crawler')
})

test('two selected series are fetched as exactly those two', () => {
  // With the crawler off, 'all' under the row cap is still almost only crawler
  // rows, and the AI rows the chart shows never load. Order is fixed so the
  // query key does not change with toggle order.
  expect(trafficFetchKind(new Set(['ai-referral', 'ai-user-fetch']))).toBe('ai-user-fetch,ai-referral')
  expect(trafficFetchKind(new Set(['ai-referral', 'crawler']))).toBe('crawler,ai-referral')
  expect(trafficFetchKind(new Set(['ai-user-fetch', 'crawler']))).toBe('crawler,ai-user-fetch')
})

test('every series or none fetches all, which is already their union', () => {
  expect(trafficFetchKind(new Set(['crawler', 'ai-user-fetch', 'ai-referral']))).toBe('all')
  expect(trafficFetchKind(new Set([]))).toBe('all')
})

test('an empty result over a TRUNCATED set does not claim nothing matched', () => {
  // Rows past the cap were never loaded, so their absence was never tested.
  // Reporting a confident "no rows match" for that state is what made the
  // original bug unreadable from the UI.
  render(<EventsTable events={[]} truncated />)
  expect(screen.queryByText('No event rows match the current filters.')).toBeNull()
  const msg = screen.getByText(/No matches in the rows loaded so far/)
  expect(msg.textContent).toContain('beyond the load limit')
})

test('an empty result over a COMPLETE set still says nothing matched', () => {
  render(<EventsTable events={[]} truncated={false} />)
  expect(screen.getByText('No event rows match the current filters.')).toBeTruthy()
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAcquisitionByChannel,
  fetchLeadEvents,
} from '../src/ga4-client.js'
import { GA4_DIMENSIONS, GA4_METRICS } from '../src/constants.js'

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('GA4 measurement reports', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('fetches the complete native acquisition grain and paginates without collapsing channels into Other', async () => {
    const requests: Array<Record<string, unknown>> = []
    fetchSpy.mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(request)
      const offset = Number(request.offset ?? 0)
      if (offset === 0) {
        return jsonResponse({
          rows: [{
            dimensionValues: [
              { value: '20260721' },
              { value: 'Paid Search' },
              { value: 'google' },
              { value: 'cpc' },
              { value: 'offers.example.com' },
              { value: '/quote?utm_campaign=summer' },
            ],
            metricValues: [{ value: '11' }],
          }],
          rowCount: 2,
        })
      }
      return jsonResponse({
        rows: [{
          dimensionValues: [
            { value: '20260722' },
            { value: 'Organic Search' },
            { value: 'bing' },
            { value: 'organic' },
            { value: 'www.example.com' },
            { value: '/blog/answer-engine-optimization' },
          ],
          metricValues: [{ value: '7' }],
        }],
        rowCount: 2,
      })
    })

    const rows = await fetchAcquisitionByChannel('fake-token', '123456', 90, { pageSize: 1 })

    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.offset)).toEqual([0, 1])
    expect(requests[0]).toMatchObject({
      dimensions: [
        { name: GA4_DIMENSIONS.date },
        { name: GA4_DIMENSIONS.sessionDefaultChannelGroup },
        { name: GA4_DIMENSIONS.sessionSource },
        { name: GA4_DIMENSIONS.sessionMedium },
        { name: GA4_DIMENSIONS.hostName },
        { name: GA4_DIMENSIONS.landingPagePlusQueryString },
      ],
      metrics: [{ name: GA4_METRICS.sessions }],
    })
    expect(rows).toEqual([
      {
        date: '2026-07-21',
        channelGroup: 'Paid Search',
        source: 'google',
        medium: 'cpc',
        hostName: 'offers.example.com',
        landingPage: '/quote?utm_campaign=summer',
        sessions: 11,
      },
      {
        date: '2026-07-22',
        channelGroup: 'Organic Search',
        source: 'bing',
        medium: 'organic',
        hostName: 'www.example.com',
        landingPage: '/blog/answer-engine-optimization',
        sessions: 7,
      },
    ])
  })

  it('requests only configured lead events and preserves landing-page attribution when GA4 accepts it', async () => {
    let request: Record<string, unknown> | undefined
    fetchSpy.mockImplementation(async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({
        rows: [{
          dimensionValues: [
            { value: '20260722' },
            { value: 'book_demo' },
            { value: 'Paid Search' },
            { value: 'google' },
            { value: 'cpc' },
            { value: 'offers.example.com' },
            { value: '/demo?utm_source=google' },
          ],
          metricValues: [{ value: '3' }],
        }],
        rowCount: 1,
      })
    })

    const report = await fetchLeadEvents(
      'fake-token',
      '123456',
      ['generate_lead', 'book_demo'],
      60,
    )

    expect(request).toMatchObject({
      dimensions: [
        { name: GA4_DIMENSIONS.date },
        { name: GA4_DIMENSIONS.eventName },
        { name: GA4_DIMENSIONS.sessionDefaultChannelGroup },
        { name: GA4_DIMENSIONS.sessionSource },
        { name: GA4_DIMENSIONS.sessionMedium },
        { name: GA4_DIMENSIONS.hostName },
        { name: GA4_DIMENSIONS.landingPagePlusQueryString },
      ],
      metrics: [{ name: GA4_METRICS.eventCount }],
      dimensionFilter: {
        orGroup: {
          expressions: [
            {
              filter: {
                fieldName: GA4_DIMENSIONS.eventName,
                stringFilter: { matchType: 'EXACT', value: 'generate_lead' },
              },
            },
            {
              filter: {
                fieldName: GA4_DIMENSIONS.eventName,
                stringFilter: { matchType: 'EXACT', value: 'book_demo' },
              },
            },
          ],
        },
      },
    })
    expect(report).toEqual({
      attributionScope: 'landing-page',
      rows: [{
        date: '2026-07-22',
        eventName: 'book_demo',
        channelGroup: 'Paid Search',
        source: 'google',
        medium: 'cpc',
        hostName: 'offers.example.com',
        landingPage: '/demo?utm_source=google',
        eventCount: 3,
      }],
    })
  })

  it('falls back to channel attribution only for GA4 dimension incompatibility and labels unavailable page dimensions honestly', async () => {
    const requests: Array<Record<string, unknown>> = []
    fetchSpy.mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(request)
      if (requests.length === 1) {
        return jsonResponse({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'Please remove landingPagePlusQueryString because the requested dimensions and metrics are incompatible.',
          },
        }, 400)
      }
      return jsonResponse({
        rows: [{
          dimensionValues: [
            { value: '20260722' },
            { value: 'generate_lead' },
            { value: 'Organic Search' },
            { value: 'google' },
            { value: 'organic' },
          ],
          metricValues: [{ value: '2' }],
        }],
        rowCount: 1,
      })
    })

    const report = await fetchLeadEvents('fake-token', '123456', ['generate_lead'], 30)

    expect(requests).toHaveLength(2)
    expect(requests[0]?.dimensions).toContainEqual({
      name: GA4_DIMENSIONS.landingPagePlusQueryString,
    })
    expect(requests[1]?.dimensions).toEqual([
      { name: GA4_DIMENSIONS.date },
      { name: GA4_DIMENSIONS.eventName },
      { name: GA4_DIMENSIONS.sessionDefaultChannelGroup },
      { name: GA4_DIMENSIONS.sessionSource },
      { name: GA4_DIMENSIONS.sessionMedium },
    ])
    expect(report).toEqual({
      attributionScope: 'channel',
      rows: [{
        date: '2026-07-22',
        eventName: 'generate_lead',
        channelGroup: 'Organic Search',
        source: 'google',
        medium: 'organic',
        hostName: '(not available)',
        landingPage: '(not available)',
        eventCount: 2,
      }],
    })
  })

  it('does not hide unrelated GA4 400 errors behind the channel fallback', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'Unknown metric eventCountt.',
      },
    }, 400))

    await expect(fetchLeadEvents('fake-token', '123456', ['generate_lead'], 30))
      .rejects.toMatchObject({ name: 'GA4ApiError', status: 400 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

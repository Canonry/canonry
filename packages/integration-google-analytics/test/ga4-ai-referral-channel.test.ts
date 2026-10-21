import fs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiEngineForReferralSource } from '@canonry/canonry-contracts'
import { GA4ApiError, GA4_DIMENSIONS, fetchAiReferrals } from '../src/index.js'
import type { GA4RunReportRequest, GA4RunReportResponse } from '../src/index.js'

/**
 * `fetchAiReferrals` against requests and responses shaped by the live GA4
 * Data API (see `fixtures/README.md`). Each pass's request must be the one
 * verified live: GA4 alone decides which rows the filter selects, so the
 * request is what gets GA4's `AI Assistant` rows into the sync at all.
 */

type Pass = 'session' | 'first_user' | 'manual_utm'

interface Fixture {
  passes: Record<Pass, { request: GA4RunReportRequest; response: GA4RunReportResponse }>
  invalidRequestError: { body: unknown }
}

const fixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/ga4-ai-referrals-ai-assistant-channel.json', import.meta.url),
  'utf8',
)) as Fixture

const PASS_BY_SOURCE_DIMENSION: Record<string, Pass> = {
  [GA4_DIMENSIONS.sessionSource]: 'session',
  [GA4_DIMENSIONS.firstUserSource]: 'first_user',
  [GA4_DIMENSIONS.sessionManualSource]: 'manual_utm',
}

interface StringFilter { matchType: string; value: string; caseSensitive?: boolean }
type Expressions = Array<{ filter: { fieldName: string; stringFilter: StringFilter } }>

/**
 * GA4's own string-filter semantics for the match types this client sends:
 * case-insensitive unless `caseSensitive` is set. GA4 applies the filter, so a
 * test of which sources a request selects has to apply it the same way.
 */
function ga4Selects(filter: StringFilter, source: string): boolean {
  const value = filter.caseSensitive ? filter.value : filter.value.toLowerCase()
  const subject = filter.caseSensitive ? source : source.toLowerCase()
  switch (filter.matchType) {
    case 'EXACT': return subject === value
    case 'CONTAINS': return subject.includes(value)
    case 'BEGINS_WITH': return subject.startsWith(value)
    case 'ENDS_WITH': return subject.endsWith(value)
    default: throw new Error(`match type not modelled here: ${filter.matchType}`)
  }
}

function expressionsOf(request: GA4RunReportRequest): Expressions {
  const filter = request.dimensionFilter
  return filter && 'orGroup' in filter ? filter.orGroup.expressions : []
}

/** The request without its date range, which depends on the clock. */
function withoutDates(request: GA4RunReportRequest): Omit<GA4RunReportRequest, 'dateRanges'> {
  const { dateRanges: _dateRanges, ...rest } = request
  return rest
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('fetchAiReferrals with GA4\'s AI Assistant channel', () => {
  let requests: Array<{ pass: Pass; body: GA4RunReportRequest }>
  let fetchSpy: ReturnType<typeof vi.spyOn>

  /** Answer each pass as `respond` says, recording every request. */
  function serve(respond: (pass: Pass, body: GA4RunReportRequest) => Response) {
    fetchSpy.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as GA4RunReportRequest
      const pass = PASS_BY_SOURCE_DIMENSION[body.dimensions[1]!.name]!
      requests.push({ pass, body })
      return respond(pass, body)
    })
  }

  /** Replay the captured exchange: the fixture's response, only for the fixture's request. */
  function replay(pass: Pass, body: GA4RunReportRequest): Response {
    const captured = fixture.passes[pass]
    if (!isDeepStrictEqual(withoutDates(body), withoutDates(captured.request))) {
      return json({ error: { code: 400, message: `unexpected ${pass} request`, status: 'INVALID_ARGUMENT' } }, 400)
    }
    return json(captured.response)
  }

  beforeEach(() => {
    requests = []
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('sends each pass the request verified against the live API', async () => {
    serve(replay)
    await fetchAiReferrals('fake-token', '123456', 90)

    expect(requests.map(r => r.pass)).toEqual(['session', 'first_user', 'manual_utm'])
    for (const { pass, body } of requests) {
      expect(withoutDates(body)).toEqual(withoutDates(fixture.passes[pass].request))
    }
    // The channel each pass filters on is the one GA4 derives from that pass's
    // own source. GA4 has none for the manual UTM fields.
    const channelFields = requests.map(({ body }) => (
      expressionsOf(body).find(e => e.filter.stringFilter.value === 'AI Assistant')?.filter.fieldName ?? null
    ))
    expect(channelFields).toEqual([
      GA4_DIMENSIONS.sessionDefaultChannelGrouping,
      GA4_DIMENSIONS.firstUserDefaultChannelGroup,
      null,
    ])
  })

  it('selects Grok by host and tag only, so an ngrok tunnel is not AI traffic', async () => {
    // Any request is answered: this reads only which sources each filter selects.
    serve(() => json({ rowCount: 0 }))
    await fetchAiReferrals('fake-token', '123456', 90)
    expect(requests).toHaveLength(3)

    for (const { pass, body } of requests) {
      const sourceDimension = body.dimensions[1]!.name
      const sourceFilters = expressionsOf(body).map(e => e.filter).filter(f => f.fieldName === sourceDimension)
      const selects = (source: string) => sourceFilters.some(f => ga4Selects(f.stringFilter, source))
      for (const source of ['grok.com', 'GROK.COM', 'www.grok.com', 'Grok']) {
        expect(selects(source), `${pass}: ${source}`).toBe(true)
      }
      // `grok` sits inside these as a substring; none of them is Grok.
      for (const source of ['demo.ngrok-free.app', 'ngrok.io', 'grokipedia.com', 'notgrok.com']) {
        expect(selects(source), `${pass}: ${source}`).toBe(false)
      }
    }
  })

  it('returns each AI Assistant row once, including a source that names no engine', async () => {
    serve(replay)
    const rows = await fetchAiReferrals('fake-token', '123456', 90)

    // 5 session + 5 first-user + 4 manual UTM rows: a row the channel and a
    // source pattern both select is one row of one report.
    expect(rows).toHaveLength(14)
    const keys = rows.map(r => `${r.sourceDimension}|${r.date}|${r.source}|${r.landingPage}`)
    expect(new Set(keys).size).toBe(14)

    expect(aiEngineForReferralSource('chat.mistral.ai')).toBeNull()
    expect(rows.filter(r => r.source === 'chat.mistral.ai')).toEqual([
      {
        date: '2026-10-06',
        source: 'chat.mistral.ai',
        medium: 'ai-assistant',
        trafficClass: 'organic',
        channelGroup: 'AI Assistant',
        landingPage: '/blog/ai-visibility',
        sessions: 2,
        users: 1,
        sourceDimension: 'session',
      },
      {
        date: '2026-10-06',
        source: 'chat.mistral.ai',
        medium: 'ai-assistant',
        trafficClass: 'organic',
        channelGroup: 'AI Assistant',
        landingPage: '/blog/ai-visibility',
        sessions: 2,
        users: 1,
        sourceDimension: 'first_user',
      },
    ])
    expect(rows.filter(r => r.sourceDimension === 'session').map(r => [r.source, r.sessions])).toEqual([
      ['chatgpt.com', 3],
      ['grok.com', 2],
      ['chat.mistral.ai', 2],
      ['chat.deepseek.com', 1],
      ['perplexity.ai', 1],
    ])
  })

  it('re-reads a pass GA4 refuses with the channel filter using the source patterns alone', async () => {
    const firstUser = fixture.passes.first_user
    const sourceOnly = { ...firstUser.request, dimensionFilter: { orGroup: { expressions: expressionsOf(firstUser.request).slice(0, -1) } } }
    serve((pass, body) => {
      if (pass !== 'first_user') return replay(pass, body)
      if (expressionsOf(body).some(e => e.filter.fieldName === GA4_DIMENSIONS.firstUserDefaultChannelGroup)) {
        return json(fixture.invalidRequestError.body, 400)
      }
      // Without the channel, GA4 no longer selects the row only the channel matched.
      return json({
        ...firstUser.response,
        rows: firstUser.response.rows!.filter(row => row.dimensionValues[1]!.value !== 'chat.mistral.ai'),
        rowCount: 4,
      })
    })

    const rows = await fetchAiReferrals('fake-token', '123456', 90)

    expect(requests.map(r => r.pass)).toEqual(['session', 'first_user', 'first_user', 'manual_utm'])
    expect(withoutDates(requests[2]!.body)).toEqual(withoutDates(sourceOnly))
    expect(rows.filter(r => r.sourceDimension === 'first_user').map(r => r.source)).toEqual([
      'chatgpt.com', 'grok.com', 'chat.deepseek.com', 'perplexity.ai',
    ])
    expect(rows.filter(r => r.sourceDimension === 'session')).toHaveLength(5)
    expect(rows.filter(r => r.sourceDimension === 'manual_utm')).toHaveLength(4)
  })

  it('throws when GA4 refuses the source-only request too', async () => {
    serve((pass, body) => (pass === 'first_user' ? json(fixture.invalidRequestError.body, 400) : replay(pass, body)))

    const error = await fetchAiReferrals('fake-token', '123456', 90).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GA4ApiError)
    expect((error as GA4ApiError).status).toBe(400)
    expect(requests.map(r => r.pass)).toEqual(['session', 'first_user', 'first_user'])
  })
})

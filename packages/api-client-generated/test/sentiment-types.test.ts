import { expect, expectTypeOf, it, vi } from 'vitest'
import { createClient, getApiV1ProjectsByNameSentimentEvidence } from '../src/index.js'
import type { SentimentComparison, SentimentSummary, SentimentEvidencePage, GetApiV1ProjectsByNameSentimentEvidenceData } from '../src/index.js'

type Outcome = SentimentSummary['queries'][number]['assessments'][number]['outcome']

it('retains null stored engine outcomes and the exact evidence selector in generated types', () => {
  type Assessment = SentimentSummary['queries'][number]['assessments'][number]
  expectTypeOf<Extract<Assessment['outcome'], null>>().toEqualTypeOf<null>()
  expectTypeOf<Assessment['assessmentId']>().toEqualTypeOf<string | null>()
  expectTypeOf<SentimentEvidencePage['selection']['assessmentId']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<NonNullable<GetApiV1ProjectsByNameSentimentEvidenceData['query']>['assessmentId']>().toEqualTypeOf<string | undefined>()
})

it('types the evidence outcome filter and its echo as optional outcome arrays', () => {
  expectTypeOf<NonNullable<GetApiV1ProjectsByNameSentimentEvidenceData['query']>['outcome']>().toEqualTypeOf<Array<NonNullable<Outcome>> | undefined>()
  expectTypeOf<SentimentEvidencePage['selection']['outcome']>().toEqualTypeOf<Array<NonNullable<Outcome>> | undefined>()
})

it('types the most criticized Properties as optional on every summary', () => {
  expectTypeOf<SentimentSummary['criticizedProperties']>().toEqualTypeOf<{ total: number; keys: Array<string> } | undefined>()
  expectTypeOf<SentimentComparison['from']['criticizedProperties']>().toEqualTypeOf<{ total: number; keys: Array<string> } | undefined>()
  expectTypeOf<SentimentComparison['to']['criticizedProperties']>().toEqualTypeOf<{ total: number; keys: Array<string> } | undefined>()
})

it('sends the outcome filter as repeated query values, the form the server accepts', async () => {
  const page = { state: 'complete', selection: { mode: 'simple', queryClass: 'branded', scope: 'project', runId: 'run', revision: null, evaluationDefinitionId: null, outcome: ['mixed', 'unfavorable'] }, items: [], nextCursor: null }
  const fakeFetch = vi.fn(async (_request: Request) => new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } }))
  const client = createClient({ baseUrl: 'https://example.test', fetch: fakeFetch as typeof fetch })
  const result = await getApiV1ProjectsByNameSentimentEvidence({ client, path: { name: 'example' }, query: { runId: 'run', outcome: ['mixed', 'unfavorable'], limit: 10 } })
  expect(result.data).toEqual(page)
  expect(fakeFetch).toHaveBeenCalledTimes(1)
  const url = new URL(fakeFetch.mock.calls[0]![0].url)
  expect(url.pathname).toBe('/api/v1/projects/example/sentiment/evidence')
  expect(url.searchParams.getAll('outcome')).toEqual(['mixed', 'unfavorable'])
  expect(url.searchParams.get('runId')).toBe('run')
  expect(url.searchParams.get('limit')).toBe('10')
})

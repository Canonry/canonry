import crypto from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { discoverySessions, discoveryProbes, domainClassifications, insights, projects, runs } from '@ainyc/canonry-db'
import type { LocationContext } from '@ainyc/canonry-contracts'
import { executeDiscoveryRun } from '../src/discovery-run.js'
import { nativeDiscoveryFixture, type LiteralAnswer } from './discovery-native-fixture.js'

const CITED = { answerText: 'Acme IQ is a strong option.', citedDomains: ['acme-iq.example.com'] }
const WASTED = { answerText: 'Compare the market.', citedDomains: ['sunplanner.test'] }
const ASPIRATIONAL = { answerText: 'Compare the market.', citedDomains: ['random.com'] }
const DETROIT: LocationContext = { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' }
const MIAMI: LocationContext = { label: 'florida', city: 'Miami', region: 'Florida', country: 'US' }

const LIFECYCLE_ROWS: Array<{ label: string; seed: string; probes: Record<string, LiteralAnswer>; counts: [number, number, number]; severity: string }> = [
  { label: 'high1/2/1', seed: 'a q\nb q\nc q\nd q', probes: { 'a q': CITED, 'b q': WASTED, 'c q': WASTED, 'd q': ASPIRATIONAL }, counts: [1, 2, 1], severity: 'high' },
  { label: 'low4/1/0', seed: 'a q\nb q\nc q\nd q\ne q', probes: { 'a q': CITED, 'b q': CITED, 'c q': CITED, 'd q': CITED, 'e q': WASTED }, counts: [4, 1, 0], severity: 'low' },
]
it.each(LIFECYCLE_ROWS)('native discovery persists literal lifecycle/buckets/insight $label', async (row) => {
  const h = nativeDiscoveryFixture({ providers: { gemini: { seed: { answerText: row.seed, citedDomains: [] }, probes: row.probes, classification: 'sunplanner.test => direct-competitor\nrandom.com => other' } } })
  await executeDiscoveryRun(h.runOptions)
  const session = h.db.select().from(discoverySessions).where(eq(discoverySessions.id, h.sessionId)).get()
  expect(session).toMatchObject({ id: h.sessionId, projectId: h.projectId, status: 'completed', seedProvider: 'gemini', citedCount: row.counts[0], wastedCount: row.counts[1], aspirationalCount: row.counts[2], probeCount: row.counts.reduce((a, b) => a + b, 0), error: null })
  expect(session?.finishedAt).toEqual(expect.any(String))
  expect(h.db.select().from(runs).where(eq(runs.id, h.runId)).get()).toMatchObject({ id: h.runId, projectId: h.projectId, status: 'completed', error: null, finishedAt: expect.any(String) })
  expect(h.db.select().from(discoveryProbes).all().map(p => p.query)).toEqual(row.seed.split('\n'))
  const all = h.db.select().from(insights).all()
  expect(all).toHaveLength(1)
  expect(all[0]).toMatchObject({ projectId: h.projectId, runId: h.runId, query: 'discovery:' + h.sessionId, type: 'discovery.basket-divergence', provider: 'gemini', dismissed: false, severity: row.severity, recommendation: { action: 'review-discovered-basket', target: h.sessionId } })
  expect(all[0]?.recommendation?.reason).toContain('cited=' + row.counts[0])
  expect(all[0]?.recommendation?.reason).toContain('wasted=' + row.counts[1])
  expect(all[0]?.recommendation?.reason).toContain('aspirational=' + row.counts[2])
  expect(all[0]?.recommendation?.reason).toContain('sunplanner.test')
  expect(session?.competitorMap).toEqual(row.label === 'high1/2/1'
    ? [{ domain: 'sunplanner.test', hits: 2, competitorType: 'direct-competitor' }, { domain: 'random.com', hits: 1, competitorType: 'other' }]
    : [{ domain: 'sunplanner.test', hits: 1, competitorType: 'direct-competitor' }])
  expect(h.embeddingRequests).toHaveLength(1)
})

it('native discovery terminalizes genuine seed failure and genuine empty answer without probes/insights', async () => {
  for (const row of [
    { seed: new Error('Gemini said no'), status: 'failed', error: 'Gemini said no' },
    { seed: { answerText: '', citedDomains: [] }, status: 'completed', error: null },
  ]) {
    const h = nativeDiscoveryFixture({ providers: { gemini: { seed: row.seed } } })
    await executeDiscoveryRun(h.runOptions)
    expect(h.db.select().from(discoverySessions).get()).toMatchObject({ id: h.sessionId, status: row.status, error: row.error, finishedAt: expect.any(String) })
    expect(h.db.select().from(runs).get()).toMatchObject({ id: h.runId, status: row.status, error: row.error, finishedAt: expect.any(String) })
    expect(h.tracked).toHaveLength(1)
    expect(h.embeddingRequests).toEqual([])
    expect(h.classification).toEqual([])
    expect(h.db.select().from(discoveryProbes).all()).toEqual([])
    expect(h.db.select().from(insights).all()).toEqual([])
  }
})

it('native discovery replaces only the current project divergence', async () => {
  const h = nativeDiscoveryFixture({ providers: { gemini: { seed: { answerText: 'a q\nb q', citedDomains: [] }, probes: { 'a q': CITED, 'b q': ASPIRATIONAL }, classification: 'random.com => other' } } })
  const peerProject = crypto.randomUUID(), peerRun = crypto.randomUUID(), now = new Date().toISOString()
  h.db.insert(projects).values({ id: peerProject, name: 'peer-project', displayName: 'Peer Project', canonicalDomain: 'peer.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  h.db.insert(runs).values({ id: peerRun, projectId: peerProject, kind: 'aeo-discover-probe', status: 'completed', trigger: 'manual', createdAt: now }).run()
  const stale = crypto.randomUUID(), unrelated = crypto.randomUUID(), peer = crypto.randomUUID()
  for (const row of [
    { id: stale, projectId: h.projectId, runId: h.runId, type: 'discovery.basket-divergence' },
    { id: unrelated, projectId: h.projectId, runId: h.runId, type: 'regression' },
    { id: peer, projectId: peerProject, runId: peerRun, type: 'discovery.basket-divergence' },
  ]) h.db.insert(insights).values({ ...row, severity: 'medium', title: 'Prior native evidence', query: 'prior:' + row.id, provider: 'gemini', recommendation: null, cause: null, dismissed: false, createdAt: now }).run()
  await executeDiscoveryRun(h.runOptions)
  const all = h.db.select().from(insights).all()
  expect(all.find(row => row.id === stale)?.dismissed).toBe(true)
  expect(all.find(row => row.id === unrelated)?.dismissed).toBe(false)
  expect(all.find(row => row.id === peer)?.dismissed).toBe(false)
  expect(all.filter(row => row.projectId === h.projectId && row.type === 'discovery.basket-divergence' && !row.dismissed).map(row => row.query)).toEqual(['discovery:' + h.sessionId])
})

it.each([
  { label: 'none', locations: [], lines: [], forbidden: ['business serves', 'at least'], buyer: undefined },
  { label: 'single', locations: [DETROIT], lines: ['The business serves Detroit, Michigan, US'], forbidden: ['at least', 'queries for EACH'], buyer: undefined },
  { label: 'two', locations: [DETROIT, MIAMI], lines: ['The business serves these locations:', ' - Detroit, Michigan, US', ' - Miami, Florida, US', 'at least 15 queries for EACH'], forbidden: [], buyer: undefined },
  { label: 'three', locations: [{ label: 'a', city: 'Aville', region: 'AR', country: 'US' }, { label: 'b', city: 'Bville', region: 'BR', country: 'US' }, { label: 'c', city: 'Cville', region: 'CR', country: 'US' }], lines: ['at least 10 queries for EACH', 'Aville, AR, US', 'Bville, BR, US', 'Cville, CR, US'], forbidden: [], buyer: undefined },
  { label: 'four', locations: [{ label: 'a', city: 'Aville', region: 'AR', country: 'US' }, { label: 'b', city: 'Bville', region: 'BR', country: 'US' }, { label: 'c', city: 'Cville', region: 'CR', country: 'US' }, { label: 'd', city: 'Dville', region: 'DR', country: 'US' }], lines: ['at least 7 queries for EACH', 'Dville, DR, US'], forbidden: [], buyer: undefined },
  { label: 'sixty', locations: Array.from({ length: 60 }, (_, i) => ({ label: 'l' + i, city: 'City' + i, region: 'Region', country: 'US' })), lines: ['at least 1 queries for EACH', 'City0, Region, US', 'City59, Region, US'], forbidden: [], buyer: undefined },
  { label: 'buyer', locations: [], lines: ['Buyer: solar sales managers comparing quoting tools', 'Every query must be one this buyer would plausibly type'], forbidden: [], buyer: 'solar sales managers comparing quoting tools' },
])('native discovery sends original seed model contracts $label', async (row) => {
  const h = nativeDiscoveryFixture({ project: { name: 'Harborline Coatings', displayName: 'Harborline Coatings', domain: 'harborline-coatings.example.com' } })
  await executeDiscoveryRun({ ...h.runOptions, icpDescription: 'spray foam installers', buyerDescription: row.buyer, locations: row.locations })
  expect(h.tracked).toHaveLength(1)
  const prompt = h.tracked[0]?.input.query
  expect(prompt).toContain('Customer: Harborline Coatings (domains: harborline-coatings.example.com)')
  expect(prompt).toContain('ICP: spray foam installers')
  expect(prompt).toContain('SEMANTICALLY DISTINCT')
  expect(prompt).toContain('Generate EXACTLY 6 queries per bucket — 30 total')
  for (const intent of ['Informational', 'Commercial', 'Navigational', 'Comparative', 'Transactional']) expect(prompt).toContain(intent)
  expect(prompt).toContain("NEVER include the customer's own brand name or domain (Harborline Coatings, harborline-coatings.example.com)")
  expect(prompt).toContain('EARN the mention')
  for (const location of row.locations) expect(prompt).toContain([location.city, location.region, location.country].join(', '))
  for (const line of row.lines) expect(prompt).toContain(line)
  for (const line of row.forbidden) expect(prompt?.toLowerCase()).not.toContain(line.toLowerCase())
  expect(prompt?.split('\n').filter(line => line.startsWith('The business serves'))).toHaveLength(row.locations.length === 0 ? 0 : 1)
  if (!row.buyer) expect(prompt).not.toContain('Buyer:')
  expect(h.db.select().from(discoverySessions).get()?.status).toBe('completed')
})

it('native discovery commercial prompt crosses two independent literal years', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  for (const row of [{ clock: new Date(2030, 11, 31, 23, 59, 59), year: '2030', other: '2031' }, { clock: new Date(2031, 0, 1, 0, 0, 0), year: '2031', other: '2030' }]) {
    vi.setSystemTime(row.clock)
    const h = nativeDiscoveryFixture()
    await executeDiscoveryRun(h.runOptions)
    expect(h.tracked[0]?.input.query).toContain('"top X ' + row.year + '"')
    expect(h.tracked[0]?.input.query).not.toContain('"top X ' + row.other + '"')
  }
})

it.each([
  { label: 'categories', domains: ['raydesign.test', 'expedia.com', 'timeout.com', 'sec.gov'], text: 'raydesign.test => direct-competitor\nexpedia.com => ota-aggregator\ntimeout.com => editorial-media\nsec.gov => other', types: ['direct-competitor', 'ota-aggregator', 'editorial-media', 'other'] },
  { label: 'markdown', domains: ['raydesign.test', 'expedia.com'], text: '```\n1. RayDesign.test => Direct-Competitor\n- EXPEDIA.COM  =>  ota-aggregator\n```', types: ['direct-competitor', 'ota-aggregator'] },
  { label: 'skipped-unknown', domains: ['raydesign.test', 'mystery.com', 'notmentioned.com'], text: 'raydesign.test => direct-competitor\nmystery.com => partner', types: ['direct-competitor', 'unknown', 'unknown'] },
  { label: 'arrow', domains: ['competitor-news.com'], text: 'competitor-news.com => other', types: ['other'] },
  { label: 'category-host-poison', domains: ['direct-competitor.example'], text: 'direct-competitor.example => other', types: ['other'] },
  { label: 'suffix', domains: ['panels.example', 'mypanels.example'], text: 'mypanels.example => editorial-media\npanels.example => direct-competitor', types: ['direct-competitor', 'editorial-media'] },
  { label: 'numbered-suffix', domains: ['panels.example', 'mypanels.example'], text: '1. mypanels.example => editorial-media\n2. panels.example => direct-competitor', types: ['direct-competitor', 'editorial-media'] },
  { label: 'prefix', domains: ['panels.example', 'panels.example.au'], text: 'panels.example.au => editorial-media\npanels.example => direct-competitor', types: ['direct-competitor', 'editorial-media'] },
  { label: 'hostname-word-negative', domains: ['brotherpanels.example'], text: 'brotherpanels.example', types: ['unknown'] },
  { label: 'hostname-word-positive', domains: ['brotherpanels.example'], text: 'brotherpanels.example => direct-competitor', types: ['direct-competitor'] },
  { label: 'empty-model-answer', domains: ['raydesign.test'], text: '', types: ['unknown'] },
  { label: 'failed-classifier', domains: ['raydesign.test'], text: new Error('classification unavailable'), types: ['unknown'] },
])('native discovery persists original classification decisions $label', async (row) => {
  const h = nativeDiscoveryFixture({ project: { name: 'Acme IQ' }, competitorDomains: ['sunplanner.test', 'solarflow.test'], providers: { gemini: { seed: { answerText: 'best independent installer', citedDomains: [] }, probes: { 'best independent installer': { answerText: 'An independent answer.', citedDomains: row.domains } }, classification: row.text } } })
  await executeDiscoveryRun({ ...h.runOptions, icpDescription: 'solar installers shopping for quoting software' })
  expect(h.classification).toHaveLength(1)
  const prompt = h.classification[0]?.prompt
  for (const literal of ['Customer: Acme IQ (own domains: acme-iq.example.com)', 'ICP: solar installers shopping for quoting software', 'direct-competitor', 'ota-aggregator', 'editorial-media', 'other', ...row.domains]) expect(prompt).toContain(literal)
  const trackedLine = prompt?.split('\n').find(line => line.startsWith('Already-tracked competitors: '))
  expect(trackedLine?.slice('Already-tracked competitors: '.length).split(', ').sort()).toEqual(['solarflow.test', 'sunplanner.test'])
  expect(h.db.select().from(discoverySessions).get()?.status).toBe('completed')
  expect(h.db.select().from(discoverySessions).get()?.competitorMap).toEqual(row.domains.map((domain, i) => ({ domain, hits: 1, competitorType: row.types[i] })).sort((a, b) => a.domain.localeCompare(b.domain)))
  expect(h.db.select().from(domainClassifications).all().map(item => ({ projectId: item.projectId, sessionId: item.sessionId, domain: item.domain, hits: item.hits, competitorType: item.competitorType })).sort((a, b) => a.domain.localeCompare(b.domain))).toEqual(row.domains.map((domain, i) => ({ projectId: h.projectId, sessionId: h.sessionId, domain, hits: 1, competitorType: row.types[i] })).sort((a, b) => a.domain.localeCompare(b.domain)))
})

it('native classifier receives none for untracked competitors and every real cited domain', async () => {
  const h = nativeDiscoveryFixture({ competitorDomains: [], providers: { gemini: { seed: { answerText: 'best independent installer', citedDomains: [] }, probes: { 'best independent installer': { answerText: 'Independent options.', citedDomains: ['a.com'] } }, classification: 'a.com => other' } } })
  await executeDiscoveryRun({ ...h.runOptions, icpDescription: 'x' })
  expect(h.classification).toHaveLength(1)
  expect(h.classification[0]?.prompt).toContain('Already-tracked competitors: none')
  expect(h.classification[0]?.prompt).toContain('\nDomains:\na.com\n')
  expect(h.db.select().from(discoverySessions).get()?.competitorMap).toEqual([{ domain: 'a.com', hits: 1, competitorType: 'other' }])
})

it.each([
  { label: 'mentioned-not-cited', query: 'best solar quoting tool', answer: 'For solar quoting we recommend Acme IQ, a strong option.', domains: ['sunplanner.test'], mentioned: true, cited: 'not-cited', bucket: 'wasted-surface', displayName: 'Acme IQ' },
  { label: 'cited-not-mentioned', query: 'how to choose a solar installer', answer: 'Here are some general tips for choosing a solar installer.', domains: ['acme-iq.example.com'], mentioned: false, cited: 'cited', bucket: 'cited', displayName: 'Acme IQ' },
  { label: 'brandless-domain', query: 'solar quote site', answer: 'Check out acme-iq.example.com for quotes.', domains: [], mentioned: true, cited: 'not-cited', bucket: 'aspirational', displayName: '' },
])('native discovery stores independent mention/citation observations $label', async (row) => {
  const h = nativeDiscoveryFixture({ project: { displayName: row.displayName }, providers: { gemini: { seed: { answerText: row.query, citedDomains: [] }, probes: { [row.query]: { answerText: row.answer, citedDomains: row.domains } }, classification: 'sunplanner.test => direct-competitor' } } })
  await executeDiscoveryRun(h.runOptions)
  expect(h.db.select().from(discoveryProbes).all()).toHaveLength(1)
  expect(h.db.select().from(discoveryProbes).get()).toMatchObject({ projectId: h.projectId, sessionId: h.sessionId, query: row.query, citationState: row.cited, answerMentioned: row.mentioned, bucket: row.bucket, citedDomains: row.domains })
})

it.each([{ label: 'first-service-area', locations: [DETROIT, MIAMI], expected: DETROIT }, { label: 'phoenix', locations: [{ label: 'phoenix', city: 'Phoenix', region: 'Arizona', country: 'US' }], expected: { label: 'phoenix', city: 'Phoenix', region: 'Arizona', country: 'US' } }, { label: 'none', locations: [], expected: undefined }])('native discovery forwards probe geo $label', async (row) => {
  const h = nativeDiscoveryFixture({ providers: { gemini: { seed: { answerText: 'best roof coating contractors', citedDomains: [] }, probes: { 'best roof coating contractors': { answerText: 'Independent choices.', citedDomains: [] } } } } })
  await executeDiscoveryRun({ ...h.runOptions, locations: row.locations })
  expect(h.tracked).toHaveLength(2)
  expect(h.tracked[1]?.input).toEqual({ query: 'best roof coating contractors', canonicalDomains: ['acme-iq.example.com'], competitorDomains: ['sunplanner.test'], ...(row.expected ? { location: row.expected } : {}) })
  expect(h.tracked[0]?.input.query).toContain(row.expected ? [row.expected.city, row.expected.region, row.expected.country].join(', ') : 'ICP: AEO test')
  expect(h.db.select().from(discoveryProbes).get()?.query).toBe('best roof coating contractors')
})

it('native default seeding spends one Gemini seed and no secondary seed', async () => {
  const h = nativeDiscoveryFixture({ providers: {
    gemini: { seed: { answerText: 'g one\ng two', citedDomains: [], searchQueries: ['gemini grounding query'] }, probes: { 'g one': { answerText: 'First.', citedDomains: [] }, 'g two': { answerText: 'Second.', citedDomains: [] }, 'gemini grounding query': { answerText: 'Grounding.', citedDomains: [] } } },
    openai: { seed: { answerText: 'o one', citedDomains: [] } },
  } })
  await executeDiscoveryRun(h.runOptions)
  expect(h.tracked.filter(call => call.provider === 'gemini').map(call => call.input.query).slice(1)).toEqual(['g one', 'g two', 'gemini grounding query'])
  expect(h.tracked.filter(call => call.provider === 'gemini')).toHaveLength(4)
  expect(h.tracked.filter(call => call.provider === 'openai')).toEqual([])
  expect(h.classification).toEqual([])
  expect(h.db.select().from(discoverySessions).get()).toMatchObject({ seedProvider: 'gemini', seedRawCandidates: ['g one', 'g two', 'gemini grounding query'], seedCountRaw: 3, canonicalCount: 3, probeCount: 3, seedFromAnswerCount: 2, seedFromGroundingCount: 1, seedProviderCounts: { gemini: 3 } })
})

it('native composite preserves source provenance and both primary intents through a bridging secondary', async () => {
  const h = nativeDiscoveryFixture({ providers: {
    gemini: { seed: { answerText: 'g one\ng two', citedDomains: [], searchQueries: ['gemini grounding query'] }, probes: { 'g one': { answerText: 'First.', citedDomains: [] }, 'g two': { answerText: 'Second.', citedDomains: [] } } },
    openai: { seed: { answerText: 'o one\no two\no three', citedDomains: [] } },
  }, vectors: [[1, 0], [0.7660444431, 0.6427876097], [1, 0], [0.9659258263, 0.2588190451], [0.9063077870, 0.4226182617], [0.9659258263, 0.2588190451]] })
  await executeDiscoveryRun({ ...h.runOptions, seedProviders: ['gemini', 'openai'], dedupThreshold: 0.9 })
  expect(h.tracked.filter(call => call.provider === 'gemini').map(call => call.input.query).slice(1)).toEqual(['g one', 'g two'])
  expect(h.tracked.filter(call => call.provider === 'gemini')).toHaveLength(3)
  expect(h.tracked.filter(call => call.provider === 'openai')).toHaveLength(1)
  expect(h.embeddingRequests[0]?.queries).toEqual(['g one', 'g two', 'gemini grounding query', 'o one', 'o two', 'o three'])
  expect(h.db.select().from(discoverySessions).get()).toMatchObject({ seedProvider: 'gemini+openai', seedRawCandidates: ['g one', 'g two', 'gemini grounding query', 'o one', 'o two', 'o three'], seedCountRaw: 6, canonicalCount: 2, probeCount: 2, seedFromAnswerCount: 5, seedFromGroundingCount: 1, seedProviderCounts: { gemini: 3, openai: 3 }, seedProviders: ['gemini', 'openai'] })
  expect(h.db.select().from(discoveryProbes).all().map(row => row.query)).toEqual(['g one', 'g two'])
})

it.each([
  { label: 'first-success', replies: ['success'], calls: 1, status: 'completed' },
  { label: '503-recovers', replies: [503, 'success'], calls: 2, status: 'completed' },
  { label: '429-network-recovers', replies: [429, 'network', 'success'], calls: 3, status: 'completed' },
  { label: '400-terminal', replies: [400], calls: 1, status: 'failed' },
  { label: '503-exhausts-three-retries', replies: [503, 503, 503, 503], calls: 4, status: 'failed' },
  { label: 'first-hang-recovers', replies: ['hang', 'success'], calls: 2, status: 'completed' },
  { label: 'all-hang-terminal', replies: ['hang', 'hang', 'hang', 'hang'], calls: 4, status: 'failed' },
] as const)('native discovery embedding policy terminalizes $label', async (row) => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(0)
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const h = nativeDiscoveryFixture({ providers: { gemini: { seed: { answerText: 'a q\nb q', citedDomains: [] }, probes: { 'a q': { answerText: 'First.', citedDomains: [] }, 'b q': { answerText: 'Second.', citedDomains: [] } } } }, embeddingReplies: [...row.replies] })
  let settled = false
  const running = executeDiscoveryRun(h.runOptions).then(() => { settled = true })
  try {
    await vi.runAllTimersAsync()
    expect(settled, 'native workflow must settle under its real bounded policy').toBe(true)
    await running
    expect(h.embeddingRequests).toHaveLength(row.calls)
    expect(h.embeddingRequests.map(request => request.queries)).toEqual(Array.from({ length: row.calls }, () => ['a q', 'b q']))
    expect(h.embeddingRequests[0]).toMatchObject({ url: 'https://embedding.fixture.invalid/discovery/v1beta/models/gemini-embedding-001:batchEmbedContents', method: 'POST', apiKey: 'gemini-fixture-key' })
    expect(h.tracked[0]?.provider).toBe('gemini')
    expect(h.tracked).toHaveLength(row.status === 'completed' ? 3 : 1)
    const session = h.db.select().from(discoverySessions).get()
    const run = h.db.select().from(runs).get()
    expect(session).toMatchObject({ id: h.sessionId, status: row.status, finishedAt: expect.any(String) })
    expect(run).toMatchObject({ id: h.runId, status: row.status, finishedAt: expect.any(String) })
    if (row.status === 'completed') {
      expect(session).toMatchObject({ error: null, seedCountRaw: 2, canonicalCount: 2, probeCount: 2 })
      expect(run?.error).toBeNull()
      expect(h.db.select().from(discoveryProbes).all().map(probe => probe.query)).toEqual(['a q', 'b q'])
    } else {
      expect(session?.error).toContain(row.label === 'all-hang-terminal' ? 'Discovery embedding call timed out after 60000ms' : 'native embedding refusal')
      expect(run?.error).toBe(session?.error)
      expect(h.db.select().from(discoveryProbes).all()).toEqual([])
      expect(h.db.select().from(insights).all()).toEqual([])
    }
    if (row.label === 'first-hang-recovers') expect(h.embeddingRequests.map(request => request.at)).toEqual([0, 60000])
    if (row.label === 'all-hang-terminal') expect(h.embeddingRequests.map(request => request.at)).toEqual([0, 60000, 120000, 180000])
  } finally {
    for (const release of h.release) release()
    await vi.runAllTimersAsync()
    await running
  }
})

it('native discovery preserves concrete Acme IQ hygiene and buyer present/absent requests', async () => {
  for (const buyer of [undefined, 'solar sales managers comparing quoting tools']) {
    const h = nativeDiscoveryFixture()
    await executeDiscoveryRun({ ...h.runOptions, icpDescription: 'solar contractors', buyerDescription: buyer })
    expect(h.tracked).toHaveLength(1)
    const prompt = h.tracked[0]?.input.query
    expect(prompt).toContain('ICP: solar contractors')
    expect(prompt).toContain("NEVER include the customer's own brand name or domain (Acme IQ, acme-iq.example.com)")
    expect(prompt).toContain('EARN the mention')
    if (buyer) {
      expect(prompt).toContain('Buyer: solar sales managers comparing quoting tools')
      expect(prompt).toContain('Every query must be one this buyer would plausibly type')
    } else expect(prompt).not.toContain('Buyer:')
  }
})

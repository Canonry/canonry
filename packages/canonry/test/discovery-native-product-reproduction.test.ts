import { it, expect } from 'vitest'
import { discoveryProbes, discoverySessions, runs } from '@ainyc/canonry-db'
import { executeDiscoveryRun } from '../src/discovery-run.js'
import { nativeDiscoveryFixture } from './discovery-native-fixture.js'

it.each([
  { label: 'raw-canonical-hit', domain: 'https://www.Acme-iq.example.com/path', owned: [], cited: ['acme-iq.example.com'], expected: 'cited' },
  { label: 'raw-owned-hit', domain: 'primary.example', owned: ['https://www.Acme-iq.example.com/path'], cited: ['acme-iq.example.com'], expected: 'cited' },
  { label: 'clean-canonical-control', domain: 'acme-iq.example.com', owned: [], cited: ['acme-iq.example.com'], expected: 'cited' },
  { label: 'foreign-prefix-control', domain: 'https://www.Acme-iq.example.com/path', owned: [], cited: ['acme-iq.example.com.evil.test'], expected: 'not-cited' },
])('native stored-domain citation reproduction $label', async row => {
  const h = nativeDiscoveryFixture({ project: { domain: row.domain, ownedDomains: row.owned }, providers: { gemini: { seed: { answerText: 'best solar quoting tool', citedDomains: [] }, probes: { 'best solar quoting tool': { answerText: 'General installer tips.', citedDomains: row.cited } }, classification: 'acme-iq.example.com => other\nacme-iq.example.com.evil.test => other' } } })
  await executeDiscoveryRun(h.runOptions)
  expect(h.db.select().from(discoverySessions).get()?.status).toBe('completed')
  expect(h.db.select().from(discoveryProbes).all()).toHaveLength(1)
  expect(h.db.select().from(discoveryProbes).get()).toMatchObject({ projectId: h.projectId, sessionId: h.sessionId, query: 'best solar quoting tool', citationState: row.expected, answerMentioned: false, bucket: row.expected === 'cited' ? 'cited' : 'aspirational', citedDomains: row.cited })
  expect(h.db.select().from(discoverySessions).get()).toMatchObject({ citedCount: row.expected === 'cited' ? 1 : 0, wastedCount: 0, aspirationalCount: row.expected === 'cited' ? 0 : 1, competitorMap: row.expected === 'cited' ? [] : [{ domain: 'acme-iq.example.com.evil.test', hits: 1, competitorType: 'other' }] })
})

it('native missing secondary admission refuses every paid seed before dispatch', async () => {
  const h = nativeDiscoveryFixture({ providers: { gemini: { seed: { answerText: 'g one', citedDomains: [] } } } })
  await executeDiscoveryRun({ ...h.runOptions, seedProviders: ['gemini', 'openai'] })
  expect(h.tracked, 'no configured provider may spend before the whole requested set is admitted').toEqual([])
  expect(h.embeddingRequests).toEqual([])
  expect(h.classification).toEqual([])
  expect(h.db.select().from(discoveryProbes).all()).toEqual([])
  expect(h.db.select().from(discoverySessions).get()).toMatchObject({ status: 'failed', error: 'Seed provider openai is not configured. Add its API key before requesting multi-provider seeding.' })
  expect(h.db.select().from(runs).get()).toMatchObject({ status: 'failed', error: 'Seed provider openai is not configured. Add its API key before requesting multi-provider seeding.' })
})

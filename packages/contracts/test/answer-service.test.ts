import { describe, expect, it } from 'vitest'
import {
  answerServiceDescriptorProblems,
  answerServiceRouteFamily,
  summarizeAnswerServiceProfile,
  type AnswerServiceDescriptor,
  type AnswerServiceProfile,
} from '../src/answer-service.js'

const profile: AnswerServiceProfile = {
  id: 'fast',
  displayName: 'Fast',
  description: 'Quick answers with citations.',
  product: 'answer',
  execution: 'sync',
  transport: 'json',
  timeoutMs: 30_000,
  requestedServiceModel: 'tier-fast',
  settings: { depth: 'basic' },
  requestPolicyVersion: 'v1',
  capabilities: {
    groundedAnswer: true,
    textGeneration: false,
    structuredOutput: false,
    evidence: { relationships: ['explicit-citation', 'search-result'], spans: true, retrievalObservability: 'events', directUrls: true },
    location: { granularity: 'country', strength: 'hint' },
    filters: { includeDomains: 'none', excludeDomains: 'none' },
    maxQueryChars: 400,
    disclosedModelKind: 'service-tier',
    costBasis: 'estimated',
  },
  workflows: ['research', 'visibility-sweep'],
}

const descriptor: AnswerServiceDescriptor = {
  id: 'acme-answers',
  displayName: 'Acme Answers',
  keyUrl: 'https://acme.example/keys',
  vendorDocsUrl: 'https://acme.example/docs',
  docsPath: 'docs/providers/answer-services/acme.md',
  auth: { scheme: 'bearer' },
  baseUrl: 'https://api.acme.example',
  settings: { fields: [{ key: 'apiKey', kind: 'secret', required: true, env: 'ACME_API_KEY', label: 'API key' }], allowBaseUrl: false, allowModel: false, keyCheck: null },
  defaultQuota: { maxConcurrency: 1, maxRequestsPerMinute: 5, maxRequestsPerDay: 100 },
  retry: { statuses: [429, 503] },
  parserVersion: 'p1',
  profiles: [profile],
}

function withProfile(overrides: Partial<AnswerServiceProfile>): AnswerServiceDescriptor {
  return { ...descriptor, profiles: [{ ...profile, ...overrides }] }
}

describe('answer service descriptor rules', () => {
  it('accepts a valid descriptor', () => {
    expect(answerServiceDescriptorProblems(descriptor)).toEqual([])
  })

  it('refuses visibility sweeps for a profile whose sources are not tied to the answer', () => {
    const problems = answerServiceDescriptorProblems(withProfile({
      capabilities: { ...profile.capabilities, evidence: { ...profile.capabilities.evidence, relationships: ['search-result'], spans: false } },
    }))
    expect(problems).toEqual(['acme-answers: profile fast: visibility-sweep needs sources the answer cites (answer-support or explicit-citation)'])
  })

  it('refuses visibility sweeps for a job profile', () => {
    expect(answerServiceDescriptorProblems(withProfile({ execution: 'job' }))).toEqual(['acme-answers: profile fast: visibility-sweep needs a synchronous profile'])
  })

  it.each([
    ['a text-generating answer service', withProfile({ capabilities: { ...profile.capabilities, textGeneration: true as never } }), 'acme-answers: profile fast: an answer service is never a text generator'],
    ['spans without explicit citations', withProfile({ workflows: ['research'], capabilities: { ...profile.capabilities, evidence: { ...profile.capabilities.evidence, relationships: ['answer-support'] } } }), 'acme-answers: profile fast: spans require explicit-citation sources'],
    ['a retried validation error', { ...descriptor, retry: { statuses: [400, 429] } }, 'acme-answers: retry status 400 is not a throttle or server error'],
    ['a plain http endpoint', { ...descriptor, baseUrl: 'http://api.acme.example' }, 'acme-answers: baseUrl must be an https URL'],
    ['an id that collides with a provider', { ...descriptor, id: 'openrouter' }, 'openrouter: id collides with an existing provider name'],
    ['a settable base URL', { ...descriptor, settings: { ...descriptor.settings, allowBaseUrl: true as never } }, 'acme-answers: base URL must not be user-settable'],
    ['a docs path outside docs/providers', { ...descriptor, docsPath: 'README.md' }, 'acme-answers: docsPath must be a docs/providers/ Markdown page'],
  ])('rejects %s', (_label, input, expected) => {
    expect(answerServiceDescriptorProblems(input)).toContain(expected)
  })
})

describe('answer service catalog fields', () => {
  it('summarizes a profile from its descriptor, citation measurability included', () => {
    expect(summarizeAnswerServiceProfile(descriptor.id, profile)).toEqual({
      id: 'fast',
      route: 'acme-answers:fast',
      displayName: 'Fast',
      description: 'Quick answers with citations.',
      product: 'answer',
      execution: 'sync',
      workflows: ['research', 'visibility-sweep'],
      evidence: { relationships: ['explicit-citation', 'search-result'], citationBasis: 'explicit-citation', citationMeasurable: true, spans: true, retrievalObservability: 'events' },
      costBasis: 'estimated',
      locationGranularity: 'country',
      disclosedModelKind: 'service-tier',
      maxQueryChars: 400,
    })
    const resultsOnly = { ...profile, capabilities: { ...profile.capabilities, evidence: { ...profile.capabilities.evidence, relationships: ['search-result' as const] } } }
    expect(summarizeAnswerServiceProfile(descriptor.id, resultsOnly).evidence).toMatchObject({ citationBasis: 'none', citationMeasurable: false })
  })

  it('declares one route per profile', () => {
    expect(answerServiceRouteFamily(descriptor)).toEqual({ connection: 'acme-answers', selectionKind: 'profile', selections: ['fast'] })
  })
})

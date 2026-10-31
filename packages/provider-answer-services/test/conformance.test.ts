import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ANSWER_SOURCE_MAX_EXCERPTS,
  answerEvidenceSchema,
  answerServiceDescriptorProblems,
  answerServiceRouteName,
  citationEligibleSources,
  deriveCitedDomains,
  DisclosedModelKinds,
  IncompleteAnswerError,
  isEligibleFor,
  isSweepProvider,
  providerWorkflowSchema,
  resolveProviderRoute,
  routeFamiliesOf,
  type ProviderAdapter,
  type RawQueryResult,
} from '@canonry/canonry-contracts'
import { createAnswerServiceAdapter, AnswerServiceHttpError, AnswerServiceQueryTooLongError, ANSWER_SERVICES, type AnswerServiceDefinition } from '../src/index.js'
import { CONFORMANCE_CASES, type ConformanceCase, type ConformanceFixtures } from './conformance.js'
import { FAKE_CONFORMANCE_FIXTURES } from './fake-fixtures.js'
import { fakeFetch, fakeServiceDefinition } from './fake-service.js'
import { SERVICE_CONFORMANCE_FIXTURES } from './services/index.js'

const WORKFLOWS = providerWorkflowSchema.options
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const SUITES: ReadonlyArray<{ definition: AnswerServiceDefinition; fixtures: ConformanceFixtures | undefined }> = [
  { definition: fakeServiceDefinition, fixtures: FAKE_CONFORMANCE_FIXTURES },
  ...ANSWER_SERVICES.map(definition => ({
    definition,
    fixtures: SERVICE_CONFORMANCE_FIXTURES.find(entry => entry.service === definition.descriptor.id),
  })),
]

function routeAdapter(adapter: ProviderAdapter, route: string): ProviderAdapter {
  const resolved = resolveProviderRoute(route, routeFamiliesOf([adapter]))
  if (!resolved || !adapter.forRoute) throw new Error(`no route ${route}`)
  return adapter.forRoute(resolved)
}

async function runCase(definition: AnswerServiceDefinition, testCase: ConformanceCase) {
  const stub = fakeFetch(testCase.responses)
  const adapter = createAnswerServiceAdapter(definition, { fetchImpl: stub.impl, sleep: async () => undefined })
  const route = answerServiceRouteName(definition.descriptor.id, testCase.profile)
  const config = { provider: route, apiKey: 'test-key', model: testCase.profile, quotaPolicy: definition.descriptor.defaultQuota }
  const input = {
    query: testCase.query ?? 'best roofing contractor near me',
    canonicalDomains: ['acme-roofing.example'],
    competitorDomains: [],
    ...(testCase.location ? { location: testCase.location } : {}),
  }
  try {
    const raw = await routeAdapter(adapter, route).executeTrackedQuery(input, config)
    return { raw, error: undefined, stub, adapter }
  } catch (error) {
    return { raw: undefined, error, stub, adapter }
  }
}

function assertCompleteInvariants(adapter: ProviderAdapter, raw: RawQueryResult) {
  const evidence = answerEvidenceSchema.parse(raw.evidence)
  const normalized = adapter.normalizeResult(raw)
  // Citations come from eligible relationships only, never from search results.
  expect(normalized.citedDomains).toEqual(deriveCitedDomains(evidence.sources))
  expect(raw.groundingSources.map(source => source.uri)).toEqual(citationEligibleSources(evidence.sources).map(source => source.url))
  expect(raw.retrievalContract).toBe('service-native-v1')
  expect(raw.model).toBe(evidence.identity.profile)
  // A served model exists only for a disclosed foundation model, never copied from the request.
  if (evidence.identity.disclosedModelKind === DisclosedModelKinds['foundation-model']) {
    expect(raw.servedModel).toBe(evidence.identity.disclosedModel)
  } else {
    expect(raw.servedModel).toBeUndefined()
  }
  // Unknown token or search counts never become zeros in stored usage.
  if (evidence.usage.tokens.basis !== 'reported' || evidence.usage.searches.basis === 'unknown') expect(raw.usage).toBeUndefined()
  if (raw.usage) expect(raw.usage.searchCount).toBe(evidence.usage.searches.count)
  // Excerpts stay within the shared bounds whatever the parser returned.
  for (const source of evidence.sources) expect((source.excerpts ?? []).length).toBeLessThanOrEqual(ANSWER_SOURCE_MAX_EXCERPTS)
  if (evidence.usage.cost.basis === 'unknown') expect(evidence.usage.cost.micros).toBeNull()
  expect(normalized.citationMeasurable).toBe(evidence.citationMeasurable)
  return { evidence, normalized }
}

for (const { definition, fixtures } of SUITES) {
  const { descriptor } = definition
  describe(`answer service conformance: ${descriptor.id}`, () => {
    it('satisfies every descriptor rule', () => {
      expect(answerServiceDescriptorProblems(descriptor)).toEqual([])
    })

    it('has a docs page', () => {
      expect(fs.existsSync(path.join(REPO_ROOT, descriptor.docsPath))).toBe(true)
    })

    it('covers every conformance case or says why it cannot happen', () => {
      expect(fixtures, `add ${descriptor.id} to test/services/index.ts`).toBeDefined()
      for (const kind of CONFORMANCE_CASES) {
        const provided = fixtures!.cases[kind] !== undefined
        const reason = fixtures!.notApplicable[kind]
        expect(provided || Boolean(reason?.trim()), `${descriptor.id}: case ${kind}`).toBe(true)
        expect(provided && reason !== undefined, `${descriptor.id}: case ${kind} is both provided and not applicable`).toBe(false)
      }
      for (const testCase of Object.values(fixtures!.cases)) {
        expect(testCase.source).toMatch(/documentation-derived|not derived from any vendor/i)
      }
    })

    it('is never selected implicitly and its connection is never a target', () => {
      const adapter = createAnswerServiceAdapter(definition)
      const families = routeFamiliesOf([adapter])
      expect(isSweepProvider(descriptor.id, families)).toBe(false)
      for (const workflow of WORKFLOWS) {
        expect(isEligibleFor(adapter, workflow, 'implicit')).toBe(false)
        expect(isEligibleFor(adapter, workflow, 'explicit')).toBe(false)
      }
      for (const profile of descriptor.profiles) {
        const route = routeAdapter(adapter, answerServiceRouteName(descriptor.id, profile.id))
        expect(isSweepProvider(route.name, families)).toBe(true)
        expect(route.generateText).toBeUndefined()
        for (const workflow of WORKFLOWS) {
          expect(isEligibleFor(route, workflow, 'implicit')).toBe(false)
          expect(isEligibleFor(route, workflow, 'explicit')).toBe(profile.workflows.includes(workflow))
        }
      }
    })

    for (const kind of CONFORMANCE_CASES) {
      const testCase = fixtures?.cases[kind]
      if (!testCase) continue
      it(`case ${kind}`, async () => {
        const { raw, error, stub, adapter } = await runCase(definition, testCase)
        const expected = testCase.expect
        if (expected.requests !== undefined) expect(stub.calls).toHaveLength(expected.requests)
        switch (expected.outcome) {
          case 'complete': {
            expect(error).toBeUndefined()
            const { evidence, normalized } = assertCompleteInvariants(adapter, raw!)
            expect(evidence.completion.status).toBe('complete')
            if (expected.answerText !== undefined) expect(normalized.answerText).toBe(expected.answerText)
            if (expected.citedDomains !== undefined) expect(normalized.citedDomains).toEqual(expected.citedDomains)
            if (expected.relationships !== undefined) {
              const counts: Record<string, number> = {}
              for (const source of evidence.sources) counts[source.relationship] = (counts[source.relationship] ?? 0) + 1
              expect(counts).toEqual(expected.relationships)
            }
            if (expected.retrievalStatus !== undefined) expect(evidence.retrievalStatus).toBe(expected.retrievalStatus)
            if (expected.disclosedModel !== undefined) expect(evidence.identity.disclosedModel).toBe(expected.disclosedModel)
            if (expected.costBasis !== undefined) expect(evidence.usage.cost.basis).toBe(expected.costBasis)
            if (expected.locationStatus !== undefined) expect(evidence.location.status).toBe(expected.locationStatus)
            if (expected.sentLocation !== undefined) expect(evidence.location.sent).toEqual(expected.sentLocation)
            break
          }
          case 'partial':
          case 'failed':
          case 'pending': {
            // Never stored as an answer: callers that do not understand completion fail closed.
            expect(raw).toBeUndefined()
            expect(error).toBeInstanceOf(IncompleteAnswerError)
            const evidence = answerEvidenceSchema.parse((error as IncompleteAnswerError).evidence)
            expect(evidence.completion.status).toBe(expected.outcome)
            if (expected.outcome === 'pending') expect(evidence.completion.upstreamJobId).toEqual(expect.any(String))
            break
          }
          case 'http-error': {
            expect(error).toBeInstanceOf(AnswerServiceHttpError)
            expect((error as AnswerServiceHttpError).status).toBe(expected.httpStatus)
            // The failure names the status the shared classifier reads, and never the key.
            expect((error as Error).message).toContain(`HTTP ${expected.httpStatus}`)
            expect((error as Error).message).not.toContain('test-key')
            break
          }
          case 'refused-before-request': {
            expect(error).toBeInstanceOf(AnswerServiceQueryTooLongError)
            expect(stub.calls).toHaveLength(0)
            break
          }
        }
      })
    }
  })
}

describe('answer service registration', () => {
  it('gives every registered service conformance fixtures', () => {
    expect(SERVICE_CONFORMANCE_FIXTURES.map(entry => entry.service).sort()).toEqual(ANSWER_SERVICES.map(service => service.descriptor.id).sort())
  })

  it('registers unique service ids', () => {
    const ids = ANSWER_SERVICES.map(service => service.descriptor.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

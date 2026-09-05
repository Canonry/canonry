import { describe, expect, it } from 'vitest'
import {
  buildSimpleMeasurementDefinition,
  canonicalSimpleMeasurementDefinitionJson,
} from '../src/simple-measurement-definition.js'

const CAPTURED_AT = '2026-09-04T12:00:00.000Z'

function input() {
  return {
    capturedAt: CAPTURED_AT,
    identity: {
      displayName: 'Northstar Living',
      aliases: ['Northstar'],
      canonicalDomain: 'northstar.example',
      ownedDomains: ['residences.northstar.example'],
    },
    country: 'US',
    language: 'en',
    location: {
      label: 'northbridge',
      city: 'Northbridge',
      region: 'NB',
      country: 'US',
      timezone: 'America/New_York',
    },
    engines: [
      { provider: 'openai', requestedModel: 'gpt-5.4' },
      { provider: 'gemini', requestedModel: null },
    ],
    queries: [
      { queryId: 'q-brand', queryText: 'Northstar Living reviews', provenance: 'manual' },
      { queryId: 'q-category', queryText: 'best apartments in Northbridge', provenance: null },
    ],
  }
}

describe('simple measurement definition', () => {
  it('freezes branded and non-brand classes with the shared classifier', () => {
    const definition = buildSimpleMeasurementDefinition(input())

    expect(definition.queries).toEqual([
      { queryId: 'q-brand', queryText: 'Northstar Living reviews', provenance: 'manual', queryClass: 'branded' },
      { queryId: 'q-category', queryText: 'best apartments in Northbridge', provenance: null, queryClass: 'non-brand' },
    ])
  })

  it('keeps class unknown when the captured identity has no usable matcher', () => {
    const value = input()
    value.identity = { displayName: '', aliases: ['!!!'], canonicalDomain: '', ownedDomains: [] }

    expect(buildSimpleMeasurementDefinition(value).queries.map(query => query.queryClass)).toEqual([null, null])
  })

  it('clones exact identity, model, location, and query evidence before callers can mutate it', () => {
    const value = input()
    const definition = buildSimpleMeasurementDefinition(value)
    value.identity.aliases.push('Changed alias')
    value.engines[0]!.requestedModel = 'changed-model'
    value.location!.city = 'Changed city'
    value.queries[0]!.queryText = 'Changed query'

    expect(definition.identity).toEqual({
      displayName: 'Northstar Living',
      aliases: ['Northstar'],
      canonicalDomain: 'northstar.example',
      ownedDomains: ['residences.northstar.example'],
    })
    expect(definition.engines[0]).toEqual({ provider: 'openai', requestedModel: 'gpt-5.4' })
    expect(definition.location).toEqual({
      label: 'northbridge', city: 'Northbridge', region: 'NB', country: 'US', timezone: 'America/New_York',
    })
    expect(definition.queries[0]!.queryText).toBe('Northstar Living reviews')
  })

  it('retains distinct selected query ids even when their normalized text overlaps', () => {
    const value = input()
    value.queries = [
      { queryId: 'q-one', queryText: 'Best apartments', provenance: null },
      { queryId: 'q-two', queryText: '  best apartments  ', provenance: null },
    ]

    expect(buildSimpleMeasurementDefinition(value).queries).toHaveLength(2)
  })

  it('preserves an existing empty query text instead of tightening dispatch validation', () => {
    const value = input()
    value.queries = [{ queryId: 'q-empty', queryText: '', provenance: 'legacy-import' }]

    expect(buildSimpleMeasurementDefinition(value).queries).toEqual([
      { queryId: 'q-empty', queryText: '', provenance: 'legacy-import', queryClass: 'non-brand' },
    ])
  })

  it('preserves blank requested models and whitespace project context from legacy inputs', () => {
    const value = input()
    value.country = '  '
    value.language = ' \t'
    value.engines[0]!.requestedModel = ''

    expect(buildSimpleMeasurementDefinition(value)).toMatchObject({
      country: '  ',
      language: ' \t',
      engines: [
        { provider: 'openai', requestedModel: '' },
        { provider: 'gemini', requestedModel: null },
      ],
    })
  })

  it('freezes competitor identities while preserving the omitted historical shape', () => {
    const value = {
      ...input(),
      competitors: [{
      domain: 'challenger.example',
      label: 'Challenger',
      aliases: ['Challenger Homes'],
      }],
    }
    const frozen = buildSimpleMeasurementDefinition(value)
    value.competitors[0]!.aliases.push('Changed live alias')

    expect(frozen.competitors).toEqual([{
      domain: 'challenger.example',
      label: 'Challenger',
      aliases: ['Challenger Homes'],
    }])
    expect(canonicalSimpleMeasurementDefinitionJson(frozen)).toContain('challenger.example')

    const { competitors: _competitors, ...legacyInput } = input()
    const legacy = buildSimpleMeasurementDefinition(legacyInput)
    expect(legacy).not.toHaveProperty('competitors')
    expect(canonicalSimpleMeasurementDefinitionJson(legacy)).not.toContain('competitors')
  })

  it('rejects duplicate query ids, and empty or duplicate engines', () => {
    const duplicateQuery = input()
    duplicateQuery.queries[1]!.queryId = 'q-brand'
    expect(() => buildSimpleMeasurementDefinition(duplicateQuery)).toThrow(/duplicate query id/i)

    const emptyEngines = input()
    emptyEngines.engines = []
    expect(() => buildSimpleMeasurementDefinition(emptyEngines)).toThrow()

    const duplicateEngine = input()
    duplicateEngine.engines.push({ provider: 'OPENAI', requestedModel: null })
    expect(() => buildSimpleMeasurementDefinition(duplicateEngine)).toThrow(/duplicate engine provider/i)

    const duplicateCompetitor = {
      ...input(),
      competitors: [
      { domain: 'challenger.example', label: 'Challenger', aliases: [] },
      { domain: 'CHALLENGER.EXAMPLE', label: 'Duplicate', aliases: [] },
      ],
    }
    expect(() => buildSimpleMeasurementDefinition(duplicateCompetitor)).toThrow(/duplicate competitor domain/i)
  })

  it('serializes equivalent set order deterministically without changing exact query text', () => {
    const first = buildSimpleMeasurementDefinition(input())
    const reordered = input()
    reordered.identity.aliases = [...reordered.identity.aliases, 'Northstar Living']
    reordered.identity.ownedDomains = ['residences.northstar.example', 'northstar.example']
    reordered.engines.reverse()
    reordered.queries.reverse()
    const second = buildSimpleMeasurementDefinition(reordered)

    const firstWithSameSets = buildSimpleMeasurementDefinition({
      ...input(),
      identity: {
        ...input().identity,
        aliases: ['Northstar Living', 'Northstar'],
        ownedDomains: ['northstar.example', 'residences.northstar.example'],
      },
    })

    expect(canonicalSimpleMeasurementDefinitionJson(second)).toBe(canonicalSimpleMeasurementDefinitionJson(firstWithSameSets))
    expect(canonicalSimpleMeasurementDefinitionJson(first)).toContain('Northstar Living reviews')
  })
})

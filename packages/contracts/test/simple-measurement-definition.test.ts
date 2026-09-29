import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildSimpleMeasurementDefinition,
  canonicalSimpleMeasurementDefinitionJson,
  simpleMeasurementCompetitorNames,
  simpleMeasurementDefinitionSchema,
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
      { domain: 'challenger.example', label: 'Duplicate', aliases: [] },
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

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

// Captured before qualified aliases existed. A sidecar that never opts in must
// keep these exact bytes, or every stored checksum would stop matching replay.
const GOLDEN_CANONICAL_JSON = '{"schemaVersion":1,"capturedAt":"2026-09-04T12:00:00.000Z","identity":{"displayName":"Northstar Living","aliases":["Northstar"],"canonicalDomain":"northstar.example","ownedDomains":["residences.northstar.example"]},"country":"US","language":"en","location":{"label":"northbridge","city":"Northbridge","region":"NB","country":"US","timezone":"America/New_York"},"engines":[{"provider":"gemini","requestedModel":null},{"provider":"openai","requestedModel":"gpt-5.4"}],"queries":[{"queryId":"q-brand","queryText":"Northstar Living reviews","provenance":"manual","queryClass":"branded"},{"queryId":"q-category","queryText":"best apartments in Northbridge","provenance":null,"queryClass":"non-brand"}]}'
const GOLDEN_CHECKSUM = '57b1abfa8792813f1e7fd9f8ab2557dabe30eecb66ce5750158baf1124a792a9'

function qualifiedInput(qualifiedAliases?: string[]) {
  const value = input()
  return {
    ...value,
    identity: {
      ...value.identity,
      aliases: ['Northstar', 'NSLNYC', 'NSL NYC', 'NSL', 'Rival Homes'],
      ...(qualifiedAliases === undefined ? {} : { qualifiedAliases }),
    },
  }
}

describe('simple measurement definition qualified aliases', () => {
  it('keeps the pre-feature canonical bytes and checksum for a definition that never opted in', () => {
    const json = canonicalSimpleMeasurementDefinitionJson(buildSimpleMeasurementDefinition(input()))
    expect(json).toBe(GOLDEN_CANONICAL_JSON)
    expect(sha256(json)).toBe(GOLDEN_CHECKSUM)
  })

  it('omits the key for an empty or absent list, with one checksum for both', () => {
    const empty = buildSimpleMeasurementDefinition({ ...input(), identity: { ...input().identity, qualifiedAliases: [] } })
    const absent = buildSimpleMeasurementDefinition(input())
    expect(empty.identity).not.toHaveProperty('qualifiedAliases')
    expect(absent.identity).not.toHaveProperty('qualifiedAliases')
    expect(sha256(canonicalSimpleMeasurementDefinitionJson(empty))).toBe(GOLDEN_CHECKSUM)
    expect(sha256(canonicalSimpleMeasurementDefinitionJson(absent))).toBe(GOLDEN_CHECKSUM)
    // A stored `[]` (not produced by the builder) serializes the same as absent.
    const storedEmpty = { ...absent, identity: { ...absent.identity, qualifiedAliases: [] } }
    expect(canonicalSimpleMeasurementDefinitionJson(storedEmpty)).toBe(GOLDEN_CANONICAL_JSON)
  })

  it('freezes a sorted subset of aliases and drops stale entries and competitor names without throwing', () => {
    const definition = buildSimpleMeasurementDefinition({
      ...qualifiedInput(['rival homes', 'nsl nyc', 'NSLNYC', 'Retired Name', 'NSL', 'Northstar Living']),
      competitors: [{ domain: 'rivalhomes.example', label: 'Rival', aliases: ['Rival Homes'] }],
    })
    expect(definition.identity.qualifiedAliases).toEqual(['NSL NYC', 'NSLNYC'])
    const json = canonicalSimpleMeasurementDefinitionJson(definition)
    expect(json).toContain('"qualifiedAliases":["NSL NYC","NSLNYC"]')
    expect(sha256(json)).not.toBe(sha256(canonicalSimpleMeasurementDefinitionJson(buildSimpleMeasurementDefinition(qualifiedInput()))))
  })

  it('drops every entry when none is still an alias, leaving the pre-feature shape', () => {
    const stale = buildSimpleMeasurementDefinition({ ...input(), identity: { ...input().identity, qualifiedAliases: ['Former Name'] } })
    expect(stale.identity).not.toHaveProperty('qualifiedAliases')
    expect(sha256(canonicalSimpleMeasurementDefinitionJson(stale))).toBe(GOLDEN_CHECKSUM)
  })

  it('serializes a stored list in sorted order whatever order it was written in', () => {
    const definition = buildSimpleMeasurementDefinition(qualifiedInput(['NSLNYC', 'NSL NYC']))
    const reversed = { ...definition, identity: { ...definition.identity, qualifiedAliases: ['NSLNYC', 'NSL NYC'] } }
    expect(canonicalSimpleMeasurementDefinitionJson(reversed)).toBe(canonicalSimpleMeasurementDefinitionJson(definition))
  })

  it('still rejects unknown identity keys', () => {
    const definition = buildSimpleMeasurementDefinition(qualifiedInput(['NSLNYC']))
    const withUnknown = { ...definition, identity: { ...definition.identity, formerNames: ['NSLNYC'] } }
    expect(simpleMeasurementDefinitionSchema.safeParse(withUnknown).success).toBe(false)
    expect(() => buildSimpleMeasurementDefinition({
      ...input(),
      identity: { ...input().identity, formerNames: ['NSLNYC'] } as ReturnType<typeof input>['identity'],
    })).toThrow()
  })

  it('reads a stored list without re-applying the write rules', () => {
    const definition = buildSimpleMeasurementDefinition(input())
    // A later rule change must never make a captured sidecar unreadable.
    const stored = { ...definition, identity: { ...definition.identity, qualifiedAliases: ['AI', 'Not An Alias'] } }
    expect(simpleMeasurementDefinitionSchema.parse(stored).identity.qualifiedAliases).toEqual(['AI', 'Not An Alias'])
  })

  it('leaves query classes unchanged', () => {
    const value = qualifiedInput()
    value.queries = [
      { queryId: 'q-alias', queryText: 'NSL NYC reviews', provenance: null },
      { queryId: 'q-category', queryText: 'best apartments in Northbridge', provenance: null },
    ]
    const withList = buildSimpleMeasurementDefinition({ ...value, identity: { ...value.identity, qualifiedAliases: ['NSL NYC'] } })
    const without = buildSimpleMeasurementDefinition(value)
    expect(withList.identity.qualifiedAliases).toEqual(['NSL NYC'])
    expect(withList.queries).toEqual(without.queries)
    expect(without.queries.map(query => query.queryClass)).toEqual(['branded', 'non-brand'])
  })

  it('never lets a stale entry that is not an alias make a query branded', () => {
    const value = input()
    value.queries = [
      { queryId: 'q-former', queryText: 'Former Name reviews', provenance: null },
      { queryId: 'q-category', queryText: 'best apartments in Northbridge', provenance: null },
    ]
    const withList = buildSimpleMeasurementDefinition({ ...value, identity: { ...value.identity, qualifiedAliases: ['Former Name'] } })
    const without = buildSimpleMeasurementDefinition(value)
    expect(withList.queries.map(query => query.queryClass)).toEqual(['non-brand', 'non-brand'])
    expect(withList.queries).toEqual(without.queries)
    expect(withList.identity).not.toHaveProperty('qualifiedAliases')
  })

  it('reads competitor names as each label, then its aliases', () => {
    expect(simpleMeasurementCompetitorNames(undefined)).toEqual([])
    expect(simpleMeasurementCompetitorNames([
      { domain: 'rivalhomes.example', label: 'rivalhomes', aliases: ['Rival Homes', 'RH Living'] },
      { domain: 'other.example', label: 'other', aliases: [] },
    ])).toEqual(['rivalhomes', 'Rival Homes', 'RH Living', 'other'])
  })
})

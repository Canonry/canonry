import { describe, expect, it } from 'vitest'
import {
  MEASUREMENT_DRAFT_ETAG_PREFIX,
  measurementDraftAuthoringSchema,
  measurementDraftApplyAssignmentsRequestSchema,
  measurementDraftAssignmentAudienceRequestSchema,
  measurementDraftClassifyAssignmentsRequestSchema,
  measurementDraftExcludeTargetRequestSchema,
  measurementDraftEtag,
  measurementDraftMutationResponseSchema,
  measurementDraftPreviewAssignmentsResponseSchema,
  measurementDraftPublishRequestSchema,
  measurementDraftReplaceAssignmentsRequestSchema,
  measurementDraftRemoveAssignmentRequestSchema,
  measurementDraftTargetPageSchema,
  measurementDraftUpsertGroupRequestSchema,
  measurementPlanDraftSchema,
  measurementQuerySetUpsertRequestSchema,
  measurementQueryTemplateApplyRequestSchema,
  measurementSetupResponseSchema,
  parseMeasurementDraftEtagVersion,
  type MeasurementDraftAuthoring,
} from '../src/measurement-draft.js'
import {
  measurementDraftEtagRequired,
  measurementDraftEtagStale,
  measurementCompiledChecksumConflict,
  measurementIdempotencyKeyConflict,
  measurementRunRevisionMismatch,
} from '../src/errors.js'

const AUTHORING: MeasurementDraftAuthoring = measurementDraftAuthoringSchema.parse({
  defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-3-pro' }, locations: ['northbridge'] },
  targets: [{
    stableKey: 'harbor-point',
    label: 'Harbor Point',
    status: 'included',
    aliases: ['Harbor Point'],
    urlMatchers: ['https://northstar.example/apartments/harbor-point'],
    source: 'sitemap',
    discoveredUrl: 'https://northstar.example/apartments/harbor-point',
    discoveryIdentity: 'northstar.example/apartments/{slug}#harbor-point',
  }],
  assignments: [{
    targetKey: 'harbor-point',
    queryId: 'q-best',
    queryClass: 'unclassified',
    classificationSource: 'rule',
  }],
  groups: [{
    stableKey: 'northbridge-portfolio',
    label: 'Northbridge portfolio',
    targetKeys: ['harbor-point'],
    competitors: [{ stableKey: 'harborview', label: 'Harborview', domain: 'harborview.example', aliases: ['Harborview'] }],
  }],
})

describe('measurement plan draft', () => {
  it('stores authoring intent and the active revision it was created from', () => {
    const draft = measurementPlanDraftSchema.parse({
      id: 'mpd-1',
      projectId: 'prj-1',
      schemaVersion: 2,
      baseActiveVersionId: 'mpv-4',
      baseActiveRevision: 4,
      authoring: AUTHORING,
      createdBy: { kind: 'user', id: 'usr-1', label: 'operator' },
      updatedBy: { kind: 'user', id: 'usr-1', label: 'operator' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })
    expect(draft.baseActiveRevision).toBe(4)
    expect(draft.authoring.assignments[0]!.queryClass).toBe('unclassified')
  })

  it('refuses compiled output on a draft, which stores authoring intent only', () => {
    expect(() => measurementDraftAuthoringSchema.parse({ ...AUTHORING, executionNodes: [] })).toThrow()
    expect(() => measurementDraftAuthoringSchema.parse({ ...AUTHORING, querySnapshots: [] })).toThrow()
  })

  it('lets a draft carry an unclassified assignment that publish will later reject', () => {
    const authoring = measurementDraftAuthoringSchema.parse(AUTHORING)
    expect(authoring.assignments.map(assignment => assignment.queryClass)).toEqual(['unclassified'])
  })
})

describe('measurement draft ETag', () => {
  it('is a quoted strong tag derived from the monotonic counter, not a content hash', () => {
    expect(measurementDraftEtag(7)).toBe(`"${MEASUREMENT_DRAFT_ETAG_PREFIX}7"`)
    expect(measurementDraftEtag(7)).not.toBe(measurementDraftEtag(8))
  })

  it('reads back a counter from either the quoted or bare header form', () => {
    expect(parseMeasurementDraftEtagVersion('"mpd_7"')).toBe(7)
    expect(parseMeasurementDraftEtagVersion('mpd_7')).toBe(7)
    expect(parseMeasurementDraftEtagVersion('W/"mpd_7"')).toBeNull()
    expect(parseMeasurementDraftEtagVersion('"mpd_"')).toBeNull()
    expect(parseMeasurementDraftEtagVersion('"7"')).toBeNull()
  })
})

describe('measurement draft action payloads', () => {
  it('accepts one Target or a non-empty bulk Target selection, but never both', () => {
    const singleApply = { targetKey: 'harbor-point', queryIds: ['q-best'] }
    const bulkApply = { targetKeys: ['harbor-point', 'river-point'], queryIds: ['q-best'] }
    expect(measurementDraftApplyAssignmentsRequestSchema.parse(singleApply)).toEqual(singleApply)
    expect(measurementDraftApplyAssignmentsRequestSchema.parse(bulkApply)).toEqual(bulkApply)
    expect(() => measurementDraftApplyAssignmentsRequestSchema.parse({ queryIds: ['q-best'] })).toThrow()
    expect(() => measurementDraftApplyAssignmentsRequestSchema.parse({ ...singleApply, targetKeys: ['river-point'] })).toThrow()
    expect(() => measurementDraftApplyAssignmentsRequestSchema.parse({ targetKeys: [], queryIds: ['q-best'] })).toThrow()

    const singleRemove = { targetKey: 'harbor-point', queryId: 'q-best' }
    const bulkRemove = { targetKeys: ['harbor-point', 'river-point'], queryId: 'q-best' }
    expect(measurementDraftRemoveAssignmentRequestSchema.parse(singleRemove)).toEqual(singleRemove)
    expect(measurementDraftRemoveAssignmentRequestSchema.parse(bulkRemove)).toEqual(bulkRemove)
    expect(() => measurementDraftRemoveAssignmentRequestSchema.parse({ queryId: 'q-best' })).toThrow()
    expect(() => measurementDraftRemoveAssignmentRequestSchema.parse({ ...singleRemove, targetKeys: ['river-point'] })).toThrow()
  })

  it('accepts group or mixed audiences for bulk apply, preview, and replace while preserving legacy singular apply', () => {
    const groupOnly = { groupKeys: ['northbridge-portfolio'], queryIds: ['q-best'] }
    const mixed = { targetKeys: ['harbor-point'], groupKeys: ['northbridge-portfolio'], queryIds: ['q-best'] }
    expect(measurementDraftAssignmentAudienceRequestSchema.parse(groupOnly)).toEqual(groupOnly)
    expect(measurementDraftApplyAssignmentsRequestSchema.parse(groupOnly)).toEqual(groupOnly)
    expect(measurementDraftReplaceAssignmentsRequestSchema.parse(mixed)).toEqual(mixed)
    expect(measurementDraftReplaceAssignmentsRequestSchema.parse({ targetKeys: ['harbor-point', 'harbor-point'], queryIds: ['q-best'] }))
      .toEqual({ targetKeys: ['harbor-point', 'harbor-point'], queryIds: ['q-best'] })
    expect(() => measurementDraftAssignmentAudienceRequestSchema.parse({ queryIds: ['q-best'] })).toThrow()
    expect(() => measurementDraftAssignmentAudienceRequestSchema.parse({ targetKeys: [], groupKeys: [], queryIds: ['q-best'] })).toThrow()
    expect(() => measurementDraftAssignmentAudienceRequestSchema.parse({ targetKey: 'harbor-point', queryIds: ['q-best'] })).toThrow()
  })

  it('strictly shapes an assignment-impact preview', () => {
    const response = {
      draftEtag: '"mpd_7"',
      groups: [{ groupKey: 'northbridge-portfolio', label: 'Northbridge portfolio', memberCount: 1 }],
      resolvedTargetKeys: ['harbor-point'],
      overlapCount: 0,
      assignments: { requested: 2, added: 1, alreadyPresent: 1 },
      execution: { addedNodes: 1, addedProviderCalls: 2, fullRunNodes: 2, fullRunProviderCalls: 4 },
    }
    expect(measurementDraftPreviewAssignmentsResponseSchema.parse(response)).toEqual(response)
    expect(() => measurementDraftPreviewAssignmentsResponseSchema.parse({ ...response, execution: { ...response.execution, unknown: true } }))
      .toThrow()
  })

  it('rejects a group payload that carries queries or execution context', () => {
    const group = { stableKey: 'northbridge-portfolio', label: 'Northbridge portfolio', targetKeys: ['harbor-point'] }
    expect(measurementDraftUpsertGroupRequestSchema.parse({ group })).toEqual({ group })
    expect(() => measurementDraftUpsertGroupRequestSchema.parse({ group: { ...group, queryIds: ['q-best'] } })).toThrow()
    expect(() => measurementDraftUpsertGroupRequestSchema.parse({ group: { ...group, providers: ['gemini'] } })).toThrow()
    expect(() => measurementDraftUpsertGroupRequestSchema.parse({ group: { ...group, locations: ['northbridge'] } })).toThrow()
  })

  it('accepts an explicit cleanup mode for exclusion while preserving the legacy payload', () => {
    expect(measurementDraftExcludeTargetRequestSchema.parse({ targetKey: 'harbor-point' }))
      .toEqual({ targetKey: 'harbor-point' })
    expect(measurementDraftExcludeTargetRequestSchema.parse({
      targetKey: 'harbor-point',
      cleanup: 'assignments-and-group-memberships',
    })).toEqual({ targetKey: 'harbor-point', cleanup: 'assignments-and-group-memberships' })
    expect(() => measurementDraftExcludeTargetRequestSchema.parse({ targetKey: 'harbor-point', cleanup: 'urls' }))
      .toThrow()
  })

  it('accepts a complete competitor list on an atomic group save', () => {
    const group = {
      stableKey: 'northbridge-portfolio',
      label: 'Northbridge portfolio',
      targetKeys: ['harbor-point'],
      competitors: [{
        stableKey: 'river-group',
        label: 'River Group',
        domain: 'river-group.example',
        aliases: ['River Group'],
      }],
    }
    expect(measurementDraftUpsertGroupRequestSchema.parse({ group })).toEqual({ group })
    expect(() => measurementDraftUpsertGroupRequestSchema.parse({
      group: { ...group, competitors: [{ ...group.competitors[0], domain: 'not a host' }] },
    })).toThrow()
  })

  it('only lets an operator classify into a published class', () => {
    const assignments = [{ targetKey: 'harbor-point', queryId: 'q-best' }]
    expect(measurementDraftClassifyAssignmentsRequestSchema.parse({ queryClass: 'branded', assignments }).queryClass)
      .toBe('branded')
    expect(() => measurementDraftClassifyAssignmentsRequestSchema.parse({ queryClass: 'unclassified', assignments }))
      .toThrow()
  })

  it('requires both publish guards, so content that changed after review cannot slip through', () => {
    const checksum = 'a'.repeat(64)
    expect(measurementDraftPublishRequestSchema.parse({ expectedActiveRevision: 4, expectedCompiledChecksum: checksum }))
      .toEqual({ expectedActiveRevision: 4, expectedCompiledChecksum: checksum })
    expect(() => measurementDraftPublishRequestSchema.parse({ expectedActiveRevision: 4 })).toThrow()
    expect(() => measurementDraftPublishRequestSchema.parse({ expectedCompiledChecksum: checksum })).toThrow()
  })

  it('returns the new ETag, what changed, warnings and counts from every mutation', () => {
    const response = measurementDraftMutationResponseSchema.parse({
      etag: '"mpd_8"',
      changed: true,
      warnings: [{ code: 'target-alias-prefix-overlap', message: 'Target aliases overlap by mention prefix', path: ['targets'] }],
      counts: {
        targets: 1,
        includedTargets: 1,
        assignments: 1,
        unclassifiedAssignments: 1,
        groups: 1,
        competitors: 1,
      },
    })
    expect(response.etag).toBe('"mpd_8"')
    expect(response.counts.unclassifiedAssignments).toBe(1)
  })
})

describe('measurement draft collections', () => {
  it('pages Targets by cursor rather than truncating them', () => {
    const page = measurementDraftTargetPageSchema.parse({
      items: AUTHORING.targets,
      nextCursor: 'harbor-point',
      totalEstimate: 194,
    })
    expect(page.nextCursor).toBe('harbor-point')
    expect(page.totalEstimate).toBe(194)
  })
})

describe('measurement query assets', () => {
  it('holds ordered references to project query ids', () => {
    const parsed = measurementQuerySetUpsertRequestSchema.parse({
      name: 'Northbridge non-brand',
      description: null,
      queryIds: ['q-best', 'q-nearby'],
    })
    expect(parsed.queryIds).toEqual(['q-best', 'q-nearby'])
  })

  it('expands a template through explicit bindings', () => {
    const parsed = measurementQueryTemplateApplyRequestSchema.parse({
      bindings: [{ city: 'Northbridge' }, { city: 'Southbridge' }],
    })
    expect(parsed.bindings).toHaveLength(2)
  })
})

describe('measurement setup state', () => {
  it('names republish as the blocking action for an active v1 plan with a draft over it', () => {
    const parsed = measurementSetupResponseSchema.parse({
      state: 'republish_required',
      nextAction: 'republish_setup',
      mode: 'active-v1',
      answerVisibilityProviderReady: true,
      activeRevision: 4,
      activeSchemaVersion: 1,
      draft: { etag: '"mpd_2"', updatedAt: '2026-08-01T00:00:00.000Z' },
    })
    expect(parsed.state).toBe('republish_required')
    expect(parsed.nextAction).toBe('republish_setup')
  })
})

describe('measurement error codes', () => {
  it('maps each failure to the status the spec fixes for it', () => {
    expect(measurementCompiledChecksumConflict('a'.repeat(64), 'b'.repeat(64))).toMatchObject({
      code: 'MEASUREMENT_COMPILED_CHECKSUM_CONFLICT',
      statusCode: 409,
    })
    expect(measurementRunRevisionMismatch('run-1', 3, 4)).toMatchObject({
      code: 'MEASUREMENT_RUN_REVISION_MISMATCH',
      statusCode: 422,
    })
    expect(measurementDraftEtagRequired()).toMatchObject({ code: 'MEASUREMENT_DRAFT_ETAG_REQUIRED', statusCode: 428 })
    expect(measurementDraftEtagStale('"mpd_7"', '"mpd_8"')).toMatchObject({
      code: 'MEASUREMENT_DRAFT_ETAG_STALE',
      statusCode: 412,
    })
    expect(measurementIdempotencyKeyConflict('publish')).toMatchObject({
      code: 'MEASUREMENT_IDEMPOTENCY_KEY_CONFLICT',
      statusCode: 409,
    })
  })
})

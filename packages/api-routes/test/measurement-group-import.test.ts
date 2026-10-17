import { describe, expect, it } from 'vitest'
import {
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES,
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS,
  measurementDraftAuthoringSchema,
  type MeasurementDraftAuthoring,
  type MeasurementDraftSegmentDescriptor,
} from '@canonry/canonry-contracts'
import {
  MeasurementGroupMembershipImportError,
  applyReviewedGroupMembership,
  assertReviewedGroupMembership,
  deriveMeasurementGroupStableKey,
  normalizeGroupMembershipLabel,
  parseGroupMembershipCsv,
  previewGroupMembershipCsv,
  resolveGroupMembershipPreview,
} from '../src/measurement-group-import.js'

function target(
  stableKey: string,
  label: string,
  status: 'proposed' | 'included' | 'excluded' = 'included',
  urlMatchers = [`https://portfolio.example/${stableKey}`],
) {
  return {
    stableKey,
    label,
    status,
    aliases: [],
    urlMatchers,
    source: 'manual' as const,
  }
}

function authoring(input: {
  targets?: ReturnType<typeof target>[]
  groups?: MeasurementDraftAuthoring['groups']
} = {}): MeasurementDraftAuthoring {
  return measurementDraftAuthoringSchema.parse({
    defaultContext: { providers: ['gemini'], locations: [] },
    targets: input.targets ?? [target('harbor-house', 'Harbor House')],
    assignments: [],
    groups: input.groups ?? [],
  })
}

function preview(
  current: MeasurementDraftAuthoring,
  csv: string,
  options: { draftEtag?: string; segments?: readonly MeasurementDraftSegmentDescriptor[] } = {},
) {
  return previewGroupMembershipCsv({
    authoring: current,
    csv,
    draftEtag: options.draftEtag ?? '"mpd_7"',
    segments: options.segments ?? [],
  })
}

function expectImportError(
  run: () => unknown,
  code: string,
  statusCode?: number,
): MeasurementGroupMembershipImportError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(MeasurementGroupMembershipImportError)
    const typed = error as MeasurementGroupMembershipImportError
    expect(typed.code).toBe(code)
    if (statusCode !== undefined) expect(typed.statusCode).toBe(statusCode)
    return typed
  }
  throw new Error(`Expected import error ${code}`)
}

describe('group membership CSV parser', () => {
  it('supports an optional BOM, quoted commas/newlines, escaped quotes, and both LF and CRLF', () => {
    const crlf = '\ufeffPROPERTY,GROUP,URL\r\n"Harbor, House","Dallas\r\nCore","https://portfolio.example/harbor-house"\r\n'
    const parsed = parseGroupMembershipCsv(crlf)
    expect(parsed.rows).toEqual([{
      dataRow: 1,
      property: 'Harbor, House',
      group: 'Dallas\r\nCore',
      url: 'https://portfolio.example/harbor-house',
      normalizedProperty: 'harbor, house',
      normalizedGroupLabel: 'dallas\r\ncore',
      columnCountValid: true,
    }])
    expect(parseGroupMembershipCsv('property,group\n"Harbor ""House""",Dallas').rows[0]!.property)
      .toBe('Harbor "House"')
  })

  it('reports malformed CSV and named header errors before any draft work', () => {
    expectImportError(() => parseGroupMembershipCsv('property,group\n"Harbor,Dallas'), 'csv-malformed')
    expectImportError(() => parseGroupMembershipCsv('property,PROPERTY,group\nHarbor,Harbor,Dallas'), 'csv-header-duplicate')
    expectImportError(() => parseGroupMembershipCsv('property,url\nHarbor,https://example.com/harbor'), 'csv-header-missing')
    expectImportError(() => parseGroupMembershipCsv('property,group,market\nHarbor,Dallas,TX'), 'csv-header-invalid')
    expectImportError(() => parseGroupMembershipCsv('property,group\rHarbor,Dallas'), 'csv-malformed')
  })

  it('enforces the UTF-8 field and logical-row limits, including their exact boundary', () => {
    const header = 'property,group\n'
    const propertyLength = MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES - Buffer.byteLength(header) - Buffer.byteLength(',x')
    const nearLimit = `${header}${'a'.repeat(propertyLength)},x`
    expect(Buffer.byteLength(nearLimit, 'utf8')).toBe(MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES)
    expect(parseGroupMembershipCsv(nearLimit).rows).toHaveLength(1)
    expectImportError(() => parseGroupMembershipCsv(`${nearLimit}x`), 'csv-too-large', 413)

    const maxRows = `${header}${'Harbor,Dallas\n'.repeat(MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS)}`
    expect(parseGroupMembershipCsv(maxRows).rows).toHaveLength(MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS)
    expectImportError(() => parseGroupMembershipCsv(`${maxRows}Harbor,Dallas\n`), 'csv-too-many-rows', 413)
  })

  it('keeps malformed data records reviewable as invalid rows instead of changing the source interpretation', () => {
    const parsed = parseGroupMembershipCsv('property,group,url\nHarbor,Dallas\nElm,Dallas,https://example.com/elm,extra')
    expect(parsed.rows.map(row => row.columnCountValid)).toEqual([false, false])
    const result = preview(authoring(), 'property,group,url\nHarbor,Dallas\nElm,Dallas,https://example.com/elm,extra')
    expect(result.rows.map(row => row.status)).toEqual(['invalid', 'invalid'])
    expect(result.rows.map(row => row.status === 'invalid' && row.reason)).toEqual(['column-count', 'column-count'])
  })

  it('ignores blank and whitespace-only physical rows with LF or CRLF endings', () => {
    for (const csv of [
      'property,group\n\nHarbor House,Dallas\n   \n',
      'property,group\r\n\r\nHarbor House,Dallas\r\n  \t\r\n',
    ]) {
      const parsed = parseGroupMembershipCsv(csv)
      expect(parsed.rows).toHaveLength(1)
      expect(parsed.rows[0]).toMatchObject({ dataRow: 1, property: 'Harbor House', group: 'Dallas' })
    }
    expect(parseGroupMembershipCsv('property,group,url\n,,').rows).toHaveLength(1)
    expect(parseGroupMembershipCsv('property,group\n"",Dallas').rows).toHaveLength(1)
  })
})

describe('group membership preview resolution', () => {
  it('surfaces every unmatched Property row instead of dropping it from review counts', () => {
    const result = preview(authoring(), 'property,group\nMissing One,Dallas\nMissing Two,Austin')
    expect(result.rows).toHaveLength(2)
    expect(result.rows).toEqual([
      expect.objectContaining({ dataRow: 1, status: 'unmatched', reason: 'property-not-found' }),
      expect.objectContaining({ dataRow: 2, status: 'unmatched', reason: 'property-not-found' }),
    ])
    expect(result.counts).toMatchObject({ dataRows: 2, unmatchedRows: 2, needsAttention: 2 })
  })

  it('uses documented Unicode normalization for labels and a deterministic safe group key', () => {
    const current = authoring({ targets: [target('harbor-house', 'Harbor House')] })
    const result = preview(current, 'property,group\n Ｈａｒｂｏｒ\u00a0House , Ｄａｌｌａｓ ')
    expect(result.rows[0]).toMatchObject({
      status: 'matched',
      normalizedProperty: 'harbor house',
      normalizedGroupLabel: 'dallas',
      targetKey: 'harbor-house',
      groupKey: 'group-dallas',
    })
    expect(normalizeGroupMembershipLabel(' ＦＯＯ\u00a0Bar ')).toBe('foo bar')
    expect(deriveMeasurementGroupStableKey('dallas')).toBe('group-dallas')
    expect(deriveMeasurementGroupStableKey('東京')).toMatch(/^group-[a-f0-9]{12}$/)
  })

  it('requires an exact URL matcher to disambiguate colliding property labels', () => {
    const current = authoring({
      targets: [
        target('harbor-one', 'Harbor House', 'included', ['https://portfolio.example/one']),
        target('harbor-two', 'Harbor House', 'included', ['https://portfolio.example/two/*']),
      ],
    })
    const ambiguous = preview(current, 'property,group\nHarbor House,Dallas')
    expect(ambiguous.rows[0]).toMatchObject({
      status: 'ambiguous',
      reason: 'property-label-ambiguous',
      candidateTargetKeys: ['harbor-one', 'harbor-two'],
    })
    const exact = preview(current, 'property,group,url\nHarbor House,Dallas,https://portfolio.example/one')
    expect(exact.rows[0]).toMatchObject({ status: 'matched', targetKey: 'harbor-one' })
    const prefixOnly = preview(current, 'property,group,url\nHarbor House,Dallas,https://portfolio.example/two/a')
    expect(prefixOnly.rows[0]).toMatchObject({ status: 'unmatched', reason: 'url-not-exact-match' })
    const suppliedMiss = preview(current, 'property,group,url\nHarbor House,Dallas,https://portfolio.example/miss')
    expect(suppliedMiss.rows[0]).toMatchObject({ status: 'unmatched', reason: 'url-not-exact-match' })
  })

  it('never applies a proposed or excluded property and returns an invalid URL explicitly', () => {
    const current = authoring({
      targets: [
        target('proposed-house', 'Proposed House', 'proposed'),
        target('excluded-house', 'Excluded House', 'excluded'),
        target('harbor-house', 'Harbor House'),
      ],
    })
    const result = preview(current, [
      'property,group,url',
      'Proposed House,Dallas,',
      'Excluded House,Dallas,',
      'Harbor House,Dallas,https://portfolio.example/harbor-house?query=forbidden',
    ].join('\n'))
    expect(result.rows.map(row => row.status)).toEqual(['proposed', 'excluded', 'invalid'])
    expect(result.rows[2]).toMatchObject({ reason: 'invalid-url' })
    expect(result.counts).toMatchObject({ proposedRows: 1, excludedRows: 1, invalidRows: 1, matchedRows: 0 })
  })

  it('collapses duplicate normalized target/group rows without inflating membership change counts', () => {
    const current = authoring()
    const result = preview(current, [
      'property,group',
      'Harbor House,Dallas',
      ' harbor house , dallas ',
      'Harbor House,Luxury',
    ].join('\n'))
    expect(result.rows.map(row => row.status)).toEqual(['matched', 'duplicate', 'matched'])
    expect(result.rows[1]).toMatchObject({ duplicateOfRow: 1, targetKey: 'harbor-house' })
    expect(result.counts).toMatchObject({ matchedRows: 2, duplicateRows: 1, membershipsReady: 2, addedMemberships: 2 })
  })

  it('reuses one existing normalized-label group and leaves its presentation and competitors untouched', () => {
    const current = authoring({
      groups: [{
        stableKey: 'dallas-market',
        label: 'DALLAS',
        targetKeys: ['harbor-house'],
        competitors: [{ stableKey: 'other', label: 'Other', domain: 'other.example', aliases: ['Other'] }],
      }],
    })
    const result = preview(current, 'property,group\nHarbor House,Dallas')
    expect(result.rows[0]).toMatchObject({ status: 'matched', groupKey: 'dallas-market' })
    expect(result.groupChanges).toEqual([{
      normalizedGroupLabel: 'dallas',
      groupKey: 'dallas-market',
      label: 'DALLAS',
      action: 'extend',
      matchedRows: [1],
      targetKeys: ['harbor-house'],
      addedTargetKeys: [],
      unchangedTargetKeys: ['harbor-house'],
    }])
  })

  it('returns a group-label ambiguity and group-key conflicts as non-applyable rows', () => {
    const ambiguousGroup = authoring({
      groups: [
        { stableKey: 'dallas-a', label: 'Dallas', targetKeys: [], competitors: [] },
        { stableKey: 'dallas-b', label: ' dallas ', targetKeys: [], competitors: [] },
      ],
    })
    expect(preview(ambiguousGroup, 'property,group\nHarbor House,Dallas').rows[0])
      .toMatchObject({
        status: 'ambiguous',
        reason: 'group-label-ambiguous',
        candidateGroupKeys: ['dallas-a', 'dallas-b'],
      })

    const draftTargetCollision = authoring({ targets: [target('group-dallas', 'Harbor House')] })
    expect(preview(draftTargetCollision, 'property,group\nHarbor House,Dallas').rows[0])
      .toMatchObject({
        status: 'invalid',
        reason: 'group-key-conflict',
        groupKeyConflict: {
          proposedGroupKey: 'group-dallas',
          evidence: [expect.objectContaining({ source: 'draft-target', stableKey: 'group-dallas' })],
        },
      })

    const draftGroupCollision = authoring({
      groups: [{ stableKey: 'GROUP-DALLAS', label: 'Different group', targetKeys: [], competitors: [] }],
    })
    expect(preview(draftGroupCollision, 'property,group\nHarbor House,Dallas').rows[0])
      .toMatchObject({ status: 'invalid', reason: 'group-key-conflict' })

    const persistedCollision = preview(authoring(), 'property,group\nHarbor House,Dallas', {
      segments: [{ stableKey: 'Group-Dallas', kind: 'target', retiredAt: null }],
    })
    expect(persistedCollision.rows[0]).toMatchObject({ status: 'invalid', reason: 'group-key-conflict' })

    const retiredCollision = preview(authoring(), 'property,group\nHarbor House,Dallas', {
      segments: [{ stableKey: 'group-dallas', kind: 'group', retiredAt: '2026-08-03T00:00:00.000Z' }],
    })
    expect(retiredCollision.rows[0]).toMatchObject({ status: 'invalid', reason: 'group-key-conflict' })

    expectImportError(() => preview(authoring(), 'property,group\nHarbor House,Dallas', {
      segments: [
        { stableKey: 'other', kind: 'group', retiredAt: null },
        { stableKey: 'OTHER', kind: 'group', retiredAt: null },
      ],
    }), 'segment-descriptor-invalid', 409)
  })

  it('flags an internally colliding pair of proposed group identities instead of auto-suffixing keys', () => {
    const result = preview(authoring(), 'property,group\nHarbor House,A/B\nHarbor House,A B')
    expect(result.rows.map(row => row.status)).toEqual(['invalid', 'invalid'])
    expect(result.rows.every(row => row.status === 'invalid' && row.reason === 'group-key-conflict')).toBe(true)
    expect(result.groupChanges).toEqual([])
  })

  it('binds parser version, source, draft ETag, row outcomes, proposed identity, and segment state into a stable preview checksum', () => {
    const current = authoring()
    const csv = 'property,group\nHarbor House,Dallas'
    const first = preview(current, csv)
    const repeat = preview(current, csv)
    const changedEtag = preview(current, csv, { draftEtag: '"mpd_8"' })
    const changedSegments = preview(current, csv, { segments: [{ stableKey: 'other', kind: 'group', retiredAt: null }] })
    const changedSource = preview(current, `${csv}\nHarbor House,Luxury`)
    expect(repeat.previewChecksum).toBe(first.previewChecksum)
    expect(changedEtag.previewChecksum).not.toBe(first.previewChecksum)
    expect(changedSegments.previewChecksum).not.toBe(first.previewChecksum)
    expect(changedSource.sourceChecksum).not.toBe(first.sourceChecksum)

    const parsed = parseGroupMembershipCsv(csv)
    const resolved = resolveGroupMembershipPreview({
      authoring: current,
      draftEtag: '"mpd_7"',
      segments: [],
      sourceChecksum: parsed.sourceChecksum,
      rows: parsed.rows,
    })
    expect(resolved).toEqual(first)
  })
})

describe('reviewed group membership application', () => {
  it('adds only reviewed matched rows atomically and does not mutate the original draft', () => {
    const current = authoring()
    const result = preview(current, [
      'property,group',
      'Harbor House,Dallas',
      'Harbor House,Dallas',
      'Missing,Luxury',
    ].join('\n'))
    const review = {
      sourceChecksum: result.sourceChecksum,
      previewChecksum: result.previewChecksum,
      acceptedRows: [1],
    }
    assertReviewedGroupMembership(result, review)
    const applied = applyReviewedGroupMembership(current, result, review)
    expect(current.groups).toEqual([])
    expect(applied).toMatchObject({ appliedRows: 1, addedMemberships: 1, unchangedMemberships: 0 })
    expect(applied.authoring.groups).toEqual([{
      stableKey: 'group-dallas',
      label: 'Dallas',
      targetKeys: ['harbor-house'],
      competitors: [],
    }])
  })

  it('counts an existing membership as unchanged while preserving competitors', () => {
    const current = authoring({
      groups: [{
        stableKey: 'dallas-market',
        label: 'Dallas',
        targetKeys: ['harbor-house'],
        competitors: [{ stableKey: 'other', label: 'Other', domain: 'other.example', aliases: [] }],
      }],
    })
    const result = preview(current, 'property,group\nHarbor House,Dallas')
    const applied = applyReviewedGroupMembership(current, result, {
      sourceChecksum: result.sourceChecksum,
      previewChecksum: result.previewChecksum,
      acceptedRows: [1],
    })
    expect(applied).toMatchObject({ appliedRows: 1, addedMemberships: 0, unchangedMemberships: 1 })
    expect(applied.authoring.groups[0]!.competitors).toEqual(current.groups[0]!.competitors)
    expect(applied.authoring.groups[0]!.targetKeys).toEqual(['harbor-house'])
  })

  it('creates only the reviewed subset of a proposed group and unions several selected targets once', () => {
    const current = authoring({
      targets: [target('harbor-house', 'Harbor House'), target('elm-street', 'Elm Street')],
    })
    const result = preview(current, [
      'property,group',
      'Harbor House,Dallas',
      'Elm Street,Dallas',
      'Harbor House,Luxury',
    ].join('\n'))
    const applied = applyReviewedGroupMembership(current, result, {
      sourceChecksum: result.sourceChecksum,
      previewChecksum: result.previewChecksum,
      acceptedRows: [2, 3],
    })
    expect(applied.authoring.groups).toEqual([
      {
        stableKey: 'group-dallas',
        label: 'Dallas',
        targetKeys: ['elm-street'],
        competitors: [],
      },
      {
        stableKey: 'group-luxury',
        label: 'Luxury',
        targetKeys: ['harbor-house'],
        competitors: [],
      },
    ])
    expect(applied).toMatchObject({ appliedRows: 2, addedMemberships: 2, unchangedMemberships: 0 })
  })

  it('refuses stale checksums and every non-matched, duplicate, empty, or repeated reviewed selection', () => {
    const current = authoring()
    const result = preview(current, 'property,group\nHarbor House,Dallas\nHarbor House,Dallas\nMissing,Luxury')
    expectImportError(() => assertReviewedGroupMembership(result, {
      sourceChecksum: 'a'.repeat(64),
      previewChecksum: result.previewChecksum,
      acceptedRows: [1],
    }), 'source-checksum-mismatch', 409)
    expectImportError(() => assertReviewedGroupMembership(result, {
      sourceChecksum: result.sourceChecksum,
      previewChecksum: 'b'.repeat(64),
      acceptedRows: [1],
    }), 'preview-checksum-mismatch', 409)
    const review = (acceptedRows: number[]) => ({
      sourceChecksum: result.sourceChecksum,
      previewChecksum: result.previewChecksum,
      acceptedRows,
    })
    expectImportError(() => applyReviewedGroupMembership(current, result, review([])), 'accepted-rows-empty')
    expectImportError(() => applyReviewedGroupMembership(current, result, review([1, 1])), 'accepted-rows-duplicate')
    expectImportError(() => applyReviewedGroupMembership(current, result, review([2])), 'accepted-row-not-matched')
    expectImportError(() => applyReviewedGroupMembership(current, result, review([3])), 'accepted-row-not-matched')

    expectImportError(() => applyReviewedGroupMembership(current, result, {
      sourceChecksum: 'f'.repeat(64),
      previewChecksum: result.previewChecksum,
      acceptedRows: [1],
    }), 'source-checksum-mismatch', 409)
  })
})

import crypto from 'node:crypto'
import {
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES,
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS,
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_PARSER_VERSION,
  normalizeMeasurementExactUrl,
  type MeasurementDraftAuthoring,
  type MeasurementDraftGroupMembershipChange,
  type MeasurementDraftGroupMembershipImportCounts,
  type MeasurementDraftGroupMembershipRow,
  type MeasurementDraftGroupMembershipRowReason,
  type MeasurementDraftPreviewGroupMembershipResponse,
  type MeasurementDraftSegmentDescriptor,
  compareText,
} from '@ainyc/canonry-contracts'

/** Errors are data-only so route wiring can map the status to the host's error envelope. */
export class MeasurementGroupMembershipImportError extends Error {
  constructor(
    readonly code: MeasurementGroupMembershipImportErrorCode,
    message: string,
    readonly statusCode: 400 | 409 | 413 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MeasurementGroupMembershipImportError'
  }
}

export type MeasurementGroupMembershipImportErrorCode =
  | 'csv-too-large'
  | 'csv-too-many-rows'
  | 'csv-malformed'
  | 'csv-header-missing'
  | 'csv-header-duplicate'
  | 'csv-header-invalid'
  | 'source-checksum-mismatch'
  | 'preview-checksum-mismatch'
  | 'accepted-rows-empty'
  | 'accepted-rows-duplicate'
  | 'accepted-row-not-matched'
  | 'preview-inconsistent'
  | 'segment-descriptor-invalid'

export interface ParsedGroupMembershipCsvRow {
  /** One-based logical CSV record after the header. */
  dataRow: number
  property: string
  group: string
  url: string | null
  normalizedProperty: string
  normalizedGroupLabel: string
  /** The record parsed, but did not have the same column count as its header. */
  columnCountValid: boolean
}

export interface ParsedGroupMembershipCsv {
  sourceChecksum: string
  rows: readonly ParsedGroupMembershipCsvRow[]
}

export interface ResolveGroupMembershipPreviewInput {
  authoring: MeasurementDraftAuthoring
  draftEtag: string
  segments: readonly MeasurementDraftSegmentDescriptor[]
  sourceChecksum: string
  rows: readonly ParsedGroupMembershipCsvRow[]
}

export interface PreviewGroupMembershipCsvInput {
  authoring: MeasurementDraftAuthoring
  draftEtag: string
  segments: readonly MeasurementDraftSegmentDescriptor[]
  csv: string
}

export interface ApplyReviewedGroupMembershipResult {
  authoring: MeasurementDraftAuthoring
  appliedRows: number
  addedMemberships: number
  unchangedMemberships: number
}

interface CsvRecord {
  readonly fields: readonly string[]
  readonly physicalBlank: boolean
}

interface GroupKeyConflictEvidence {
  readonly source: 'draft-target' | 'draft-group' | 'persisted-segment' | 'retired-segment' | 'proposed-group'
  readonly stableKey: string
  readonly kind?: 'target' | 'group'
  readonly retiredAt?: string | null
  readonly normalizedGroupLabel?: string
}

type GroupIdentity =
  | {
    readonly kind: 'ready'
    readonly action: 'create' | 'extend'
    readonly normalizedGroupLabel: string
    readonly groupKey: string
    readonly label: string
    readonly existingTargetKeys: ReadonlySet<string>
  }
  | {
    readonly kind: 'ambiguous'
    readonly normalizedGroupLabel: string
    readonly groupKeys: readonly string[]
  }
  | {
    readonly kind: 'conflict'
    readonly normalizedGroupLabel: string
    readonly groupKey: string
    readonly evidence: readonly GroupKeyConflictEvidence[]
  }

interface ResolutionArtifacts {
  readonly rows: MeasurementDraftGroupMembershipRow[]
  readonly groupChanges: MeasurementDraftGroupMembershipChange[]
  readonly counts: MeasurementDraftGroupMembershipImportCounts
  readonly identities: readonly GroupIdentity[]
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    )
  }
  return value
}

function canonicalChecksum(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalJsonValue(value)))
}

/** Unicode NFKC, trim, and ECMAScript's locale-independent default case fold. */
export function normalizeGroupMembershipLabel(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function canonicalGroupLabel(value: string): string {
  return value.normalize('NFKC').trim()
}

/** The draft compiler treats group stable keys as case-insensitive identities. */
function groupStableKeyIdentity(value: string): string {
  return value.toLowerCase()
}

/** Stable, URL-safe identities for newly imported groups. Collisions are never auto-renamed. */
export function deriveMeasurementGroupStableKey(normalizedGroupLabel: string): string {
  const fingerprint = sha256Hex(normalizedGroupLabel).slice(0, 12)
  const slug = normalizedGroupLabel.normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = slug ? `group-${slug}` : `group-${fingerprint}`
  if (base.length <= 128) return base
  const suffix = `-${fingerprint}`
  const head = base.slice(0, 128 - suffix.length).replace(/-+$/g, '')
  return `${head || 'group'}${suffix}`
}

function sourceChecksum(csv: string): string {
  return sha256Hex(`${MEASUREMENT_GROUP_MEMBERSHIP_CSV_PARSER_VERSION}:source\0${csv}`)
}

function csvError(
  code: MeasurementGroupMembershipImportErrorCode,
  message: string,
  statusCode: 400 | 409 | 413 = 400,
  details?: Record<string, unknown>,
): never {
  throw new MeasurementGroupMembershipImportError(code, message, statusCode, details)
}

/**
 * A small strict RFC-style parser. A logical CSV record, rather than a physical
 * line, is what later becomes the stable one-based `dataRow` number.
 */
function parseCsvRecords(value: string): readonly CsvRecord[] {
  const source = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
  if (!source) return []

  const records: CsvRecord[] = []
  let fields: string[] = []
  let field = ''
  let inQuotes = false
  let closedQuote = false
  let recordHasInput = false
  let recordHasStructure = false

  const endRecord = () => {
    fields.push(field)
    records.push({
      fields,
      physicalBlank: !recordHasStructure && fields.length === 1 && fields[0]!.trim().length === 0,
    })
    fields = []
    field = ''
    closedQuote = false
    recordHasInput = false
    recordHasStructure = false
  }

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
          closedQuote = true
        }
      } else {
        field += character
      }
      recordHasInput = true
      continue
    }

    if (closedQuote) {
      if (character === ',') {
        fields.push(field)
        field = ''
        closedQuote = false
        recordHasInput = true
        continue
      }
      if (character === '\n') {
        endRecord()
        continue
      }
      if (character === '\r' && source[index + 1] === '\n') {
        index += 1
        endRecord()
        continue
      }
      csvError('csv-malformed', 'CSV has text after a closing quote before the next delimiter.', 400, { index })
    }

    if (character === '"') {
      if (field.length > 0) {
        csvError('csv-malformed', 'CSV quotes must begin at the start of a field.', 400, { index })
      }
      inQuotes = true
      recordHasInput = true
      recordHasStructure = true
      continue
    }
    if (character === ',') {
      fields.push(field)
      field = ''
      recordHasInput = true
      recordHasStructure = true
      continue
    }
    if (character === '\n') {
      endRecord()
      continue
    }
    if (character === '\r') {
      if (source[index + 1] !== '\n') {
        csvError('csv-malformed', 'CSV uses a bare carriage return; use LF or CRLF line endings.', 400, { index })
      }
      index += 1
      endRecord()
      continue
    }
    field += character
    recordHasInput = true
  }

  if (inQuotes) csvError('csv-malformed', 'CSV has an unterminated quoted field.')
  if (recordHasInput || fields.length > 0 || field.length > 0) endRecord()
  return records.filter(record => !record.physicalBlank)
}

function parseHeader(records: readonly CsvRecord[]): { readonly indices: ReadonlyMap<string, number>; readonly length: number } {
  const header = records.at(0)
  if (!header) csvError('csv-header-missing', 'CSV must include a property and group header row.')
  const allowed = new Set(['property', 'group', 'url'])
  const indices = new Map<string, number>()
  for (const [index, raw] of header.fields.entries()) {
    const name = normalizeGroupMembershipLabel(raw)
    if (!allowed.has(name)) {
      csvError('csv-header-invalid', `CSV header "${raw}" is not supported. Use property, group, and optional url.`, 400, { header: raw })
    }
    if (indices.has(name)) {
      csvError('csv-header-duplicate', `CSV header "${raw}" appears more than once.`, 400, { header: name })
    }
    indices.set(name, index)
  }
  for (const required of ['property', 'group']) {
    if (!indices.has(required)) {
      csvError('csv-header-missing', `CSV is missing the required "${required}" header.`, 400, { header: required })
    }
  }
  return { indices, length: header.fields.length }
}

/** Parses source only. It never reads or mutates a draft. */
export function parseGroupMembershipCsv(csv: string): ParsedGroupMembershipCsv {
  const byteLength = Buffer.byteLength(csv, 'utf8')
  if (byteLength > MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES) {
    csvError(
      'csv-too-large',
      `CSV is ${byteLength.toLocaleString('en-US')} bytes; the maximum is ${MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES.toLocaleString('en-US')} bytes.`,
      413,
      { byteLength, maxBytes: MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES },
    )
  }
  const records = parseCsvRecords(csv)
  const header = parseHeader(records)
  const dataRecords = records.slice(1)
  if (dataRecords.length > MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS) {
    csvError(
      'csv-too-many-rows',
      `CSV has ${dataRecords.length.toLocaleString('en-US')} data rows; the maximum is ${MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS.toLocaleString('en-US')}.`,
      413,
      { rowCount: dataRecords.length, maxRows: MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_DATA_ROWS },
    )
  }

  const propertyIndex = header.indices.get('property')!
  const groupIndex = header.indices.get('group')!
  const urlIndex = header.indices.get('url')
  const rows = dataRecords.map((record, index): ParsedGroupMembershipCsvRow => {
    const property = record.fields[propertyIndex] ?? ''
    const group = record.fields[groupIndex] ?? ''
    const rawUrl = urlIndex === undefined ? '' : (record.fields[urlIndex] ?? '')
    const url = rawUrl.trim() || null
    return {
      dataRow: index + 1,
      property,
      group,
      url,
      normalizedProperty: normalizeGroupMembershipLabel(property),
      normalizedGroupLabel: normalizeGroupMembershipLabel(group),
      columnCountValid: record.fields.length === header.length,
    }
  })
  return { sourceChecksum: sourceChecksum(csv), rows }
}

function exactMatcherUrls(target: MeasurementDraftAuthoring['targets'][number]): readonly string[] {
  const urls: string[] = []
  for (const rawMatcher of target.urlMatchers) {
    if (rawMatcher.trim().endsWith('/*')) continue
    try {
      urls.push(normalizeMeasurementExactUrl(rawMatcher))
    } catch {
      // Host and malformed draft matchers cannot act as an exact CSV disambiguator.
    }
  }
  return urls
}

function sourceRow(row: ParsedGroupMembershipCsvRow): Omit<MeasurementDraftGroupMembershipRow, 'status' | 'reason' | 'targetKey' | 'groupKey' | 'candidateTargetKeys' | 'candidateGroupKeys' | 'groupKeyConflict' | 'duplicateOfRow'> {
  return {
    dataRow: row.dataRow,
    property: row.property,
    group: row.group,
    url: row.url,
    normalizedProperty: row.normalizedProperty,
    normalizedGroupLabel: row.normalizedGroupLabel,
  }
}

function rowFailure(
  row: ParsedGroupMembershipCsvRow,
  status: 'ambiguous' | 'unmatched' | 'invalid',
  reason: MeasurementDraftGroupMembershipRowReason,
  detail?: {
    candidateTargetKeys?: readonly string[]
    candidateGroupKeys?: readonly string[]
    groupKeyConflict?: { proposedGroupKey: string; evidence: readonly GroupKeyConflictEvidence[] }
  },
): MeasurementDraftGroupMembershipRow {
  const source = sourceRow(row)
  if (status === 'ambiguous') {
    if (!detail?.candidateTargetKeys?.length && !detail?.candidateGroupKeys?.length) {
      throw new MeasurementGroupMembershipImportError('preview-inconsistent', 'An ambiguous CSV row is missing candidates.', 409)
    }
    return {
      ...source,
      status,
      reason,
      ...(detail.candidateTargetKeys?.length ? { candidateTargetKeys: [...detail.candidateTargetKeys] } : {}),
      ...(detail.candidateGroupKeys?.length ? { candidateGroupKeys: [...detail.candidateGroupKeys] } : {}),
    }
  }
  return {
    ...source,
    status,
    reason,
    ...(detail?.groupKeyConflict ? {
      groupKeyConflict: {
        proposedGroupKey: detail.groupKeyConflict.proposedGroupKey,
        evidence: [...detail.groupKeyConflict.evidence],
      },
    } : {}),
  }
}

function targetStateRow(
  row: ParsedGroupMembershipCsvRow,
  status: 'proposed' | 'excluded',
  targetKey: string,
): MeasurementDraftGroupMembershipRow {
  return {
    ...sourceRow(row),
    status,
    reason: status === 'proposed' ? 'target-proposed' : 'target-excluded',
    targetKey,
  }
}

function keyEvidenceForNewGroup(
  stableKey: string,
  authoring: MeasurementDraftAuthoring,
  segmentsByKey: ReadonlyMap<string, MeasurementDraftSegmentDescriptor>,
): GroupKeyConflictEvidence[] {
  const evidence: GroupKeyConflictEvidence[] = []
  const keyIdentity = groupStableKeyIdentity(stableKey)
  const target = authoring.targets.find(candidate => groupStableKeyIdentity(candidate.stableKey) === keyIdentity)
  if (target) {
    evidence.push({ source: 'draft-target', stableKey: target.stableKey, kind: 'target' })
  }
  const group = authoring.groups.find(candidate => groupStableKeyIdentity(candidate.stableKey) === keyIdentity)
  if (group) {
    evidence.push({ source: 'draft-group', stableKey: group.stableKey, kind: 'group' })
  }
  const segment = segmentsByKey.get(keyIdentity)
  if (segment) {
    evidence.push(segment.retiredAt === null
      ? { source: 'persisted-segment', stableKey: segment.stableKey, kind: segment.kind, retiredAt: null }
      : { source: 'retired-segment', stableKey: segment.stableKey, kind: segment.kind, retiredAt: segment.retiredAt })
  }
  return evidence
}

function keyEvidenceForExistingGroup(
  stableKey: string,
  authoring: MeasurementDraftAuthoring,
  segmentsByKey: ReadonlyMap<string, MeasurementDraftSegmentDescriptor>,
): GroupKeyConflictEvidence[] {
  const evidence: GroupKeyConflictEvidence[] = []
  const keyIdentity = groupStableKeyIdentity(stableKey)
  const target = authoring.targets.find(candidate => groupStableKeyIdentity(candidate.stableKey) === keyIdentity)
  if (target) {
    evidence.push({ source: 'draft-target', stableKey: target.stableKey, kind: 'target' })
  }
  const segment = segmentsByKey.get(keyIdentity)
  if (segment?.retiredAt !== null && segment !== undefined) {
    evidence.push({ source: 'retired-segment', stableKey: segment.stableKey, kind: segment.kind, retiredAt: segment.retiredAt })
  } else if (segment && segment.kind !== 'group') {
    evidence.push({ source: 'persisted-segment', stableKey: segment.stableKey, kind: segment.kind, retiredAt: null })
  }
  return evidence
}

function groupIdentities(
  rows: readonly ParsedGroupMembershipCsvRow[],
  authoring: MeasurementDraftAuthoring,
  segments: readonly MeasurementDraftSegmentDescriptor[],
): readonly GroupIdentity[] {
  const segmentsByKey = new Map<string, MeasurementDraftSegmentDescriptor>()
  for (const segment of segments) {
    const keyIdentity = groupStableKeyIdentity(segment.stableKey)
    if (segmentsByKey.has(keyIdentity)) {
      csvError('segment-descriptor-invalid', `Persisted segment "${segment.stableKey}" appears more than once.`, 409, { stableKey: segment.stableKey })
    }
    segmentsByKey.set(keyIdentity, segment)
  }

  const labels = new Map<string, string>()
  for (const row of rows) {
    if (!row.normalizedGroupLabel) continue
    if (!labels.has(row.normalizedGroupLabel)) labels.set(row.normalizedGroupLabel, canonicalGroupLabel(row.group))
  }
  const groupsByLabel = new Map<string, MeasurementDraftAuthoring['groups']>()
  for (const group of authoring.groups) {
    const label = normalizeGroupMembershipLabel(group.label)
    const matches = groupsByLabel.get(label) ?? []
    matches.push(group)
    groupsByLabel.set(label, matches)
  }

  const identities: GroupIdentity[] = []
  for (const normalizedGroupLabel of [...labels.keys()].sort(compareText)) {
    const existing = [...(groupsByLabel.get(normalizedGroupLabel) ?? [])].sort((left, right) => compareText(left.stableKey, right.stableKey))
    if (existing.length > 1) {
      identities.push({
        kind: 'ambiguous',
        normalizedGroupLabel,
        groupKeys: existing.map(group => group.stableKey),
      })
      continue
    }
    if (existing.length === 1) {
      const group = existing[0]!
      const evidence = keyEvidenceForExistingGroup(group.stableKey, authoring, segmentsByKey)
      if (evidence.length) {
        identities.push({ kind: 'conflict', normalizedGroupLabel, groupKey: group.stableKey, evidence })
      } else {
        identities.push({
          kind: 'ready',
          action: 'extend',
          normalizedGroupLabel,
          groupKey: group.stableKey,
          label: group.label,
          existingTargetKeys: new Set(group.targetKeys),
        })
      }
      continue
    }

    const groupKey = deriveMeasurementGroupStableKey(normalizedGroupLabel)
    const evidence = keyEvidenceForNewGroup(groupKey, authoring, segmentsByKey)
    if (evidence.length) {
      identities.push({ kind: 'conflict', normalizedGroupLabel, groupKey, evidence })
    } else {
      identities.push({
        kind: 'ready',
        action: 'create',
        normalizedGroupLabel,
        groupKey,
        label: labels.get(normalizedGroupLabel)!,
        existingTargetKeys: new Set(),
      })
    }
  }

  const readyByKey = new Map<string, GroupIdentity[]>()
  for (const identity of identities) {
    if (identity.kind !== 'ready') continue
    const keyIdentity = groupStableKeyIdentity(identity.groupKey)
    const sameKey = readyByKey.get(keyIdentity) ?? []
    sameKey.push(identity)
    readyByKey.set(keyIdentity, sameKey)
  }
  return identities.map(identity => {
    if (identity.kind !== 'ready') return identity
    const sameKey = readyByKey.get(groupStableKeyIdentity(identity.groupKey))!
    if (sameKey.length === 1) return identity
    return {
      kind: 'conflict',
      normalizedGroupLabel: identity.normalizedGroupLabel,
      groupKey: identity.groupKey,
      evidence: sameKey
        .filter(other => other.normalizedGroupLabel !== identity.normalizedGroupLabel)
        .map(other => ({
          source: 'proposed-group' as const,
          stableKey: identity.groupKey,
          normalizedGroupLabel: other.normalizedGroupLabel,
        })),
    }
  })
}

function groupChangesFromRows(
  rows: readonly MeasurementDraftGroupMembershipRow[],
  identities: readonly GroupIdentity[],
): MeasurementDraftGroupMembershipChange[] {
  const identityByLabel = new Map(identities.map(identity => [identity.normalizedGroupLabel, identity]))
  type MatchedRow = Extract<MeasurementDraftGroupMembershipRow, { status: 'matched' }>
  const byGroupKey = new Map<string, { identity: Extract<GroupIdentity, { kind: 'ready' }>; rows: MatchedRow[] }>()
  for (const row of rows) {
    if (row.status !== 'matched') continue
    const identity = identityByLabel.get(row.normalizedGroupLabel)
    if (!identity || identity.kind !== 'ready' || identity.groupKey !== row.groupKey) {
      throw new MeasurementGroupMembershipImportError('preview-inconsistent', 'A matched CSV row has no ready group identity.', 409, { dataRow: row.dataRow })
    }
    const bucket = byGroupKey.get(row.groupKey) ?? { identity, rows: [] }
    bucket.rows.push(row)
    byGroupKey.set(row.groupKey, bucket)
  }
  return [...byGroupKey.values()]
    .sort((left, right) => compareText(left.identity.normalizedGroupLabel, right.identity.normalizedGroupLabel))
    .map(({ identity, rows: matchedRows }) => {
      const targetKeys = [...new Set(matchedRows.map(row => row.targetKey))].sort(compareText)
      const addedTargetKeys = targetKeys.filter(targetKey => !identity.existingTargetKeys.has(targetKey))
      const unchangedTargetKeys = targetKeys.filter(targetKey => identity.existingTargetKeys.has(targetKey))
      return {
        normalizedGroupLabel: identity.normalizedGroupLabel,
        groupKey: identity.groupKey,
        label: identity.label,
        action: identity.action,
        matchedRows: matchedRows.map(row => row.dataRow),
        targetKeys,
        addedTargetKeys,
        unchangedTargetKeys,
      }
    })
}

function countsFromRows(
  rows: readonly MeasurementDraftGroupMembershipRow[],
  groupChanges: readonly MeasurementDraftGroupMembershipChange[],
): MeasurementDraftGroupMembershipImportCounts {
  const count = (status: MeasurementDraftGroupMembershipRow['status']) => rows.filter(row => row.status === status).length
  const ambiguousRows = count('ambiguous')
  const unmatchedRows = count('unmatched')
  const invalidRows = count('invalid')
  const proposedRows = count('proposed')
  const excludedRows = count('excluded')
  return {
    dataRows: rows.length,
    matchedRows: count('matched'),
    ambiguousRows,
    unmatchedRows,
    invalidRows,
    duplicateRows: count('duplicate'),
    proposedRows,
    excludedRows,
    needsAttention: ambiguousRows + unmatchedRows + invalidRows + proposedRows + excludedRows,
    groupsReady: groupChanges.length,
    groupsToCreate: groupChanges.filter(change => change.action === 'create').length,
    groupsToExtend: groupChanges.filter(change => change.action === 'extend').length,
    membershipsReady: groupChanges.reduce((total, change) => total + change.targetKeys.length, 0),
    addedMemberships: groupChanges.reduce((total, change) => total + change.addedTargetKeys.length, 0),
    unchangedMemberships: groupChanges.reduce((total, change) => total + change.unchangedTargetKeys.length, 0),
  }
}

function resolveRows(
  parsedRows: readonly ParsedGroupMembershipCsvRow[],
  authoring: MeasurementDraftAuthoring,
  identities: readonly GroupIdentity[],
): MeasurementDraftGroupMembershipRow[] {
  const targetsByLabel = new Map<string, MeasurementDraftAuthoring['targets']>()
  for (const target of authoring.targets) {
    const label = normalizeGroupMembershipLabel(target.label)
    const matches = targetsByLabel.get(label) ?? []
    matches.push(target)
    targetsByLabel.set(label, matches)
  }
  const identityByLabel = new Map(identities.map(identity => [identity.normalizedGroupLabel, identity]))
  const firstMembershipRow = new Map<string, number>()
  const resolved: MeasurementDraftGroupMembershipRow[] = []

  for (const row of parsedRows) {
    if (!row.columnCountValid) {
      resolved.push(rowFailure(row, 'invalid', 'column-count'))
      continue
    }
    if (!row.normalizedProperty) {
      resolved.push(rowFailure(row, 'invalid', 'missing-property'))
      continue
    }
    if (!row.normalizedGroupLabel) {
      resolved.push(rowFailure(row, 'invalid', 'missing-group'))
      continue
    }

    const labelCandidates = [...(targetsByLabel.get(row.normalizedProperty) ?? [])]
      .sort((left, right) => compareText(left.stableKey, right.stableKey))
    if (!labelCandidates.length) {
      resolved.push(rowFailure(row, 'unmatched', 'property-not-found'))
      continue
    }

    let candidates = labelCandidates
    if (row.url) {
      let normalizedUrl: string
      try {
        normalizedUrl = normalizeMeasurementExactUrl(row.url)
      } catch {
        resolved.push(rowFailure(row, 'invalid', 'invalid-url'))
        continue
      }
      candidates = labelCandidates.filter(target => exactMatcherUrls(target).includes(normalizedUrl))
      if (!candidates.length) {
        resolved.push(rowFailure(row, 'unmatched', 'url-not-exact-match'))
        continue
      }
    }
    if (candidates.length > 1) {
      resolved.push(rowFailure(
        row,
        'ambiguous',
        'property-label-ambiguous',
        { candidateTargetKeys: candidates.map(target => target.stableKey) },
      ))
      continue
    }

    const target = candidates[0]!
    if (target.status === 'proposed') {
      resolved.push(targetStateRow(row, 'proposed', target.stableKey))
      continue
    }
    if (target.status === 'excluded') {
      resolved.push(targetStateRow(row, 'excluded', target.stableKey))
      continue
    }

    const identity = identityByLabel.get(row.normalizedGroupLabel)
    if (!identity) {
      throw new MeasurementGroupMembershipImportError('preview-inconsistent', 'A non-empty CSV group has no identity proposal.', 409, { dataRow: row.dataRow })
    }
    if (identity.kind === 'ambiguous') {
      resolved.push(rowFailure(row, 'ambiguous', 'group-label-ambiguous', { candidateGroupKeys: identity.groupKeys }))
      continue
    }
    if (identity.kind === 'conflict') {
      resolved.push(rowFailure(row, 'invalid', 'group-key-conflict', {
        groupKeyConflict: { proposedGroupKey: identity.groupKey, evidence: identity.evidence },
      }))
      continue
    }

    const membershipKey = `${target.stableKey}\u0000${identity.normalizedGroupLabel}`
    const duplicateOfRow = firstMembershipRow.get(membershipKey)
    if (duplicateOfRow !== undefined) {
      resolved.push({
        ...sourceRow(row),
        status: 'duplicate',
        duplicateOfRow,
        targetKey: target.stableKey,
        groupKey: identity.groupKey,
      })
      continue
    }
    firstMembershipRow.set(membershipKey, row.dataRow)
    resolved.push({
      ...sourceRow(row),
      status: 'matched',
      targetKey: target.stableKey,
      groupKey: identity.groupKey,
    })
  }
  return resolved
}

function resolveArtifacts(input: ResolveGroupMembershipPreviewInput): ResolutionArtifacts {
  const identities = groupIdentities(input.rows, input.authoring, input.segments)
  const rows = resolveRows(input.rows, input.authoring, identities)
  const groupChanges = groupChangesFromRows(rows, identities)
  return { rows, groupChanges, counts: countsFromRows(rows, groupChanges), identities }
}

function checksumIdentities(identities: readonly GroupIdentity[]): readonly Record<string, unknown>[] {
  return [...identities]
    .sort((left, right) => compareText(left.normalizedGroupLabel, right.normalizedGroupLabel))
    .map(identity => {
      if (identity.kind === 'ready') {
        return {
          normalizedGroupLabel: identity.normalizedGroupLabel,
          outcome: identity.kind,
          action: identity.action,
          groupKey: identity.groupKey,
          label: identity.label,
        }
      }
      if (identity.kind === 'ambiguous') {
        return {
          normalizedGroupLabel: identity.normalizedGroupLabel,
          outcome: identity.kind,
          groupKeys: [...identity.groupKeys].sort(compareText),
        }
      }
      return {
        normalizedGroupLabel: identity.normalizedGroupLabel,
        outcome: identity.kind,
        groupKey: identity.groupKey,
        evidence: [...identity.evidence].sort((left, right) => {
          const bySource = compareText(left.source, right.source)
          return bySource || compareText(left.normalizedGroupLabel ?? '', right.normalizedGroupLabel ?? '')
        }),
      }
    })
}

/**
 * Resolve against the exact draft and persisted identity set a route observed.
 * It is intentionally all pure: preview calls leave no database, audit, or receipt state.
 */
export function resolveGroupMembershipPreview(
  input: ResolveGroupMembershipPreviewInput,
): MeasurementDraftPreviewGroupMembershipResponse {
  const artifacts = resolveArtifacts(input)
  const previewChecksum = canonicalChecksum({
    parserVersion: MEASUREMENT_GROUP_MEMBERSHIP_CSV_PARSER_VERSION,
    sourceChecksum: input.sourceChecksum,
    draftEtag: input.draftEtag,
    normalizedRows: input.rows.map(row => ({
      dataRow: row.dataRow,
      normalizedProperty: row.normalizedProperty,
      normalizedGroupLabel: row.normalizedGroupLabel,
      url: row.url,
      columnCountValid: row.columnCountValid,
    })),
    rows: artifacts.rows,
    proposedGroups: checksumIdentities(artifacts.identities),
    persistedSegments: [...input.segments]
      .sort((left, right) => compareText(left.stableKey, right.stableKey))
      .map(segment => ({ stableKey: segment.stableKey, kind: segment.kind, retiredAt: segment.retiredAt })),
  })
  return {
    draftEtag: input.draftEtag,
    sourceChecksum: input.sourceChecksum,
    previewChecksum,
    rows: artifacts.rows,
    groupChanges: artifacts.groupChanges,
    counts: artifacts.counts,
  }
}

/** Convenience entry point for a route's read-semantic preview operation. */
export function previewGroupMembershipCsv(
  input: PreviewGroupMembershipCsvInput,
): MeasurementDraftPreviewGroupMembershipResponse {
  const parsed = parseGroupMembershipCsv(input.csv)
  return resolveGroupMembershipPreview({
    authoring: input.authoring,
    draftEtag: input.draftEtag,
    segments: input.segments,
    sourceChecksum: parsed.sourceChecksum,
    rows: parsed.rows,
  })
}

/** Rejects a changed source or stale/re-resolved preview before any draft mutation is prepared. */
export function assertReviewedGroupMembership(
  preview: MeasurementDraftPreviewGroupMembershipResponse,
  review: {
    readonly sourceChecksum: string
    readonly previewChecksum: string
    readonly acceptedRows: readonly number[]
  },
): void {
  if (preview.sourceChecksum !== review.sourceChecksum) {
    csvError('source-checksum-mismatch', 'The CSV source changed after preview. Preview it again before applying.', 409, {
      expectedSourceChecksum: review.sourceChecksum,
      actualSourceChecksum: preview.sourceChecksum,
    })
  }
  if (preview.previewChecksum !== review.previewChecksum) {
    csvError('preview-checksum-mismatch', 'The CSV preview changed after review. Reload it before applying.', 409, {
      expectedPreviewChecksum: review.previewChecksum,
      actualPreviewChecksum: preview.previewChecksum,
    })
  }
  if (!review.acceptedRows.length) {
    csvError('accepted-rows-empty', 'Choose at least one matched CSV row to apply.', 400)
  }
  const accepted = new Set<number>()
  const rowsByNumber = new Map(preview.rows.map(row => [row.dataRow, row]))
  for (const dataRow of review.acceptedRows) {
    if (!Number.isInteger(dataRow) || dataRow < 1) {
      csvError('accepted-row-not-matched', `CSV data row ${String(dataRow)} is not a reviewed matched row.`, 400, { dataRow })
    }
    if (accepted.has(dataRow)) {
      csvError('accepted-rows-duplicate', `CSV data row ${dataRow} was accepted more than once.`, 400, { dataRow })
    }
    accepted.add(dataRow)
    if (rowsByNumber.get(dataRow)?.status !== 'matched') {
      csvError('accepted-row-not-matched', `CSV data row ${dataRow} is not a reviewed matched row.`, 400, { dataRow })
    }
  }
}

function cloneAuthoring(authoring: MeasurementDraftAuthoring): MeasurementDraftAuthoring {
  return {
    ...authoring,
    targets: authoring.targets.map(target => ({
      ...target,
      aliases: [...target.aliases],
      urlMatchers: [...target.urlMatchers],
    })),
    assignments: authoring.assignments.map(assignment => ({
      ...assignment,
      contextOverride: assignment.contextOverride && {
        ...assignment.contextOverride,
        providers: assignment.contextOverride.providers && [...assignment.contextOverride.providers],
        models: assignment.contextOverride.models && { ...assignment.contextOverride.models },
        locations: assignment.contextOverride.locations && [...assignment.contextOverride.locations],
      },
    })),
    groups: authoring.groups.map(group => ({
      ...group,
      targetKeys: [...group.targetKeys],
      competitors: group.competitors.map(competitor => ({ ...competitor, aliases: [...competitor.aliases] })),
    })),
  }
}

/**
 * Applies only rows that survived the reviewed preview. The review checksums
 * are required here so every caller gets the same staleness guard.
 */
export function applyReviewedGroupMembership(
  authoring: MeasurementDraftAuthoring,
  preview: MeasurementDraftPreviewGroupMembershipResponse,
  review: {
    readonly sourceChecksum: string
    readonly previewChecksum: string
    readonly acceptedRows: readonly number[]
  },
): ApplyReviewedGroupMembershipResult {
  assertReviewedGroupMembership(preview, review)
  const next = cloneAuthoring(authoring)
  const rowsByNumber = new Map(preview.rows.map(row => [row.dataRow, row]))
  const changesByKey = new Map(preview.groupChanges.map(change => [change.groupKey, change]))
  const groupsByKey = new Map(next.groups.map(group => [group.stableKey, group]))
  const createdGroupKeys = new Set<string>()
  let addedMemberships = 0
  let unchangedMemberships = 0

  for (const dataRow of review.acceptedRows) {
    const row = rowsByNumber.get(dataRow)
    if (!row || row.status !== 'matched') {
      throw new MeasurementGroupMembershipImportError('accepted-row-not-matched', `CSV data row ${dataRow} is not a reviewed matched row.`)
    }
    const change = changesByKey.get(row.groupKey)
    if (!change) {
      throw new MeasurementGroupMembershipImportError('preview-inconsistent', `CSV data row ${dataRow} has no group change.`, 409, { dataRow })
    }
    let group = groupsByKey.get(row.groupKey)
    if (!group) {
      if (change.action !== 'create') {
        throw new MeasurementGroupMembershipImportError('preview-inconsistent', `Existing group "${row.groupKey}" disappeared before applying.`, 409, { dataRow, groupKey: row.groupKey })
      }
      group = {
        stableKey: change.groupKey,
        label: change.label,
        targetKeys: [],
        competitors: [],
      }
      next.groups.push(group)
      groupsByKey.set(group.stableKey, group)
      createdGroupKeys.add(group.stableKey)
    } else if (change.action === 'create' && !createdGroupKeys.has(group.stableKey)) {
      throw new MeasurementGroupMembershipImportError('preview-inconsistent', `Proposed group "${row.groupKey}" already exists before applying.`, 409, { dataRow, groupKey: row.groupKey })
    }
    if (group.targetKeys.includes(row.targetKey)) {
      unchangedMemberships += 1
    } else {
      group.targetKeys.push(row.targetKey)
      addedMemberships += 1
    }
  }
  return {
    authoring: next,
    appliedRows: review.acceptedRows.length,
    addedMemberships,
    unchangedMemberships,
  }
}

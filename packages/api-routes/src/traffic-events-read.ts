import crypto from 'node:crypto'
import { desc, eq, sql, type SQL } from 'drizzle-orm'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { aiReferralEventsHourly, aiUserFetchEventsHourly, crawlerEventsHourly } from '@canonry/canonry-db'
import {
  escapeLikePattern,
  TrafficEventKinds,
  validationError,
  type TrafficEventGroup,
  type TrafficEventGroupField,
  type TrafficEventKind,
} from '@canonry/canonry-contracts'

/**
 * The columns the events read filters, pages and groups on, per hourly table.
 * `keys` are the primary-key columns after the project and hour, so
 * (hour, ...keys) names exactly one row and gives the read a fixed order.
 */
export interface TrafficEventTable {
  kind: TrafficEventKind
  /** Position among kinds within one hour: rows of a lower rank come first. */
  rank: number
  table: SQLiteTable
  tsHour: SQLiteColumn
  keys: SQLiteColumn[]
  /** Bot ID, or AI product on AI-referral rows. */
  agent: SQLiteColumn
  /** Fetched path, or landing path on AI-referral rows. */
  path: SQLiteColumn
  status: SQLiteColumn
  sourceId: SQLiteColumn
  hits: SQLiteColumn
}

export const TRAFFIC_EVENT_TABLES: Record<TrafficEventKind, TrafficEventTable> = {
  [TrafficEventKinds.crawler]: {
    kind: TrafficEventKinds.crawler,
    rank: 0,
    table: crawlerEventsHourly,
    tsHour: crawlerEventsHourly.tsHour,
    keys: [
      crawlerEventsHourly.sourceId,
      crawlerEventsHourly.botId,
      crawlerEventsHourly.verificationStatus,
      crawlerEventsHourly.pathNormalized,
      crawlerEventsHourly.status,
    ],
    agent: crawlerEventsHourly.botId,
    path: crawlerEventsHourly.pathNormalized,
    status: crawlerEventsHourly.status,
    sourceId: crawlerEventsHourly.sourceId,
    hits: crawlerEventsHourly.hits,
  },
  [TrafficEventKinds['ai-user-fetch']]: {
    kind: TrafficEventKinds['ai-user-fetch'],
    rank: 1,
    table: aiUserFetchEventsHourly,
    tsHour: aiUserFetchEventsHourly.tsHour,
    keys: [
      aiUserFetchEventsHourly.sourceId,
      aiUserFetchEventsHourly.botId,
      aiUserFetchEventsHourly.verificationStatus,
      aiUserFetchEventsHourly.pathNormalized,
      aiUserFetchEventsHourly.status,
    ],
    agent: aiUserFetchEventsHourly.botId,
    path: aiUserFetchEventsHourly.pathNormalized,
    status: aiUserFetchEventsHourly.status,
    sourceId: aiUserFetchEventsHourly.sourceId,
    hits: aiUserFetchEventsHourly.hits,
  },
  [TrafficEventKinds['ai-referral']]: {
    kind: TrafficEventKinds['ai-referral'],
    rank: 2,
    table: aiReferralEventsHourly,
    tsHour: aiReferralEventsHourly.tsHour,
    keys: [
      aiReferralEventsHourly.sourceId,
      aiReferralEventsHourly.product,
      aiReferralEventsHourly.sourceDomain,
      aiReferralEventsHourly.evidenceType,
      aiReferralEventsHourly.landingPathNormalized,
      aiReferralEventsHourly.status,
    ],
    agent: aiReferralEventsHourly.product,
    path: aiReferralEventsHourly.landingPathNormalized,
    status: aiReferralEventsHourly.status,
    sourceId: aiReferralEventsHourly.sourceId,
    hits: aiReferralEventsHourly.sessionsOrHits,
  },
}

export interface TrafficEventFilters {
  kinds: TrafficEventKind[]
  sourceId: string | null
  path: string | null
  agent: string | null
}

/** The path and agent predicates for one table; the route adds project, window and source. */
export function trafficEventFilterPredicates(table: TrafficEventTable, filters: Pick<TrafficEventFilters, 'path' | 'agent'>): SQL[] {
  const predicates: SQL[] = []
  // Prefix match, the same rule as `traffic samples --path`.
  if (filters.path !== null) predicates.push(sql`${table.path} LIKE ${escapeLikePattern(filters.path) + '%'} ESCAPE '\\'`)
  if (filters.agent !== null) predicates.push(eq(table.agent, filters.agent))
  return predicates
}

/** A query value that must be one non-empty string when present; a repeated parameter is refused. */
export function optionalQueryString(value: unknown, name: string): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.trim() === '') throw validationError(`"${name}" must be one non-empty value`)
  return value
}

type CursorKey = string | number

export interface TrafficEventCursor {
  since: string
  until: string
  tsHour: string
  rank: number
  keys: CursorKey[]
}

interface EncodedCursor {
  v: 1
  w: [string, string]
  f: string
  t: string
  r: number
  k: CursorKey[]
}

function filterDigest(filters: TrafficEventFilters, since: string, until: string): string {
  const basis = JSON.stringify([since, until, [...filters.kinds].sort(), filters.sourceId, filters.path, filters.agent])
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

export function encodeTrafficEventCursor(filters: TrafficEventFilters, cursor: TrafficEventCursor): string {
  const body: EncodedCursor = {
    v: 1,
    w: [cursor.since, cursor.until],
    f: filterDigest(filters, cursor.since, cursor.until),
    t: cursor.tsHour,
    r: cursor.rank,
    k: cursor.keys,
  }
  return Buffer.from(JSON.stringify(body)).toString('base64url')
}

const CURSOR_REFUSED = '"cursor" is not a cursor from this read. Pass the nextCursor of the previous page unchanged.'

/** Reads a cursor's window without checking filters, so the route can bind the page to it. */
export function readTrafficEventCursorWindow(raw: string): { since: string; until: string } {
  const body = parseCursor(raw)
  return { since: body.w[0], until: body.w[1] }
}

/** Decodes a cursor and checks it belongs to these filters and this window. */
export function decodeTrafficEventCursor(raw: string, filters: TrafficEventFilters, since: string, until: string): TrafficEventCursor {
  const body = parseCursor(raw)
  if (body.w[0] !== since || body.w[1] !== until || body.f !== filterDigest(filters, since, until)) {
    throw validationError('"cursor" belongs to a read with different filters or a different window. Repeat the first page\'s kind, sourceId, path and agent (since and until may be left out).')
  }
  return { since, until, tsHour: body.t, rank: body.r, keys: body.k }
}

function parseCursor(raw: string): EncodedCursor {
  let body: unknown
  try {
    body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw validationError(CURSOR_REFUSED)
  }
  const value = body as Partial<EncodedCursor> | null
  const valid = value !== null && typeof value === 'object'
    && value.v === 1
    && Array.isArray(value.w) && value.w.length === 2 && value.w.every((part) => typeof part === 'string')
    && typeof value.f === 'string'
    && typeof value.t === 'string'
    && typeof value.r === 'number' && Number.isInteger(value.r)
    && Array.isArray(value.k) && value.k.every((part) => typeof part === 'string' || typeof part === 'number')
  if (!valid) throw validationError(CURSOR_REFUSED)
  return value as EncodedCursor
}

/**
 * Rows of this table that come after the cursor in the read's order:
 * newest hour first, then kind rank, then the table's keys, descending.
 */
export function trafficEventCursorPredicate(table: TrafficEventTable, cursor: TrafficEventCursor): SQL {
  if (table.rank < cursor.rank) return sql`${table.tsHour} < ${cursor.tsHour}`
  if (table.rank > cursor.rank) return sql`${table.tsHour} <= ${cursor.tsHour}`
  if (cursor.keys.length !== table.keys.length) throw validationError(CURSOR_REFUSED)
  const columns = sql.join([table.tsHour, ...table.keys].map((column) => sql`${column}`), sql`, `)
  const values = sql.join([cursor.tsHour, ...cursor.keys].map((value) => sql`${value}`), sql`, `)
  return sql`(${columns}) < (${values})`
}

/** The read's fixed order for one table. */
export function trafficEventOrder(table: TrafficEventTable): SQL[] {
  return [desc(table.tsHour), ...table.keys.map((column) => desc(column))]
}

export interface RankedTrafficEventRow<T> {
  rank: number
  tsHour: string
  keys: CursorKey[]
  row: T
}

/**
 * Merges per-table pages, each already in the read's order, into one page.
 * Within a table the SQL order is kept (the sort is stable), so key order is
 * never compared outside SQLite. Returns the page and the next cursor.
 */
export function mergeTrafficEventPages<T>(
  pages: RankedTrafficEventRow<T>[][],
  limit: number,
  filters: TrafficEventFilters,
  since: string,
  until: string,
): { page: RankedTrafficEventRow<T>[]; nextCursor: string | null } {
  const merged = pages.flat()
  merged.sort((a, b) => (a.tsHour < b.tsHour ? 1 : a.tsHour > b.tsHour ? -1 : a.rank - b.rank))
  const page = merged.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = merged.length > limit && last
    ? encodeTrafficEventCursor(filters, { since, until, tsHour: last.tsHour, rank: last.rank, keys: last.keys })
    : null
  return { page, nextCursor }
}

interface GroupRow {
  agent?: string
  path?: string
  status?: number
  sourceId?: string
  hits: number
  rows: number
  firstHour: string
  lastHour: string
}

/** Totals over the whole filtered window for one table, split by the asked fields. */
export function trafficEventGroupColumns(table: TrafficEventTable, by: TrafficEventGroupField[]) {
  const columns: Record<string, SQLiteColumn> = {}
  if (by.includes('agent')) columns.agent = table.agent
  if (by.includes('path')) columns.path = table.path
  if (by.includes('status')) columns.status = table.status
  if (by.includes('source')) columns.sourceId = table.sourceId
  return columns
}

export function toTrafficEventGroup(kind: TrafficEventKind, row: GroupRow): TrafficEventGroup {
  const group: TrafficEventGroup = {
    kind,
    hits: Number(row.hits),
    rows: Number(row.rows),
    firstHour: row.firstHour,
    lastHour: row.lastHour,
  }
  if (row.agent !== undefined) group.agent = row.agent
  if (row.path !== undefined) group.path = row.path
  if (row.status !== undefined) group.status = Number(row.status)
  if (row.sourceId !== undefined) group.sourceId = row.sourceId
  return group
}

const KIND_RANK: Record<TrafficEventKind, number> = {
  [TrafficEventKinds.crawler]: 0,
  [TrafficEventKinds['ai-user-fetch']]: 1,
  [TrafficEventKinds['ai-referral']]: 2,
}

/** Most hits first; ties in a fixed order so the cap cuts the same groups every time. */
export function compareTrafficEventGroups(a: TrafficEventGroup, b: TrafficEventGroup): number {
  if (a.hits !== b.hits) return b.hits - a.hits
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind]
  for (const field of ['agent', 'path', 'sourceId'] as const) {
    const left = a[field] ?? ''
    const right = b[field] ?? ''
    if (left !== right) return left < right ? -1 : 1
  }
  return (a.status ?? 0) - (b.status ?? 0)
}

import crypto from 'node:crypto'
import { and, eq, gt, lte } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  measurementDraftAuthoringSchema,
  measurementDraftEtag,
  measurementDraftEtagRequired,
  measurementDraftEtagStale,
  measurementIdempotencyKeyConflict,
  measurementIdempotencyKeyRequired,
  parseMeasurementDraftEtagVersion,
  type ActorReference,
  type MeasurementDraftAuthoring,
  type MeasurementDraftCounts,
  type MeasurementPlanDraft,
} from '@ainyc/canonry-contracts'
import {
  measurementOperationReceipts,
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  type DatabaseClient,
} from '@ainyc/canonry-db'

export type DraftRow = typeof measurementPlanDrafts.$inferSelect
export type PlanVersionRow = typeof measurementPlanVersions.$inferSelect

/** Any Drizzle handle, so every helper works inside a transaction and outside one. */
type DbLike = Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'delete'>
type DbRead = Pick<DatabaseClient, 'select'>

/**
 * How long a stored response stays replayable. Long enough that a client
 * retrying a dropped connection still hits the receipt, short enough that the
 * table stays small between sweeps.
 */
export const MEASUREMENT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Key-order-independent JSON. The draft service compares and hashes structures
 * the client serialized, so a value's identity must not turn on the order a
 * caller happened to write its keys in.
 */
export function canonicalJsonValue(value: unknown): unknown {
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

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Key-order-independent identity for a request body. Two retries that differ
 * only in how the client serialized the same object must replay, not conflict.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value))
}

export function requestChecksum(body: unknown): string {
  return sha256Hex(canonicalJson(body ?? null))
}

/**
 * Who is acting, for the draft row and the audit trail. `system` covers the
 * harnesses that mount `apiRoutes` with `skipAuth`, where no principal exists.
 */
export function actorFromRequest(request: FastifyRequest): ActorReference {
  const principal = request.principal
  if (principal) {
    return { kind: principal.kind, id: principal.id, label: principal.name }
  }
  const key = request.apiKey
  if (key) return { kind: 'api-key', id: key.id, label: key.name }
  return { kind: 'system', id: 'system', label: 'system' }
}

function parseActor(value: string): ActorReference {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && typeof (parsed as ActorReference).id === 'string') {
      return parsed as ActorReference
    }
  } catch {
    // Fall through: a row written before actors were JSON still has to read.
  }
  return { kind: 'system', id: value || 'system', label: value || 'system' }
}

export function parseStoredAuthoring(json: string): MeasurementDraftAuthoring {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('Stored measurement draft authoring JSON is invalid')
  }
  const parsed = measurementDraftAuthoringSchema.safeParse(value)
  if (!parsed.success) throw new Error('Stored measurement draft authoring is invalid')
  return parsed.data
}

export function draftRow(db: DbRead, projectId: string): DraftRow | null {
  return db.select().from(measurementPlanDrafts)
    .where(eq(measurementPlanDrafts.projectId, projectId)).get() ?? null
}

export function draftDto(row: DraftRow): MeasurementPlanDraft {
  return {
    id: row.id,
    projectId: row.projectId,
    schemaVersion: 2,
    baseActiveVersionId: row.baseActiveVersionId,
    baseActiveRevision: row.baseActiveRevision,
    authoring: parseStoredAuthoring(row.authoringJson),
    createdBy: parseActor(row.createdBy),
    updatedBy: parseActor(row.updatedBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function serializeActor(actor: ActorReference): string {
  return JSON.stringify(actor)
}

/**
 * What still blocks publish, returned on every mutation so nobody discovers an
 * unclassified assignment at publish time.
 */
export function draftCounts(authoring: MeasurementDraftAuthoring): MeasurementDraftCounts {
  return {
    targets: authoring.targets.length,
    includedTargets: authoring.targets.filter(target => target.status === 'included').length,
    assignments: authoring.assignments.length,
    unclassifiedAssignments: authoring.assignments.filter(assignment => assignment.queryClass === 'unclassified').length,
    groups: authoring.groups.length,
    competitors: authoring.groups.reduce((total, group) => total + group.competitors.length, 0),
  }
}

/** The active-plan pointer and the revision it names, or null on a planless project. */
export function activePlanVersionRow(db: DbRead, projectId: string): PlanVersionRow | null {
  const pointer = db.select().from(measurementPlans)
    .where(eq(measurementPlans.projectId, projectId)).get()
  if (!pointer) return null
  const version = db.select().from(measurementPlanVersions).where(and(
    eq(measurementPlanVersions.projectId, projectId),
    eq(measurementPlanVersions.id, pointer.activeVersionId),
  )).get()
  if (!version) throw new Error(`Measurement plan ${projectId} points to missing version ${pointer.activeVersionId}`)
  return version
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * The precondition itself, read before anything is loaded: a mutation that
 * cannot say which draft it saw is refused with 428 whether or not one exists.
 */
export function requireIfMatch(request: FastifyRequest): string {
  const value = headerValue(request, 'if-match')
  if (!value) throw measurementDraftEtagRequired()
  return value
}

/** A tag that does not name the stored counter is stale, malformed included. */
export function assertDraftEtag(row: DraftRow, ifMatch: string): void {
  const expected = parseMeasurementDraftEtagVersion(ifMatch)
  if (expected === null || expected !== row.etagVersion) {
    throw measurementDraftEtagStale(ifMatch, measurementDraftEtag(row.etagVersion))
  }
}

export function requireIdempotencyKey(request: FastifyRequest, operation: string): string {
  const value = headerValue(request, 'idempotency-key')
  if (!value) throw measurementIdempotencyKeyRequired(operation)
  return value
}

export interface ReceiptLookup {
  operation: string
  key: string
  checksum: string
}

/**
 * Replay a stored response, or refuse the key outright when it was used for
 * different content.
 *
 * Deliberately consulted BEFORE `If-Match`: the retry of a request whose
 * response was lost carries the ETag the caller held when it first sent, which
 * the successful first attempt has already moved past. Checking the
 * precondition first would make a dropped response unrecoverable.
 */
export function replayReceipt(
  db: DbLike,
  projectId: string,
  lookup: ReceiptLookup,
  reply: FastifyReply,
): unknown | null {
  const now = new Date().toISOString()
  const existing = db.select().from(measurementOperationReceipts).where(and(
    eq(measurementOperationReceipts.projectId, projectId),
    eq(measurementOperationReceipts.operation, lookup.operation),
    eq(measurementOperationReceipts.idempotencyKey, lookup.key),
    gt(measurementOperationReceipts.expiresAt, now),
  )).get()
  if (!existing) return null
  if (existing.requestChecksum !== lookup.checksum) throw measurementIdempotencyKeyConflict(lookup.operation)
  reply.status(existing.statusCode)
  return JSON.parse(existing.responseJson)
}

/**
 * Receipts are written for successful responses only. A refused precondition
 * or a failed validation is not an outcome worth replaying, and storing one
 * would pin the failure to the key for its whole lifetime.
 */
export function writeReceipt(
  tx: DbLike,
  projectId: string,
  lookup: ReceiptLookup,
  response: unknown,
  statusCode: number,
  now: Date,
): void {
  tx.insert(measurementOperationReceipts).values({
    projectId,
    operation: lookup.operation,
    idempotencyKey: lookup.key,
    requestChecksum: lookup.checksum,
    responseJson: JSON.stringify(response),
    statusCode,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MEASUREMENT_RECEIPT_TTL_MS).toISOString(),
  }).run()
}

/**
 * Nothing on the write path deletes a receipt, so without this the table only
 * ever grows. Called at boot and again before each receipt is written, which
 * keeps the sweep on the same schedule as the writes that fill the table
 * rather than inventing a schedule type for it.
 */
export function sweepExpiredMeasurementReceipts(db: DbLike, now: Date): number {
  const result = db.delete(measurementOperationReceipts)
    .where(lte(measurementOperationReceipts.expiresAt, now.toISOString())).run()
  return Number(result.changes)
}

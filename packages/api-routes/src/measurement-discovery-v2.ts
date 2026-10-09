import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  brandKeyFromText,
  effectiveDomains,
  MIN_DOMAIN_BRAND_KEY_LENGTH,
  measurementDraftApplySitemapSelectionRequestSchema,
  measurementDraftAuthoringSchema,
  measurementDraftEtag,
  measurementDraftEtagRequired,
  measurementDraftEtagStale,
  measurementDraftImportSitemapRequestSchema,
  measurementDraftMutationResponseSchema,
  measurementIdempotencyKeyConflict,
  measurementIdempotencyKeyRequired,
  normalizeMeasurementHost,
  notFound,
  parseMeasurementDraftEtagVersion,
  validationError,
  type MeasurementDiscoveryRule,
  type MeasurementDraftAuthoring,
  type MeasurementDraftTarget,
  type MeasurementDraftWarning,
  describeError,
  compareText,
  sortedUnique,
} from '@ainyc/canonry-contracts'
import {
  measurementDiscoveryConfigs,
  measurementOperationReceipts,
  measurementPlanDrafts,
  projects,
} from '@ainyc/canonry-db'
import { requireAdminSession, requireScope } from './auth.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import {
  classifyMeasurementSitemapUrls,
  MeasurementDiscoveryConfigurationError,
  type MeasurementDiscoveryCandidate,
} from './measurement-discovery.js'
import { draftCounts } from './measurement-draft-repo.js'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from './measurement-plan.js'
import { fetchMeasurementSitemap, type MeasurementSitemapDocument } from './measurement-sitemap-fetch.js'

/**
 * Bumped whenever a change here would classify the same sitemap differently.
 * It is part of the discovery input checksum, so a rerun under a new compiler
 * is a new input rather than a silent change of answer.
 */
export const MEASUREMENT_DISCOVERY_COMPILER_VERSION = 'measurement-discovery/2.0'

/**
 * How similar a discovered candidate must be to a Target that vanished from the
 * sitemap before a rebind is worth showing. Exceeding it with exactly one
 * Target is the only thing that proposes a rebind; anything else is either a
 * new Target or an ambiguity the operator resolves.
 */
export const MEASUREMENT_REBIND_THRESHOLD = 0.7

const DISCOVERY_URL_LIMIT = 10_000
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000

export interface MeasurementDiscoveryIdentityParts {
  host: string
  pathTemplate: string
  slug: string
}

export type MeasurementRebindProposalKind = 'new-target' | 'rebind' | 'ambiguous'

export interface MeasurementRebindCandidate {
  targetKey: string
  score: number
}

export interface MeasurementRebindProposal {
  discoveryIdentity: string
  stableKey: string
  slug: string
  label: string
  discoveredUrl: string
  urlMatchers: string[]
  kind: MeasurementRebindProposalKind
  /** Set only when exactly one existing Target crossed the threshold. */
  rebindTargetKey?: string
  /** Every existing Target over the threshold, strongest first. */
  candidates: MeasurementRebindCandidate[]
}

export interface MeasurementDiscoveryBindingInput {
  candidates: readonly MeasurementDiscoveryCandidate[]
  rule: MeasurementDiscoveryRule
  exclusions: readonly string[]
  targets: readonly MeasurementDraftTarget[]
}

export interface MeasurementDiscoveryBindingResult {
  proposals: MeasurementRebindProposal[]
  /** Stable keys the sitemap still covers at the identity they are already bound to. */
  unchanged: string[]
}

/**
 * The join key between a discovery run and a Target across time. It is built
 * from normalized URL structure and the extraction fields — host, the path
 * template the rule matched, and the slug it pulled out — and never from the
 * display label, which an operator is free to rewrite at any moment.
 *
 * Structured rather than hashed on purpose: a rebind has to compare the parts,
 * and a digest can only answer "same or not".
 */
export function measurementDiscoveryIdentity(parts: MeasurementDiscoveryIdentityParts): string {
  const host = normalizeMeasurementHost(parts.host.trim().toLowerCase())
  const pathTemplate = normalizePathTemplate(parts.pathTemplate)
  const slug = parts.slug.trim().toLowerCase()
  return ['sitemap', '1', host, pathTemplate, slug].map(value => encodeURIComponent(value)).join(':')
}

export function parseMeasurementDiscoveryIdentity(value: string): MeasurementDiscoveryIdentityParts | null {
  const parts = value.split(':')
  if (parts.length !== 5 || parts[0] !== 'sitemap' || parts[1] !== '1') return null
  try {
    const [host, pathTemplate, slug] = parts.slice(2).map(part => decodeURIComponent(part)) as [string, string, string]
    return host && pathTemplate && slug ? { host, pathTemplate, slug } : null
  } catch {
    return null
  }
}

/**
 * Turn classified sitemap URLs into review proposals. Pure and deterministic:
 * equal candidates, rule, exclusions and Targets produce an equal result, which
 * is what lets a rerun over an unchanged sitemap be a no-op.
 *
 * It proposes only. Nothing here creates, renames, merges, publishes or starts
 * anything — a rebind is a suggestion the operator applies by hand.
 */
export function proposeMeasurementDiscoveryBindings(
  input: MeasurementDiscoveryBindingInput,
): MeasurementDiscoveryBindingResult {
  const pathTemplate = normalizePathTemplate(input.rule.primary.pathTemplate)
  const excluded = new Set(input.exclusions.map(value => value.trim().toLowerCase()))

  const discovered = input.candidates.map(candidate => ({
    candidate,
    identity: measurementDiscoveryIdentity({ host: hostOfUrl(candidate.primaryUrl), pathTemplate, slug: candidate.slug }),
  }))
  // Every identity the sitemap still covers, exclusions included: an excluded
  // slug is present on the site, so the Target holding it has not gone missing
  // and must never be offered as somewhere else's rebind.
  const present = new Set(discovered.map(entry => entry.identity))

  const bound = new Set(input.targets.flatMap(target => target.discoveryIdentity ? [target.discoveryIdentity] : []))

  // Only a discovered Target whose URL disappeared can be rebound. A manually
  // authored Target has no structural identity to compare, and matching it on
  // its label alone is exactly what §10 forbids.
  const missing = input.targets
    .filter(target => target.source === 'sitemap' && target.status !== 'excluded')
    .flatMap((target) => {
      if (target.discoveryIdentity === undefined || present.has(target.discoveryIdentity)) return []
      const parts = parseMeasurementDiscoveryIdentity(target.discoveryIdentity)
      return parts ? [{ target, parts }] : []
    })

  const proposals: MeasurementRebindProposal[] = []
  for (const { candidate, identity } of discovered) {
    if (bound.has(identity)) continue
    if (excluded.has(candidate.slug) || excluded.has(identity.toLowerCase())) continue

    const parts = parseMeasurementDiscoveryIdentity(identity)
    if (!parts) continue
    const candidates = missing
      .map(entry => ({ targetKey: entry.target.stableKey, score: rebindScore(parts, entry.parts) }))
      .filter(entry => entry.score > MEASUREMENT_REBIND_THRESHOLD)
      .sort((left, right) => right.score - left.score || compareText(left.targetKey, right.targetKey))

    proposals.push({
      discoveryIdentity: identity,
      stableKey: candidate.stableKey,
      slug: candidate.slug,
      label: candidate.label,
      discoveredUrl: candidate.primaryUrl,
      urlMatchers: sortedUnique([candidate.primaryUrl, ...candidate.aliasCoverageUrls]),
      kind: candidates.length === 1 ? 'rebind' : candidates.length === 0 ? 'new-target' : 'ambiguous',
      ...(candidates.length === 1 ? { rebindTargetKey: candidates[0]!.targetKey } : {}),
      candidates,
    })
  }

  return {
    proposals: proposals.sort((left, right) => compareText(left.discoveryIdentity, right.discoveryIdentity)),
    unchanged: input.targets
      .filter(target => target.discoveryIdentity !== undefined && present.has(target.discoveryIdentity))
      .map(target => target.stableKey)
      .sort(compareText),
  }
}

/**
 * Weighted over the extraction fields, never the label. The slug carries most
 * of it because a restructure usually keeps the slug and moves the path; the
 * host and template make up the rest, so a Target that kept its place scores
 * above one that only shares a word.
 */
function rebindScore(left: MeasurementDiscoveryIdentityParts, right: MeasurementDiscoveryIdentityParts): number {
  const slug = left.slug === right.slug ? 1 : jaccard(slugTokens(left.slug), slugTokens(right.slug))
  const host = left.host === right.host ? 1 : 0
  const template = left.pathTemplate === right.pathTemplate ? 1 : 0
  return Math.round((slug * 0.6 + host * 0.2 + template * 0.2) * 10_000) / 10_000
}

function slugTokens(slug: string): Set<string> {
  return new Set(slug.split(/[-_]+/).filter(Boolean))
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  const shared = [...left].filter(token => right.has(token)).length
  return shared / (left.size + right.size - shared)
}

function normalizePathTemplate(value: string): string {
  return `/${value.split('/').map(segment => segment.trim().toLowerCase()).filter(Boolean).join('/')}`
}

function hostOfUrl(value: string): string {
  return normalizeMeasurementHost(new URL(value).hostname)
}

function canonicalJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => compareText(left, right))
          .map(([key, child]) => [key, canonical(child)]),
      )
    }
    return input
  }
  return JSON.stringify(canonical(value))
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * The four inputs §10 names determinism over. A rerun that reproduces all four
 * resolves to the discovery config that already exists rather than proposing
 * the same Targets a second time; a sitemap that changed under an unchanged URL
 * produces a different checksum, which is what stops a change being accepted
 * silently.
 */
export function measurementDiscoveryInputChecksum(input: {
  sitemapUrl: string
  rule: MeasurementDiscoveryRule
  exclusions: readonly string[]
  bytesChecksum: string
}): string {
  return sha256(canonicalJson({
    compilerVersion: MEASUREMENT_DISCOVERY_COMPILER_VERSION,
    sitemapUrl: input.sitemapUrl,
    rule: input.rule,
    exclusions: sortedUnique(input.exclusions.map(value => value.trim().toLowerCase())),
    bytesChecksum: input.bytesChecksum,
  }))
}

interface LoadedDraft {
  row: typeof measurementPlanDrafts.$inferSelect
  authoring: MeasurementDraftAuthoring
}

function loadDraft(app: FastifyInstance, projectId: string, projectName: string): LoadedDraft {
  const row = app.db.select().from(measurementPlanDrafts).where(eq(measurementPlanDrafts.projectId, projectId)).get()
  if (!row) throw notFound('Measurement plan draft', projectName)
  const parsed = measurementDraftAuthoringSchema.safeParse(JSON.parse(row.authoringJson))
  if (!parsed.success) {
    throw validationError('The stored measurement draft could not be read.', { issues: parsed.error.issues })
  }
  return { row, authoring: parsed.data }
}

/** Collapses the duplicated-header case, which these two guards must not read past. */
function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value: unknown = request.headers[name]
  const first: unknown = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() ? first.trim() : undefined
}

/** `If-Match` proves the caller is acting on the draft it last read. Missing is 428, stale is 412. */
function requireCurrentEtag(request: FastifyRequest, draft: LoadedDraft): void {
  const supplied = headerValue(request, 'if-match')
  if (!supplied) throw measurementDraftEtagRequired()
  if (parseMeasurementDraftEtagVersion(supplied) !== draft.row.etagVersion) {
    throw measurementDraftEtagStale(measurementDraftEtag(draft.row.etagVersion), supplied)
  }
}

function requireIdempotencyKey(request: FastifyRequest, operation: string): string {
  const supplied = headerValue(request, 'idempotency-key')
  if (!supplied) throw measurementIdempotencyKeyRequired(operation)
  return supplied
}

/**
 * A replay answers with the stored response and never re-runs the action; the
 * same key over different content is a conflict, because replaying a receipt
 * over a changed request would apply the wrong one.
 */
function replayedResponse(
  app: FastifyInstance,
  projectId: string,
  operation: string,
  idempotencyKey: string,
  requestChecksum: string,
): unknown | null {
  const receipt = app.db.select().from(measurementOperationReceipts).where(and(
    eq(measurementOperationReceipts.projectId, projectId),
    eq(measurementOperationReceipts.operation, operation),
    eq(measurementOperationReceipts.idempotencyKey, idempotencyKey),
  )).get()
  if (!receipt) return null
  if (receipt.requestChecksum !== requestChecksum) throw measurementIdempotencyKeyConflict(operation)
  return JSON.parse(receipt.responseJson)
}

function actorReference(request: FastifyRequest) {
  const principal = request.principal
  if (!principal) return { kind: 'system' as const, id: 'system', label: 'system' }
  return {
    kind: principal.kind === 'user' ? ('user' as const) : ('api-key' as const),
    id: principal.id,
    label: principal.name,
  }
}

interface CommitInput {
  request: FastifyRequest
  reply: FastifyReply
  project: typeof projects.$inferSelect
  draft: LoadedDraft
  operation: string
  idempotencyKey: string
  requestChecksum: string
  authoring: MeasurementDraftAuthoring
  changed: boolean
  warnings: MeasurementDraftWarning[]
  audit: { action: string; diff: Record<string, unknown> }
  discovery?: {
    sitemapUrl: string
    rule: MeasurementDiscoveryRule
    exclusions: string[]
    inputChecksum: string
  }
}

/**
 * One transaction: the draft, its discovery config, the audit event and the
 * idempotency receipt either all land or none do. The ETag counter moves only
 * when something actually changed, so a rerun over an unchanged sitemap leaves
 * the caller's tag valid.
 */
function commitDraft(app: FastifyInstance, input: CommitInput) {
  // Re-read the document before it is stored. Writing an unreadable draft
  // would break every later read of it, and failing here names the field.
  const authoring = measurementDraftAuthoringSchema.safeParse(input.authoring)
  if (!authoring.success) {
    throw validationError('The action would leave the draft unreadable.', { issues: authoring.error.issues })
  }
  const now = new Date().toISOString()
  const etagVersion = input.changed ? input.draft.row.etagVersion + 1 : input.draft.row.etagVersion
  const response = measurementDraftMutationResponseSchema.parse({
    etag: measurementDraftEtag(etagVersion),
    changed: input.changed,
    warnings: input.warnings,
    counts: draftCounts(authoring.data),
  })
  const actor = actorReference(input.request)

  app.db.transaction((tx) => {
    if (input.changed) {
      tx.update(measurementPlanDrafts).set({
        authoringJson: JSON.stringify(authoring.data),
        etagVersion,
        updatedBy: JSON.stringify(actor),
        updatedAt: now,
      }).where(eq(measurementPlanDrafts.id, input.draft.row.id)).run()
    }

    if (input.discovery) {
      const existing = tx.select().from(measurementDiscoveryConfigs).where(and(
        eq(measurementDiscoveryConfigs.projectId, input.project.id),
        eq(measurementDiscoveryConfigs.inputChecksum, input.discovery.inputChecksum),
      )).get()
      if (existing) {
        tx.update(measurementDiscoveryConfigs).set({ updatedAt: now })
          .where(eq(measurementDiscoveryConfigs.id, existing.id)).run()
      } else {
        tx.insert(measurementDiscoveryConfigs).values({
          id: crypto.randomUUID(),
          projectId: input.project.id,
          sitemapUrl: input.discovery.sitemapUrl,
          rule: input.discovery.rule as unknown as Record<string, unknown>,
          exclusions: input.discovery.exclusions,
          inputChecksum: input.discovery.inputChecksum,
          compilerVersion: MEASUREMENT_DISCOVERY_COMPILER_VERSION,
          createdAt: now,
          updatedAt: now,
        }).run()
      }
    }

    writeAuditLog(tx, auditFromRequest(input.request, {
      projectId: input.project.id,
      actor: actor.label,
      action: input.audit.action,
      entityType: 'measurement-plan-draft',
      entityId: input.draft.row.id,
      diff: {
        ...input.audit.diff,
        actor,
        previousEtag: measurementDraftEtag(input.draft.row.etagVersion),
        etag: response.etag,
      },
    }))

    tx.insert(measurementOperationReceipts).values({
      projectId: input.project.id,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestChecksum: input.requestChecksum,
      responseJson: JSON.stringify(response),
      statusCode: 200,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + RECEIPT_TTL_MS).toISOString(),
    }).run()
  })

  input.reply.header('ETag', response.etag)
  return response
}

/**
 * Warnings are the review channel: they never block, and the path carries the
 * proposed key and the Target a rebind would land on, so a browser can offer
 * the choice without parsing a sentence.
 */
function proposalWarnings(proposals: readonly MeasurementRebindProposal[]): MeasurementDraftWarning[] {
  return proposals.flatMap((proposal): MeasurementDraftWarning[] => {
    if (proposal.kind === 'rebind') {
      return [{
        code: 'measurement.discovery.proposed_rebind',
        message: `'${proposal.discoveredUrl}' looks like Target '${proposal.rebindTargetKey}' at a new URL. Rebind it or accept it as new.`,
        path: ['targets', proposal.stableKey, 'rebind', proposal.rebindTargetKey ?? ''],
      }]
    }
    if (proposal.kind === 'ambiguous') {
      // One warning per tied Target: the operator has to choose, so every
      // choice has to be addressable rather than buried in a sentence.
      return proposal.candidates.map(candidate => ({
        code: 'measurement.discovery.rebind_ambiguous',
        message: `'${proposal.discoveredUrl}' matches several Targets, '${candidate.targetKey}' among them. Select one before applying.`,
        path: ['targets', proposal.stableKey, 'rebind', candidate.targetKey],
      }))
    }
    return [{
      code: 'measurement.discovery.proposed_new_target',
      message: `'${proposal.discoveredUrl}' matches no existing Target and is proposed as a new one.`,
      path: ['targets', proposal.stableKey],
    }]
  })
}

/**
 * A proposal keeps the key discovery derived from its slug unless an unrelated
 * Target already holds it, in which case it takes the first free suffix. The
 * keys in play decide it, so the same inputs produce the same key.
 */
function availableStableKey(preferred: string, taken: ReadonlySet<string>): string {
  if (!taken.has(preferred)) return preferred
  for (let suffix = 2; suffix <= 1_000; suffix += 1) {
    const key = `${preferred}-${suffix}`
    if (!taken.has(key)) return key
  }
  throw validationError(`Discovery could not find a free stable key for '${preferred}'.`)
}

function messageOf(error: unknown): string {
  return describeError(error)
}

/**
 * Sitemap import and identity rebinding against a setup draft.
 *
 * These are draft actions, but they belong here rather than in
 * `measurement-draft.ts` because the fetch they perform is the hardened one:
 * the server dereferences an operator-supplied URL while sitting on a tailnet
 * beside internal services. Both produce review proposals only — neither
 * publishes a plan nor starts a run.
 *
 * There is no fetch seam to inject: the hardened fetch is the only way out of
 * this route, and tests that need a stub replace the module it lives in.
 */
export async function measurementDiscoveryV2Routes(app: FastifyInstance) {
  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/import-sitemap', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)

    const parsed = measurementDraftImportSitemapRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid sitemap import request', { issues: parsed.error.issues })
    }
    const exclusions = sortedUnique((parsed.data.exclusions ?? []).map(value => value.trim().toLowerCase()))

    const idempotencyKey = requireIdempotencyKey(request, 'import-sitemap')
    const requestChecksum = sha256(canonicalJson({ ...parsed.data, exclusions }))
    const replay = replayedResponse(app, project.id, 'import-sitemap', idempotencyKey, requestChecksum)
    if (replay) return replay

    const draft = loadDraft(app, project.id, request.params.name)
    requireCurrentEtag(request, draft)

    let document: MeasurementSitemapDocument
    try {
      document = await fetchMeasurementSitemap(parsed.data.sitemapUrl)
    } catch (error) {
      // A refused or unreachable sitemap is reported against the field that
      // named it. The upstream-failure code would be more precise for a flaky
      // host, but this action's OpenAPI entry declares no 5xx and parity is not
      // this slice's to change.
      throw validationError(`Unable to fetch sitemap: ${messageOf(error)}`, { path: ['sitemapUrl'] })
    }

    let candidates: MeasurementDiscoveryCandidate[]
    try {
      candidates = classifyMeasurementSitemapUrls({
        ownedHosts: effectiveDomains(project),
        rules: parsed.data.rule,
        urls: document.urls,
        maxUrls: DISCOVERY_URL_LIMIT,
      }).proposed
    } catch (error) {
      if (error instanceof MeasurementDiscoveryConfigurationError) throw validationError(error.message)
      throw error
    }

    const { proposals } = proposeMeasurementDiscoveryBindings({
      candidates,
      rule: parsed.data.rule,
      exclusions,
      targets: draft.authoring.targets,
    })
    const discovery = {
      sitemapUrl: parsed.data.sitemapUrl,
      rule: parsed.data.rule,
      exclusions,
      inputChecksum: measurementDiscoveryInputChecksum({
        sitemapUrl: parsed.data.sitemapUrl,
        rule: parsed.data.rule,
        exclusions,
        bytesChecksum: document.bytesChecksum,
      }),
    }

    // The key a proposal wants can already belong to an unrelated Target, so
    // the placed key — not the preferred one — is what the row, the warning and
    // the audit entry all have to agree on.
    const taken = new Set(draft.authoring.targets.map(target => target.stableKey))
    const placed = proposals.map((proposal) => {
      const stableKey = availableStableKey(proposal.stableKey, taken)
      taken.add(stableKey)
      return { ...proposal, stableKey }
    })
    const added: MeasurementDraftTarget[] = placed.map(proposal => ({
      stableKey: proposal.stableKey,
      label: proposal.label,
      // Proposed, never included: discovery reviews and the operator decides.
      status: 'proposed',
      // The label is deterministic output from the reviewed sitemap rule, so
      // it is safe to seed as mention identity when it meets the scorer's
      // specificity floor. A later display-label edit deliberately does not
      // rewrite this approved identity.
      aliases: brandKeyFromText(proposal.label).length >= MIN_DOMAIN_BRAND_KEY_LENGTH
        ? [proposal.label]
        : [],
      urlMatchers: proposal.urlMatchers,
      source: 'sitemap',
      discoveredUrl: proposal.discoveredUrl,
      discoveryIdentity: proposal.discoveryIdentity,
    }))

    const authoring: MeasurementDraftAuthoring = {
      ...draft.authoring,
      targets: [...draft.authoring.targets, ...added],
      discovery,
    }

    return commitDraft(app, {
      request,
      reply,
      project,
      draft,
      operation: 'import-sitemap',
      idempotencyKey,
      requestChecksum,
      authoring,
      changed: added.length > 0 || draft.authoring.discovery?.inputChecksum !== discovery.inputChecksum,
      warnings: proposalWarnings(placed),
      audit: {
        action: 'measurement.discovery.imported',
        diff: {
          sitemapUrl: discovery.sitemapUrl,
          inputChecksum: discovery.inputChecksum,
          compilerVersion: MEASUREMENT_DISCOVERY_COMPILER_VERSION,
          proposed: placed.map(proposal => ({ stableKey: proposal.stableKey, kind: proposal.kind })),
        },
      },
      discovery,
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/apply-sitemap-selection', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)

    const parsed = measurementDraftApplySitemapSelectionRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid sitemap selection request', { issues: parsed.error.issues })
    }
    const identities = new Set(parsed.data.selections.map(selection => selection.discoveryIdentity))
    if (identities.size !== parsed.data.selections.length) {
      throw validationError('Each discovery identity may appear at most once in a selection.')
    }

    const idempotencyKey = requireIdempotencyKey(request, 'apply-sitemap-selection')
    const requestChecksum = sha256(canonicalJson(parsed.data))
    const replay = replayedResponse(app, project.id, 'apply-sitemap-selection', idempotencyKey, requestChecksum)
    if (replay) return replay

    const draft = loadDraft(app, project.id, request.params.name)
    requireCurrentEtag(request, draft)

    if (parsed.data.selectedTargetKeys !== undefined) {
      const unresolved = draft.authoring.targets
        .filter(target => target.status === 'proposed' && target.discoveryIdentity && !identities.has(target.discoveryIdentity))
      if (unresolved.length > 0) {
        throw validationError('Every discovery proposal must be reviewed before saving the Property selection.', {
          discoveryIdentities: unresolved.map(target => target.discoveryIdentity),
        })
      }
    }

    let targets = draft.authoring.targets
    let assignments = draft.authoring.assignments
    let groups = draft.authoring.groups
    const applied: Array<Record<string, unknown>> = []
    for (const selection of parsed.data.selections) {
      const proposal = targets.find(target =>
        target.status === 'proposed' && target.discoveryIdentity === selection.discoveryIdentity)
      if (!proposal) throw notFound('Discovery proposal', selection.discoveryIdentity)
      const relabelled = selection.label ? { label: selection.label } : {}

      if (selection.action === 'ignore') {
        targets = targets.map(target => target === proposal ? { ...target, status: 'excluded' as const } : target)
        applied.push({ action: 'ignore', stableKey: proposal.stableKey, discoveryIdentity: selection.discoveryIdentity })
        continue
      }

      if (selection.action === 'create') {
        targets = targets.map(target =>
          target === proposal ? { ...target, ...relabelled, status: 'included' as const } : target)
        applied.push({ action: 'create', stableKey: proposal.stableKey, discoveryIdentity: selection.discoveryIdentity })
        continue
      }

      if (!selection.targetKey) {
        throw validationError('A rebind selection must name the Target it rebinds.', {
          discoveryIdentity: selection.discoveryIdentity,
        })
      }
      const existing = targets.find(target => target.stableKey === selection.targetKey && target.status !== 'proposed')
      if (!existing) throw notFound('Measurement Target', selection.targetKey)

      // The stable key — and with it every assignment and group membership
      // keyed on it — is untouched by construction: only the discovered URL,
      // the structural identity and the matchers move. The old matchers stay,
      // so evidence collected against the previous URL still resolves.
      const rebound: MeasurementDraftTarget = {
        ...existing,
        ...relabelled,
        urlMatchers: sortedUnique([...existing.urlMatchers, ...proposal.urlMatchers]),
        discoveredUrl: proposal.discoveredUrl,
        discoveryIdentity: proposal.discoveryIdentity,
      }
      targets = targets
        .filter(target => target !== proposal)
        .map(target => target === existing ? rebound : target)
      applied.push({
        action: 'rebind',
        stableKey: existing.stableKey,
        discoveryIdentity: selection.discoveryIdentity,
        previousDiscoveryIdentity: existing.discoveryIdentity ?? null,
        previousDiscoveredUrl: existing.discoveredUrl ?? null,
        discoveredUrl: proposal.discoveredUrl,
      })
    }

    if (parsed.data.selectedTargetKeys !== undefined) {
      const selected = new Set(parsed.data.selectedTargetKeys)
      const known = new Set(targets.map(target => target.stableKey))
      const unknown = [...selected].filter(targetKey => !known.has(targetKey))
      if (unknown.length > 0) throw notFound('Measurement Target', unknown[0]!)
      const excluded = new Set(targets.filter(target => !selected.has(target.stableKey)).map(target => target.stableKey))
      targets = targets.map(target => ({
        ...target,
        status: selected.has(target.stableKey) ? 'included' as const : 'excluded' as const,
      }))
      assignments = assignments.filter(assignment => !excluded.has(assignment.targetKey))
      groups = groups.map(group => ({
        ...group,
        targetKeys: group.targetKeys.filter(targetKey => !excluded.has(targetKey)),
      }))
      applied.push({ action: 'review-selection', included: selected.size, excluded: excluded.size })
    }

    return commitDraft(app, {
      request,
      reply,
      project,
      draft,
      operation: 'apply-sitemap-selection',
      idempotencyKey,
      requestChecksum,
      authoring: { ...draft.authoring, targets, assignments, groups },
      changed: true,
      warnings: [],
      audit: { action: 'measurement.discovery.selection_applied', diff: { applied } },
    })
  })
}

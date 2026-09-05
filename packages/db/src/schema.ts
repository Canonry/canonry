import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AdsActivationEntityType, AdsActivationGrantState, AdsActivationManifest, AdsOperationStepState, AdsReconcileFields, BacklinkSource, ContentBriefDto, ConversionTrackingContract, DiscoveryCompetitorMapEntry, DiscoveryCompetitorType, AiReferralTrafficClass, LocationContext, ProviderModels, ProviderName, SiteAuditCrossCuttingIssueDto, SiteAuditEffectiveRequest, SiteAuditFactorSummaryDto, SiteAuditPageFactorDto, MeasurementConfig, GaLeadAttributionScope, GaMeasurementComponentStatus, GoogleAdsCustomerStatus, GoogleAdsSnapshotKind, GoogleAdsSnapshotPayload, GtmSnapshotKind, GtmSnapshotPayload, SimpleMeasurementDefinition, TrafficVerificationManifest } from '@ainyc/canonry-contracts'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  canonicalDomain: text('canonical_domain').notNull(),
  ownedDomains: text('owned_domains', { mode: 'json' }).$type<string[]>().notNull().default([]),
  aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull().default([]),
  country: text('country').notNull(),
  language: text('language').notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  labels: text('labels', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  providers: text('providers', { mode: 'json' }).$type<string[]>().notNull().default([]),
  providerModels: text('provider_models', { mode: 'json' }).$type<ProviderModels>().notNull().default({}),
  measurement: text('measurement_config', { mode: 'json' }).$type<MeasurementConfig>().notNull().default({
    marketingHosts: [],
    brandTerms: [],
    leadEventNames: ['generate_lead'],
  }),
  locations: text('locations', { mode: 'json' }).$type<LocationContext[]>().notNull().default([]),
  defaultLocation: text('default_location'),
  autoExtractBacklinks: integer('auto_extract_backlinks', { mode: 'boolean' }).notNull().default(false),
  configSource: text('config_source').notNull().default('cli'),
  configRevision: integer('config_revision').notNull().default(1),
  icpDescription: text('icp_description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const queries = sqliteTable('queries', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  query: text('query').notNull(),
  provenance: text('provenance'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_queries_project').on(table.projectId),
  uniqueIndex('idx_queries_project_query').on(table.projectId, table.query),
])

export const competitors = sqliteTable('competitors', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
  provenance: text('provenance'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_competitors_project').on(table.projectId),
  uniqueIndex('idx_competitors_project_domain').on(table.projectId, table.domain),
])

// Canonical plan payloads are immutable revisions. The surrogate id gives
// active-plan and run-scope rows a real FK target; revision remains project-local.
export const measurementPlanVersions = sqliteTable('measurement_plan_versions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  canonicalJson: text('canonical_json').notNull(),
  /** Document identity: sha256 over the whole stored document, revision included. */
  checksum: text('checksum').notNull(),
  /** Which decoder reads `canonical_json`. Every row written before v122 is v1. */
  schemaVersion: integer('schema_version').notNull().default(1),
  /**
   * The publish/review guard, and deliberately NOT `checksum`. It is taken over
   * the compiled document with storage ids, timestamps, revision and itself
   * excluded, so the same content at two revisions compares equal — which is
   * what makes a revert expressible at all. Null on every historic v1 row: it
   * was never computed for them, and backfilling one would claim a review that
   * never happened.
   */
  compiledChecksum: text('compiled_checksum'),
  /**
   * Continuity link written at publish time: the superseded active version this
   * revision is measurement-comparable with. Set ONLY when the publish changed
   * nothing about execution — the frozen execution nodes of both revisions are
   * canonically identical — so a run pinned to the linked version answered
   * exactly the questions this revision would ask. A label-only republish
   * therefore keeps serving the previous run instead of blanking the dashboard
   * until the next sweep. Null for the first revision, for every
   * execution-changing publish, and on every historic row.
   */
  comparableToVersionId: text('comparable_to_version_id'),
  publishedBy: text('published_by'),
  sourceDraftId: text('source_draft_id'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_measurement_plan_versions_project_revision').on(table.projectId, table.revision),
  uniqueIndex('idx_measurement_plan_versions_project_id').on(table.projectId, table.id),
  // The DDL orders `revision` DESC on both of these: every read of them wants
  // the newest revision first.
  index('idx_measurement_plan_versions_project_revision_desc').on(table.projectId, table.revision),
  index('idx_measurement_plan_versions_project_schema').on(table.projectId, table.schemaVersion, table.revision),
  // Lookup only, and non-unique on purpose: a unique index here would refuse to
  // publish content identical to an older revision, which is exactly a revert.
  index('idx_measurement_plan_versions_compiled_checksum').on(table.projectId, table.compiledChecksum),
])

/**
 * At most one server-side authoring draft per project. `etag_version` is a
 * monotonic counter rather than a content hash: the ETag must change after
 * every mutation and must not repeat when content returns to a value it already
 * had, which a hash cannot promise.
 */
export const measurementPlanDrafts = sqliteTable('measurement_plan_drafts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  schemaVersion: integer('schema_version').notNull().default(2),
  /** Null when the draft was started from a planless project. */
  baseActiveVersionId: text('base_active_version_id'),
  baseActiveRevision: integer('base_active_revision'),
  /** Authoring intent only — never compiled nodes, usage edges or query snapshots. */
  authoringJson: text('authoring_json').notNull(),
  etagVersion: integer('etag_version').notNull().default(1),
  createdBy: text('created_by').notNull(),
  updatedBy: text('updated_by').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const measurementQuerySets = sqliteTable('measurement_query_sets', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_measurement_query_sets_project_name').on(table.projectId, table.name),
])

/**
 * Ordered references only. Deleting a set drops its rows here and no query:
 * the queries themselves outlive every set and every published snapshot.
 */
export const measurementQuerySetItems = sqliteTable('measurement_query_set_items', {
  id: text('id').primaryKey(),
  querySetId: text('query_set_id').notNull().references(() => measurementQuerySets.id, { onDelete: 'cascade' }),
  queryId: text('query_id').notNull().references(() => queries.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_measurement_query_set_items_set_query').on(table.querySetId, table.queryId),
  index('idx_measurement_query_set_items_order').on(table.querySetId, table.position),
])

/** Authoring asset. Applying one expands concrete project queries; a published plan holds only snapshots. */
export const measurementQueryTemplates = sqliteTable('measurement_query_templates', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  pattern: text('pattern').notNull(),
  variables: text('variables_json', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_measurement_query_templates_project_name').on(table.projectId, table.name),
])

/**
 * The inputs a discovery rerun has to reproduce to be called deterministic.
 * Keyed by the checksum over them so an unchanged sitemap, rule and exclusion
 * set resolves to the row that already exists instead of proposing the same
 * Targets a second time.
 */
export const measurementDiscoveryConfigs = sqliteTable('measurement_discovery_configs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sitemapUrl: text('sitemap_url').notNull(),
  rule: text('rule_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  exclusions: text('exclusions_json', { mode: 'json' }).$type<string[]>().notNull().default([]),
  inputChecksum: text('input_checksum').notNull(),
  /** Same bytes and same rule under a different compiler are a different result. */
  compilerVersion: text('compiler_version').notNull(),
  reviewedAt: text('reviewed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_measurement_discovery_configs_input').on(table.projectId, table.inputChecksum),
  index('idx_measurement_discovery_configs_project').on(table.projectId),
])

/**
 * Idempotency receipts for mutating measurement actions. Nothing deletes a row
 * on the write path, so the expiry index is what the boot-time and periodic
 * sweep uses to keep the table from growing without bound.
 */
export const measurementOperationReceipts = sqliteTable('measurement_operation_receipts', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  operation: text('operation').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  /** Same key with different content is a conflict, not a replay. */
  requestChecksum: text('request_checksum').notNull(),
  responseJson: text('response_json').notNull(),
  statusCode: integer('status_code').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.operation, table.idempotencyKey] }),
  index('idx_measurement_operation_receipts_expires').on(table.expiresAt),
])

// Stable identity only. Labels, memberships, aliases and route matchers remain
// in immutable plan versions so historical attribution cannot drift.
export const measurementSegments = sqliteTable('measurement_segments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  stableKey: text('stable_key').notNull(),
  kind: text('kind').$type<'target' | 'group'>().notNull(),
  /** An explicitly retired identity can never be reassigned to a new segment. */
  retiredAt: text('retired_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_measurement_segments_project_key').on(table.projectId, table.stableKey),
  uniqueIndex('idx_measurement_segments_project_id').on(table.projectId, table.id),
])

// A project only gets this aggregate row once measurement planning is enabled.
// The composite FK prevents an active pointer from crossing project boundaries.
export const measurementPlans = sqliteTable('measurement_plans', {
  projectId: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  activeVersionId: text('active_version_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  foreignKey({
    name: 'measurement_plans_active_version_fk',
    columns: [table.projectId, table.activeVersionId],
    foreignColumns: [measurementPlanVersions.projectId, measurementPlanVersions.id],
  }).onDelete('restrict'),
])

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('answer-visibility'),
  status: text('status').notNull().default('queued'),
  trigger: text('trigger').notNull().default('manual'),
  location: text('location'),
  queries: text('queries', { mode: 'json' }).$type<string[]>(),
  sourceId: text('source_id'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  error: text('error'),
  /**
   * Which version of the project's query set this run measured. Null on runs
   * that predate versioning; analytics treats null as "unversioned" rather than
   * guessing a revision.
  */
  queryBasketRevision: integer('query_basket_revision'),
  // A plan-aware answer-visibility run pins the immutable plan revision used
  // to materialize its execution graph. Planless runs keep both fields null.
  measurementPlanVersionId: text('measurement_plan_version_id'),
  measurementManifest: text('measurement_manifest', { mode: 'json' }).$type<Record<string, unknown>>(),
  // Set only on a spot check: which groups/targets the operator named and the
  // targets they resolved to. Null means the run measured the whole plan, so
  // `IS NOT NULL` is the test for "this run measured a slice".
  measurementScope: text('measurement_scope', { mode: 'json' }).$type<{
    groups: string[]
    targets: string[]
    queries: string[]
    resolvedTargets: string[]
  }>(),
  /**
   * What this run measured WITH: the engines and the models they were pointed
   * at, plus a checksum over both. One plan revision measured under one
   * execution identity is a comparable series; a change of engine or model
   * starts a new series rather than being refused, and charts break at the
   * boundary the same way they break at a revision boundary.
   */
  measurementExecutionIdentity: text('measurement_execution_identity', { mode: 'json' }).$type<{
    schemaVersion: 1
    providers: string[]
    models: Record<string, string>
    checksum: string
  }>(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_runs_project').on(table.projectId),
  // Enables child tables that carry project + run to enforce that the two IDs
  // belong together, rather than trusting a caller-provided project ID.
  uniqueIndex('idx_runs_project_id').on(table.projectId, table.id),
  index('idx_runs_status').on(table.status),
  index('idx_runs_source').on(table.sourceId),
  index('idx_runs_measurement_plan').on(table.projectId, table.measurementPlanVersionId, table.createdAt),
  foreignKey({
    name: 'runs_measurement_plan_version_fk',
    columns: [table.projectId, table.measurementPlanVersionId],
    foreignColumns: [measurementPlanVersions.projectId, measurementPlanVersions.id],
  }),
])

/**
 * The frozen inputs of a simple, planless answer-visibility run. This is a
 * sidecar rather than a `runs` column so historic runs remain absent instead of
 * acquiring a definition they never actually executed. The composite FK makes
 * a copied run id from another project impossible, while a run deletion (and
 * therefore project deletion) removes its capture automatically.
 */
export const simpleMeasurementDefinitions = sqliteTable('simple_measurement_definitions', {
  runId: text('run_id').notNull().primaryKey(),
  projectId: text('project_id').notNull(),
  definition: text('definition', { mode: 'json' }).$type<SimpleMeasurementDefinition>().notNull(),
  checksum: text('checksum').notNull(),
  capturedAt: text('captured_at').notNull(),
}, (table) => [
  index('idx_simple_measurement_definitions_project').on(table.projectId),
  foreignKey({
    name: 'simple_measurement_definitions_project_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('cascade'),
])

/**
 * Immutable snapshots of a project's query set, one row per distinct set.
 * Membership is stored as normalized query text so a query that is removed and
 * re-added rejoins its own history instead of looking new.
 */
export const queryBasketVersions = sqliteTable('query_basket_versions', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  membersJson: text('members_json').notNull(),
  checksum: text('checksum').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.revision] }),
  index('idx_query_basket_checksum').on(table.projectId, table.checksum),
])

export const querySnapshots = sqliteTable('query_snapshots', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  // `query_id` is nullable + `ON DELETE SET NULL` so historical snapshots
  // outlive their queries row. Pre-v58 this FK cascaded — deleting a tracked
  // query (PUT /queries replace, individual delete, `canonry apply` dropping
  // one) silently wiped the entire citation history for that query. With SET
  // NULL the snapshot survives; `queryText` keeps it self-describing when
  // the queries row is gone.
  queryId: text('query_id').references(() => queries.id, { onDelete: 'set null' }),
  queryText: text('query_text'),
  provider: text('provider').notNull().default('gemini'),
  model: text('model'),
  // The model string the PROVIDER reported serving, as distinct from `model`
  // (what we REQUESTED). They diverge routinely: a request for `gpt-5.4` is
  // served by the dated snapshot `gpt-5.4-2026-03-05`. Nullable — historical
  // rows and providers that disclose no model identity (CDP scrapes the web
  // UI) legitimately have none.
  servedModel: text('served_model'),
  citationState: text('citation_state').notNull(),
  answerMentioned: integer('answer_mentioned', { mode: 'boolean' }),
  answerText: text('answer_text'),
  citedDomains: text('cited_domains', { mode: 'json' }).$type<string[]>().notNull().default([]),
  // Flat capture fields are deliberately nullable: historical rows are not
  // backfilled, so all-null means this observation predates URL capture.
  citedUrls: text('cited_urls', { mode: 'json' }).$type<string[]>(),
  captureStatus: text('capture_status').$type<import('@ainyc/canonry-contracts').CitedUrlCaptureStatus>(),
  sourceCount: integer('source_count'),
  resolvedCount: integer('resolved_count'),
  captureVersion: integer('capture_version'),
  // Retrieval is recorded separately from citation capture above: an extraction
  // that completed having found zero sources says nothing about whether a search
  // ran. Nullable because historical rows are not backfilled, so null means the
  // observation predates the field, NOT that retrieval did not happen.
  retrievalStatus: text('retrieval_status').$type<import('@ainyc/canonry-contracts').RetrievalStatus>(),
  retrievalContract: text('retrieval_contract').$type<import('@ainyc/canonry-contracts').RetrievalContract>(),
  /**
   * LEGACY MIXED SIGNAL — never read this for a mention or a citation metric.
   *
   * The run writer unions three different things into it: cited domains,
   * grounding-source hosts, and answer-text brand matches. A count taken from it
   * is therefore neither the citation signal nor the mention signal, and naming
   * it either one reports a number for one signal under the other's name (see
   * AGENTS.md "Vocabulary"). It is also frozen at run time against the competitor
   * set and the alias threshold that existed then, so it drifts from any
   * read-time recomputation as soon as either changes.
   *
   * For citations read `citedDomains`. For mentions match the project/competitor
   * brand aliases against `answerText` with `packages/contracts/src/brand-matching.ts`.
   * The column is retained for the raw results export and historical inspection.
   */
  competitorOverlap: text('competitor_overlap', { mode: 'json' }).$type<string[]>().notNull().default([]),
  recommendedCompetitors: text('recommended_competitors', { mode: 'json' }).$type<string[]>().notNull().default([]),
  location: text('location'),
  measurementExecutionId: text('measurement_execution_id'),
  requestedContext: text('requested_context', { mode: 'json' }).$type<LocationContext>(),
  supportedContext: text('supported_context', { mode: 'json' }).$type<{
    status: 'applied' | 'ignored' | 'browser-implicit' | 'unknown'
    resolved?: LocationContext | null
  }>(),
  screenshotPath: text('screenshot_path'),
  rawResponse: text('raw_response'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_snapshots_run').on(table.runId),
  index('idx_snapshots_query').on(table.queryId),
  index('idx_snapshots_citation_state').on(table.citationState),
  index('idx_snapshots_provider_model').on(table.provider, table.model),
  index('idx_snapshots_location').on(table.location),
  uniqueIndex('idx_snapshots_measurement_slot')
    .on(table.runId, table.measurementExecutionId, table.provider),
  index('idx_snapshots_created_at').on(table.createdAt),
])

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  // SET NULL (not CASCADE) so deleting a project preserves its audit trail.
  // The DELETE /projects route writes a "project.deleted" row immediately
  // before the delete — a CASCADE here would wipe that record before any
  // reader could see it (the deletion would erase the only evidence it
  // happened). Detached rows surface in audit queries with project_id=NULL.
  projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
  // High-level identity of the caller: 'api' for HTTP requests, 'scheduler'
  // for cron-triggered work, 'cli' / 'agent' / 'mcp' for direct DB writes
  // (where applicable). Coarse on purpose — narrower attribution lives in
  // `userAgent` and `actorSession`.
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  diff: text('diff'),
  // User-Agent header from the originating HTTP request, when available.
  // The narrowest reliable signal for "which client did this" — distinguishes
  // CLI (`canonry-cli/X.Y.Z`), dashboard (browser UA), MCP adapter, and
  // external scripts. NULL for non-HTTP writes (scheduler, run-coordinator,
  // direct CLI commands that bypass the API).
  userAgent: text('user_agent'),
  // Optional caller-supplied trace key for cross-request correlation —
  // a session ID, prompt ID, batch ID, etc. The Aero agent populates this
  // with its session id so post-mortems can group a related sequence of
  // mutations. NULL when the caller didn't provide one.
  actorSession: text('actor_session'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_audit_log_project').on(table.projectId),
  index('idx_audit_log_created').on(table.createdAt),
])

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default(['*']),
  /**
   * When set, the key is scoped to a SINGLE project: every project-scoped read
   * or write is gated to this project id (enforced centrally in `auth.ts`).
   * NULL keeps full-instance access — the historical default for every key
   * `canonry init` / `canonry key create` writes. Cascade-deletes with the
   * project so a stale scoped key never outlives its project.
   */
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('idx_api_keys_prefix').on(table.keyPrefix),
  index('idx_api_keys_project').on(table.projectId),
])

/**
 * Named sign-in accounts.
 *
 * An install with no rows here is an install that never asks anyone to sign in
 * — that is the historical behavior and it is preserved exactly. The first row
 * inserted turns sign-in on for the whole install.
 *
 * `password_hash` holds a salted scrypt digest in a self-describing format (see
 * `hashUserPassword`). The plaintext is never stored, never logged, and never
 * leaves the request that carried it.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  /** Display form, as typed at creation. */
  name: text('name').notNull(),
  /** Lower-cased `name`. Unique, so "Sam" and "sam" cannot both exist. */
  nameKey: text('name_key').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<'admin' | 'viewer'>().notNull(),
  createdAt: text('created_at').notNull(),
  lastLoginAt: text('last_login_at'),
})

/**
 * Live sign-in sessions. One row per browser that signed in, so signing out (or
 * deleting the account) ends the session server-side rather than merely asking
 * the browser to forget it.
 *
 * The key is the SHA-256 of the cookie's token, never the token. A session
 * cookie is a bearer credential: stored verbatim, anyone who reads this table —
 * a copied database file, a stray backup, a support export — is holding a live
 * sign-in for as long as it has left. Storing the digest makes the table a
 * record that a session exists rather than a way to become that session. Plain
 * SHA-256 is right here (unlike a password) because the token is 256 bits of
 * randomness, so there is nothing to guess.
 */
export const userSessions = sqliteTable('user_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  index('idx_user_sessions_user').on(table.userId),
  index('idx_user_sessions_expires').on(table.expiresAt),
])

/**
 * OAuth 2.1 clients registered against this instance.
 *
 * Pre-registered only. Dynamic Client Registration (RFC 7591) is deprecated in
 * the current MCP revision and retained there only for backwards compatibility,
 * and the hosts that matter do not need it: Gemini Enterprise has no DCR path
 * at all and wants a client id and secret typed into a form, and ChatGPT keeps
 * predefined clients working. So an operator registers a client explicitly and
 * nothing on the network can mint one.
 */
export const oauthClients = sqliteTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /**
   * scrypt digest, or NULL for a public client that authenticates by PKCE
   * alone. Never the secret: a client secret is a bearer credential, and a
   * copied database file must not be a working client.
   */
  secretHash: text('secret_hash'),
  /** Exact-match allowlist. A redirect_uri not in here is refused. */
  redirectUris: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /**
   * How this client came to exist.
   *
   * `dynamic` means it registered ITSELF over the open RFC 7591 endpoint and
   * chose its own display name — so that name is a claim, not a fact, and the
   * consent page must say so. A client calling itself "Canonry Dashboard"
   * otherwise reads as first-party on the one screen where trust is decided.
   */
  registration: text('registration').$type<'operator' | 'dynamic'>().notNull().default('operator'),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
})

/**
 * In-flight authorization codes. Single use, short lived, and bound to the
 * PKCE challenge plus the resource the client asked for.
 */
export const oauthAuthorizationCodes = sqliteTable('oauth_authorization_codes', {
  /** SHA-256 of the code. The code itself is 256 bits of randomness. */
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  /** S256 only. `plain` is refused at the authorize endpoint, not stored. */
  codeChallenge: text('code_challenge').notNull(),
  /**
   * RFC 8707 resource indicator. Carried from authorize to token and stamped
   * into the token's audience, so a token minted for one MCP endpoint cannot
   * be replayed against another.
   */
  resource: text('resource'),
  scope: text('scope'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_oauth_codes_expires').on(table.expiresAt),
])

/**
 * Issued access and refresh tokens, stored as digests for the same reason
 * `user_sessions` stores a digest: the row records that a token exists, it is
 * not a way to become that token.
 */
export const oauthTokens = sqliteTable('oauth_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  kind: text('kind').$type<'access' | 'refresh'>().notNull(),
  clientId: text('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Audience. Enforced on every resource request. */
  resource: text('resource'),
  scope: text('scope'),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_oauth_tokens_user').on(table.userId),
  index('idx_oauth_tokens_expires').on(table.expiresAt),
])

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Run kind dispatched by this schedule. Must be a value of `RunKinds` —
  // currently 'answer-visibility' and 'traffic-sync' are user-facing schedulable kinds.
  // Defaults to 'answer-visibility' for backward compatibility with rows
  // created before migration 53.
  kind: text('kind').notNull().default('answer-visibility'),
  cronExpr: text('cron_expr').notNull(),
  preset: text('preset'),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  providers: text('providers', { mode: 'json' }).$type<ProviderName[]>().notNull().default([]),
  /** Optional traffic-source UUID for traffic-sync schedules. Null for other kinds. */
  sourceId: text('source_id'),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_schedules_project_kind').on(table.projectId, table.kind),
])

/**
 * Last observed doctor outcome per project, so health alerting is
 * edge-triggered. Without this the scheduled pass would re-notify every day a
 * warning persists, and an operator who learns to ignore the channel is worse
 * than no channel at all.
 */
/**
 * WHAT AN INSIGHT WEBHOOK HAS ALREADY SAID, so it stops saying it.
 *
 * Health is edge-triggered and citations are transition-based, but insight
 * dispatch had no memory: every run recomputed its findings and sent whatever
 * was high or critical. A finding that persists therefore alerted on every run,
 * forever.
 *
 * MEASURED on gjelina-hotel: a GBP keyword drop notified daily at 08:30 for over
 * a month with byte-identical text, because Google publishes GBP keyword data
 * about a month behind, so the comparison window sat at 2026-06 -> 2026-07 while
 * the calendar moved on. The insights table held ONE row for it: the finding was
 * recomputed and re-sent, never re-stored, so nothing in the data showed the
 * repetition.
 *
 * Keyed on the identity of the FINDING, not on the run: same project, type,
 * subject and window is the same news. A changed window, a changed severity or a
 * materially changed magnitude is new news and notifies again.
 */
export const insightNotifyState = sqliteTable('insight_notify_state', {
  /** `${projectId}:${type}:${subject}:${window}` - stable across runs. */
  key: text('key').primaryKey(),
  projectId: text('project_id').notNull(),
  /** Insight type, e.g. `gbp-keyword-drop`. */
  type: text('type').notNull(),
  /** What the finding is about: the keyword, query, or url. */
  subject: text('subject').notNull(),
  /**
   * The finding's identity as text: its title with the magnitude number
   * neutralised, so 79% and 80% of the same drop over the same window are one
   * piece of news, while a window that advances is a different one.
   */
  fingerprint: text('fingerprint').notNull(),
  severity: text('severity').notNull(),
  /** Rounded magnitude, so a drift from 79% to 80% is not treated as new news. */
  magnitude: integer('magnitude'),
  notifiedAt: text('notified_at').notNull(),
})

export const doctorHealthState = sqliteTable('doctor_health_state', {
  projectId: text('project_id').primaryKey(),
  /** Worst check status observed on the last pass: ok | warn | fail. */
  status: text('status').notNull(),
  /** Stable code of the worst check, so a changed cause re-notifies. */
  code: text('code').notNull(),
  summary: text('summary').notNull(),
  checkedAt: text('checked_at').notNull(),
  /** When we last emitted for this (status, code). Null until first emit. */
  notifiedAt: text('notified_at'),
})

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  config: text('config', { mode: 'json' }).$type<{ url: string; events: string[] }>().notNull(),
  webhookSecret: text('webhook_secret'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_notifications_project').on(table.projectId),
])

export const googleConnections = sqliteTable('google_connections', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull(),
  connectionType: text('connection_type').notNull(),
  propertyId: text('property_id'),
  sitemapUrl: text('sitemap_url'),
  scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  // The project that established this connection. Used by the OAuth callback
  // and the DELETE route to refuse cross-project takeover (a malicious caller
  // who points another project at the same `canonicalDomain` cannot overwrite
  // or remove an existing connection owned by the original project). Nullable
  // for legacy rows written before the column existed — those are treated as
  // unowned and the first connect call to claim them succeeds. See root
  // AGENTS.md "Deployment Posture" for the broader multi-tenancy posture.
  createdByProjectId: text('created_by_project_id').references(() => projects.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_google_conn_domain_type').on(table.domain, table.connectionType),
  index('idx_google_conn_project').on(table.createdByProjectId),
])

export const gscSearchData = sqliteTable('gsc_search_data', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  syncRunId: text('sync_run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  query: text('query').notNull(),
  page: text('page').notNull(),
  country: text('country'),
  device: text('device'),
  clicks: integer('clicks').notNull().default(0),
  impressions: integer('impressions').notNull().default(0),
  ctr: text('ctr').notNull().default('0'),
  position: text('position').notNull().default('0'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_gsc_search_project_date').on(table.projectId, table.date),
  index('idx_gsc_search_query').on(table.query),
  index('idx_gsc_search_run').on(table.syncRunId),
])

// Property-level daily totals (no query/page/country/device dimensions). The
// dimensioned `gsc_search_data` rows above OVER-count impressions (the `page`
// dimension fans one SERP into N rows) and UNDER-count clicks (the `query`
// dimension drops Google's anonymized rare queries), so summing them does not
// equal Google's property total. This table stores the un-dimensioned daily
// figure (`dimensions: ['date']`) so the headline totals + daily trend match
// the GSC UI. Per-query / per-page breakdowns still read `gsc_search_data`.
/**
 * The furthest GSC reporting date a project has EVER observed, plus how far the
 * last sync asked.
 *
 * `MAX(date)` over the stored rows is NOT a frontier. Search Analytics omits
 * days with no data, so on a quiet property the observed max walks backward and
 * drags every anchored window back with it — a 30-day window silently slides
 * into the previous month and its totals move. `dataThroughDate` is monotonic
 * (a sync may only advance it), which is what makes it usable as an anchor.
 *
 * `syncedThroughDate` records the ceiling the last sync actually requested, so
 * the gap between the two is attributable: days in
 * `(dataThroughDate, syncedThroughDate]` were asked for and came back empty.
 */
export const gscDataWatermarks = sqliteTable('gsc_data_watermarks', {
  projectId: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  dataThroughDate: text('data_through_date').notNull(),
  syncedThroughDate: text('synced_through_date'),
  updatedAt: text('updated_at').notNull(),
})

export const gscDailyTotals = sqliteTable('gsc_daily_totals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  clicks: integer('clicks').notNull(),
  impressions: integer('impressions').notNull(),
  // Stored as a string like `gscSearchData.position` (parsed to a number on
  // read). CTR is derived (clicks / impressions) and intentionally not stored.
  position: text('position').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_gsc_daily_totals_project_date').on(table.projectId, table.date),
  index('idx_gsc_daily_totals_project').on(table.projectId),
])

/**
 * Per-QUERY daily totals, fetched with `dimensions: ['date', 'query']` — the
 * per-query counterpart to `gsc_daily_totals`.
 *
 * `gsc_search_data` carries the `page` dimension, and one SERP that shows
 * several of the site's URLs becomes several rows there. Summing it by query
 * therefore multiplies impressions by how many of your pages ranked together.
 * Measured on a live property: 80,949 summed vs 48,156 true, +68% overall —
 * but the error is NOT uniform. It is ~0% for single-page queries and ~500%
 * for the brand+category terms where several pages rank on one SERP, which
 * REORDERS a top-queries table rather than merely inflating it.
 *
 * Dropping the `page` dimension makes Google do the dedup, so these rows match
 * the GSC UI's per-query figures, including `position` (Google's own per-query
 * average, which beats any weighting computed here).
 *
 * NOTE ON COMPLETENESS: this is the accurate figure for every query Google
 * NAMES. Google withholds rare queries for privacy, so summing this table
 * still falls short of the property total in `gsc_daily_totals` (48,156 vs
 * 64,365 on the same property). It is a complete list of reported queries, not
 * a decomposition of all traffic — never present it as the latter.
 */
export const gscQueryDailyTotals = sqliteTable('gsc_query_daily_totals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  query: text('query').notNull(),
  clicks: integer('clicks').notNull().default(0),
  impressions: integer('impressions').notNull().default(0),
  /**
   * Stored as a string like `gscSearchData.position` (parsed on read). CTR is
   * derived (clicks / impressions) and intentionally not stored.
   */
  position: text('position').notNull().default('0'),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_gsc_query_daily_totals_project_date_query').on(table.projectId, table.date, table.query),
  index('idx_gsc_query_daily_totals_project_date').on(table.projectId, table.date),
  index('idx_gsc_query_daily_totals_query').on(table.query),
  index('idx_gsc_query_daily_totals_run').on(table.syncRunId),
])

export const gscUrlInspections = sqliteTable('gsc_url_inspections', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  indexingState: text('indexing_state'),
  verdict: text('verdict'),
  coverageState: text('coverage_state'),
  pageFetchState: text('page_fetch_state'),
  robotsTxtState: text('robots_txt_state'),
  crawlTime: text('crawl_time'),
  lastCrawlResult: text('last_crawl_result'),
  isMobileFriendly: integer('is_mobile_friendly', { mode: 'boolean' }),
  richResults: text('rich_results', { mode: 'json' }).$type<string[]>().notNull().default([]),
  referringUrls: text('referring_urls', { mode: 'json' }).$type<string[]>().notNull().default([]),
  inspectedAt: text('inspected_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_gsc_inspect_project_url').on(table.projectId, table.url),
  index('idx_gsc_inspect_run').on(table.syncRunId),
  index('idx_gsc_inspect_url_time').on(table.url, table.inspectedAt),
])

export const gscCoverageSnapshots = sqliteTable('gsc_coverage_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  indexed: integer('indexed').notNull().default(0),
  notIndexed: integer('not_indexed').notNull().default(0),
  /**
   * Pages we have no evidence either way for: no impressions in the window and
   * never inspected. Deliberately NOT folded into `notIndexed` — absence of
   * impressions is not evidence of exclusion, and collapsing the two would
   * report every unmeasured page as a problem.
   */
  unknownPages: integer('unknown_pages').notNull().default(0),
  /** Of the above, how many carry a real URL Inspection verdict. */
  verifiedByInspection: integer('verified_by_inspection').notNull().default(0),
  /** Pages proven indexed by impressions alone, costing no inspection quota. */
  derivedFromImpressions: integer('derived_from_impressions').notNull().default(0),
  reasonBreakdown: text('reason_breakdown', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_gsc_coverage_snap_project_date').on(table.projectId, table.date),
  index('idx_gsc_coverage_snap_run').on(table.syncRunId),
])

/**
 * Technical AEO — per-run summary of a `site-audit` run. One row per completed
 * (or partial) site audit; drives the score hero, the per-factor scorecard, and
 * the aggregate-score trend. JSON columns use native `mode: 'json'`.
 */
export const siteAuditSnapshots = sqliteTable('site_audit_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  sitemapUrl: text('sitemap_url').notNull(),
  auditedAt: text('audited_at').notNull(),
  aggregateScore: integer('aggregate_score').notNull().default(0),
  pagesDiscovered: integer('pages_discovered').notNull().default(0),
  pagesAudited: integer('pages_audited').notNull().default(0),
  pagesSkipped: integer('pages_skipped').notNull().default(0),
  pagesErrored: integer('pages_errored').notNull().default(0),
  factorAverages: text('factor_averages', { mode: 'json' }).$type<SiteAuditFactorSummaryDto[]>().notNull().default([]),
  crossCuttingIssues: text('cross_cutting_issues', { mode: 'json' }).$type<SiteAuditCrossCuttingIssueDto[]>().notNull().default([]),
  prioritizedFixes: text('prioritized_fixes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_site_audit_snap_project_created').on(table.projectId, table.createdAt),
  index('idx_site_audit_snap_run').on(table.runId),
])

/**
 * Technical AEO — per-page breakdown of a `site-audit` run. One row per audited
 * URL; `status='error'` rows carry an `error` and no factors. Findings /
 * recommendations are rolled up at the site level (snapshot) rather than stored
 * per page, so `factors` holds only the per-factor scores.
 */
export const siteAuditPages = sqliteTable('site_audit_pages', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  overallScore: integer('overall_score').notNull().default(0),
  status: text('status').notNull(),
  error: text('error'),
  factors: text('factors', { mode: 'json' }).$type<SiteAuditPageFactorDto[]>().notNull().default([]),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_site_audit_pages_run').on(table.runId),
  index('idx_site_audit_pages_project_score').on(table.projectId, table.overallScore),
])

/**
 * Production identity for a queued site crawl. It exists before an attempt so
 * an identical request can reuse an active run while a different request gets
 * an explicit conflict instead of silently inheriting the wrong crawl.
 */
export const siteCrawlRunRequests = sqliteTable('site_crawl_run_requests', {
  runId: text('run_id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  identityKey: text('identity_key').notNull(),
  effectiveOptions: text('effective_options', { mode: 'json' }).$type<SiteAuditEffectiveRequest>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_site_crawl_run_requests_project').on(table.projectId, table.runId),
  foreignKey({
    name: 'site_crawl_run_requests_project_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('cascade'),
])

/**
 * A crawl attempt is a durable event checkpoint for one site-audit run.
 * `project_id + run_id` is a real FK to runs, so an attempt cannot be attached
 * to a run owned by a different project.
 */
export const siteCrawlAttempts = sqliteTable('site_crawl_attempts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  state: text('state').notNull().default('queued'),
  lastEventSequence: integer('last_event_sequence').notNull().default(0),
  lastEventChecksum: text('last_event_checksum'),
  pagesDiscovered: integer('pages_discovered').notNull().default(0),
  pagesFetched: integer('pages_fetched').notNull().default(0),
  pagesEligible: integer('pages_eligible').notNull().default(0),
  pagesErrored: integer('pages_errored').notNull().default(0),
  edgesDiscovered: integer('edges_discovered').notNull().default(0),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_attempts_run_number').on(table.runId, table.attemptNumber),
  uniqueIndex('idx_site_crawl_attempts_project_run_id').on(table.projectId, table.runId, table.id),
  index('idx_site_crawl_attempts_project_run').on(table.projectId, table.runId),
  foreignKey({
    name: 'site_crawl_attempts_project_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('cascade'),
])

/**
 * One immutable crawl summary per site-audit run. It deliberately lives beside
 * (rather than inside) the legacy scorecard tables so old score/pages/trend
 * consumers preserve their historic semantics.
 */
export const siteCrawlSnapshots = sqliteTable('site_crawl_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id'),
  rootUrl: text('root_url').notNull(),
  /** Original requested crawl root; null for snapshots written before v128. */
  requestedRootUrl: text('requested_root_url'),
  crawlSchemaVersion: text('crawl_schema_version').notNull().default('1.0'),
  engineVersion: text('engine_version').notNull().default(''),
  normalizationVersion: text('normalization_version').notNull().default(''),
  indexabilityVersion: text('indexability_version').notNull().default(''),
  linkScoreVersion: text('link_score_version').notNull().default(''),
  effectiveOptions: text('effective_options', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  pageBudget: integer('page_budget'),
  edgeBudget: integer('edge_budget'),
  maxDepth: integer('max_depth'),
  checkDeadLinks: integer('check_dead_links', { mode: 'boolean' }).notNull().default(false),
  complete: integer('complete', { mode: 'boolean' }).notNull().default(false),
  termination: text('termination').notNull().default('unknown'),
  detailsAvailable: integer('details_available', { mode: 'boolean' }).notNull().default(false),
  pagesDiscovered: integer('pages_discovered').notNull().default(0),
  pagesFetched: integer('pages_fetched').notNull().default(0),
  pagesEligible: integer('pages_eligible').notNull().default(0),
  pagesErrored: integer('pages_errored').notNull().default(0),
  edgesDiscovered: integer('edges_discovered').notNull().default(0),
  findingsCount: integer('findings_count').notNull().default(0),
  deadLinkState: text('dead_link_state').notNull().default('disabled'),
  deadLinksChecked: integer('dead_links_checked').notNull().default(0),
  deadLinksFound: integer('dead_links_found').notNull().default(0),
  /**
   * Internal link targets the crawler could not fetch at all, so their state is
   * unknown. These are NOT dead links and are excluded from both `found` and
   * `deadLinksChecked` — a timeout or a connection reset under crawl
   * concurrency says nothing about the URL, and reporting one as broken put
   * fabricated findings in front of clients.
   */
  deadLinksUnverified: integer('dead_links_unverified').notNull().default(0),
  /**
   * Whether nav/header/footer link detection ran for this scan, and if not,
   * why. NULL means the scan predates detection, which reads report as
   * `unavailable-legacy-scan` rather than letting an empty template-link list
   * pass for "this site has no nav".
   */
  templateDetection: text('template_detection'),
  /**
   * The crawler's landmark ruleset version, from the crawl summary's
   * `linkPlacementRulesetVersion`. NULL means this scan recorded no placement
   * at all, which is the one thing that decides whether its links could be
   * classified by where they sit or only by how often they repeat. It cannot be
   * backfilled: a pre-4.7.0 crawl never observed placement.
   */
  linkPlacementRulesetVersion: text('link_placement_ruleset_version'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_snapshots_run').on(table.runId),
  index('idx_site_crawl_snapshots_project_created').on(table.projectId, table.createdAt),
  foreignKey({
    name: 'site_crawl_snapshots_project_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'site_crawl_snapshots_attempt_fk',
    columns: [table.projectId, table.runId, table.attemptId],
    foreignColumns: [siteCrawlAttempts.projectId, siteCrawlAttempts.runId, siteCrawlAttempts.id],
  }),
])

/** One canonical crawl node/page, scoped to the exact attempt that observed it. */
export const siteCrawlPages = sqliteTable('site_crawl_pages', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  nodeKey: text('node_key').notNull(),
  url: text('url').notNull(),
  path: text('path').notNull(),
  parentPath: text('parent_path').notNull(),
  discoverySource: text('discovery_source').notNull().default('crawl'),
  discoveryProvenance: text('discovery_provenance', { mode: 'json' }).$type<Record<string, unknown>[]>().notNull().default([]),
  sitemapMetadata: text('sitemap_metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  fetchState: text('fetch_state').notNull().default('queued'),
  fetchedAt: text('fetched_at'),
  httpStatus: integer('http_status'),
  contentType: text('content_type'),
  finalUrl: text('final_url'),
  redirectChain: text('redirect_chain', { mode: 'json' }).$type<string[]>().notNull().default([]),
  directives: text('directives', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  canonicalUrl: text('canonical_url'),
  canonicalNodeKey: text('canonical_node_key'),
  indexabilityState: text('indexability_state').notNull().default('unknown'),
  indexabilityReasons: text('indexability_reasons', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /**
   * Derived Site Health state, computed once at publish time by the contract's
   * `deriveSiteHealthState`. Stored so reads can filter on an index instead of
   * materializing every page row; NULL means a snapshot published before this
   * column existed, which reads must report rather than treat as a state.
   */
  healthState: text('health_state'),
  auditState: text('audit_state').notNull().default('pending'),
  auditScore: real('audit_score'),
  auditFields: text('audit_fields', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  inventoryEligible: integer('inventory_eligible', { mode: 'boolean' }).notNull().default(false),
  depth: integer('depth'),
  inboundUniqueEdges: integer('inbound_unique_edges').notNull().default(0),
  outboundUniqueEdges: integer('outbound_unique_edges').notNull().default(0),
  inboundOccurrences: integer('inbound_occurrences').notNull().default(0),
  outboundOccurrences: integer('outbound_occurrences').notNull().default(0),
  linkScoreRaw: real('link_score_raw'),
  linkScoreNormalized: real('link_score_normalized'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_pages_attempt_node').on(table.projectId, table.runId, table.attemptId, table.nodeKey),
  index('idx_site_crawl_pages_read').on(table.projectId, table.runId, table.attemptId, table.inventoryEligible, table.auditScore, table.url),
  index('idx_site_crawl_pages_parent').on(table.projectId, table.runId, table.attemptId, table.parentPath, table.path),
  index('idx_site_crawl_pages_url').on(table.projectId, table.runId, table.attemptId, table.url),
  index('idx_site_crawl_pages_health').on(table.projectId, table.runId, table.attemptId, table.healthState, table.path, table.nodeKey),
  // The in-progress Page Health preview reads only completed audits below its
  // threshold, ordered worst-first. Keep its stable tie-breaker in the index
  // so a growing crawl never needs a transient sort before its small limit.
  index('idx_site_crawl_pages_live_preview').on(table.projectId, table.runId, table.attemptId, table.auditState, table.auditScore, table.nodeKey),
  foreignKey({
    name: 'site_crawl_pages_attempt_fk',
    columns: [table.projectId, table.runId, table.attemptId],
    foreignColumns: [siteCrawlAttempts.projectId, siteCrawlAttempts.runId, siteCrawlAttempts.id],
  }).onDelete('cascade'),
])

/** Bounded, canonical internal-link observations. */
export const siteCrawlEdges = sqliteTable('site_crawl_edges', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  edgeKey: text('edge_key').notNull(),
  sourceNodeKey: text('source_node_key').notNull(),
  sourceUrl: text('source_url').notNull(),
  targetNodeKey: text('target_node_key'),
  targetUrl: text('target_url').notNull(),
  relation: text('relation').notNull().default('link'),
  internal: integer('internal', { mode: 'boolean' }).notNull().default(true),
  followable: integer('followable', { mode: 'boolean' }).notNull().default(true),
  occurrences: integer('occurrences').notNull().default(1),
  followableOccurrences: integer('followable_occurrences').notNull().default(1),
  nofollowOccurrences: integer('nofollow_occurrences').notNull().default(0),
  anchors: text('anchors', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /**
   * True for a nav, header, or footer link rather than an editorial one.
   * Computed once at publish time by the contract's `classifyTemplateLinkEdge`,
   * so the map, the API filters, and the agents all read the same decision.
   *
   * The rule is DOM placement where the crawl recorded it: any occurrence
   * inside a main or article landmark makes the whole link editorial, and
   * navigation with no content occurrence makes it chrome. Where the page
   * declares no landmark that answers the question, `template_ratio` below is
   * the fallback.
   *
   * Classification writes a STRICT BOOLEAN and never a NULL. A link no rule
   * could measure is a real `false` whose `templateSource` reads `unmeasured`,
   * because "not shown to be chrome" is what a content link means here. A third
   * stored state would be invisible to every reader that treats this as a
   * boolean (the layout input, the graph sample, the totals, the map legend,
   * the inspector tiles) while only the two SQL link filters honoured it, and
   * one definition of a content link is the whole point of the column.
   *
   * NULL therefore means exactly one thing: this row predates classification
   * entirely, which reads report as `unavailable-legacy-scan`. It never means
   * "not a template link".
   */
  isTemplate: integer('is_template', { mode: 'boolean' }),
  /**
   * Share of fetched pages carrying this link's LEAST ubiquitous anchor. NULL
   * when the link has no measurable pair (an unresolved target or no anchor)
   * OR when DOM placement decided it, because it is the fallback rule's own
   * evidence and had no vote.
   */
  templateRatio: real('template_ratio'),
  /**
   * Occurrences of this link split by where they sat in the source page, from
   * the crawler's `placementOccurrences`. NULL means this scan recorded no
   * placement for this link, which is a real state (a pre-4.7.0 crawl) and
   * never zeros: `{0, 0, 0}` is what a redirect or canonical edge legitimately
   * carries, since a non-anchor edge has no position in a page.
   */
  placementNavigationOccurrences: integer('placement_navigation_occurrences'),
  placementContentOccurrences: integer('placement_content_occurrences'),
  placementUnknownOccurrences: integer('placement_unknown_occurrences'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_edges_attempt_key').on(table.projectId, table.runId, table.attemptId, table.edgeKey),
  index('idx_site_crawl_edges_outbound').on(table.projectId, table.runId, table.attemptId, table.sourceNodeKey, table.edgeKey),
  index('idx_site_crawl_edges_inbound').on(table.projectId, table.runId, table.attemptId, table.targetNodeKey, table.edgeKey),
  index('idx_site_crawl_edges_source_url').on(table.projectId, table.runId, table.attemptId, table.sourceUrl),
  index('idx_site_crawl_edges_target_url').on(table.projectId, table.runId, table.attemptId, table.targetUrl),
  // Backs the `linkKind` filter on the internal-link reads, whose ORDER BY is
  // the trailing edge key, so a filtered page terminates at LIMIT instead of
  // sorting every match in a temp b-tree.
  index('idx_site_crawl_edges_template').on(
    table.projectId,
    table.runId,
    table.attemptId,
    table.internal,
    table.isTemplate,
    table.edgeKey,
  ),
  // Publish-time graph sampling filters this exact scope and consumes the
  // highest-occurrence internal anchors first. The mixed-direction suffix
  // avoids a million-row temporary ORDER BY at the maximum crawl budget.
  index('idx_site_crawl_edges_graph_sample').on(
    table.projectId,
    table.runId,
    table.attemptId,
    table.internal,
    table.relation,
    sql`${table.occurrences} desc`,
    table.edgeKey,
  ),
  foreignKey({
    name: 'site_crawl_edges_attempt_fk',
    columns: [table.projectId, table.runId, table.attemptId],
    foreignColumns: [siteCrawlAttempts.projectId, siteCrawlAttempts.runId, siteCrawlAttempts.id],
  }).onDelete('cascade'),
])

/**
 * One immutable, publish-time graph layout per crawl attempt. Keeping layout
 * metadata separate from crawl pages makes the visualization optional: legacy
 * snapshots have no row and remain fully readable without nullable x/y fields
 * contaminating the canonical URL inventory.
 */
export const siteCrawlGraphLayouts = sqliteTable('site_crawl_graph_layouts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  state: text('state').notNull(),
  layoutVersion: text('layout_version'),
  failureCode: text('failure_code'),
  totalNodes: integer('total_nodes').notNull().default(0),
  totalEdges: integer('total_edges').notNull().default(0),
  /** Share of `totalEdges` classified as nav, header, or footer links. */
  totalTemplateEdges: integer('total_template_edges').notNull().default(0),
  nodeCount: integer('node_count').notNull().default(0),
  edgeCount: integer('edge_count').notNull().default(0),
  /**
   * True when template links were kept out of the ForceAtlas2 physics, so
   * these positions describe content structure. Layouts published before
   * template detection keep `false`: the migration classifies their links, but
   * it deliberately does not rewrite immutable coordinates.
   */
  templateLinksExcluded: integer('template_links_excluded', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_graph_layouts_attempt').on(table.projectId, table.runId, table.attemptId),
  index('idx_site_crawl_graph_layouts_run').on(table.projectId, table.runId),
  check('site_crawl_graph_layouts_state_check', sql`${table.state} in ('ready', 'unavailable')`),
  foreignKey({
    name: 'site_crawl_graph_layouts_attempt_fk',
    columns: [table.projectId, table.runId, table.attemptId],
    foreignColumns: [siteCrawlAttempts.projectId, siteCrawlAttempts.runId, siteCrawlAttempts.id],
  }).onDelete('cascade'),
])

/** Persisted ForceAtlas2 coordinates for only the bounded graph sample. */
export const siteCrawlGraphNodes = sqliteTable('site_crawl_graph_nodes', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  nodeKey: text('node_key').notNull(),
  sampleRank: integer('sample_rank').notNull(),
  x: real('x').notNull(),
  y: real('y').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_graph_nodes_attempt_node').on(table.projectId, table.runId, table.attemptId, table.nodeKey),
  uniqueIndex('idx_site_crawl_graph_nodes_attempt_rank').on(table.projectId, table.runId, table.attemptId, table.sampleRank),
  index('idx_site_crawl_graph_nodes_read').on(table.projectId, table.runId, table.attemptId, table.sampleRank),
  check('site_crawl_graph_nodes_rank_check', sql`${table.sampleRank} >= 0`),
  foreignKey({
    name: 'site_crawl_graph_nodes_layout_fk',
    columns: [table.projectId, table.runId, table.attemptId],
    foreignColumns: [siteCrawlGraphLayouts.projectId, siteCrawlGraphLayouts.runId, siteCrawlGraphLayouts.attemptId],
  }).onDelete('cascade'),
  foreignKey({
    name: 'site_crawl_graph_nodes_page_fk',
    columns: [table.projectId, table.runId, table.attemptId, table.nodeKey],
    foreignColumns: [siteCrawlPages.projectId, siteCrawlPages.runId, siteCrawlPages.attemptId, siteCrawlPages.nodeKey],
  }).onDelete('cascade'),
])

/** The exact bounded edge sample consumed by ForceAtlas2 and the renderer. */
export const siteCrawlGraphEdges = sqliteTable('site_crawl_graph_edges', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  edgeKey: text('edge_key').notNull(),
  sampleRank: integer('sample_rank').notNull(),
  sourceNodeKey: text('source_node_key').notNull(),
  targetNodeKey: text('target_node_key').notNull(),
  followable: integer('followable', { mode: 'boolean' }).notNull(),
  occurrences: integer('occurrences').notNull(),
  /**
   * Denormalized from `site_crawl_edges` the same way `followable` and
   * `occurrences` are, so a bounded map read never joins the full link table.
   * Template links stay IN the sample: the map hides them by default, and a
   * viewer switching them on must not trigger a refetch or a re-layout.
   */
  isTemplate: integer('is_template', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_graph_edges_attempt_edge').on(table.projectId, table.runId, table.attemptId, table.edgeKey),
  uniqueIndex('idx_site_crawl_graph_edges_attempt_rank').on(table.projectId, table.runId, table.attemptId, table.sampleRank),
  index('idx_site_crawl_graph_edges_read').on(table.projectId, table.runId, table.attemptId, table.sampleRank),
  // These FKs otherwise make a layout cascade scan graph edges once per node.
  index('idx_site_crawl_graph_edges_source_node').on(table.projectId, table.runId, table.attemptId, table.sourceNodeKey),
  index('idx_site_crawl_graph_edges_target_node').on(table.projectId, table.runId, table.attemptId, table.targetNodeKey),
  check('site_crawl_graph_edges_rank_check', sql`${table.sampleRank} >= 0`),
  check('site_crawl_graph_edges_occurrences_check', sql`${table.occurrences} > 0`),
  foreignKey({
    name: 'site_crawl_graph_edges_layout_fk',
    columns: [table.projectId, table.runId, table.attemptId],
    foreignColumns: [siteCrawlGraphLayouts.projectId, siteCrawlGraphLayouts.runId, siteCrawlGraphLayouts.attemptId],
  }).onDelete('cascade'),
  foreignKey({
    name: 'site_crawl_graph_edges_source_node_fk',
    columns: [table.projectId, table.runId, table.attemptId, table.sourceNodeKey],
    foreignColumns: [siteCrawlGraphNodes.projectId, siteCrawlGraphNodes.runId, siteCrawlGraphNodes.attemptId, siteCrawlGraphNodes.nodeKey],
  }).onDelete('cascade'),
  foreignKey({
    name: 'site_crawl_graph_edges_target_node_fk',
    columns: [table.projectId, table.runId, table.attemptId, table.targetNodeKey],
    foreignColumns: [siteCrawlGraphNodes.projectId, siteCrawlGraphNodes.runId, siteCrawlGraphNodes.attemptId, siteCrawlGraphNodes.nodeKey],
  }).onDelete('cascade'),
  foreignKey({
    name: 'site_crawl_graph_edges_canonical_edge_fk',
    columns: [table.projectId, table.runId, table.attemptId, table.edgeKey],
    foreignColumns: [siteCrawlEdges.projectId, siteCrawlEdges.runId, siteCrawlEdges.attemptId, siteCrawlEdges.edgeKey],
  }).onDelete('cascade'),
])

/** Deterministic findings; `dead-link` rows are written only when opted in. */
export const siteCrawlFindings = sqliteTable('site_crawl_findings', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  findingKey: text('finding_key').notNull(),
  findingType: text('finding_type').notNull(),
  severity: text('severity').notNull().default('info'),
  sourceNodeKey: text('source_node_key'),
  sourceUrl: text('source_url'),
  targetNodeKey: text('target_node_key'),
  targetUrl: text('target_url'),
  evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_findings_attempt_key').on(table.projectId, table.runId, table.attemptId, table.findingKey),
  index('idx_site_crawl_findings_type').on(table.projectId, table.runId, table.attemptId, table.findingType, table.findingKey),
  foreignKey({
    name: 'site_crawl_findings_attempt_fk',
    columns: [table.projectId, table.runId, table.attemptId],
    foreignColumns: [siteCrawlAttempts.projectId, siteCrawlAttempts.runId, siteCrawlAttempts.id],
  }).onDelete('cascade'),
])

/**
 * One receipt per logical event. The uniqueness key intentionally excludes
 * checksum: retry handlers read it and reject a same-event different payload.
 */
export const siteCrawlEventReceipts = sqliteTable('site_crawl_event_receipts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  sequence: integer('sequence').notNull(),
  batchId: text('batch_id').notNull(),
  checksum: text('checksum').notNull(),
  receipt: text('receipt', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_site_crawl_receipts_attempt_event').on(table.attemptId, table.sequence, table.batchId),
  index('idx_site_crawl_receipts_project_run').on(table.projectId, table.runId, table.attemptId),
  foreignKey({
    name: 'site_crawl_receipts_attempt_fk',
    columns: [table.projectId, table.runId, table.attemptId],
    foreignColumns: [siteCrawlAttempts.projectId, siteCrawlAttempts.runId, siteCrawlAttempts.id],
  }).onDelete('cascade'),
])

export const bingCoverageSnapshots = sqliteTable('bing_coverage_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  indexed: integer('indexed').notNull().default(0),
  notIndexed: integer('not_indexed').notNull().default(0),
  unknown: integer('unknown').notNull().default(0),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_bing_coverage_snap_project_date_unique').on(table.projectId, table.date),
  index('idx_bing_coverage_snap_run').on(table.syncRunId),
])

export const bingConnections = sqliteTable('bing_connections', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull(),
  siteUrl: text('site_url'),
  // Same takeover-prevention column as `google_connections.createdByProjectId`.
  // The Bing connect / disconnect routes refuse cross-project writes when an
  // existing row's owner doesn't match. Null for legacy rows (treated as
  // unowned).
  createdByProjectId: text('created_by_project_id').references(() => projects.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_bing_conn_domain').on(table.domain),
  index('idx_bing_conn_project').on(table.createdByProjectId),
])

export const bingUrlInspections = sqliteTable('bing_url_inspections', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  httpCode: integer('http_code'),
  inIndex: integer('in_index', { mode: 'boolean' }),
  lastCrawledDate: text('last_crawled_date'),
  inIndexDate: text('in_index_date'),
  inspectedAt: text('inspected_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  documentSize: integer('document_size'),
  anchorCount: integer('anchor_count'),
  discoveryDate: text('discovery_date'),
}, (table) => [
  index('idx_bing_inspect_project_url').on(table.projectId, table.url),
  index('idx_bing_inspect_url_time').on(table.url, table.inspectedAt),
  index('idx_bing_inspect_run').on(table.syncRunId),
])

export const bingKeywordStats = sqliteTable('bing_keyword_stats', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  query: text('query').notNull(),
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  ctr: text('ctr').notNull().default('0'),
  averagePosition: text('average_position').notNull().default('0'),
  syncedAt: text('synced_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_bing_keyword_project').on(table.projectId),
  index('idx_bing_keyword_query').on(table.query),
])

export const gaConnections = sqliteTable('ga_connections', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  propertyId: text('property_id').notNull(),
  clientEmail: text('client_email').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ga_conn_project').on(table.projectId),
])

export const gaTrafficSnapshots = sqliteTable('ga_traffic_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  landingPage: text('landing_page').notNull(),
  /**
   * Canonicalized form of `landingPage` produced by `normalizeUrlPath()` in
   * `@ainyc/canonry-contracts`. Nullable so existing rows survive migration;
   * new GA4 sync writes populate it. Per-page aggregations should
   * `GROUP BY COALESCE(landing_page_normalized, landing_page)` so
   * partially-backfilled state still aggregates correctly.
   */
  landingPageNormalized: text('landing_page_normalized'),
  sessions: integer('sessions').notNull().default(0),
  organicSessions: integer('organic_sessions').notNull().default(0),
  /**
   * Per-page Direct channel sessions. Nullable so existing rows survive
   * the migration; new GA4 sync writes populate it. Distinct from
   * `sessions - organicSessions` because that residual lumps Direct
   * together with social, referral, paid, and email.
   */
  directSessions: integer('direct_sessions'),
  users: integer('users').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
}, (table) => [
  index('idx_ga_traffic_project_date').on(table.projectId, table.date),
  index('idx_ga_traffic_page').on(table.landingPage),
  index('idx_ga_traffic_page_normalized').on(table.projectId, table.date, table.landingPageNormalized),
  index('idx_ga_traffic_run').on(table.syncRunId),
])

/**
 * Property-level GA4 totals for one day, fetched with NO landing-page
 * dimension — the daily counterpart to `ga_summaries`' windowed totals.
 *
 * Exists because `users` is not additive across a dimension: one visitor who
 * lands on three pages is ONE user but appears in three `ga_traffic_snapshots`
 * rows, so `SUM(users) GROUP BY date` overcounts (a real project showed 192 vs
 * GA's 158 for a single day). GA does the dedup when the report carries only
 * the date dimension, so these rows match the GA UI.
 *
 * `sessions` comes back in the same response and is stored alongside, so the
 * property-level session count is available without a second fetch. Nothing
 * reads it yet: sessions ARE additive (GA4 attributes one landing page per
 * session), so the landing-page sum is already correct for them and carries
 * the organic split this table does not. Same shape as `gsc_daily_totals`.
 */
export const gaDailyTotals = sqliteTable('ga_daily_totals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  sessions: integer('sessions').notNull().default(0),
  users: integer('users').notNull().default(0),
  /**
   * GA4's `engagementRate` for the day (0-1), requested directly from the Data
   * API. Nullable, with no default: every row written before the metric was
   * added has no reading, and defaulting to 0 would report a real "nobody
   * engaged" day for the whole pre-migration period.
   */
  engagementRate: real('engagement_rate'),
  /**
   * GA4's `newUsers` for the day. Nullable: rows written before this column
   * existed have no reading, and a 0 would read as a real "no new users" day.
   *
   * Stored on its own merit. It is NOT an input to a returning-users figure:
   * a visitor can be first-seen and return inside the same range, so
   * `users - newUsers` does not reconstruct one. That needs the
   * `newVsReturning` dimension.
   */
  newUsers: integer('new_users'),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ga_daily_totals_project_date').on(table.projectId, table.date),
  index('idx_ga_daily_totals_project').on(table.projectId),
  index('idx_ga_daily_totals_run').on(table.syncRunId),
])

export const gaAcquisitionDaily = sqliteTable('ga_acquisition_daily', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  channelGroup: text('channel_group').notNull(),
  source: text('source').notNull(),
  medium: text('medium').notNull(),
  hostName: text('host_name').notNull(),
  landingPage: text('landing_page').notNull(),
  landingPageNormalized: text('landing_page_normalized'),
  sessions: integer('sessions').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ga_acquisition_daily_grain').on(
    table.projectId,
    table.date,
    table.channelGroup,
    table.source,
    table.medium,
    table.hostName,
    table.landingPage,
  ),
  index('idx_ga_acquisition_daily_project_date').on(table.projectId, table.date),
  index('idx_ga_acquisition_daily_project_channel').on(table.projectId, table.date, table.channelGroup),
  index('idx_ga_acquisition_daily_project_page').on(table.projectId, table.date, table.landingPageNormalized),
  check('chk_ga_acquisition_daily_sessions', sql`${table.sessions} >= 0`),
])

export const gaLeadEventsDaily = sqliteTable('ga_lead_events_daily', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  eventName: text('event_name').notNull(),
  channelGroup: text('channel_group').notNull(),
  source: text('source').notNull(),
  medium: text('medium').notNull(),
  hostName: text('host_name').notNull(),
  landingPage: text('landing_page').notNull(),
  landingPageNormalized: text('landing_page_normalized'),
  attributionScope: text('attribution_scope').$type<GaLeadAttributionScope>().notNull(),
  eventCount: integer('event_count').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ga_lead_events_daily_grain').on(
    table.projectId,
    table.date,
    table.eventName,
    table.channelGroup,
    table.source,
    table.medium,
    table.hostName,
    table.landingPage,
    table.attributionScope,
  ),
  index('idx_ga_lead_events_daily_project_date').on(table.projectId, table.date),
  index('idx_ga_lead_events_daily_project_channel').on(table.projectId, table.date, table.channelGroup),
  index('idx_ga_lead_events_daily_project_event').on(table.projectId, table.date, table.eventName),
  index('idx_ga_lead_events_daily_project_page').on(table.projectId, table.date, table.landingPageNormalized),
  check('chk_ga_lead_events_daily_count', sql`${table.eventCount} >= 0`),
  check(
    'chk_ga_lead_events_daily_scope',
    sql`${table.attributionScope} IN ('landing-page', 'channel')`,
  ),
])

export const gaMeasurementSyncStates = sqliteTable('ga_measurement_sync_state', {
  projectId: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  acquisitionStatus: text('acquisition_status').$type<GaMeasurementComponentStatus>()
    .notNull().default('never-synced'),
  acquisitionError: text('acquisition_error'),
  acquisitionSyncedAt: text('acquisition_synced_at'),
  leadStatus: text('lead_status').$type<GaMeasurementComponentStatus>()
    .notNull().default('never-synced'),
  leadError: text('lead_error'),
  leadSyncedAt: text('lead_synced_at'),
  leadAttributionScope: text('lead_attribution_scope').$type<GaLeadAttributionScope>(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check(
    'chk_ga_measurement_sync_acquisition_status',
    sql`${table.acquisitionStatus} IN ('never-synced', 'ready', 'error')`,
  ),
  check(
    'chk_ga_measurement_sync_lead_status',
    sql`${table.leadStatus} IN ('never-synced', 'ready', 'error')`,
  ),
  check(
    'chk_ga_measurement_sync_lead_scope',
    sql`${table.leadAttributionScope} IS NULL OR ${table.leadAttributionScope} IN ('landing-page', 'channel')`,
  ),
])

export const gaAiReferrals = sqliteTable('ga_ai_referrals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  source: text('source').notNull(),
  medium: text('medium').notNull(),
  trafficClass: text('traffic_class').$type<AiReferralTrafficClass>().notNull().default('organic'),
  /** Which GA4 dimension produced this row: 'session' | 'first_user' | 'manual_utm' */
  sourceDimension: text('source_dimension').notNull().default('session'),
  /** GA4 default channel group for the session (e.g. 'Referral', 'Organic Social'). */
  channelGroup: text('channel_group').notNull().default('(not set)'),
  landingPage: text('landing_page').notNull().default('(not set)'),
  landingPageNormalized: text('landing_page_normalized'),
  sessions: integer('sessions').notNull().default(0),
  users: integer('users').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
}, (table) => [
  index('idx_ga_ai_ref_project_date').on(table.projectId, table.date),
  index('idx_ga_ai_ref_source').on(table.source),
  index('idx_ga_ai_ref_landing_page').on(table.projectId, table.date, table.landingPageNormalized),
  index('idx_ga_ai_ref_traffic_class').on(table.projectId, table.date, table.trafficClass),
  uniqueIndex('idx_ga_ai_ref_unique_v4').on(table.projectId, table.date, table.source, table.medium, table.sourceDimension, table.channelGroup, table.landingPage),
  index('idx_ga_ai_ref_run').on(table.syncRunId),
])

// Social media referral traffic from GA4 — uses GA4's native sessionDefaultChannelGroup
// to classify social traffic rather than hardcoded source patterns.
export const gaSocialReferrals = sqliteTable('ga_social_referrals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  source: text('source').notNull(),
  medium: text('medium').notNull(),
  /** GA4 default channel group (e.g. 'Organic Social', 'Paid Social') */
  channelGroup: text('channel_group').notNull().default('Organic Social'),
  sessions: integer('sessions').notNull().default(0),
  users: integer('users').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
}, (table) => [
  index('idx_ga_social_ref_project_date').on(table.projectId, table.date),
  index('idx_ga_social_ref_source').on(table.source),
  uniqueIndex('idx_ga_social_ref_unique').on(table.projectId, table.date, table.source, table.medium, table.channelGroup),
  index('idx_ga_social_ref_run').on(table.syncRunId),
])

// Aggregate GA4 totals for a sync period — stores true unique user count
// (not derivable by summing per-page rows, which inflates the metric).
export const gaTrafficSummaries = sqliteTable('ga_traffic_summaries', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  totalSessions: integer('total_sessions').notNull().default(0),
  totalOrganicSessions: integer('total_organic_sessions').notNull().default(0),
  totalUsers: integer('total_users').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
}, (table) => [
  index('idx_ga_summary_project').on(table.projectId),
  index('idx_ga_summary_run').on(table.syncRunId),
])

// Per-window aggregate totals (7d / 30d / 90d). Sourced from GA4 with no
// landing-page dimension, so totalUsers is the true deduplicated count.
// Summing gaTrafficSnapshots.users by window double-counts users who land
// on multiple pages — this table avoids that bug.
export const gaTrafficWindowSummaries = sqliteTable('ga_traffic_window_summaries', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** '7d' | '30d' | '90d' */
  windowKey: text('window_key').notNull(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  totalSessions: integer('total_sessions').notNull().default(0),
  totalOrganicSessions: integer('total_organic_sessions').notNull().default(0),
  totalDirectSessions: integer('total_direct_sessions').notNull().default(0),
  totalUsers: integer('total_users').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
}, (table) => [
  uniqueIndex('idx_ga_window_summary_unique').on(table.projectId, table.windowKey),
  index('idx_ga_window_summary_run').on(table.syncRunId),
])

export const usageCounters = sqliteTable('usage_counters', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  period: text('period').notNull(),
  metric: text('metric').notNull(),
  count: integer('count').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_usage_scope_period_metric').on(table.scope, table.period, table.metric),
  index('idx_usage_scope_period').on(table.scope, table.period),
])

export const insights = sqliteTable('insights', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  query: text('query').notNull(),
  provider: text('provider').notNull(),
  recommendation: text('recommendation', { mode: 'json' }).$type<{ action: string; target?: string; reason: string }>(),
  cause: text('cause', { mode: 'json' }).$type<{ cause: string; competitorDomain?: string; details?: string }>(),
  dismissed: integer('dismissed', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_insights_project').on(table.projectId),
  index('idx_insights_run').on(table.runId),
  index('idx_insights_created').on(table.createdAt),
  index('idx_insights_query_provider').on(table.query, table.provider),
])

export const healthSnapshots = sqliteTable('health_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
  overallCitedRate: text('overall_cited_rate').notNull(),
  // Answer-text mention rate, independent of citation. Nullable because the
  // column is added by migration v80 via ALTER TABLE ADD COLUMN — rows
  // persisted before v80 read back as NULL ("not measured"); readers coalesce
  // NULL→0. New writes always populate it (see intelligence-service persist).
  overallMentionRate: text('overall_mention_rate'),
  totalPairs: integer('total_pairs').notNull(),
  citedPairs: integer('cited_pairs').notNull(),
  // Count of pairs MENTIONED in the answer text. Nullable for the same
  // legacy-row reason as overall_mention_rate; coalesced NULL→0 on read.
  mentionedPairs: integer('mentioned_pairs'),
  providerBreakdown: text('provider_breakdown', { mode: 'json' }).$type<Record<string, { citedRate: number; mentionRate: number; cited: number; mentioned: number; total: number }>>().notNull().default({}),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_health_snapshots_project').on(table.projectId),
  index('idx_health_snapshots_run').on(table.runId),
  index('idx_health_snapshots_created').on(table.createdAt),
])

/**
 * Per-project rolling Aero session.
 *
 * Durable half of the hybrid session registry: stores the transcript, any
 * follow-up messages queued while no live Agent was alive, and the model/
 * prompt config so a restart can rehydrate an in-memory Agent on demand.
 * The live pi-agent-core Agent instance (listeners, AbortController) lives
 * in memory and is reconstructed from this row after a restart.
 *
 * One row per project (enforced by UNIQUE on project_id). Single rolling
 * thread per project — we intentionally do not support many concurrent
 * threads per project (see `project_aero_ui_direction` memory).
 */
export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  systemPrompt: text('system_prompt').notNull(),
  modelProvider: text('model_provider').notNull(),
  modelId: text('model_id').notNull(),
  messages: text('messages').notNull().default('[]'),
  followUpQueue: text('follow_up_queue').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_agent_sessions_project').on(table.projectId),
  index('idx_agent_sessions_updated').on(table.updatedAt),
])

export const ccReleaseSyncs = sqliteTable('cc_release_syncs', {
  id: text('id').primaryKey(),
  release: text('release').notNull().unique(),
  status: text('status').notNull(),
  phaseDetail: text('phase_detail'),
  vertexPath: text('vertex_path'),
  edgesPath: text('edges_path'),
  vertexSha256: text('vertex_sha256'),
  edgesSha256: text('edges_sha256'),
  vertexBytes: integer('vertex_bytes'),
  edgesBytes: integer('edges_bytes'),
  projectsProcessed: integer('projects_processed'),
  domainsDiscovered: integer('domains_discovered'),
  downloadStartedAt: text('download_started_at'),
  downloadFinishedAt: text('download_finished_at'),
  queryStartedAt: text('query_started_at'),
  queryFinishedAt: text('query_finished_at'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_cc_release_syncs_status').on(table.status),
])

export const backlinkDomains = sqliteTable('backlink_domains', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Nullable: Bing Webmaster backlink rows have no Common Crawl release sync.
  releaseSyncId: text('release_sync_id').references(() => ccReleaseSyncs.id, { onDelete: 'cascade' }),
  source: text('source').$type<BacklinkSource>().notNull().default('commoncrawl'),
  release: text('release').notNull(),
  targetDomain: text('target_domain').notNull(),
  linkingDomain: text('linking_domain').notNull(),
  numHosts: integer('num_hosts').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_backlink_domains_project').on(table.projectId),
  index('idx_backlink_domains_release_sync').on(table.releaseSyncId),
  index('idx_backlink_domains_project_release').on(table.projectId, table.release),
  index('idx_backlink_domains_hosts').on(table.numHosts),
  uniqueIndex('idx_backlink_domains_unique').on(table.projectId, table.source, table.release, table.linkingDomain),
])

export const backlinkSummaries = sqliteTable('backlink_summaries', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Nullable: Bing Webmaster summaries have no Common Crawl release sync.
  releaseSyncId: text('release_sync_id').references(() => ccReleaseSyncs.id, { onDelete: 'cascade' }),
  source: text('source').$type<BacklinkSource>().notNull().default('commoncrawl'),
  release: text('release').notNull(),
  targetDomain: text('target_domain').notNull(),
  totalLinkingDomains: integer('total_linking_domains').notNull(),
  totalHosts: integer('total_hosts').notNull(),
  top10HostsShare: text('top_10_hosts_share').notNull(),
  queriedAt: text('queried_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_backlink_summaries_project_release').on(table.projectId, table.source, table.release),
  index('idx_backlink_summaries_project').on(table.projectId),
])

/**
 * Project-scoped durable notes Aero reads/writes via `remember`, `forget`,
 * and `recall`. Also holds compaction summaries (`source='compaction'`) so
 * compacted transcript slices remain recoverable. Hydration reads the N
 * most-recently-updated rows per project into the `<memory>` block of the
 * system prompt.
 *
 * UNIQUE (project_id, key) — upsert is the only write path. Writing the
 * same key replaces the prior value; `forget` deletes the row.
 */
export const agentMemory = sqliteTable('agent_memory', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  source: text('source').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('uniq_agent_memory_project_key').on(table.projectId, table.key),
  index('idx_agent_memory_project_updated').on(table.projectId, table.updatedAt),
])

/**
 * Append-only internal LLM usage ledger. `usage_counters` is intentionally
 * aggregate-only; prompt-cache tuning needs per-call token and cache component
 * rows grouped by feature/provider/model/session.
 */
export const llmUsageEvents = sqliteTable('llm_usage_events', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
  agentSessionId: text('agent_session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
  feature: text('feature').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  responseId: text('response_id'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  costMillicents: integer('cost_millicents').notNull().default(0),
  promptFamily: text('prompt_family'),
  promptVersion: text('prompt_version'),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_llm_usage_project_created').on(table.projectId, table.createdAt),
  index('idx_llm_usage_feature_created').on(table.feature, table.createdAt),
  index('idx_llm_usage_session_created').on(table.agentSessionId, table.createdAt),
  index('idx_llm_usage_run_created').on(table.runId, table.createdAt),
])

/**
 * Append-only internal tool-call ledger for long-running Aero sessions. It
 * lets operators see tool fan-out, failures, latency, and result size without
 * replaying the transcript or scraping SSE events.
 */
export const agentToolEvents = sqliteTable('agent_tool_events', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  agentSessionId: text('agent_session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
  toolCallId: text('tool_call_id').notNull(),
  toolName: text('tool_name').notNull(),
  assistantResponseId: text('assistant_response_id'),
  provider: text('provider'),
  model: text('model'),
  status: text('status').notNull(),
  durationMs: integer('duration_ms').notNull().default(0),
  argsBytes: integer('args_bytes').notNull().default(0),
  resultTextChars: integer('result_text_chars').notNull().default(0),
  resultBytes: integer('result_bytes').notNull().default(0),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_agent_tool_events_project_created').on(table.projectId, table.createdAt),
  index('idx_agent_tool_events_session_created').on(table.agentSessionId, table.createdAt),
  index('idx_agent_tool_events_tool_created').on(table.toolName, table.createdAt),
  index('idx_agent_tool_events_status_created').on(table.status, table.createdAt),
])

// --- Server-side traffic ingestion ---
// Per-source connection metadata. Credentials live in ~/.canonry/config.yaml,
// not here. `archived_at` retains the row after a host migration so historical
// crawler/referral buckets keep their FK target.
export const trafficSources = sqliteTable('traffic_sources', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull(),
  lastSyncedAt: text('last_synced_at'),
  lastCursor: text('last_cursor'),
  // A WordPress cursor is valid only inside the fixed [lastSyncedAt,
  // wordpressPendingUntil) window that created it. NULL means no such window
  // is pending; a non-NULL cursor with a NULL end is legacy state that cannot
  // safely compose with a bounded incremental pull.
  wordpressPendingUntil: text('wordpress_pending_until'),
  lastError: text('last_error'),
  // JSON-encoded array of normalized event IDs (e.g. `cloud-run:<ts>:<insertId>`)
  // observed in the most recent successful sync. Bounded ring buffer used to
  // dedupe across sync runs at the boundary timestamp where lastSyncedAt
  // clamping alone leaves a small overlap window.
  /**
   * Newest instant whose traffic a sync clamped past instead of ingesting.
   * Set when the single-sync reach cap fires; cleared only by a backfill that
   * covers the span. Without it the loss is unobservable a cycle later: the
   * watermark advances, current lag returns to normal, and a health check that
   * only reads lag reports `ok` on a source with a permanent hole in it.
   */
  skippedThroughAt: text('skipped_through_at'),
  lastEventIds: text('last_event_ids', { mode: 'json' }).$type<string[]>(),
  archivedAt: text('archived_at'),
  configJson: text('config_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  // sha256 hex of the per-source bearer token issued at connect time. Only
  // populated for push-receive source types (currently `cloudflare`); pull
  // adapters leave this NULL. The cleartext bearer + HMAC secret never live
  // in the DB — they go to `~/.canonry/config.yaml` under the per-type
  // connections block.
  ingestTokenHash: text('ingest_token_hash'),
  // Semver reported by the most recent forwarded event. Drives the
  // `traffic.source.worker-version` doctor check. NULL until the first
  // event arrives or for source types that don't forward versioned events.
  lastWorkerVersion: text('last_worker_version'),
  // Pull adapters use this durable, owner-bound lease to prevent a manual
  // sync and the scheduler from consuming the same source concurrently.
  // Both fields are nullable so pre-lease sources remain immediately valid.
  syncLeaseOwner: text('sync_lease_owner'),
  syncLeaseExpiresAt: text('sync_lease_expires_at'),
  // Residual Queue depth returned by Cloudflare after the most recent bounded
  // pull. NULL means a queue-backed source has not observed backlog yet; zero
  // is an explicit observation that the Queue was drained at that instant.
  queueBacklogCount: integer('queue_backlog_count'),
  queueBacklogObservedAt: text('queue_backlog_observed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_traffic_sources_project').on(table.projectId),
  index('idx_traffic_sources_project_status').on(table.projectId, table.status),
])

/**
 * Durable, transport-neutral idempotency claims for pushed or buffered raw
 * traffic events. A delivery adapter claims `(sourceId, eventId)` in the same
 * transaction as its rollup writes, then acknowledges upstream only after the
 * transaction commits. `expiresAt` is chosen by the adapter: direct push only
 * needs to cover its signed-request replay window, while a Queue pull adapter
 * can retain claims for the queue's full redelivery horizon.
 */
export const trafficEventReceipts = sqliteTable('traffic_event_receipts', {
  sourceId: text('source_id').notNull().references(() => trafficSources.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull(),
  receivedAt: text('received_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.sourceId, table.eventId] }),
  index('idx_traffic_event_receipts_expires').on(table.sourceId, table.expiresAt),
])

// Hourly rollup of server-observed crawler hits. Composite PK so the same
// (project, source, hour, bot, verification, path, status) tuple can be
// upserted to accumulate `hits` without a surrogate row id.
export const crawlerEventsHourly = sqliteTable('crawler_events_hourly', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().references(() => trafficSources.id, { onDelete: 'cascade' }),
  tsHour: text('ts_hour').notNull(),
  botId: text('bot_id').notNull(),
  operator: text('operator').notNull(),
  verificationStatus: text('verification_status').notNull(),
  pathNormalized: text('path_normalized').notNull(),
  status: integer('status').notNull(),
  hits: integer('hits').notNull().default(0),
  sampledUserAgent: text('sampled_user_agent'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({
    columns: [
      table.projectId,
      table.sourceId,
      table.tsHour,
      table.botId,
      table.verificationStatus,
      table.pathNormalized,
      table.status,
    ],
  }),
  index('idx_crawler_hourly_project_ts').on(table.projectId, table.tsHour),
  index('idx_crawler_hourly_path').on(table.projectId, table.pathNormalized),
])

// Provenance for the classifier manifests represented within one crawler
// rollup. Kept in an additive sidecar so older writers can continue to upsert
// the parent table using its original composite conflict target.
export const crawlerVerificationManifestsHourly = sqliteTable('crawler_verification_manifests_hourly', {
  projectId: text('project_id').notNull(),
  sourceId: text('source_id').notNull(),
  tsHour: text('ts_hour').notNull(),
  botId: text('bot_id').notNull(),
  verificationStatus: text('verification_status').notNull(),
  pathNormalized: text('path_normalized').notNull(),
  status: integer('status').notNull(),
  manifestId: text('manifest_id').notNull(),
  manifestJson: text('manifest_json', { mode: 'json' }).$type<TrafficVerificationManifest | null>(),
  hits: integer('hits').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({
    columns: [
      table.projectId,
      table.sourceId,
      table.tsHour,
      table.botId,
      table.verificationStatus,
      table.pathNormalized,
      table.status,
      table.manifestId,
    ],
  }),
  foreignKey({
    name: 'crawler_verification_manifests_parent_fk',
    columns: [
      table.projectId,
      table.sourceId,
      table.tsHour,
      table.botId,
      table.verificationStatus,
      table.pathNormalized,
      table.status,
    ],
    foreignColumns: [
      crawlerEventsHourly.projectId,
      crawlerEventsHourly.sourceId,
      crawlerEventsHourly.tsHour,
      crawlerEventsHourly.botId,
      crawlerEventsHourly.verificationStatus,
      crawlerEventsHourly.pathNormalized,
      crawlerEventsHourly.status,
    ],
  }).onDelete('cascade'),
  index('idx_crawler_verification_manifests_project_ts').on(table.projectId, table.tsHour),
])

// Hourly rollup of on-demand per-user fetches from AI surfaces — ChatGPT-User,
// Perplexity-User, MistralAI-User, etc. UA-evidenced like a crawler, but each
// hit was initiated by a real user (citation click, "read this URL" prompt).
// Kept disjoint from `crawler_events_hourly` so dashboard / API / report
// totals don't conflate machine crawl with human-in-the-loop fetch.
export const aiUserFetchEventsHourly = sqliteTable('ai_user_fetch_events_hourly', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().references(() => trafficSources.id, { onDelete: 'cascade' }),
  tsHour: text('ts_hour').notNull(),
  botId: text('bot_id').notNull(),
  operator: text('operator').notNull(),
  verificationStatus: text('verification_status').notNull(),
  pathNormalized: text('path_normalized').notNull(),
  status: integer('status').notNull(),
  hits: integer('hits').notNull().default(0),
  sampledUserAgent: text('sampled_user_agent'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({
    columns: [
      table.projectId,
      table.sourceId,
      table.tsHour,
      table.botId,
      table.verificationStatus,
      table.pathNormalized,
      table.status,
    ],
  }),
  index('idx_ai_user_fetch_hourly_project_ts').on(table.projectId, table.tsHour),
  index('idx_ai_user_fetch_hourly_path').on(table.projectId, table.pathNormalized),
])

// Manifest provenance for on-demand user-fetch rollups. As with crawler
// provenance, absence of a sidecar row means legacy/unattributed evidence.
export const aiUserFetchVerificationManifestsHourly = sqliteTable('ai_user_fetch_verification_manifests_hourly', {
  projectId: text('project_id').notNull(),
  sourceId: text('source_id').notNull(),
  tsHour: text('ts_hour').notNull(),
  botId: text('bot_id').notNull(),
  verificationStatus: text('verification_status').notNull(),
  pathNormalized: text('path_normalized').notNull(),
  status: integer('status').notNull(),
  manifestId: text('manifest_id').notNull(),
  manifestJson: text('manifest_json', { mode: 'json' }).$type<TrafficVerificationManifest | null>(),
  hits: integer('hits').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({
    columns: [
      table.projectId,
      table.sourceId,
      table.tsHour,
      table.botId,
      table.verificationStatus,
      table.pathNormalized,
      table.status,
      table.manifestId,
    ],
  }),
  foreignKey({
    name: 'ai_user_fetch_verification_manifests_parent_fk',
    columns: [
      table.projectId,
      table.sourceId,
      table.tsHour,
      table.botId,
      table.verificationStatus,
      table.pathNormalized,
      table.status,
    ],
    foreignColumns: [
      aiUserFetchEventsHourly.projectId,
      aiUserFetchEventsHourly.sourceId,
      aiUserFetchEventsHourly.tsHour,
      aiUserFetchEventsHourly.botId,
      aiUserFetchEventsHourly.verificationStatus,
      aiUserFetchEventsHourly.pathNormalized,
      aiUserFetchEventsHourly.status,
    ],
  }).onDelete('cascade'),
  index('idx_ai_user_fetch_verification_manifests_project_ts').on(table.projectId, table.tsHour),
])

// Hourly rollup of human visits with explicit AI-origin evidence (referer
// host or UTM source). Independent from `crawler_events_hourly` — never
// collapse the two; they answer different questions.
export const aiReferralEventsHourly = sqliteTable('ai_referral_events_hourly', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().references(() => trafficSources.id, { onDelete: 'cascade' }),
  tsHour: text('ts_hour').notNull(),
  product: text('product').notNull(),
  operator: text('operator').notNull(),
  sourceDomain: text('source_domain').notNull(),
  evidenceType: text('evidence_type').notNull(),
  landingPathNormalized: text('landing_path_normalized').notNull(),
  status: integer('status').notNull(),
  sessionsOrHits: integer('sessions_or_hits').notNull().default(0),
  /**
   * Paid/organic splits the MEASURE, not the primary key. The paid marker lives
   * in the request's UTM tags, which `landing_path_normalized` strips, so one
   * bucket can legitimately hold both kinds and the class is NOT functionally
   * determined by the key. Unclassified arrivals are the residual
   * `sessions_or_hits - paid - organic`, which leaves rows written before the
   * ingest classifier shipped (both columns 0) visibly unknown rather than
   * silently organic — the regression migration v95 shipped on the GA4 side.
   */
  paidSessionsOrHits: integer('paid_sessions_or_hits').notNull().default(0),
  organicSessionsOrHits: integer('organic_sessions_or_hits').notNull().default(0),
  usersEstimated: integer('users_estimated'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({
    columns: [
      table.projectId,
      table.sourceId,
      table.tsHour,
      table.product,
      table.sourceDomain,
      table.evidenceType,
      table.landingPathNormalized,
      table.status,
    ],
  }),
  index('idx_ai_referral_hourly_project_ts').on(table.projectId, table.tsHour),
  index('idx_ai_referral_hourly_landing').on(table.projectId, table.landingPathNormalized),
])

// Short-retention raw evidence for classifier debugging and replay.
// Source writes plus a startup/daily global sweep enforce the 30-day ceiling.
export const rawEventSamples = sqliteTable('raw_event_samples', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().references(() => trafficSources.id, { onDelete: 'cascade' }),
  ts: text('ts').notNull(),
  eventType: text('event_type').notNull(),
  ipHash: text('ip_hash'),
  userAgent: text('user_agent'),
  pathNormalized: text('path_normalized').notNull(),
  status: integer('status'),
  refererHost: text('referer_host'),
  classifierDetailsJson: text('classifier_details_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_raw_event_samples_ts').on(table.ts),
  index('idx_raw_event_samples_project_ts').on(table.projectId, table.ts),
  index('idx_raw_event_samples_source_ts').on(table.sourceId, table.ts),
  index('idx_raw_event_samples_event_type').on(table.eventType),
])

export const discoverySessions = sqliteTable('discovery_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id'),
  status: text('status').notNull().default('queued'),
  icpDescription: text('icp_description'),
  seedProvider: text('seed_provider'),
  seedCountRaw: integer('seed_count_raw'),
  seedCount: integer('seed_count'),
  // Diagnostics: split of the raw seed candidates by source — the model's
  // answer text vs. the grounding fan-out (issued search queries). Recorded at
  // seed time; nullable for legacy sessions. No gate/warning math reads these.
  seedFromAnswerCount: integer('seed_from_answer_count'),
  seedFromGroundingCount: integer('seed_from_grounding_count'),
  // Diagnostics: raw candidates dropped by the branded self-query filter
  // before seed_count_raw was recorded. Nullable for legacy sessions.
  seedBrandFilteredCount: integer('seed_brand_filtered_count'),
  // Buyer definition the session was seeded with; part of session identity
  // for in-flight consolidation (same ICP + different buyer never reuses).
  buyerDescription: text('buyer_description'),
  // Resolved service areas the session was seeded/probed with; part of session
  // identity for in-flight consolidation. Null on legacy sessions.
  locations: text('locations', { mode: 'json' }).$type<LocationContext[]>(),
  // Full seed provenance + dedup calibration diagnostics (nullable, legacy
  // sessions stay null). seed_raw_candidates is the seed dep's original list,
  // pre-brand-filter, so filter and dedup changes can replay real sessions.
  seedRawCandidates: text('seed_raw_candidates', { mode: 'json' }).$type<string[]>(),
  dedupClusterMinSims: text('dedup_cluster_min_sims', { mode: 'json' }).$type<number[]>(),
  dedupBandPairFraction: real('dedup_band_pair_fraction'),
  dedupPairsTotal: integer('dedup_pairs_total'),
  // Seed provider set (canonical order; null = legacy / Gemini-only) — part of
  // session identity for consolidation — and per-provider candidate counts.
  seedProviders: text('seed_providers', { mode: 'json' }).$type<string[]>(),
  seedProviderCounts: text('seed_provider_counts', { mode: 'json' }).$type<Record<string, number>>(),
  // TRUE canonical count after dedup, BEFORE the probe-budget slice. seed_count
  // is post-truncation (probedCanonicals.length), so a deliberately small
  // maxProbes deflates it; this column is the honest numerator.
  canonicalCount: integer('canonical_count'),
  dedupThreshold: real('dedup_threshold'),
  probeCount: integer('probe_count'),
  citedCount: integer('cited_count'),
  aspirationalCount: integer('aspirational_count'),
  wastedCount: integer('wasted_count'),
  competitorMap: text('competitor_map', { mode: 'json' }).$type<DiscoveryCompetitorMapEntry[]>().notNull().default([]),
  warning: text('warning'),
  error: text('error'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_discovery_sessions_project_created').on(table.projectId, table.createdAt),
  index('idx_discovery_sessions_run').on(table.runId),
])

/** Research is intentionally separate from tracked queries, runs, and snapshots. */
export const researchRuns = sqliteTable('research_runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('queued'), provider: text('provider').notNull(),
  requestedModel: text('requested_model'), resolvedModel: text('resolved_model').notNull(),
  location: text('location', { mode: 'json' }).$type<LocationContext | null>(),
  totalQueries: integer('total_queries').notNull(), completedQueries: integer('completed_queries').notNull().default(0), failedQueries: integer('failed_queries').notNull().default(0),
  idempotencyKey: text('idempotency_key'), requestHash: text('request_hash'), error: text('error'),
  startedAt: text('started_at'), finishedAt: text('finished_at'), createdAt: text('created_at').notNull(),
}, (table) => [index('idx_research_runs_project_created').on(table.projectId, table.createdAt), index('idx_research_runs_status').on(table.status), uniqueIndex('idx_research_runs_project_idempotency').on(table.projectId, table.idempotencyKey)])

export const researchRunQueries = sqliteTable('research_run_queries', {
  id: text('id').primaryKey(), researchRunId: text('research_run_id').notNull().references(() => researchRuns.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(), queryText: text('query_text').notNull(), status: text('status').notNull().default('queued'),
  requestedModel: text('requested_model'), resolvedModel: text('resolved_model').notNull(), servedModel: text('served_model'), answerText: text('answer_text'),
  groundingSources: text('grounding_sources', { mode: 'json' }).$type<import('@ainyc/canonry-contracts').GroundingSource[]>().notNull().default([]),
  citedDomains: text('cited_domains', { mode: 'json' }).$type<string[]>().notNull().default([]), searchQueries: text('search_queries', { mode: 'json' }).$type<string[]>().notNull().default([]),
  namedCompetitors: text('named_competitors', { mode: 'json' }).$type<string[]>().notNull().default([]), citedCompetitorDomains: text('cited_competitor_domains', { mode: 'json' }).$type<string[]>().notNull().default([]),
  answerMentioned: integer('answer_mentioned', { mode: 'boolean' }), citationState: text('citation_state'), rawResponse: text('raw_response', { mode: 'json' }).$type<Record<string, unknown> | null>(), error: text('error'),
  startedAt: text('started_at'), finishedAt: text('finished_at'), createdAt: text('created_at').notNull(),
}, (table) => [index('idx_research_run_queries_run').on(table.researchRunId), uniqueIndex('idx_research_run_queries_run_position').on(table.researchRunId, table.position)])

export const discoveryProbes = sqliteTable('discovery_probes', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => discoverySessions.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  query: text('query').notNull(),
  bucket: text('bucket'),
  citationState: text('citation_state').notNull(),
  // Answer-text mention signal, independent of citationState. Tri-state: true
  // (named in the answer prose), false (probed, not named), null (legacy rows
  // written before this column / never computed). Mirrors querySnapshots.answerMentioned.
  answerMentioned: integer('answer_mentioned', { mode: 'boolean' }),
  citedDomains: text('cited_domains', { mode: 'json' }).$type<string[]>().notNull().default([]),
  rawResponse: text('raw_response'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_discovery_probes_session').on(table.sessionId),
  index('idx_discovery_probes_project').on(table.projectId),
])

/**
 * Durable, per-domain classification of cited surfaces produced by discovery.
 *
 * Discovery already types every recurring cited domain (`direct-competitor` /
 * `ota-aggregator` / `editorial-media` / `other` / `unknown`) into a session's
 * `competitor_map`, but that map is keyed to a session, not to a
 * `(project, domain)` lookup. The content-targets winnabilityClass gate runs on
 * every report and sweep and cannot run a discovery probe, so it needs a cheap
 * indexed read. This table accumulates the union of every classification ever
 * produced, upserted on each discovery completion (last-write-wins per domain),
 * decoupled from session retention.
 *
 * Keyed UNIQUE on `(project_id, domain)`. `domain` is normalized
 * (`normalizeDomain`). `session_id` records the provenance of the latest write.
 */
export const domainClassifications = sqliteTable('domain_classifications', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
  competitorType: text('competitor_type').$type<DiscoveryCompetitorType>().notNull(),
  /** Recurrence count from the latest classifying session; informational. */
  hits: integer('hits').notNull().default(0),
  /** Discovery session that produced the latest classification. */
  sessionId: text('session_id'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_domain_classifications_project_domain').on(table.projectId, table.domain),
  index('idx_domain_classifications_project').on(table.projectId),
])

/**
 * Per-recommendation dismissal for content-opportunity rows in the report.
 *
 * Recommendations are recomputed on every report load from live GSC/GA
 * inventory (see `loadOrchestratorInput`). Without a persistent dismissal
 * layer, a recommendation lingers until Google indexes the new page AND a
 * `canonry google sync` pulls it in — typical lag days to weeks. Users mark
 * a recommendation "addressed" here so it drops off the report immediately
 * and stays off until explicitly un-dismissed.
 *
 * Keyed by `(project_id, target_ref)` where `target_ref` is the stable hash
 * `computeTargetRef()` already produces and surfaces on
 * `ContentTargetRowDto.targetRef`. UNIQUE on `(project_id, target_ref)` so
 * re-dismissing the same row is a no-op upsert, not a duplicate.
 */
export const contentTargetDismissals = sqliteTable('content_target_dismissals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  targetRef: text('target_ref').notNull(),
  addressedUrl: text('addressed_url'),
  note: text('note'),
  dismissedAt: text('dismissed_at').notNull(),
}, (table) => [
  uniqueIndex('idx_content_target_dismissals_project_ref').on(table.projectId, table.targetRef),
  index('idx_content_target_dismissals_project').on(table.projectId),
])

/**
 * LLM-generated rationale for a content recommendation. Cached per
 * (project, target_ref, prompt_version) so repeat clicks on the same
 * recommendation are free; bumping `prompt_version` in the template
 * invalidates the cache forward without touching the table. Stores the
 * actual provider + model used and a rough cost estimate so admins can
 * audit spend without re-deriving it from logs.
 */
export const recommendationExplanations = sqliteTable('recommendation_explanations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  targetRef: text('target_ref').notNull(),
  promptVersion: text('prompt_version').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  responseText: text('response_text').notNull(),
  /** Estimated cost in millicents (1/100 of a cent) for audit; 0 if unknown. */
  costMillicents: integer('cost_millicents').notNull().default(0),
  generatedAt: text('generated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_recommendation_explanations_unique').on(
    table.projectId,
    table.targetRef,
    table.promptVersion,
  ),
  index('idx_recommendation_explanations_project').on(table.projectId),
])

/**
 * LLM-synthesized content brief for a recommendation. Separate from
 * `recommendation_explanations` on purpose: the brief carries a STRUCTURED
 * payload, and the explanation cache lookup is prompt-version-blind (it returns
 * the newest row for a target regardless of version) — sharing a table would
 * let brief and explanation rows bleed into each other's reads. The brief
 * lookup keys on the full `(project, target_ref, prompt_version)` tuple, so the
 * two modes never collide. Gated to `ownable` targets; a `ceded` target is
 * rejected before synthesis, so no row is ever written for one.
 */
export const recommendationBriefs = sqliteTable('recommendation_briefs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  targetRef: text('target_ref').notNull(),
  promptVersion: text('prompt_version').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  /** The structured brief payload (angle, why-winnable, schema hookup, etc.). */
  brief: text('brief', { mode: 'json' }).$type<ContentBriefDto>().notNull(),
  /** Estimated cost in millicents (1/100 of a cent) for audit; 0 if unknown. */
  costMillicents: integer('cost_millicents').notNull().default(0),
  generatedAt: text('generated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_recommendation_briefs_unique').on(
    table.projectId,
    table.targetRef,
    table.promptVersion,
  ),
  index('idx_recommendation_briefs_project').on(table.projectId),
])

/**
 * Internal bookkeeping for the migration runner. One row per applied
 * `MIGRATION_VERSIONS` entry. The migrator reads `MAX(version)` on boot and
 * skips anything already recorded; statements never query this table at
 * runtime. Defined here for grep-ability and consistency with the rest of
 * the schema, but the table is created in `MIGRATION_SQL`.
 */
export const migrationsTable = sqliteTable('_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  appliedAt: text('applied_at').notNull(),
})

// Google Business Profile locations — one row per discovered location.
// `selected` controls which locations are pulled during gbp-sync runs.
// Resource names are kept in full form (`accounts/{n}` and `locations/{n}`)
// because both v1 and v4 endpoints expect the full path.
export const gbpLocations = sqliteTable('gbp_locations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  accountName: text('account_name').notNull(),
  locationName: text('location_name').notNull(),
  displayName: text('display_name').notNull(),
  primaryCategoryDisplayName: text('primary_category_display_name'),
  storefrontAddress: text('storefront_address'),
  websiteUri: text('website_uri'),
  // Google Maps Place ID + public Maps link, sourced from the location's
  // `metadata` (output-only; populated only when the location is on Maps).
  // `placeId` links a GBP location to the Places API for supplemental
  // rendered-listing data. Null when Google has not assigned a Place ID.
  placeId: text('place_id'),
  mapsUri: text('maps_uri'),
  // Owner-authored profile content from the Business Information v1 Location
  // resource — the entity-anchor + qualifier signals AI answer engines weight.
  // `serviceArea` / `regularHours` are stored verbatim (presence + raw shape).
  additionalCategories: text('additional_categories', { mode: 'json' }).$type<string[]>(),
  description: text('description'),
  serviceArea: text('service_area', { mode: 'json' }).$type<Record<string, unknown>>(),
  regularHours: text('regular_hours', { mode: 'json' }).$type<Record<string, unknown>>(),
  primaryPhone: text('primary_phone'),
  openStatus: text('open_status'),
  openingDate: text('opening_date'),
  selected: integer('selected', { mode: 'boolean' }).notNull().default(true),
  syncedAt: text('synced_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_gbp_locations_project').on(table.projectId),
  uniqueIndex('uniq_gbp_locations_project_location').on(table.projectId, table.locationName),
])

// GBP daily performance metrics — one row per (location, date, metric).
// `value` is the integer count (Google returns string-encoded; the worker
// parses it, and omitted zero-days are persisted as 0). The sync range-replaces
// the window so re-runs don't accumulate duplicates.
export const gbpDailyMetrics = sqliteTable('gbp_daily_metrics', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  locationName: text('location_name').notNull(),
  date: text('date').notNull(),           // YYYY-MM-DD
  metric: text('metric').notNull(),       // BUSINESS_IMPRESSIONS_DESKTOP_MAPS, WEBSITE_CLICKS, …
  value: integer('value').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_gbp_daily_metrics_loc').on(table.projectId, table.locationName, table.date),
  uniqueIndex('uniq_gbp_daily_metrics').on(table.projectId, table.locationName, table.date, table.metric),
])

// GBP search-keyword impressions — one row per (location, window, keyword).
// The Performance API returns a single impressions figure per keyword aggregated
// over the whole requested range, NOT a per-month breakdown — so each row records
// the trailing window it covers via period_start / period_end (both YYYY-MM,
// inclusive) rather than a single month. Google returns either an exact `value`
// or a privacy `threshold` (the floor it won't go below); exactly one of
// valueCount / valueThreshold is non-null per row.
export const gbpKeywordImpressions = sqliteTable('gbp_keyword_impressions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  locationName: text('location_name').notNull(),
  periodStart: text('period_start').notNull(), // YYYY-MM, inclusive
  periodEnd: text('period_end').notNull(),     // YYYY-MM, inclusive
  keyword: text('keyword').notNull(),
  valueCount: integer('value_count'),     // exact impressions, or null when thresholded
  valueThreshold: integer('value_threshold'), // privacy floor, or null when exact
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_gbp_keyword_impr_loc').on(table.projectId, table.locationName, table.periodEnd),
  uniqueIndex('uniq_gbp_keyword_impr').on(table.projectId, table.locationName, table.periodEnd, table.keyword),
])

// GBP keyword monthly series — one row per (location, calendar month, keyword).
// Unlike gbp_keyword_impressions (a single range-replaced trailing-window
// aggregate), this table ACCUMULATES: each sync upserts the most recent
// complete months and leaves older in-retention months in place, so the
// intelligence engine can detect month-over-month keyword drops. The monthly
// endpoint returns one aggregate per range, so a true monthly series requires
// one call per month — the sync fetches the last few complete months and the
// history builds up over time. `month` is YYYY-MM; exactly one of valueCount /
// valueThreshold is non-null per row (the privacy floor when Google redacts).
export const gbpKeywordMonthly = sqliteTable('gbp_keyword_monthly', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  locationName: text('location_name').notNull(),
  month: text('month').notNull(),         // YYYY-MM (the calendar month this count covers)
  keyword: text('keyword').notNull(),
  valueCount: integer('value_count'),     // exact impressions, or null when thresholded
  valueThreshold: integer('value_threshold'), // privacy floor, or null when exact
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
  syncedAt: text('synced_at').notNull(),
}, (table) => [
  index('idx_gbp_keyword_monthly_loc').on(table.projectId, table.locationName, table.month),
  uniqueIndex('uniq_gbp_keyword_monthly').on(table.projectId, table.locationName, table.month, table.keyword),
])

// GBP place action links — booking / reservation / order CTAs surfaced by AI
// engines. Range-replaced per location each sync (the resource name is the
// stable key). `providerType` MERCHANT = direct, AGGREGATOR = OTA link.
export const gbpPlaceActions = sqliteTable('gbp_place_actions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  locationName: text('location_name').notNull(),
  placeActionLinkName: text('place_action_link_name').notNull(),
  placeActionType: text('place_action_type').notNull(),
  uri: text('uri'),
  isPreferred: integer('is_preferred', { mode: 'boolean' }).notNull().default(false),
  providerType: text('provider_type'),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_gbp_place_actions_loc').on(table.projectId, table.locationName),
  uniqueIndex('uniq_gbp_place_actions').on(table.projectId, table.placeActionLinkName),
])

// GBP lodging snapshots — hotel structured attributes, snapshotted on change.
// Hotel profiles change rarely, so we only insert a new row when the content
// hash differs from the latest stored snapshot for the location. `attributes`
// holds the raw Lodging resource; `populatedGroupCount` is the count of
// non-empty top-level groups returned by the API. A zero count means "no
// readable Lodging API groups" and should be treated as a Hotel details verify
// signal, not proof the public listing or owner panel has no amenities.
export const gbpLodgingSnapshots = sqliteTable('gbp_lodging_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  locationName: text('location_name').notNull(),
  contentHash: text('content_hash').notNull(),
  attributes: text('attributes', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  populatedGroupCount: integer('populated_group_count').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_gbp_lodging_loc').on(table.projectId, table.locationName, table.syncedAt),
])

// GBP Places (New) Place Details snapshots — the *rendered-listing* data Google
// synthesizes (amenities, accessibility, editorial summary), fetched via the
// Places API key for lodging locations and snapshotted on change (hotel data
// changes rarely — same pattern as gbp_lodging_snapshots). `attributes` holds
// the raw Place Details resource; `tier` records the field-mask SKU it was
// fetched at (which fields are present). Cross-referenced against the GBP
// lodging profile to detect listing discrepancies (#648).
export const gbpPlaceDetails = sqliteTable('gbp_place_details', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  locationName: text('location_name').notNull(),
  placeId: text('place_id').notNull(),
  contentHash: text('content_hash').notNull(),
  tier: text('tier').notNull(),
  attributes: text('attributes', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_gbp_place_details_loc').on(table.projectId, table.locationName, table.syncedAt),
])

// GBP owner-set attributes (Business Information API) — the generic,
// any-category amenity / service / accessibility / identity / social-URL tags
// the owner has set on the location. Unlike gbp_lodging_snapshots (hotels only)
// this works for every business type. getAttributes returns ONLY the set
// attributes, so `attributeCount` is the count of set attributes. Snapshotted
// on change (attributes change rarely — same pattern as gbp_lodging_snapshots).
export const gbpAttributesSnapshots = sqliteTable('gbp_attributes_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  locationName: text('location_name').notNull(),
  contentHash: text('content_hash').notNull(),
  attributes: text('attributes', { mode: 'json' })
    .$type<{ name: string; valueType: string; values: (boolean | string)[]; unsetValues: string[]; uris: string[] }[]>()
    .notNull()
    .default([]),
  attributeCount: integer('attribute_count').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
}, (table) => [
  index('idx_gbp_attributes_loc').on(table.projectId, table.locationName, table.syncedAt),
])

// --- OpenAI Advertiser API (ChatGPT ads) ---

// One ads connection per project (ad accounts are not domain-bound, so the
// connection keys on project — same model as ga_connections). The API key
// lives in ~/.canonry/config.yaml; this row holds metadata + sync state only.
export const adsConnections = sqliteTable('ads_connections', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  adAccountId: text('ad_account_id').notNull(),
  displayName: text('display_name'),
  currencyCode: text('currency_code'),
  timezone: text('timezone'),
  status: text('status'),
  reviewStatus: text('review_status'),
  integrityReviewStatus: text('integrity_review_status'),
  integrityDecision: text('integrity_decision'),
  lastSyncedAt: text('last_synced_at'),
  conversionTrackingConfigured: integer('conversion_tracking_configured', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ads_conn_project').on(table.projectId),
])

// Durable receipts for upstream Ads API mutations. The upstream API does not
// document an idempotency key, so the operation row is inserted before the
// network call. A repeated (project, operation_key) is never sent upstream a
// second time; unknown outcomes require operator reconciliation.
export const adsOperations = sqliteTable('ads_operations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Bound to the verified account attached to the credential at mutation time.
  // Reconciliation refuses to inspect a different account after reconnect.
  adAccountId: text('ad_account_id'),
  operationKey: text('operation_key').notNull(),
  requestHash: text('request_hash').notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  upstreamUpdatedAt: integer('upstream_updated_at'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  reconcileStrategy: text('reconcile_strategy'),
  reconcileParentId: text('reconcile_parent_id'),
  reconcileFingerprint: text('reconcile_fingerprint'),
  reconcileFields: text('reconcile_fields', { mode: 'json' }).$type<AdsReconcileFields | null>(),
  reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
  lastReconciledAt: text('last_reconciled_at'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ads_operations_project_key').on(table.projectId, table.operationKey),
  index('idx_ads_operations_project_created').on(table.projectId, table.createdAt),
  index('idx_ads_operations_project_state').on(table.projectId, table.state),
  index('idx_ads_operations_reconcile_lease').on(table.state, table.leaseExpiresAt, table.updatedAt),
])

// A human approval is bound to one canonical campaign-tree manifest, one
// advertiser account, and one executor API key. The grant never stores a
// plaintext credential. Approver and executor key rows are retained/revoked
// rather than deleted, so NO ACTION FKs preserve the durable audit identity.
export const adsActivationGrants = sqliteTable('ads_activation_grants', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  adAccountId: text('ad_account_id').notNull(),
  manifestHash: text('manifest_hash').notNull(),
  manifest: text('manifest', { mode: 'json' }).$type<AdsActivationManifest>().notNull(),
  executorApiKeyId: text('executor_api_key_id').notNull().references(() => apiKeys.id),
  approverApiKeyId: text('approver_api_key_id').notNull().references(() => apiKeys.id),
  state: text('state').$type<AdsActivationGrantState>().notNull(),
  expiresAt: text('expires_at').notNull(),
  operationId: text('operation_id').references(() => adsOperations.id),
  approvedAt: text('approved_at').notNull(),
  executionStartedAt: text('execution_started_at'),
  consumedAt: text('consumed_at'),
  revokedAt: text('revoked_at'),
  revocationRequestedAt: text('revocation_requested_at'),
  expiredAt: text('expired_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_ads_activation_grants_project').on(table.projectId),
  index('idx_ads_activation_grants_project_state_expiry').on(table.projectId, table.state, table.expiresAt),
  index('idx_ads_activation_grants_project_manifest').on(table.projectId, table.manifestHash),
  uniqueIndex('idx_ads_activation_grants_operation').on(table.operationId),
])

// Durable, ordered checkpoints for one campaign-tree activation. Every state
// transition writes only sanitized errors/remediation; raw provider responses
// and credentials never enter this table.
export const adsOperationSteps = sqliteTable('ads_operation_steps', {
  id: text('id').primaryKey(),
  operationId: text('operation_id').notNull().references(() => adsOperations.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  entityType: text('entity_type').$type<AdsActivationEntityType>().notNull(),
  entityId: text('entity_id').notNull(),
  expectedUpdatedAt: integer('expected_updated_at').notNull(),
  state: text('state').$type<AdsOperationStepState>().notNull(),
  providerUpdatedAt: integer('provider_updated_at'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  remediation: text('remediation'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_ads_operation_steps_operation_state').on(table.operationId, table.state),
  uniqueIndex('idx_ads_operation_steps_operation_ordinal').on(table.operationId, table.ordinal),
  uniqueIndex('idx_ads_operation_steps_operation_entity').on(table.operationId, table.entityType, table.entityId),
])

// Entity snapshots refreshed on every ads-sync (range-replaced per project) so
// dashboards and the paid/organic overlap can read campaign structure without
// live API calls. Ids are the upstream ids (cmpn_… / adgrp_… / ad_…). Money
// columns are integer micros, mirroring the upstream budget/bid units.
export const adsCampaigns = sqliteTable('ads_campaigns', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull(),
  startTime: integer('start_time'),
  endTime: integer('end_time'),
  biddingType: text('bidding_type'),
  dailySpendLimitMicros: integer('daily_spend_limit_micros'),
  lifetimeSpendLimitMicros: integer('lifetime_spend_limit_micros'),
  conversionEventSettingIds: text('conversion_event_setting_ids', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  targeting: text('targeting', { mode: 'json' }).$type<unknown>(),
  upstreamCreatedAt: integer('upstream_created_at'),
  upstreamUpdatedAt: integer('upstream_updated_at'),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
  syncedAt: text('synced_at').notNull(),
}, (table) => [
  index('idx_ads_campaigns_project').on(table.projectId),
])

// `contextHints` is the targeting primitive: an array whose entries are
// multi-line strings of newline-separated example queries (live format).
// The paid/organic overlap matcher joins these against tracked queries.
export const adsAdGroups = sqliteTable('ads_ad_groups', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  campaignId: text('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull(),
  billingEventType: text('billing_event_type'),
  maxBidMicros: integer('max_bid_micros'),
  contextHints: text('context_hints', { mode: 'json' }).$type<string[]>().notNull().default([]),
  upstreamCreatedAt: integer('upstream_created_at'),
  upstreamUpdatedAt: integer('upstream_updated_at'),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
  syncedAt: text('synced_at').notNull(),
}, (table) => [
  index('idx_ads_ad_groups_project').on(table.projectId),
  index('idx_ads_ad_groups_campaign').on(table.campaignId),
])

export const adsAds = sqliteTable('ads_ads', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  adGroupId: text('ad_group_id').notNull().references(() => adsAdGroups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status').notNull(),
  creative: text('creative', { mode: 'json' }).$type<unknown>(),
  reviewStatus: text('review_status'),
  upstreamCreatedAt: integer('upstream_created_at'),
  upstreamUpdatedAt: integer('upstream_updated_at'),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
  syncedAt: text('synced_at').notNull(),
}, (table) => [
  index('idx_ads_ads_project').on(table.projectId),
  index('idx_ads_ads_group').on(table.adGroupId),
])

// Daily paid-performance rollups, one row per (level, entity, date). Spend is
// stored as integer micros — the upstream insights API returns DECIMAL DOLLARS
// for spend/cpc, so ads-sync normalizes via dollarsToMicros at ingest. Derived
// ratios (ctr, cpc, cpm) are computed at read time, never stored. Upserted on
// conflict so re-syncing an in-progress day replaces instead of duplicating.
export const adsInsightsDaily = sqliteTable('ads_insights_daily', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  level: text('level').notNull(),
  entityId: text('entity_id').notNull(),
  date: text('date').notNull(),
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  spendMicros: integer('spend_micros').notNull().default(0),
  conversions: integer('conversions').notNull().default(0),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'set null' }),
}, (table) => [
  uniqueIndex('uniq_ads_insights_daily').on(table.projectId, table.level, table.entityId, table.date),
  index('idx_ads_insights_project_date').on(table.projectId, table.date),
])

// --- Google Ads + Google Tag Manager (read-only marketing evidence) ---

/**
 * One Google Ads connection per project. OAuth material is intentionally held
 * only in private config; this row records the selected read context and its
 * last known public metadata.
 */
export const googleAdsConnections = sqliteTable('google_ads_connections', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  selectedLoginCustomerId: text('selected_login_customer_id'),
  selectedCustomerId: text('selected_customer_id'),
  selectedCustomerName: text('selected_customer_name'),
  selectedCustomerCurrencyCode: text('selected_customer_currency_code'),
  selectedCustomerTimeZone: text('selected_customer_time_zone'),
  selectedCustomerStatus: text('selected_customer_status').$type<GoogleAdsCustomerStatus>(),
  scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** Monotonic CAS token; selection writes increment it even when values match. */
  selectionGeneration: integer('selection_generation').notNull().default(0),
  lastValidatedAt: text('last_validated_at'),
  /** Internal exact anchors for the current selection generation. */
  lastCustomerSnapshotId: text('last_customer_snapshot_id'),
  lastInventorySnapshotAt: text('last_inventory_snapshot_at'),
  lastInventorySnapshotId: text('last_inventory_snapshot_id'),
  lastMetricsSnapshotAt: text('last_metrics_snapshot_at'),
  lastMetricsSnapshotId: text('last_metrics_snapshot_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_google_ads_connections_project').on(table.projectId),
  // Required parent key for project-scoped snapshot foreign keys below.
  uniqueIndex('idx_google_ads_connections_project_id').on(table.projectId, table.id),
  index('idx_google_ads_connections_selected_customer').on(table.selectedCustomerId),
])

/**
 * One Google Tag Manager connection per project. Account/container/workspace
 * selection and safe labels persist; OAuth client credentials and tokens do not.
 */
export const gtmConnections = sqliteTable('gtm_connections', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  selectedAccountId: text('selected_account_id'),
  selectedAccountName: text('selected_account_name'),
  selectedContainerId: text('selected_container_id'),
  selectedContainerName: text('selected_container_name'),
  selectedContainerPublicId: text('selected_container_public_id'),
  selectedWorkspaceId: text('selected_workspace_id'),
  selectedWorkspaceName: text('selected_workspace_name'),
  scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** Monotonic CAS token; selection writes increment it even when values match. */
  selectionGeneration: integer('selection_generation').notNull().default(0),
  lastValidatedAt: text('last_validated_at'),
  lastSnapshotAt: text('last_snapshot_at'),
  /** Internal exact anchor for the current selection generation. */
  lastSnapshotId: text('last_snapshot_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_gtm_connections_project').on(table.projectId),
  // Required parent key for project-scoped snapshot foreign keys below.
  uniqueIndex('idx_gtm_connections_project_id').on(table.projectId, table.id),
  index('idx_gtm_connections_selected_container').on(table.selectedContainerId),
])

/**
 * Declared project-local conversion semantics. This remains independent from
 * live Google connection/snapshot rows so the integrity reader can truthfully
 * report a missing connection, tag, or goal against a durable desired state.
 * The nested JSON shapes are the matching `ConversionTrackingContract` fields;
 * they contain identifiers and verification requirements only, never OAuth or
 * provider-body material.
 */
export const conversionTrackingContracts = sqliteTable('conversion_tracking_contracts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  eventName: text('event_name').notNull(),
  googleAds: text('google_ads', { mode: 'json' }).$type<ConversionTrackingContract['googleAds']>().notNull(),
  gtm: text('gtm', { mode: 'json' }).$type<ConversionTrackingContract['gtm']>().notNull(),
  runtime: text('runtime', { mode: 'json' }).$type<ConversionTrackingContract['runtime']>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_conversion_tracking_contracts_project_name').on(table.projectId, table.name),
  index('idx_conversion_tracking_contracts_project_event').on(table.projectId, table.eventName),
])

/**
 * Append-only, redacted Google Ads reads. The exact provider body is never
 * persisted; `payload` is constrained to the secret-free contract DTO and the
 * raw body is represented only by metadata/hash for forensic correlation.
 */
export const googleAdsRawSnapshots = sqliteTable('google_ads_raw_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  connectionId: text('connection_id').notNull(),
  runId: text('run_id').notNull(),
  kind: text('kind').$type<GoogleAdsSnapshotKind>().notNull(),
  customerId: text('customer_id'),
  payloadChecksum: text('payload_checksum').notNull(),
  rawPayloadSha256: text('raw_payload_sha256'),
  rawPayloadBytes: integer('raw_payload_bytes'),
  redactedFieldCount: integer('redacted_field_count').notNull().default(0),
  payload: text('payload', { mode: 'json' }).$type<GoogleAdsSnapshotPayload>().notNull(),
  capturedAt: text('captured_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_google_ads_raw_snapshots_project_run').on(table.projectId, table.runId),
  index('idx_google_ads_raw_snapshots_connection_kind_captured').on(table.connectionId, table.kind, table.capturedAt),
  index('idx_google_ads_raw_snapshots_project_captured').on(table.projectId, table.capturedAt),
  foreignKey({
    name: 'google_ads_raw_snapshots_project_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'google_ads_raw_snapshots_project_connection_fk',
    columns: [table.projectId, table.connectionId],
    foreignColumns: [googleAdsConnections.projectId, googleAdsConnections.id],
  }).onDelete('cascade'),
])

/**
 * Append-only, redacted GTM reads. Tags, triggers, and variables are stored as
 * the typed safe graph; raw template/parameter values and OAuth material stay out.
 */
export const gtmRawSnapshots = sqliteTable('gtm_raw_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  connectionId: text('connection_id').notNull(),
  runId: text('run_id').notNull(),
  kind: text('kind').$type<GtmSnapshotKind>().notNull(),
  accountId: text('account_id'),
  containerId: text('container_id'),
  workspaceId: text('workspace_id'),
  payloadChecksum: text('payload_checksum').notNull(),
  rawPayloadSha256: text('raw_payload_sha256'),
  rawPayloadBytes: integer('raw_payload_bytes'),
  redactedFieldCount: integer('redacted_field_count').notNull().default(0),
  payload: text('payload', { mode: 'json' }).$type<GtmSnapshotPayload>().notNull(),
  capturedAt: text('captured_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_gtm_raw_snapshots_project_run').on(table.projectId, table.runId),
  index('idx_gtm_raw_snapshots_connection_kind_captured').on(table.connectionId, table.kind, table.capturedAt),
  index('idx_gtm_raw_snapshots_project_container_captured').on(table.projectId, table.containerId, table.capturedAt),
  foreignKey({
    name: 'gtm_raw_snapshots_project_run_fk',
    columns: [table.projectId, table.runId],
    foreignColumns: [runs.projectId, runs.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'gtm_raw_snapshots_project_connection_fk',
    columns: [table.projectId, table.connectionId],
    foreignColumns: [gtmConnections.projectId, gtmConnections.id],
  }).onDelete('cascade'),
])

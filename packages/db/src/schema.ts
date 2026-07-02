import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { BacklinkSource, ContentBriefDto, DiscoveryCompetitorMapEntry, DiscoveryCompetitorType, LocationContext, ProviderName, SiteAuditCrossCuttingIssueDto, SiteAuditFactorSummaryDto, SiteAuditPageFactorDto } from '@ainyc/canonry-contracts'

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
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_runs_project').on(table.projectId),
  index('idx_runs_status').on(table.status),
  index('idx_runs_source').on(table.sourceId),
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
  citationState: text('citation_state').notNull(),
  answerMentioned: integer('answer_mentioned', { mode: 'boolean' }),
  answerText: text('answer_text'),
  citedDomains: text('cited_domains', { mode: 'json' }).$type<string[]>().notNull().default([]),
  competitorOverlap: text('competitor_overlap', { mode: 'json' }).$type<string[]>().notNull().default([]),
  recommendedCompetitors: text('recommended_competitors', { mode: 'json' }).$type<string[]>().notNull().default([]),
  location: text('location'),
  screenshotPath: text('screenshot_path'),
  rawResponse: text('raw_response'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_snapshots_run').on(table.runId),
  index('idx_snapshots_query').on(table.queryId),
  index('idx_snapshots_citation_state').on(table.citationState),
  index('idx_snapshots_provider_model').on(table.provider, table.model),
  index('idx_snapshots_location').on(table.location),
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

export const gaAiReferrals = sqliteTable('ga_ai_referrals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  source: text('source').notNull(),
  medium: text('medium').notNull(),
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
  lastError: text('last_error'),
  // JSON-encoded array of normalized event IDs (e.g. `cloud-run:<ts>:<insertId>`)
  // observed in the most recent successful sync. Bounded ring buffer used to
  // dedupe across sync runs at the boundary timestamp where lastSyncedAt
  // clamping alone leaves a small overlap window.
  lastEventIds: text('last_event_ids', { mode: 'json' }).$type<string[]>(),
  archivedAt: text('archived_at'),
  configJson: text('config_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_traffic_sources_project').on(table.projectId),
  index('idx_traffic_sources_project_status').on(table.projectId, table.status),
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
// Default retention is 30 days; older rows are pruned out-of-band.
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
  lastSyncedAt: text('last_synced_at'),
  conversionTrackingConfigured: integer('conversion_tracking_configured', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_ads_conn_project').on(table.projectId),
])

// Entity snapshots refreshed on every ads-sync (range-replaced per project) so
// dashboards and the paid/organic overlap can read campaign structure without
// live API calls. Ids are the upstream ids (cmpn_… / adgrp_… / ad_…). Money
// columns are integer micros, mirroring the upstream budget/bid units.
export const adsCampaigns = sqliteTable('ads_campaigns', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status').notNull(),
  biddingType: text('bidding_type'),
  dailySpendLimitMicros: integer('daily_spend_limit_micros'),
  lifetimeSpendLimitMicros: integer('lifetime_spend_limit_micros'),
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

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  canonicalDomain: text('canonical_domain').notNull(),
  ownedDomains: text('owned_domains').notNull().default('[]'),
  country: text('country').notNull(),
  language: text('language').notNull(),
  tags: text('tags').notNull().default('[]'),
  labels: text('labels').notNull().default('{}'),
  providers: text('providers').notNull().default('[]'),
  locations: text('locations').notNull().default('[]'),
  defaultLocation: text('default_location'),
  autoExtractBacklinks: integer('auto_extract_backlinks').notNull().default(0),
  configSource: text('config_source').notNull().default('cli'),
  configRevision: integer('config_revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const keywords = sqliteTable('keywords', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  keyword: text('keyword').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_keywords_project').on(table.projectId),
  uniqueIndex('idx_keywords_project_keyword').on(table.projectId, table.keyword),
])

export const competitors = sqliteTable('competitors', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
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
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_runs_project').on(table.projectId),
  index('idx_runs_status').on(table.status),
])

export const querySnapshots = sqliteTable('query_snapshots', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  keywordId: text('keyword_id').notNull().references(() => keywords.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('gemini'),
  model: text('model'),
  citationState: text('citation_state').notNull(),
  answerMentioned: integer('answer_mentioned', { mode: 'boolean' }),
  answerText: text('answer_text'),
  citedDomains: text('cited_domains').notNull().default('[]'),
  competitorOverlap: text('competitor_overlap').notNull().default('[]'),
  recommendedCompetitors: text('recommended_competitors').notNull().default('[]'),
  location: text('location'),
  screenshotPath: text('screenshot_path'),
  rawResponse: text('raw_response'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_snapshots_run').on(table.runId),
  index('idx_snapshots_keyword').on(table.keywordId),
  index('idx_snapshots_citation_state').on(table.citationState),
  index('idx_snapshots_provider_model').on(table.provider, table.model),
  index('idx_snapshots_location').on(table.location),
  index('idx_snapshots_created_at').on(table.createdAt),
])

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  diff: text('diff'),
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
  scopes: text('scopes').notNull().default('["*"]'),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('idx_api_keys_prefix').on(table.keyPrefix),
])

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  cronExpr: text('cron_expr').notNull(),
  preset: text('preset'),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: integer('enabled').notNull().default(1),
  providers: text('providers').notNull().default('[]'),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_schedules_project').on(table.projectId),
])

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  config: text('config').notNull(),
  webhookSecret: text('webhook_secret'),
  enabled: integer('enabled').notNull().default(1),
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
  scopes: text('scopes').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_google_conn_domain_type').on(table.domain, table.connectionType),
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
  isMobileFriendly: integer('is_mobile_friendly'),
  richResults: text('rich_results').notNull().default('[]'),
  referringUrls: text('referring_urls').notNull().default('[]'),
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
  reasonBreakdown: text('reason_breakdown').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_gsc_coverage_snap_project_date').on(table.projectId, table.date),
  index('idx_gsc_coverage_snap_run').on(table.syncRunId),
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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_bing_conn_domain').on(table.domain),
])

export const bingUrlInspections = sqliteTable('bing_url_inspections', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  httpCode: integer('http_code'),
  inIndex: integer('in_index'),
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
  sessions: integer('sessions').notNull().default(0),
  organicSessions: integer('organic_sessions').notNull().default(0),
  users: integer('users').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
}, (table) => [
  index('idx_ga_traffic_project_date').on(table.projectId, table.date),
  index('idx_ga_traffic_page').on(table.landingPage),
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
  sessions: integer('sessions').notNull().default(0),
  users: integer('users').notNull().default(0),
  syncedAt: text('synced_at').notNull(),
  syncRunId: text('sync_run_id').references(() => runs.id, { onDelete: 'cascade' }),
}, (table) => [
  index('idx_ga_ai_ref_project_date').on(table.projectId, table.date),
  index('idx_ga_ai_ref_source').on(table.source),
  uniqueIndex('idx_ga_ai_ref_unique_v2').on(table.projectId, table.date, table.source, table.medium, table.sourceDimension),
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
  keyword: text('keyword').notNull(),
  provider: text('provider').notNull(),
  recommendation: text('recommendation'),
  cause: text('cause'),
  dismissed: integer('dismissed', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_insights_project').on(table.projectId),
  index('idx_insights_run').on(table.runId),
  index('idx_insights_created').on(table.createdAt),
  index('idx_insights_keyword_provider').on(table.keyword, table.provider),
])

export const healthSnapshots = sqliteTable('health_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
  overallCitedRate: text('overall_cited_rate').notNull(),
  totalPairs: integer('total_pairs').notNull(),
  citedPairs: integer('cited_pairs').notNull(),
  providerBreakdown: text('provider_breakdown').notNull().default('{}'),
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
  releaseSyncId: text('release_sync_id').notNull().references(() => ccReleaseSyncs.id, { onDelete: 'cascade' }),
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
  uniqueIndex('idx_backlink_domains_unique').on(table.projectId, table.release, table.linkingDomain),
])

export const backlinkSummaries = sqliteTable('backlink_summaries', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  releaseSyncId: text('release_sync_id').notNull().references(() => ccReleaseSyncs.id, { onDelete: 'cascade' }),
  release: text('release').notNull(),
  targetDomain: text('target_domain').notNull(),
  totalLinkingDomains: integer('total_linking_domains').notNull(),
  totalHosts: integer('total_hosts').notNull(),
  top10HostsShare: text('top_10_hosts_share').notNull(),
  queriedAt: text('queried_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_backlink_summaries_project_release').on(table.projectId, table.release),
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

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
  answerText: text('answer_text'),
  citedDomains: text('cited_domains').notNull().default('[]'),
  competitorOverlap: text('competitor_overlap').notNull().default('[]'),
  rawResponse: text('raw_response'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_snapshots_run').on(table.runId),
  index('idx_snapshots_keyword').on(table.keywordId),
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
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: text('token_expires_at'),
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

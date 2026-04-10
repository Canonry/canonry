import { sql } from 'drizzle-orm'
import type { DatabaseClient } from './client.js'

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  canonical_domain  TEXT NOT NULL,
  owned_domains     TEXT NOT NULL DEFAULT '[]',
  country           TEXT NOT NULL,
  language          TEXT NOT NULL,
  tags              TEXT NOT NULL DEFAULT '[]',
  labels            TEXT NOT NULL DEFAULT '{}',
  providers         TEXT NOT NULL DEFAULT '[]',
  config_source     TEXT NOT NULL DEFAULT 'cli',
  config_revision   INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keywords (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  keyword     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(project_id, keyword)
);

CREATE TABLE IF NOT EXISTS competitors (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(project_id, domain)
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'answer-visibility',
  status      TEXT NOT NULL DEFAULT 'queued',
  trigger     TEXT NOT NULL DEFAULT 'manual',
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS query_snapshots (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  keyword_id          TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'gemini',
  citation_state      TEXT NOT NULL,
  answer_text         TEXT,
  cited_domains       TEXT NOT NULL DEFAULT '[]',
  competitor_overlap  TEXT NOT NULL DEFAULT '[]',
  raw_response        TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  diff        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '["*"]',
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS usage_counters (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  period      TEXT NOT NULL,
  metric      TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  UNIQUE(scope, period, metric)
);

CREATE INDEX IF NOT EXISTS idx_keywords_project ON keywords(project_id);
CREATE INDEX IF NOT EXISTS idx_competitors_project ON competitors(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_snapshots_run ON query_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_keyword ON query_snapshots(keyword_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cron_expr   TEXT NOT NULL,
  preset      TEXT,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  enabled     INTEGER NOT NULL DEFAULT 1,
  providers   TEXT NOT NULL DEFAULT '[]',
  last_run_at TEXT,
  next_run_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(project_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  config      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_usage_scope_period ON usage_counters(scope, period);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_id);
CREATE INDEX IF NOT EXISTS idx_notifications_project ON notifications(project_id);
`

const MIGRATIONS = [
  // v2: Add providers column to projects for multi-provider support
  `ALTER TABLE projects ADD COLUMN providers TEXT NOT NULL DEFAULT '[]'`,
  // v3: Add webhook_secret column to notifications for HMAC signing
  `ALTER TABLE notifications ADD COLUMN webhook_secret TEXT`,
  // v4: Add owned_domains column to projects for multi-domain citation matching
  `ALTER TABLE projects ADD COLUMN owned_domains TEXT NOT NULL DEFAULT '[]'`,
  // v5: Add model column to query_snapshots for per-model scoring
  `ALTER TABLE query_snapshots ADD COLUMN model TEXT`,
  // v5b: Backfill model from rawResponse JSON for existing snapshots
  `UPDATE query_snapshots SET model = json_extract(raw_response, '$.model') WHERE model IS NULL AND raw_response IS NOT NULL AND json_extract(raw_response, '$.model') IS NOT NULL`,
  // v6: Google Search Console integration — google_connections table (domain-scoped)
  // WARNING: access_token, refresh_token are authentication material; consider storing in config.yaml per CLAUDE.md
  `CREATE TABLE IF NOT EXISTS google_connections (
    id              TEXT PRIMARY KEY,
    domain          TEXT NOT NULL,
    connection_type TEXT NOT NULL,
    property_id     TEXT,
    access_token    TEXT,
    refresh_token   TEXT,
    token_expires_at TEXT,
    scopes          TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_google_conn_domain_type ON google_connections(domain, connection_type)`,
  // v6: Google Search Console integration — gsc_search_data table
  `CREATE TABLE IF NOT EXISTS gsc_search_data (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sync_run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    date          TEXT NOT NULL,
    query         TEXT NOT NULL,
    page          TEXT NOT NULL,
    country       TEXT,
    device        TEXT,
    clicks        INTEGER NOT NULL DEFAULT 0,
    impressions   INTEGER NOT NULL DEFAULT 0,
    ctr           TEXT NOT NULL DEFAULT '0',
    position      TEXT NOT NULL DEFAULT '0',
    created_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gsc_search_project_date ON gsc_search_data(project_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_gsc_search_query ON gsc_search_data(query)`,
  `CREATE INDEX IF NOT EXISTS idx_gsc_search_run ON gsc_search_data(sync_run_id)`,
  // v6: Google Search Console integration — gsc_url_inspections table
  `CREATE TABLE IF NOT EXISTS gsc_url_inspections (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sync_run_id       TEXT REFERENCES runs(id) ON DELETE CASCADE,
    url               TEXT NOT NULL,
    indexing_state    TEXT,
    verdict           TEXT,
    coverage_state    TEXT,
    page_fetch_state  TEXT,
    robots_txt_state  TEXT,
    crawl_time        TEXT,
    last_crawl_result TEXT,
    is_mobile_friendly INTEGER,
    rich_results      TEXT NOT NULL DEFAULT '[]',
    referring_urls    TEXT NOT NULL DEFAULT '[]',
    inspected_at      TEXT NOT NULL,
    created_at        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gsc_inspect_project_url ON gsc_url_inspections(project_id, url)`,
  `CREATE INDEX IF NOT EXISTS idx_gsc_inspect_run ON gsc_url_inspections(sync_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_gsc_inspect_url_time ON gsc_url_inspections(url, inspected_at)`,
  // v7: GSC coverage snapshots for historical tracking
  `CREATE TABLE IF NOT EXISTS gsc_coverage_snapshots (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sync_run_id     TEXT REFERENCES runs(id) ON DELETE CASCADE,
    date            TEXT NOT NULL,
    indexed         INTEGER NOT NULL DEFAULT 0,
    not_indexed     INTEGER NOT NULL DEFAULT 0,
    reason_breakdown TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gsc_coverage_snap_project_date ON gsc_coverage_snapshots(project_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_gsc_coverage_snap_run ON gsc_coverage_snapshots(sync_run_id)`,
  // v8: Location-aware sweeps — project locations + snapshot location tag
  `ALTER TABLE projects ADD COLUMN locations TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE projects ADD COLUMN default_location TEXT`,
  `ALTER TABLE query_snapshots ADD COLUMN location TEXT`,
  // v9: Add location column to runs for per-location run tracking
  `ALTER TABLE runs ADD COLUMN location TEXT`,
  // v10: Add sitemapUrl to google_connections for persistent sitemap storage
  `ALTER TABLE google_connections ADD COLUMN sitemap_url TEXT`,
  // v11: CDP browser provider — screenshot path for captured evidence
  `ALTER TABLE query_snapshots ADD COLUMN screenshot_path TEXT`,
  // v12: Bing Webmaster Tools — bing_connections table
  `CREATE TABLE IF NOT EXISTS bing_connections (
    id          TEXT PRIMARY KEY,
    domain      TEXT NOT NULL,
    site_url    TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bing_conn_domain ON bing_connections(domain)`,
  // v12: Bing Webmaster Tools — bing_url_inspections table
  `CREATE TABLE IF NOT EXISTS bing_url_inspections (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url               TEXT NOT NULL,
    http_code         INTEGER,
    in_index          INTEGER,
    last_crawled_date TEXT,
    in_index_date     TEXT,
    inspected_at      TEXT NOT NULL,
    created_at        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bing_inspect_project_url ON bing_url_inspections(project_id, url)`,
  `CREATE INDEX IF NOT EXISTS idx_bing_inspect_url_time ON bing_url_inspections(url, inspected_at)`,
  // v12: Bing Webmaster Tools — bing_keyword_stats table
  `CREATE TABLE IF NOT EXISTS bing_keyword_stats (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    query            TEXT NOT NULL,
    impressions      INTEGER NOT NULL DEFAULT 0,
    clicks           INTEGER NOT NULL DEFAULT 0,
    ctr              TEXT NOT NULL DEFAULT '0',
    average_position TEXT NOT NULL DEFAULT '0',
    synced_at        TEXT NOT NULL,
    created_at       TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bing_keyword_project ON bing_keyword_stats(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bing_keyword_query ON bing_keyword_stats(query)`,
  // v13: Google Analytics 4 — ga_connections table (service account auth)
  // WARNING: private_key is authentication material; consider storing in config.yaml per CLAUDE.md
  `CREATE TABLE IF NOT EXISTS ga_connections (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    property_id   TEXT NOT NULL,
    client_email  TEXT NOT NULL,
    private_key   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_conn_project ON ga_connections(project_id)`,
  // v13: Google Analytics 4 — ga_traffic_snapshots table
  `CREATE TABLE IF NOT EXISTS ga_traffic_snapshots (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date             TEXT NOT NULL,
    landing_page     TEXT NOT NULL,
    sessions         INTEGER NOT NULL DEFAULT 0,
    organic_sessions INTEGER NOT NULL DEFAULT 0,
    users            INTEGER NOT NULL DEFAULT 0,
    synced_at        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ga_traffic_project_date ON ga_traffic_snapshots(project_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_ga_traffic_page ON ga_traffic_snapshots(landing_page)`,
  // v14: GA4 aggregate summaries — stores true unique user count per sync period
  `CREATE TABLE IF NOT EXISTS ga_traffic_summaries (
    id                     TEXT PRIMARY KEY,
    project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period_start           TEXT NOT NULL,
    period_end             TEXT NOT NULL,
    total_sessions         INTEGER NOT NULL DEFAULT 0,
    total_organic_sessions INTEGER NOT NULL DEFAULT 0,
    total_users            INTEGER NOT NULL DEFAULT 0,
    synced_at              TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ga_summary_project ON ga_traffic_summaries(project_id)`,
  // v15: Bing URL inspections — document_size, anchor_count, discovery_date columns
  `ALTER TABLE bing_url_inspections ADD COLUMN document_size INTEGER`,
  `ALTER TABLE bing_url_inspections ADD COLUMN anchor_count INTEGER`,
  `ALTER TABLE bing_url_inspections ADD COLUMN discovery_date TEXT`,
  // v16: Recommended competitor names extracted from run answers
  `ALTER TABLE query_snapshots ADD COLUMN recommended_competitors TEXT NOT NULL DEFAULT '[]'`,
  // v17: GA4 AI referral tracking — ga_ai_referrals table
  `CREATE TABLE IF NOT EXISTS ga_ai_referrals (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    source      TEXT NOT NULL,
    medium      TEXT NOT NULL,
    sessions    INTEGER NOT NULL DEFAULT 0,
    users       INTEGER NOT NULL DEFAULT 0,
    synced_at   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ga_ai_ref_project_date ON ga_ai_referrals(project_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_ga_ai_ref_source ON ga_ai_referrals(source)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_ai_ref_unique ON ga_ai_referrals(project_id, date, source, medium)`,
  // v18: Answer-level visibility derived from answer text
  `ALTER TABLE query_snapshots ADD COLUMN answer_mentioned INTEGER`,
  // v19: Add named unique indexes and missing columns from early tables
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_keywords_project_keyword ON keywords(project_id, keyword)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_competitors_project_domain ON competitors(project_id, domain)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_scope_period_metric ON usage_counters(scope, period, metric)`,
  `ALTER TABLE projects ADD COLUMN config_source TEXT NOT NULL DEFAULT 'cli'`,
  `ALTER TABLE projects ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1`,

  // v20: Track which GA4 dimension produced each AI referral row
  // Values: 'session' (sessionSource), 'first_user' (firstUserSource), 'manual_utm' (manualSource/utm_source)
  `ALTER TABLE ga_ai_referrals ADD COLUMN source_dimension TEXT NOT NULL DEFAULT 'session'`,
  // Replace old unique index with one that includes source_dimension
  `DROP INDEX IF EXISTS idx_ga_ai_ref_unique`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_ai_ref_unique_v2 ON ga_ai_referrals(project_id, date, source, medium, source_dimension)`,

  // v21: Add missing indexes for query_snapshots filtering
  `CREATE INDEX IF NOT EXISTS idx_snapshots_citation_state ON query_snapshots(citation_state)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_provider_model ON query_snapshots(provider, model)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_location ON query_snapshots(location)`,

  // v22: Intelligence — insights table for regression/gain/opportunity tracking
  `CREATE TABLE IF NOT EXISTS insights (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    severity        TEXT NOT NULL,
    title           TEXT NOT NULL,
    keyword         TEXT NOT NULL,
    provider        TEXT NOT NULL,
    recommendation  TEXT,
    cause           TEXT,
    dismissed       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_insights_project ON insights(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_insights_created ON insights(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_insights_keyword_provider ON insights(keyword, provider)`,

  // v23: Intelligence — health_snapshots table for citation health over time
  `CREATE TABLE IF NOT EXISTS health_snapshots (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    overall_cited_rate  TEXT NOT NULL,
    total_pairs         INTEGER NOT NULL,
    cited_pairs         INTEGER NOT NULL,
    provider_breakdown  TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_health_snapshots_project ON health_snapshots(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_health_snapshots_created ON health_snapshots(created_at)`,

  // v24: Intelligence — add run_id to insights and health_snapshots for per-run correlation and idempotency
  `ALTER TABLE insights ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_insights_run ON insights(run_id)`,
  `ALTER TABLE health_snapshots ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_health_snapshots_run ON health_snapshots(run_id)`,

  // v25: Social media referral tracking — ga_social_referrals table
  // Uses GA4's native sessionDefaultChannelGroup for social classification
  `CREATE TABLE IF NOT EXISTS ga_social_referrals (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date            TEXT NOT NULL,
    source          TEXT NOT NULL,
    medium          TEXT NOT NULL,
    channel_group   TEXT NOT NULL DEFAULT 'Organic Social',
    sessions        INTEGER NOT NULL DEFAULT 0,
    users           INTEGER NOT NULL DEFAULT 0,
    synced_at       TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ga_social_ref_project_date ON ga_social_referrals(project_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_ga_social_ref_source ON ga_social_referrals(source)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_social_ref_unique ON ga_social_referrals(project_id, date, source, medium, channel_group)`,

  // v26: Bing coverage snapshots for historical tracking (mirrors gsc_coverage_snapshots)
  `CREATE TABLE IF NOT EXISTS bing_coverage_snapshots (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    date            TEXT NOT NULL,
    indexed         INTEGER NOT NULL DEFAULT 0,
    not_indexed     INTEGER NOT NULL DEFAULT 0,
    unknown         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bing_coverage_snap_project_date ON bing_coverage_snapshots(project_id, date)`,

  // v27: Credential columns removed from Drizzle schema — credentials now live in config.yaml.
  // Physical columns (access_token, refresh_token, token_expires_at on google_connections;
  // private_key on ga_connections) intentionally retained in DB for one-time migration in server.ts.
  // v28: Add sync_run_id to bing_url_inspections for tracking sync correlation
  `ALTER TABLE bing_url_inspections ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_bing_inspect_run ON bing_url_inspections(sync_run_id)`,

  // v29: Add sync_run_id to ga_traffic_snapshots for tracking sync correlation
  `ALTER TABLE ga_traffic_snapshots ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_ga_traffic_run ON ga_traffic_snapshots(sync_run_id)`,

  // v30: Add sync_run_id to ga_ai_referrals for tracking sync correlation
  `ALTER TABLE ga_ai_referrals ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_ga_ai_ref_run ON ga_ai_referrals(sync_run_id)`,

  // v31: Add sync_run_id to ga_social_referrals for tracking sync correlation
  `ALTER TABLE ga_social_referrals ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_ga_social_ref_run ON ga_social_referrals(sync_run_id)`,

  // v32: Add sync_run_id to ga_traffic_summaries for tracking sync correlation
  `ALTER TABLE ga_traffic_summaries ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_ga_summary_run ON ga_traffic_summaries(sync_run_id)`,

  // v33: Add sync_run_id to bing_coverage_snapshots for tracking sync correlation
  `ALTER TABLE bing_coverage_snapshots ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS idx_bing_coverage_snap_run ON bing_coverage_snapshots(sync_run_id)`,

  // v34: Rename unique index for bing_coverage_snapshots to follow convention
  `DROP INDEX IF EXISTS idx_bing_coverage_snap_project_date`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bing_coverage_snap_project_date_unique ON bing_coverage_snapshots(project_id, date)`,
]

/**
 * Returns true only when an error (or its cause chain) represents a SQLite
 * "duplicate column name" error — the expected idempotency signal for
 * ALTER TABLE ADD COLUMN statements that have already been applied.
 */
function isDuplicateColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.message.includes('duplicate column name')) return true
  // Drizzle wraps SqliteError in a DrizzleError; check the cause too.
  if (err.cause instanceof Error && err.cause.message.includes('duplicate column name')) return true
  return false
}

export function migrate(db: DatabaseClient) {
  const statements = MIGRATION_SQL.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const statement of statements) {
    db.run(sql.raw(statement))
  }

  // Run incremental migrations. Most statements use IF NOT EXISTS / IF EXISTS
  // and are fully idempotent. The only expected failure is ALTER TABLE ADD COLUMN
  // on an already-migrated database, where SQLite throws "duplicate column name".
  // Drizzle wraps the raw SqliteError inside a DrizzleError, so we check both the
  // top-level message and the cause. Any other error (syntax error, FK violation,
  // real migration bug) must propagate so the caller can surface it rather than
  // silently leaving the DB half-migrated.
  for (const migration of MIGRATIONS) {
    try {
      db.run(sql.raw(migration))
    } catch (err: unknown) {
      if (isDuplicateColumnError(err)) continue
      throw err
    }
  }
}

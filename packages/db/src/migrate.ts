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
]

export function migrate(db: DatabaseClient) {
  const statements = MIGRATION_SQL.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const statement of statements) {
    db.run(sql.raw(statement))
  }

  // Run incremental migrations (safe to re-run — ALTER TABLE ADD COLUMN
  // fails silently if the column already exists in SQLite)
  for (const migration of MIGRATIONS) {
    try {
      db.run(sql.raw(migration))
    } catch {
      // Column already exists — ignore
    }
  }
}

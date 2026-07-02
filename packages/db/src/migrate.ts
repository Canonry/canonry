import { sql } from 'drizzle-orm'
import type { DatabaseClient } from './client.js'
import { parseJsonColumn } from './json.js'

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

CREATE TABLE IF NOT EXISTS queries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(project_id, query)
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
  query_id            TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_queries_project ON queries(project_id);
CREATE INDEX IF NOT EXISTS idx_competitors_project ON competitors(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_snapshots_run ON query_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_query ON query_snapshots(query_id);
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
-- NOTE: the (project_id) UNIQUE INDEX that used to live here was replaced by
-- v53's (project_id, kind) index. MIGRATION_SQL re-runs on every boot, so we
-- must NOT recreate the single-column index — it would conflict with v53 and
-- break traffic-sync schedule creation.
CREATE INDEX IF NOT EXISTS idx_notifications_project ON notifications(project_id);

-- Migration tracking: records which version has been applied.
-- On boot only versions > max applied version are run.
CREATE TABLE IF NOT EXISTS _migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`

/**
 * Subset of the drizzle DB API that's usable inside a transaction. The full
 * `DatabaseClient` type is the top-level drizzle instance which can't be
 * assigned from `db.transaction((tx) => ...)`'s `tx` argument.
 */
type MigrationDb = Pick<DatabaseClient, 'run' | 'all'>

/**
 * Each entry describes one migration version.  Statements are run in order
 * within the version; if any fail the version is not recorded, leaving it
 * pending for the next boot.  Long-running statements (e.g. large UPDATEs)
 * should be idempotent so they produce no side-effects on re-run.
 *
 * `run` is an optional escape hatch for migrations that need runtime
 * conditionals. It runs after `statements` within the same transaction.
 */
export interface MigrationVersion {
  version: number
  name: string
  statements: string[]
  run?: (tx: MigrationDb) => void
}

export const MIGRATION_VERSIONS: ReadonlyArray<MigrationVersion> = [
  {
    version: 2,
    name: 'add-providers-column',
    statements: [
      `ALTER TABLE projects ADD COLUMN providers TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    version: 3,
    name: 'add-webhook-secret',
    statements: [
      `ALTER TABLE notifications ADD COLUMN webhook_secret TEXT`,
    ],
  },
  {
    version: 4,
    name: 'add-owned-domains',
    statements: [
      `ALTER TABLE projects ADD COLUMN owned_domains TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    version: 5,
    name: 'add-snapshot-model',
    statements: [
      `ALTER TABLE query_snapshots ADD COLUMN model TEXT`,
      `UPDATE query_snapshots SET model = json_extract(raw_response, '$.model') WHERE model IS NULL AND raw_response IS NOT NULL AND json_extract(raw_response, '$.model') IS NOT NULL`,
    ],
  },
  {
    version: 6,
    name: 'gsc-integration',
    statements: [
      // google_connections (domain-scoped)
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
      // gsc_search_data
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
      // gsc_url_inspections
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
    ],
  },
  {
    version: 7,
    name: 'gsc-coverage-snapshots',
    statements: [
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
    ],
  },
  {
    version: 8,
    name: 'location-aware-sweeps',
    statements: [
      `ALTER TABLE projects ADD COLUMN locations TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE projects ADD COLUMN default_location TEXT`,
      `ALTER TABLE query_snapshots ADD COLUMN location TEXT`,
    ],
  },
  {
    version: 9,
    name: 'add-run-location',
    statements: [
      `ALTER TABLE runs ADD COLUMN location TEXT`,
    ],
  },
  {
    version: 10,
    name: 'add-sitemap-url',
    statements: [
      `ALTER TABLE google_connections ADD COLUMN sitemap_url TEXT`,
    ],
  },
  {
    version: 11,
    name: 'add-screenshot-path',
    statements: [
      `ALTER TABLE query_snapshots ADD COLUMN screenshot_path TEXT`,
    ],
  },
  {
    version: 12,
    name: 'bing-wmt-integration',
    statements: [
      // bing_connections
      `CREATE TABLE IF NOT EXISTS bing_connections (
        id          TEXT PRIMARY KEY,
        domain      TEXT NOT NULL,
        site_url    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_bing_conn_domain ON bing_connections(domain)`,
      // bing_url_inspections
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
      // bing_keyword_stats
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
    ],
  },
  {
    version: 13,
    name: 'ga4-integration',
    statements: [
      // ga_connections
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
      // ga_traffic_snapshots
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
    ],
  },
  {
    version: 14,
    name: 'ga4-traffic-summaries',
    statements: [
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
    ],
  },
  {
    version: 15,
    name: 'bing-inspect-columns',
    statements: [
      `ALTER TABLE bing_url_inspections ADD COLUMN document_size INTEGER`,
      `ALTER TABLE bing_url_inspections ADD COLUMN anchor_count INTEGER`,
      `ALTER TABLE bing_url_inspections ADD COLUMN discovery_date TEXT`,
    ],
  },
  {
    version: 16,
    name: 'recommended-competitors',
    statements: [
      `ALTER TABLE query_snapshots ADD COLUMN recommended_competitors TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    version: 17,
    name: 'ga4-ai-referrals',
    statements: [
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
    ],
  },
  {
    version: 18,
    name: 'answer-mentioned',
    statements: [
      `ALTER TABLE query_snapshots ADD COLUMN answer_mentioned INTEGER`,
    ],
  },
  {
    version: 19,
    name: 'named-unique-indexes',
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_queries_project_query ON queries(project_id, query)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_competitors_project_domain ON competitors(project_id, domain)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_scope_period_metric ON usage_counters(scope, period, metric)`,
      `ALTER TABLE projects ADD COLUMN config_source TEXT NOT NULL DEFAULT 'cli'`,
      `ALTER TABLE projects ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1`,
    ],
  },
  {
    version: 20,
    name: 'ga4-source-dimension',
    statements: [
      // Values: 'session' (sessionSource), 'first_user' (firstUserSource), 'manual_utm' (manualSource/utm_source)
      `ALTER TABLE ga_ai_referrals ADD COLUMN source_dimension TEXT NOT NULL DEFAULT 'session'`,
      // Adopt the widened unique key (now including source_dimension). This
      // version intentionally does NOT drop the prior narrow index
      // idx_ga_ai_ref_unique — the original v17 + v20 pair did, but replaying
      // that pair on a DB where data has since accumulated duplicates on the
      // narrow key would crash (the bug this PR fixes). Any DB that ran the
      // historical v20 once already has the narrow index gone; brand-new DBs
      // never create it because v17 was rewritten to omit it. Anything else
      // is repaired by v46, which drops idx_ga_ai_ref_unique_v2 and lands on
      // the final (…, source_dimension, landing_page) index.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_ai_ref_unique_v2 ON ga_ai_referrals(project_id, date, source, medium, source_dimension)`,
    ],
  },
  {
    version: 21,
    name: 'snapshot-filtering-indexes',
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_snapshots_citation_state ON query_snapshots(citation_state)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_provider_model ON query_snapshots(provider, model)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_location ON query_snapshots(location)`,
    ],
  },
  {
    version: 22,
    name: 'insights-table',
    statements: [
      `CREATE TABLE IF NOT EXISTS insights (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type            TEXT NOT NULL,
        severity        TEXT NOT NULL,
        title           TEXT NOT NULL,
        query           TEXT NOT NULL,
        provider        TEXT NOT NULL,
        recommendation  TEXT,
        cause           TEXT,
        dismissed       INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_insights_project ON insights(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_insights_created ON insights(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_insights_query_provider ON insights(query, provider)`,
    ],
  },
  {
    version: 23,
    name: 'health-snapshots-table',
    statements: [
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
    ],
  },
  {
    version: 24,
    name: 'intelligence-run-id',
    statements: [
      `ALTER TABLE insights ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_insights_run ON insights(run_id)`,
      `ALTER TABLE health_snapshots ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_health_snapshots_run ON health_snapshots(run_id)`,
    ],
  },
  {
    version: 25,
    name: 'ga4-social-referrals',
    statements: [
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
    ],
  },
  {
    version: 26,
    name: 'bing-coverage-snapshots',
    statements: [
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
    ],
  },
  {
    version: 27,
    name: 'credential-columns-removed-from-schema',
    statements: [
      // Credential columns removed from Drizzle schema — credentials now live in config.yaml.
      // Physical columns intentionally retained for one-time migration by server.ts.
      // No DDL statements needed.
    ],
  },
  {
    version: 28,
    name: 'sync-run-id-bing-inspect',
    statements: [
      `ALTER TABLE bing_url_inspections ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_bing_inspect_run ON bing_url_inspections(sync_run_id)`,
    ],
  },
  {
    version: 29,
    name: 'sync-run-id-ga-traffic',
    statements: [
      `ALTER TABLE ga_traffic_snapshots ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_ga_traffic_run ON ga_traffic_snapshots(sync_run_id)`,
    ],
  },
  {
    version: 30,
    name: 'sync-run-id-ga-ai-ref',
    statements: [
      `ALTER TABLE ga_ai_referrals ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_ga_ai_ref_run ON ga_ai_referrals(sync_run_id)`,
    ],
  },
  {
    version: 31,
    name: 'sync-run-id-ga-social-ref',
    statements: [
      `ALTER TABLE ga_social_referrals ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_ga_social_ref_run ON ga_social_referrals(sync_run_id)`,
    ],
  },
  {
    version: 32,
    name: 'sync-run-id-ga-summary',
    statements: [
      `ALTER TABLE ga_traffic_summaries ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_ga_summary_run ON ga_traffic_summaries(sync_run_id)`,
    ],
  },
  {
    version: 33,
    name: 'sync-run-id-bing-coverage',
    statements: [
      `ALTER TABLE bing_coverage_snapshots ADD COLUMN sync_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_bing_coverage_snap_run ON bing_coverage_snapshots(sync_run_id)`,
    ],
  },
  {
    version: 34,
    name: 'bing-coverage-index-rename',
    statements: [
      `DROP INDEX IF EXISTS idx_bing_coverage_snap_project_date`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_bing_coverage_snap_project_date_unique ON bing_coverage_snapshots(project_id, date)`,
    ],
  },
  {
    version: 35,
    name: 'snapshot-created-at-index',
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON query_snapshots(created_at)`,
    ],
  },
  {
    version: 36,
    name: 'sql-injection-review',
    statements: [
      // Transaction handling and SQL injection review: verified all strings
      // use SQLite ? binding via Drizzle. No parameterization changes needed.
    ],
  },
  {
    version: 37,
    name: 'legacy-credential-cleanup',
    statements: [
      // The legacy credential columns (private_key on ga_connections; access_token,
      // refresh_token, token_expires_at on google_connections) are removed by the
      // extractLegacyCredentials / dropLegacyCredentialColumns pair.
      // Callers read the rows, persist them to config.yaml, and only then drop
      // the columns so a failed config write doesn't permanently lose credentials.
      // No DDL statements here — columns are dropped via exported functions below.
    ],
  },
  {
    version: 38,
    name: 'agent-sessions',
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_sessions (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        system_prompt     TEXT NOT NULL,
        model_provider    TEXT NOT NULL,
        model_id          TEXT NOT NULL,
        messages          TEXT NOT NULL DEFAULT '[]',
        follow_up_queue   TEXT NOT NULL DEFAULT '[]',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at)`,
    ],
  },
  {
    version: 39,
    name: 'aero-provider-rename',
    statements: [
      // Align Aero provider IDs with sweep naming — anthropic→claude, google→gemini.
      // Idempotent: the UPDATE is a no-op once the rename has been applied.
      `UPDATE agent_sessions SET model_provider = 'claude' WHERE model_provider = 'anthropic'`,
      `UPDATE agent_sessions SET model_provider = 'gemini' WHERE model_provider = 'google'`,
    ],
  },
  {
    version: 40,
    name: 'agent-memory',
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_memory (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_memory_project_key
        ON agent_memory(project_id, key)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_memory_project_updated
        ON agent_memory(project_id, updated_at)`,
    ],
  },
  {
    version: 41,
    name: 'common-crawl-backlinks',
    statements: [
      // cc_release_syncs
      `CREATE TABLE IF NOT EXISTS cc_release_syncs (
        id                      TEXT PRIMARY KEY,
        release                 TEXT NOT NULL UNIQUE,
        status                  TEXT NOT NULL,
        phase_detail            TEXT,
        vertex_path             TEXT,
        edges_path              TEXT,
        vertex_sha256           TEXT,
        edges_sha256            TEXT,
        vertex_bytes            INTEGER,
        edges_bytes             INTEGER,
        projects_processed      INTEGER,
        domains_discovered      INTEGER,
        download_started_at     TEXT,
        download_finished_at    TEXT,
        query_started_at        TEXT,
        query_finished_at       TEXT,
        error                   TEXT,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cc_release_syncs_status ON cc_release_syncs(status)`,
      // backlink_domains
      `CREATE TABLE IF NOT EXISTS backlink_domains (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        release_sync_id  TEXT NOT NULL REFERENCES cc_release_syncs(id) ON DELETE CASCADE,
        release          TEXT NOT NULL,
        target_domain    TEXT NOT NULL,
        linking_domain   TEXT NOT NULL,
        num_hosts        INTEGER NOT NULL,
        created_at       TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_backlink_domains_project ON backlink_domains(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_backlink_domains_release_sync ON backlink_domains(release_sync_id)`,
      `CREATE INDEX IF NOT EXISTS idx_backlink_domains_project_release ON backlink_domains(project_id, release)`,
      `CREATE INDEX IF NOT EXISTS idx_backlink_domains_hosts ON backlink_domains(num_hosts)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_backlink_domains_unique ON backlink_domains(project_id, release, linking_domain)`,
      // backlink_summaries
      `CREATE TABLE IF NOT EXISTS backlink_summaries (
        id                       TEXT PRIMARY KEY,
        project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        release_sync_id          TEXT NOT NULL REFERENCES cc_release_syncs(id) ON DELETE CASCADE,
        release                  TEXT NOT NULL,
        target_domain            TEXT NOT NULL,
        total_linking_domains    INTEGER NOT NULL,
        total_hosts              INTEGER NOT NULL,
        top_10_hosts_share       TEXT NOT NULL,
        queried_at               TEXT NOT NULL,
        created_at               TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_backlink_summaries_project_release ON backlink_summaries(project_id, release)`,
      `CREATE INDEX IF NOT EXISTS idx_backlink_summaries_project ON backlink_summaries(project_id)`,
    ],
  },
  {
    version: 42,
    name: 'auto-extract-backlinks',
    statements: [
      `ALTER TABLE projects ADD COLUMN auto_extract_backlinks INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 43,
    name: 'backfill-bing-in-index',
    statements: [
      // Backfill bing_url_inspections.in_index using the new crawl-signal
      // decision tree. Uses a created_at cutoff so rows written by the new
      // code (which applies a live GetCrawlIssues demotion that can't be
      // replayed offline) are preserved.
      `UPDATE bing_url_inspections
       SET in_index = CASE
         WHEN document_size IS NOT NULL AND document_size > 0 THEN 1
         WHEN last_crawled_date IS NOT NULL AND http_code IS NOT NULL AND http_code >= 400 THEN 0
         WHEN last_crawled_date IS NOT NULL THEN 1
         WHEN discovery_date IS NOT NULL THEN 0
         ELSE NULL
       END
       WHERE created_at < '2026-04-22T00:00:00Z'`,
    ],
  },
  {
    version: 44,
    name: 'ga-traffic-landing-normalized',
    statements: [
      `ALTER TABLE ga_traffic_snapshots ADD COLUMN landing_page_normalized TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_ga_traffic_page_normalized
         ON ga_traffic_snapshots(project_id, date, landing_page_normalized)`,
    ],
  },
  {
    version: 45,
    name: 'ga-traffic-direct-sessions',
    statements: [
      `ALTER TABLE ga_traffic_snapshots ADD COLUMN direct_sessions INTEGER`,
    ],
  },
  {
    version: 46,
    name: 'ga-ai-landing-page',
    statements: [
      `ALTER TABLE ga_ai_referrals ADD COLUMN landing_page TEXT NOT NULL DEFAULT '(not set)'`,
      `ALTER TABLE ga_ai_referrals ADD COLUMN landing_page_normalized TEXT`,
      `DROP INDEX IF EXISTS idx_ga_ai_ref_unique_v2`,
      `CREATE INDEX IF NOT EXISTS idx_ga_ai_ref_landing_page
         ON ga_ai_referrals(project_id, date, landing_page_normalized)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_ai_ref_unique_v3
         ON ga_ai_referrals(project_id, date, source, medium, source_dimension, landing_page)`,
    ],
  },
  {
    version: 47,
    name: 'ga-traffic-window-summaries',
    statements: [
      `CREATE TABLE IF NOT EXISTS ga_traffic_window_summaries (
        id                       TEXT PRIMARY KEY,
        project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        window_key               TEXT NOT NULL,
        period_start             TEXT NOT NULL,
        period_end               TEXT NOT NULL,
        total_sessions           INTEGER NOT NULL DEFAULT 0,
        total_organic_sessions   INTEGER NOT NULL DEFAULT 0,
        total_direct_sessions    INTEGER NOT NULL DEFAULT 0,
        total_users              INTEGER NOT NULL DEFAULT 0,
        synced_at                TEXT NOT NULL,
        sync_run_id              TEXT REFERENCES runs(id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_window_summary_unique
         ON ga_traffic_window_summaries(project_id, window_key)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_window_summary_run
         ON ga_traffic_window_summaries(sync_run_id)`,
    ],
  },
  {
    version: 48,
    name: 'rename-keywords-to-queries',
    // The actual legacy rename runs before bootstrap SQL so existing DBs never
    // see new-name indexes before their old columns have been renamed. This
    // version records the schema cutover and lands the final index names.
    statements: [
      `DROP INDEX IF EXISTS idx_keywords_project`,
      `DROP INDEX IF EXISTS idx_keywords_project_keyword`,
      `DROP INDEX IF EXISTS idx_snapshots_keyword`,
      `DROP INDEX IF EXISTS idx_insights_keyword_provider`,
      `CREATE INDEX IF NOT EXISTS idx_queries_project ON queries(project_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_queries_project_query ON queries(project_id, query)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_query ON query_snapshots(query_id)`,
      `CREATE INDEX IF NOT EXISTS idx_insights_query_provider ON insights(query, provider)`,
    ],
    run: (tx) => {
      normalizeLegacyQuerySchema(tx)
    },
  },
  {
    version: 49,
    name: 'server-side-traffic-tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS traffic_sources (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_type     TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        status          TEXT NOT NULL,
        last_synced_at  TEXT,
        last_cursor     TEXT,
        last_error      TEXT,
        archived_at     TEXT,
        config_json     TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_traffic_sources_project ON traffic_sources(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_traffic_sources_project_status ON traffic_sources(project_id, status)`,
      `CREATE TABLE IF NOT EXISTS crawler_events_hourly (
        project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id            TEXT NOT NULL REFERENCES traffic_sources(id) ON DELETE CASCADE,
        ts_hour              TEXT NOT NULL,
        bot_id               TEXT NOT NULL,
        operator             TEXT NOT NULL,
        verification_status  TEXT NOT NULL,
        path_normalized      TEXT NOT NULL,
        status               INTEGER NOT NULL,
        hits                 INTEGER NOT NULL DEFAULT 0,
        sampled_user_agent   TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        PRIMARY KEY (project_id, source_id, ts_hour, bot_id, verification_status, path_normalized, status)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_crawler_hourly_project_ts ON crawler_events_hourly(project_id, ts_hour)`,
      `CREATE INDEX IF NOT EXISTS idx_crawler_hourly_path ON crawler_events_hourly(project_id, path_normalized)`,
      `CREATE TABLE IF NOT EXISTS ai_referral_events_hourly (
        project_id                 TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id                  TEXT NOT NULL REFERENCES traffic_sources(id) ON DELETE CASCADE,
        ts_hour                    TEXT NOT NULL,
        product                    TEXT NOT NULL,
        operator                   TEXT NOT NULL,
        source_domain              TEXT NOT NULL,
        evidence_type              TEXT NOT NULL,
        landing_path_normalized    TEXT NOT NULL,
        status                     INTEGER NOT NULL,
        sessions_or_hits           INTEGER NOT NULL DEFAULT 0,
        users_estimated            INTEGER,
        created_at                 TEXT NOT NULL,
        updated_at                 TEXT NOT NULL,
        PRIMARY KEY (project_id, source_id, ts_hour, product, source_domain, evidence_type, landing_path_normalized, status)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_referral_hourly_project_ts ON ai_referral_events_hourly(project_id, ts_hour)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_referral_hourly_landing ON ai_referral_events_hourly(project_id, landing_path_normalized)`,
      `CREATE TABLE IF NOT EXISTS raw_event_samples (
        id                        TEXT PRIMARY KEY,
        project_id                TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id                 TEXT NOT NULL REFERENCES traffic_sources(id) ON DELETE CASCADE,
        ts                        TEXT NOT NULL,
        event_type                TEXT NOT NULL,
        ip_hash                   TEXT,
        user_agent                TEXT,
        path_normalized           TEXT NOT NULL,
        status                    INTEGER,
        referer_host              TEXT,
        classifier_details_json   TEXT NOT NULL DEFAULT '{}',
        created_at                TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_raw_event_samples_project_ts ON raw_event_samples(project_id, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_raw_event_samples_source_ts ON raw_event_samples(source_id, ts)`,
      `CREATE INDEX IF NOT EXISTS idx_raw_event_samples_event_type ON raw_event_samples(event_type)`,
    ],
  },
  {
    version: 50,
    name: 'ga-ai-referral-channel-group',
    statements: [],
    run: (tx) => {
      if (!tableExists(tx, 'ga_ai_referrals')) return
      if (!columnExists(tx, 'ga_ai_referrals', 'channel_group')) {
        tx.run(sql.raw(`ALTER TABLE ga_ai_referrals ADD COLUMN channel_group TEXT NOT NULL DEFAULT '(not set)'`))
      }
      tx.run(sql.raw(`DROP INDEX IF EXISTS idx_ga_ai_ref_unique_v3`))
      tx.run(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_ai_ref_unique_v4
         ON ga_ai_referrals(project_id, date, source, medium, source_dimension, channel_group, landing_page)`))
    },
  },
  {
    version: 51,
    name: 'runs-source-id',
    statements: [
      `ALTER TABLE runs ADD COLUMN source_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source_id)`,
    ],
  },
  {
    version: 52,
    name: 'traffic-sources-last-event-ids',
    statements: [
      // JSON-encoded array of normalized event IDs from the previous sync,
      // used for cross-sync boundary-window dedupe so a longer default
      // sync window (or any overlapping re-sync) cannot double-count.
      `ALTER TABLE traffic_sources ADD COLUMN last_event_ids TEXT`,
    ],
  },
  {
    version: 53,
    name: 'schedules-kind-and-source',
    // The legacy schedules table carries an inline `UNIQUE(project_id)`
    // constraint (see MIGRATION_SQL). SQLite doesn't support dropping inline
    // table constraints, so we use the canonical table-rebuild pattern:
    // create a new table with the desired schema, copy the data, drop the
    // old, rename. All 4 statements run inside the migration runner's
    // single transaction so a partial failure rolls everything back.
    statements: [
      // (project_id, kind) uniqueness is enforced by the explicit
      // `CREATE UNIQUE INDEX idx_schedules_project_kind` below — that's the
      // canonical drizzle-side index name (see schema.ts), so don't duplicate
      // it as an inline UNIQUE() in CREATE TABLE.
      `CREATE TABLE IF NOT EXISTS schedules_v53 (
         id          TEXT PRIMARY KEY,
         project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         kind        TEXT NOT NULL DEFAULT 'answer-visibility',
         cron_expr   TEXT NOT NULL,
         preset      TEXT,
         timezone    TEXT NOT NULL DEFAULT 'UTC',
         enabled     INTEGER NOT NULL DEFAULT 1,
         providers   TEXT NOT NULL DEFAULT '[]',
         source_id   TEXT,
         last_run_at TEXT,
         next_run_at TEXT,
         created_at  TEXT NOT NULL,
         updated_at  TEXT NOT NULL
       )`,
      `INSERT INTO schedules_v53 (
         id, project_id, kind, cron_expr, preset, timezone, enabled,
         providers, source_id, last_run_at, next_run_at, created_at, updated_at
       )
       SELECT id, project_id, 'answer-visibility', cron_expr, preset, timezone, enabled,
              providers, NULL, last_run_at, next_run_at, created_at, updated_at
       FROM schedules`,
      `DROP TABLE schedules`,
      `ALTER TABLE schedules_v53 RENAME TO schedules`,
      // The legacy single-column unique index doesn't survive the table
      // rename, but explicitly DROP IF EXISTS to keep the migration
      // idempotent across edge-case re-runs.
      `DROP INDEX IF EXISTS idx_schedules_project`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_project_kind ON schedules(project_id, kind)`,
    ],
  },
  {
    version: 54,
    name: 'drop-resurrected-schedules-project-index',
    // v53 dropped `idx_schedules_project`, but `MIGRATION_SQL` (which runs on
    // every boot, before versioned migrations) was still creating it. On any
    // boot AFTER the one that applied v53, Phase 1 re-created the legacy
    // single-column UNIQUE index, which then collided with the new
    // (project_id, kind) semantics and broke traffic-sync schedule creation
    // (`UNIQUE constraint failed: schedules.project_id`). MIGRATION_SQL no
    // longer creates that index; this migration removes it from any DB that
    // already booted past v53 with the resurrected index.
    statements: [
      `DROP INDEX IF EXISTS idx_schedules_project`,
    ],
  },
  {
    version: 55,
    name: 'discovery-foundation',
    // Adds the three-ring discovery foundation: per-project ICP, query/competitor
    // provenance (so we can trace adopted basket entries back to a discovery
    // session), and the two tables that hold a discovery session's research
    // output. No UNIQUE(session_id, query) on discovery_probes — v2 will probe
    // the same query across multiple providers in the same session.
    //
    // `competitor_map` defaults to '[]' (JSON array) — see DTO
    // `discoveryCompetitorMapEntrySchema` for the entry shape `{domain, hits}`.
    // Backfill of `provenance='cli'` runs once: existing pre-v55 rows are
    // attributed to manual CLI entry so a future NULL distinctly means
    // "post-v55 row missing provenance" (a bug to catch in review).
    statements: [
      `ALTER TABLE projects ADD COLUMN icp_description TEXT`,
      `ALTER TABLE queries ADD COLUMN provenance TEXT`,
      `ALTER TABLE competitors ADD COLUMN provenance TEXT`,
      `UPDATE queries SET provenance = 'cli' WHERE provenance IS NULL`,
      `UPDATE competitors SET provenance = 'cli' WHERE provenance IS NULL`,
      `CREATE TABLE IF NOT EXISTS discovery_sessions (
         id                  TEXT PRIMARY KEY,
         project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         status              TEXT NOT NULL DEFAULT 'queued',
         icp_description     TEXT,
         seed_provider       TEXT,
         seed_count_raw      INTEGER,
         seed_count          INTEGER,
         dedup_threshold     REAL,
         probe_count         INTEGER,
         cited_count         INTEGER,
         aspirational_count  INTEGER,
         wasted_count        INTEGER,
         competitor_map      TEXT NOT NULL DEFAULT '[]',
         error               TEXT,
         started_at          TEXT,
         finished_at         TEXT,
         created_at          TEXT NOT NULL
       )`,
      // "Latest session per project" is the access pattern; SQLite walks the
      // composite index backwards for ORDER BY created_at DESC.
      `CREATE INDEX IF NOT EXISTS idx_discovery_sessions_project_created ON discovery_sessions(project_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS discovery_probes (
         id              TEXT PRIMARY KEY,
         session_id      TEXT NOT NULL REFERENCES discovery_sessions(id) ON DELETE CASCADE,
         project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         query           TEXT NOT NULL,
         bucket          TEXT,
         citation_state  TEXT NOT NULL,
         cited_domains   TEXT NOT NULL DEFAULT '[]',
         raw_response    TEXT,
         created_at      TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_discovery_probes_session ON discovery_probes(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_discovery_probes_project ON discovery_probes(project_id)`,
    ],
  },
  {
    version: 56,
    name: 'discovery-sessions-run-id',
    // Links a discovery_sessions row back to the runs row that drove it. Without
    // this column the run-coordinator can't tell two concurrent discovery
    // sessions apart for the same project — it would fall back to "latest
    // non-queued session" and surface the wrong bucket counts to Aero.
    statements: [
      `ALTER TABLE discovery_sessions ADD COLUMN run_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_discovery_sessions_run ON discovery_sessions(run_id)`,
    ],
  },
  {
    version: 57,
    name: 'runs-scoped-queries',
    // Persists an optional subset of tracked queries to sweep on a per-run
    // basis. NULL = full sweep (the default and only behavior pre-v57); a JSON
    // array of query strings = scope. The job runner reads this to filter the
    // query fetch via `inArray`.
    statements: [
      `ALTER TABLE runs ADD COLUMN queries TEXT`,
    ],
  },
  {
    version: 58,
    name: 'snapshots-preserve-on-query-delete',
    // The legacy `query_snapshots.query_id` FK was `ON DELETE CASCADE`, so a
    // routine basket edit (PUT /queries replace, individual delete, `canonry
    // apply` dropping a query) silently destroyed every historical citation
    // snapshot for the removed queries — the regression history, transitions,
    // and competitor-overlap evidence that are canonry's whole value.
    //
    // Fix: rebuild `query_snapshots` with `query_id` nullable + `ON DELETE
    // SET NULL`, and add a denormalized `query_text` column populated from
    // `queries.query` via the join. SQLite can't change FK or NOT NULL in
    // place — same canonical table-rebuild pattern v53 used. All statements
    // run inside the migration runner's single transaction.
    //
    // `run_id` keeps `ON DELETE CASCADE` — deleting a run legitimately
    // removes its snapshots. Indexes are recreated on the renamed table.
    statements: [
      `CREATE TABLE IF NOT EXISTS query_snapshots_v58 (
         id                       TEXT PRIMARY KEY,
         run_id                   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
         query_id                 TEXT REFERENCES queries(id) ON DELETE SET NULL,
         query_text               TEXT,
         provider                 TEXT NOT NULL DEFAULT 'gemini',
         model                    TEXT,
         citation_state           TEXT NOT NULL,
         answer_mentioned         INTEGER,
         answer_text              TEXT,
         cited_domains            TEXT NOT NULL DEFAULT '[]',
         competitor_overlap       TEXT NOT NULL DEFAULT '[]',
         recommended_competitors  TEXT NOT NULL DEFAULT '[]',
         location                 TEXT,
         screenshot_path          TEXT,
         raw_response             TEXT,
         created_at               TEXT NOT NULL
       )`,
      // Backfill `query_text` from joined queries.query so existing snapshots
      // stay readable even if their query is later deleted.
      //
      // IMPORTANT: we use `q.id` (the JOINED queries.id), not `qs.query_id`.
      // Production DBs may already contain snapshots whose `qs.query_id`
      // dangles — a queries row was hard-deleted at some point without
      // cascading (PRAGMA foreign_keys was OFF, or pre-FK schema). Copying
      // `qs.query_id` directly would re-introduce those dangling refs into
      // the new table, which now validates them at INSERT (the new FK still
      // requires query_id values to match queries.id when non-null). Reading
      // through the LEFT JOIN forces every value to be either a valid `q.id`
      // or NULL — pre-existing orphans land with NULL `query_id` / NULL
      // `query_text`, preserving the snapshot row instead of failing the
      // migration. The May 2026 azcoatings DB had 459 such pre-existing
      // orphans; without this guard, migrate() throws SQLITE_CONSTRAINT_FOREIGNKEY.
      `INSERT INTO query_snapshots_v58 (
         id, run_id, query_id, query_text, provider, model, citation_state,
         answer_mentioned, answer_text, cited_domains, competitor_overlap,
         recommended_competitors, location, screenshot_path, raw_response,
         created_at
       )
       SELECT qs.id, qs.run_id, q.id, q.query, qs.provider, qs.model,
              qs.citation_state, qs.answer_mentioned, qs.answer_text,
              qs.cited_domains, qs.competitor_overlap, qs.recommended_competitors,
              qs.location, qs.screenshot_path, qs.raw_response, qs.created_at
       FROM query_snapshots qs
       LEFT JOIN queries q ON q.id = qs.query_id`,
      `DROP TABLE query_snapshots`,
      `ALTER TABLE query_snapshots_v58 RENAME TO query_snapshots`,
      // Recreate the indexes that didn't survive the rename.
      `CREATE INDEX IF NOT EXISTS idx_snapshots_run ON query_snapshots(run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_query ON query_snapshots(query_id)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_citation_state ON query_snapshots(citation_state)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_provider_model ON query_snapshots(provider, model)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_location ON query_snapshots(location)`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON query_snapshots(created_at)`,
    ],
  },
  {
    version: 59,
    name: 'projects-aliases',
    statements: [
      `ALTER TABLE projects ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    version: 60,
    name: 'audit-log-preserve-on-project-delete',
    // The legacy `audit_log.project_id` FK was `ON DELETE CASCADE`, so any
    // `DELETE /projects/:name` call cascade-wiped every audit row for that
    // project — including the `project.deleted` row the route handler had
    // just written in the same path. The deletion erased the only record
    // that the deletion happened, defeating the entire purpose of the
    // audit log.
    //
    // Fix: rebuild `audit_log` with `project_id` as `ON DELETE SET NULL`.
    // Existing rows survive verbatim; future deletions detach audit rows
    // from the project (project_id=NULL) instead of erasing them. SQLite
    // can't change FK behavior in place — same canonical table-rebuild
    // pattern v58 used for `query_snapshots`.
    statements: [
      `CREATE TABLE IF NOT EXISTS audit_log_v60 (
         id           TEXT PRIMARY KEY,
         project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
         actor        TEXT NOT NULL,
         action       TEXT NOT NULL,
         entity_type  TEXT NOT NULL,
         entity_id    TEXT,
         diff         TEXT,
         created_at   TEXT NOT NULL
       )`,
      // LEFT JOIN guard mirrors v58: if a pre-existing row carries a
      // dangling project_id (from a pre-FK era or a write with
      // PRAGMA foreign_keys=OFF), the join nulls it out rather than
      // failing the migration on the new FK validation.
      `INSERT INTO audit_log_v60 (
         id, project_id, actor, action, entity_type, entity_id, diff, created_at
       )
       SELECT a.id, p.id, a.actor, a.action, a.entity_type, a.entity_id, a.diff, a.created_at
       FROM audit_log a
       LEFT JOIN projects p ON p.id = a.project_id`,
      `DROP TABLE audit_log`,
      `ALTER TABLE audit_log_v60 RENAME TO audit_log`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_project ON audit_log(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)`,
    ],
  },
  {
    version: 61,
    name: 'content-target-dismissals',
    // Persistent per-recommendation dismissal so users can mark a content
    // opportunity "addressed" after they ship the page. The orchestrator
    // recomputes opportunities on every report load from live GSC / GA
    // inventory; without persistent dismissal, a recommendation lingers
    // until the next sync surfaces the new page (days–weeks of lag).
    //
    // Keyed by `(project_id, target_ref)` where `target_ref` is the stable
    // hash that `computeTargetRef()` already produces — same value the
    // ContentTargetRowDto exposes, so the client passes back the ref it
    // sees.
    statements: [
      `CREATE TABLE IF NOT EXISTS content_target_dismissals (
         id             TEXT PRIMARY KEY,
         project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         target_ref     TEXT NOT NULL,
         addressed_url  TEXT,
         note           TEXT,
         dismissed_at   TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_target_dismissals_project_ref ON content_target_dismissals(project_id, target_ref)`,
      `CREATE INDEX IF NOT EXISTS idx_content_target_dismissals_project ON content_target_dismissals(project_id)`,
    ],
  },
  {
    version: 62,
    name: 'recommendation-explanations',
    // LLM-generated rationale for content recommendations. Cached per
    // (project, target_ref, prompt_version) so repeat clicks are free.
    // Bumping the prompt version invalidates the cache forward without
    // touching the table.
    statements: [
      `CREATE TABLE IF NOT EXISTS recommendation_explanations (
         id              TEXT PRIMARY KEY,
         project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         target_ref      TEXT NOT NULL,
         prompt_version  TEXT NOT NULL,
         provider        TEXT NOT NULL,
         model           TEXT NOT NULL,
         response_text   TEXT NOT NULL,
         cost_millicents INTEGER NOT NULL DEFAULT 0,
         generated_at    TEXT NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendation_explanations_unique ON recommendation_explanations(project_id, target_ref, prompt_version)`,
      `CREATE INDEX IF NOT EXISTS idx_recommendation_explanations_project ON recommendation_explanations(project_id)`,
    ],
  },
  {
    version: 63,
    name: 'audit-log-attribution-columns',
    // Adds `user_agent` and `actor_session` to `audit_log` so post-mortems
    // can attribute destructive events (like the 2026-05-15 azcoatings
    // queries.replaced incident — see PR #593) to a specific caller.
    // Without these columns, every mutation rides as `actor='api'` with no
    // narrower identity, so it's impossible to tell whether a destructive
    // event came from CLI, dashboard, MCP, an agent, or an external script.
    //
    // Both columns nullable — the audit log accepts writes from sources
    // that don't have an HTTP request context (scheduler, run-coordinator,
    // direct DB writes from CLI commands).
    statements: [
      `ALTER TABLE audit_log ADD COLUMN user_agent TEXT`,
      `ALTER TABLE audit_log ADD COLUMN actor_session TEXT`,
    ],
  },
  {
    version: 64,
    name: 'ai-user-fetch-events-hourly',
    // Splits per-user fetches (ChatGPT-User, Perplexity-User) out of
    // crawler_events_hourly so the dashboard / API can distinguish bulk
    // machine crawl from human-in-the-loop fetch. Bot IDs are pinned to the
    // two `purpose: 'user-agent'` rules that existed before this change —
    // future user-fetch UAs land in the new table directly via the
    // refactored classifier and never need a backfill.
    //
    // Statements are idempotent: CREATE/INDEX are IF NOT EXISTS; the
    // INSERT … SELECT uses ON CONFLICT DO NOTHING (composite PK rows
    // already moved skip silently); the DELETE keys on `bot_id`, so a
    // second run is a no-op after the first DELETE drains the source.
    statements: [
      `CREATE TABLE IF NOT EXISTS ai_user_fetch_events_hourly (
         project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         source_id            TEXT NOT NULL REFERENCES traffic_sources(id) ON DELETE CASCADE,
         ts_hour              TEXT NOT NULL,
         bot_id               TEXT NOT NULL,
         operator             TEXT NOT NULL,
         verification_status  TEXT NOT NULL,
         path_normalized      TEXT NOT NULL,
         status               INTEGER NOT NULL,
         hits                 INTEGER NOT NULL DEFAULT 0,
         sampled_user_agent   TEXT,
         created_at           TEXT NOT NULL,
         updated_at           TEXT NOT NULL,
         PRIMARY KEY (project_id, source_id, ts_hour, bot_id, verification_status, path_normalized, status)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_user_fetch_hourly_project_ts ON ai_user_fetch_events_hourly(project_id, ts_hour)`,
      `CREATE INDEX IF NOT EXISTS idx_ai_user_fetch_hourly_path ON ai_user_fetch_events_hourly(project_id, path_normalized)`,
      `INSERT INTO ai_user_fetch_events_hourly
         (project_id, source_id, ts_hour, bot_id, operator, verification_status, path_normalized, status, hits, sampled_user_agent, created_at, updated_at)
       SELECT project_id, source_id, ts_hour, bot_id, operator, verification_status, path_normalized, status, hits, sampled_user_agent, created_at, updated_at
         FROM crawler_events_hourly
        WHERE bot_id IN ('openai-chatgpt-user', 'perplexity-user')
       ON CONFLICT DO NOTHING`,
      `DELETE FROM crawler_events_hourly WHERE bot_id IN ('openai-chatgpt-user', 'perplexity-user')`,
    ],
  },
  {
    version: 65,
    name: 'split-mistral-ai-rule',
    // The pre-existing `mistral-ai` rule matched both `MistralAI-User/*`
    // (per-user fetch) and `MistralBot/*` (bulk crawl) under one id, so
    // every historical row landed in crawler_events_hourly with
    // bot_id='mistral-ai'. The rule is now split into `mistral-ai-user`
    // (purpose: 'user-agent') and `mistral-bot` (purpose: 'crawl'); this
    // migration best-effort routes the legacy rows using the bucket's
    // representative sampled_user_agent.
    //
    // Mixed-UA buckets (where a single (project, source, hour, path,
    // status) accumulated both UAs under the old shared id) are routed
    // by whichever UA happened to be sampled — the bucket-key granularity
    // doesn't preserve per-event UAs, so any heuristic has the same
    // limitation. Going forward the split rules write to disjoint tables.
    //
    // Idempotent: the INSERT…SELECT uses ON CONFLICT DO NOTHING; the
    // UPDATE and DELETE both filter on bot_id='mistral-ai', so a second
    // run finds no rows after the first apply.
    statements: [
      `INSERT INTO ai_user_fetch_events_hourly
         (project_id, source_id, ts_hour, bot_id, operator, verification_status, path_normalized, status, hits, sampled_user_agent, created_at, updated_at)
       SELECT project_id, source_id, ts_hour, 'mistral-ai-user', operator, verification_status, path_normalized, status, hits, sampled_user_agent, created_at, updated_at
         FROM crawler_events_hourly
        WHERE bot_id = 'mistral-ai' AND sampled_user_agent LIKE '%MistralAI-User%'
       ON CONFLICT DO NOTHING`,
      `DELETE FROM crawler_events_hourly WHERE bot_id = 'mistral-ai' AND sampled_user_agent LIKE '%MistralAI-User%'`,
      `UPDATE crawler_events_hourly SET bot_id = 'mistral-bot' WHERE bot_id = 'mistral-ai'`,
    ],
  },
  {
    version: 66,
    name: 'oauth-connections-track-owning-project',
    // Cross-project OAuth takeover defense. Before this column, the OAuth
    // callback for Google and the connect route for Bing keyed everything on
    // `domain` alone — an attacker who created a project pointed at a victim's
    // canonical domain could complete OAuth from their own Google/Bing account
    // and silently overwrite the legitimate refresh token under that domain
    // key. The new `created_by_project_id` column records the project that
    // first established each connection; the callback and DELETE routes refuse
    // cross-project writes when it doesn't match.
    //
    // Backfill: for each existing connection row, set the owner to the project
    // whose `canonical_domain` matches AND whose `created_at` is oldest (the
    // most likely original owner in a 1:N domain-shared install). Rows with no
    // matching project stay NULL — treated as "unowned" so a future legitimate
    // connect from any project can claim them.
    //
    // Uses the `run` hook so the schema-edit + backfill only fire when the
    // target tables exist. The legacy-keyword test scenario seeds a DB at v46
    // without google_connections / bing_connections (they're created in v6 but
    // the test bypasses the bootstrap) — without the guard, this version's
    // ALTER fails with "no such table".
    //
    // Idempotent: column-existence guard means re-running this version is a
    // no-op; the backfill UPDATE only writes rows where the column is NULL.
    statements: [],
    run: (db) => {
      if (tableExists(db, 'google_connections') && !columnExists(db, 'google_connections', 'created_by_project_id')) {
        db.run(sql.raw(
          `ALTER TABLE google_connections ADD COLUMN created_by_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`,
        ))
        db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_google_conn_project ON google_connections(created_by_project_id)`))
        db.run(sql.raw(
          `UPDATE google_connections
              SET created_by_project_id = (
                SELECT p.id FROM projects p
                 WHERE LOWER(p.canonical_domain) = LOWER(google_connections.domain)
                 ORDER BY p.created_at ASC
                 LIMIT 1
              )
            WHERE created_by_project_id IS NULL`,
        ))
      }
      if (tableExists(db, 'bing_connections') && !columnExists(db, 'bing_connections', 'created_by_project_id')) {
        db.run(sql.raw(
          `ALTER TABLE bing_connections ADD COLUMN created_by_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`,
        ))
        db.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_bing_conn_project ON bing_connections(created_by_project_id)`))
        db.run(sql.raw(
          `UPDATE bing_connections
              SET created_by_project_id = (
                SELECT p.id FROM projects p
                 WHERE LOWER(p.canonical_domain) = LOWER(bing_connections.domain)
                 ORDER BY p.created_at ASC
                 LIMIT 1
              )
            WHERE created_by_project_id IS NULL`,
        ))
      }
    },
  },
  {
    version: 67,
    name: 'gbp-locations',
    statements: [
      // Google Business Profile integration (Phase 1) — gbp_locations table
      // holds per-project discovered locations and their selection state.
      `CREATE TABLE IF NOT EXISTS gbp_locations (
        id                              TEXT PRIMARY KEY,
        project_id                      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        account_name                    TEXT NOT NULL,
        location_name                   TEXT NOT NULL,
        display_name                    TEXT NOT NULL,
        primary_category_display_name   TEXT,
        storefront_address              TEXT,
        website_uri                     TEXT,
        selected                        INTEGER NOT NULL DEFAULT 1,
        synced_at                       TEXT,
        created_at                      TEXT NOT NULL,
        updated_at                      TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gbp_locations_project ON gbp_locations(project_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_gbp_locations_project_location ON gbp_locations(project_id, location_name)`,
    ],
  },
  {
    version: 68,
    name: 'gbp-performance',
    statements: [
      // GBP Phase 2 — daily performance metrics + monthly keyword impressions.
      `CREATE TABLE IF NOT EXISTS gbp_daily_metrics (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        location_name  TEXT NOT NULL,
        date           TEXT NOT NULL,
        metric         TEXT NOT NULL,
        value          INTEGER NOT NULL,
        sync_run_id    TEXT REFERENCES runs(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gbp_daily_metrics_loc ON gbp_daily_metrics(project_id, location_name, date)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_gbp_daily_metrics ON gbp_daily_metrics(project_id, location_name, date, metric)`,
      `CREATE TABLE IF NOT EXISTS gbp_keyword_impressions (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        location_name   TEXT NOT NULL,
        period_start    TEXT NOT NULL,
        period_end      TEXT NOT NULL,
        keyword         TEXT NOT NULL,
        value_count     INTEGER,
        value_threshold INTEGER,
        sync_run_id     TEXT REFERENCES runs(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gbp_keyword_impr_loc ON gbp_keyword_impressions(project_id, location_name, period_end)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_gbp_keyword_impr ON gbp_keyword_impressions(project_id, location_name, period_end, keyword)`,
    ],
  },
  {
    version: 69,
    name: 'gbp-place-actions-and-lodging',
    statements: [
      `CREATE TABLE IF NOT EXISTS gbp_place_actions (
        id                      TEXT PRIMARY KEY,
        project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        location_name           TEXT NOT NULL,
        place_action_link_name  TEXT NOT NULL,
        place_action_type       TEXT NOT NULL,
        uri                     TEXT,
        is_preferred            INTEGER NOT NULL DEFAULT 0,
        provider_type           TEXT,
        sync_run_id             TEXT REFERENCES runs(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gbp_place_actions_loc ON gbp_place_actions(project_id, location_name)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_gbp_place_actions ON gbp_place_actions(project_id, place_action_link_name)`,
      `CREATE TABLE IF NOT EXISTS gbp_lodging_snapshots (
        id                     TEXT PRIMARY KEY,
        project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        location_name          TEXT NOT NULL,
        content_hash           TEXT NOT NULL,
        attributes             TEXT NOT NULL DEFAULT '{}',
        populated_group_count  INTEGER NOT NULL DEFAULT 0,
        synced_at              TEXT NOT NULL,
        sync_run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gbp_lodging_loc ON gbp_lodging_snapshots(project_id, location_name, synced_at)`,
    ],
  },
  {
    version: 70,
    name: 'gbp-keyword-monthly',
    statements: [
      `CREATE TABLE IF NOT EXISTS gbp_keyword_monthly (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        location_name    TEXT NOT NULL,
        month            TEXT NOT NULL,
        keyword          TEXT NOT NULL,
        value_count      INTEGER,
        value_threshold  INTEGER,
        sync_run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
        synced_at        TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gbp_keyword_monthly_loc ON gbp_keyword_monthly(project_id, location_name, month)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_gbp_keyword_monthly ON gbp_keyword_monthly(project_id, location_name, month, keyword)`,
    ],
  },
  {
    // Capture the Google Maps Place ID + Maps link on each location so we can
    // link it to the Places API for supplemental rendered-listing data (#648).
    // ALTER ADD COLUMN is idempotent here — the runner swallows the duplicate-
    // column error on re-apply.
    version: 71,
    name: 'gbp-locations-place-id',
    statements: [
      `ALTER TABLE gbp_locations ADD COLUMN place_id TEXT`,
      `ALTER TABLE gbp_locations ADD COLUMN maps_uri TEXT`,
    ],
  },
  {
    // Places (New) Place Details snapshots for lodging locations (#648) —
    // snapshot-on-change, same shape as gbp_lodging_snapshots.
    version: 72,
    name: 'gbp-place-details',
    statements: [
      `CREATE TABLE IF NOT EXISTS gbp_place_details (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        location_name TEXT NOT NULL,
        place_id      TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        tier          TEXT NOT NULL,
        attributes    TEXT NOT NULL DEFAULT '{}',
        synced_at     TEXT NOT NULL,
        sync_run_id   TEXT REFERENCES runs(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gbp_place_details_loc ON gbp_place_details(project_id, location_name, synced_at)`,
    ],
  },
  {
    // Durable per-domain classification of cited surfaces, upserted on each
    // discovery completion. Powers the content-targets winnabilityClass winnability
    // gate without re-running a discovery probe. Keyed (project_id, domain).
    version: 73,
    name: 'domain-classifications',
    statements: [
      `CREATE TABLE IF NOT EXISTS domain_classifications (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        domain          TEXT NOT NULL,
        competitor_type TEXT NOT NULL,
        hits            INTEGER NOT NULL DEFAULT 0,
        session_id      TEXT,
        updated_at      TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_classifications_project_domain ON domain_classifications(project_id, domain)`,
      `CREATE INDEX IF NOT EXISTS idx_domain_classifications_project ON domain_classifications(project_id)`,
    ],
  },
  {
    // Structured LLM content briefs, cached per (project, target_ref,
    // prompt_version). Separate from recommendation_explanations so the
    // structured brief payload and its version-keyed cache never collide with
    // the prompt-version-blind explanation lookup.
    version: 74,
    name: 'recommendation-briefs',
    statements: [
      `CREATE TABLE IF NOT EXISTS recommendation_briefs (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        target_ref      TEXT NOT NULL,
        prompt_version  TEXT NOT NULL,
        provider        TEXT NOT NULL,
        model           TEXT NOT NULL,
        brief           TEXT NOT NULL,
        cost_millicents INTEGER NOT NULL DEFAULT 0,
        generated_at    TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendation_briefs_unique ON recommendation_briefs(project_id, target_ref, prompt_version)`,
      `CREATE INDEX IF NOT EXISTS idx_recommendation_briefs_project ON recommendation_briefs(project_id)`,
    ],
  },
  {
    // Technical AEO — site-wide audit persistence. `site_audit_snapshots` is the
    // per-run summary (drives the score + trend); `site_audit_pages` is the
    // per-page breakdown (drives the drill-down table). Both cascade off runs so
    // a run delete cleans up its audit data.
    version: 75,
    name: 'site-audit-tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS site_audit_snapshots (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id               TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sitemap_url          TEXT NOT NULL,
        audited_at           TEXT NOT NULL,
        aggregate_score      INTEGER NOT NULL DEFAULT 0,
        pages_discovered     INTEGER NOT NULL DEFAULT 0,
        pages_audited        INTEGER NOT NULL DEFAULT 0,
        pages_skipped        INTEGER NOT NULL DEFAULT 0,
        pages_errored        INTEGER NOT NULL DEFAULT 0,
        factor_averages      TEXT NOT NULL DEFAULT '[]',
        cross_cutting_issues TEXT NOT NULL DEFAULT '[]',
        prioritized_fixes    TEXT NOT NULL DEFAULT '[]',
        created_at           TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_site_audit_snap_project_created ON site_audit_snapshots(project_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_site_audit_snap_run ON site_audit_snapshots(run_id)`,
      `CREATE TABLE IF NOT EXISTS site_audit_pages (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        url           TEXT NOT NULL,
        overall_score INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL,
        error         TEXT,
        factors       TEXT NOT NULL DEFAULT '[]',
        created_at    TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_site_audit_pages_run ON site_audit_pages(run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_site_audit_pages_project_score ON site_audit_pages(project_id, overall_score)`,
    ],
  },
  {
    // Non-fatal operator warning on a discovery session (e.g. the seed-dedup
    // degenerate-collapse guard). The session still completes; the warning
    // flags that its coverage may be misleading.
    version: 76,
    name: 'discovery-session-warning',
    statements: [
      `ALTER TABLE discovery_sessions ADD COLUMN warning TEXT`,
    ],
  },
  {
    // OpenAI Advertiser API (ChatGPT ads) — connection metadata, entity
    // snapshots (campaigns / ad groups / ads), and daily paid-performance
    // rollups. One connection per project (ad accounts are not domain-bound).
    // Money columns are integer micros; ads-sync normalizes the insights
    // API's decimal-dollar spend at ingest. Credentials live in config.yaml.
    version: 77,
    name: 'openai-ads-tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS ads_connections (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ad_account_id  TEXT NOT NULL,
        display_name   TEXT,
        currency_code  TEXT,
        timezone       TEXT,
        status         TEXT,
        last_synced_at TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_conn_project ON ads_connections(project_id)`,
      `CREATE TABLE IF NOT EXISTS ads_campaigns (
        id                          TEXT PRIMARY KEY,
        project_id                  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name                        TEXT NOT NULL,
        status                      TEXT NOT NULL,
        bidding_type                TEXT,
        daily_spend_limit_micros    INTEGER,
        lifetime_spend_limit_micros INTEGER,
        targeting                   TEXT,
        upstream_created_at         INTEGER,
        upstream_updated_at         INTEGER,
        sync_run_id                 TEXT REFERENCES runs(id) ON DELETE SET NULL,
        synced_at                   TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ads_campaigns_project ON ads_campaigns(project_id)`,
      `CREATE TABLE IF NOT EXISTS ads_ad_groups (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        campaign_id         TEXT NOT NULL REFERENCES ads_campaigns(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        status              TEXT NOT NULL,
        billing_event_type  TEXT,
        max_bid_micros      INTEGER,
        context_hints       TEXT NOT NULL DEFAULT '[]',
        upstream_created_at INTEGER,
        upstream_updated_at INTEGER,
        sync_run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
        synced_at           TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ads_ad_groups_project ON ads_ad_groups(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ads_ad_groups_campaign ON ads_ad_groups(campaign_id)`,
      `CREATE TABLE IF NOT EXISTS ads_ads (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ad_group_id         TEXT NOT NULL REFERENCES ads_ad_groups(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        status              TEXT NOT NULL,
        creative            TEXT,
        review_status       TEXT,
        upstream_created_at INTEGER,
        upstream_updated_at INTEGER,
        sync_run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
        synced_at           TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ads_ads_project ON ads_ads(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ads_ads_group ON ads_ads(ad_group_id)`,
      `CREATE TABLE IF NOT EXISTS ads_insights_daily (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        level        TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        date         TEXT NOT NULL,
        impressions  INTEGER NOT NULL DEFAULT 0,
        clicks       INTEGER NOT NULL DEFAULT 0,
        spend_micros INTEGER NOT NULL DEFAULT 0,
        sync_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_ads_insights_daily ON ads_insights_daily(project_id, level, entity_id, date)`,
      `CREATE INDEX IF NOT EXISTS idx_ads_insights_project_date ON ads_insights_daily(project_id, date)`,
    ],
  },
  {
    // Bing Webmaster inbound links land in the SAME backlink store as Common
    // Crawl, tagged by a `source` discriminator (commoncrawl | bing-webmaster).
    // Bing rows have no `cc_release_syncs` row, so `release_sync_id` becomes
    // nullable and the per-window UNIQUE gains `source`. SQLite can't drop a
    // NOT NULL or rewrite a UNIQUE in place — canonical table rebuild (the
    // v58/v60 pattern). Guarded on the `source` column's absence so a replay
    // over the already-migrated schema is a no-op (the hardcoded
    // `source='commoncrawl'` backfill must never clobber real bing rows).
    version: 78,
    name: 'backlinks-source-discriminator',
    statements: [],
    run: (tx) => {
      addBacklinkSourceDiscriminator(tx)
    },
  },
  {
    // Answer-text mention signal on discovery probes (independent of citation).
    // Nullable: pre-existing rows were written before the column / never had the
    // mention computed, so they read back as null (unknown) downstream.
    version: 79,
    name: 'discovery-probes-answer-mentioned',
    statements: [
      `ALTER TABLE discovery_probes ADD COLUMN answer_mentioned INTEGER`,
    ],
  },
  {
    // Mention-rate columns on the persisted health snapshot, mirroring the
    // existing cited columns (overall_cited_rate / cited_pairs) for the
    // independent answer-text mention signal. Nullable: rows written before
    // this version have no mention math, so they read back as NULL ("not
    // measured") and readers coalesce NULL→0.
    //
    // Guarded `run` rather than bare `statements` (the v66 pattern): the
    // table-existence check makes this a no-op when `health_snapshots` is
    // absent — only possible on a legacy fixture whose recorded
    // `_migrations` version skips v23's `CREATE TABLE` (the bootstrap is
    // bypassed). The column-existence check keeps a replay idempotent.
    version: 80,
    name: 'health-snapshots-mention-rate',
    statements: [],
    run: (db) => {
      if (!tableExists(db, 'health_snapshots')) return
      if (!columnExists(db, 'health_snapshots', 'overall_mention_rate')) {
        db.run(sql.raw(`ALTER TABLE health_snapshots ADD COLUMN overall_mention_rate TEXT`))
      }
      if (!columnExists(db, 'health_snapshots', 'mentioned_pairs')) {
        db.run(sql.raw(`ALTER TABLE health_snapshots ADD COLUMN mentioned_pairs INTEGER`))
      }
    },
  },
  {
    version: 81,
    name: 'gbp-locations-owner-content',
    statements: [],
    run: (db) => {
      if (!tableExists(db, 'gbp_locations')) return
      const cols = [
        'additional_categories',
        'description',
        'service_area',
        'regular_hours',
        'primary_phone',
        'open_status',
        'opening_date',
      ]
      for (const col of cols) {
        if (!columnExists(db, 'gbp_locations', col)) {
          db.run(sql.raw(`ALTER TABLE gbp_locations ADD COLUMN ${col} TEXT`))
        }
      }
    },
  },
  {
    version: 82,
    name: 'gbp-attributes-snapshots',
    statements: [
      `CREATE TABLE IF NOT EXISTS gbp_attributes_snapshots (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        location_name    TEXT NOT NULL,
        content_hash     TEXT NOT NULL,
        attributes       TEXT NOT NULL DEFAULT '[]',
        attribute_count  INTEGER NOT NULL DEFAULT 0,
        synced_at        TEXT NOT NULL,
        sync_run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gbp_attributes_loc ON gbp_attributes_snapshots(project_id, location_name, synced_at)`,
    ],
  },
  {
    version: 83,
    name: 'ads-insights-conversions',
    statements: [
      `ALTER TABLE ads_insights_daily ADD COLUMN conversions INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ads_connections ADD COLUMN conversion_tracking_configured INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 84,
    name: 'llm-usage-events',
    statements: [
      `CREATE TABLE IF NOT EXISTS llm_usage_events (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT REFERENCES projects(id) ON DELETE CASCADE,
        run_id              TEXT REFERENCES runs(id) ON DELETE SET NULL,
        agent_session_id    TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        feature             TEXT NOT NULL,
        provider            TEXT NOT NULL,
        model               TEXT NOT NULL,
        response_id         TEXT,
        input_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens       INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
        total_tokens        INTEGER NOT NULL DEFAULT 0,
        cost_millicents     INTEGER NOT NULL DEFAULT 0,
        prompt_family       TEXT,
        prompt_version      TEXT,
        metadata            TEXT,
        created_at          TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_llm_usage_project_created ON llm_usage_events(project_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_llm_usage_feature_created ON llm_usage_events(feature, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_llm_usage_session_created ON llm_usage_events(agent_session_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_llm_usage_run_created ON llm_usage_events(run_id, created_at)`,
    ],
  },
  {
    version: 85,
    name: 'agent-tool-events',
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_tool_events (
        id                    TEXT PRIMARY KEY,
        project_id            TEXT REFERENCES projects(id) ON DELETE CASCADE,
        agent_session_id      TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        tool_call_id          TEXT NOT NULL,
        tool_name             TEXT NOT NULL,
        assistant_response_id TEXT,
        provider              TEXT,
        model                 TEXT,
        status                TEXT NOT NULL,
        duration_ms           INTEGER NOT NULL DEFAULT 0,
        args_bytes            INTEGER NOT NULL DEFAULT 0,
        result_text_chars     INTEGER NOT NULL DEFAULT 0,
        result_bytes          INTEGER NOT NULL DEFAULT 0,
        metadata              TEXT,
        created_at            TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_agent_tool_events_project_created ON agent_tool_events(project_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_tool_events_session_created ON agent_tool_events(agent_session_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_tool_events_tool_created ON agent_tool_events(tool_name, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_agent_tool_events_status_created ON agent_tool_events(status, created_at)`,
    ],
  },
  {
    version: 86,
    name: 'gsc-daily-totals',
    statements: [
      `CREATE TABLE IF NOT EXISTS gsc_daily_totals (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date         TEXT NOT NULL,
        clicks       INTEGER NOT NULL,
        impressions  INTEGER NOT NULL,
        position     TEXT NOT NULL,
        created_at   TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_daily_totals_project_date ON gsc_daily_totals(project_id, date)`,
      `CREATE INDEX IF NOT EXISTS idx_gsc_daily_totals_project ON gsc_daily_totals(project_id)`,
    ],
  },
  {
    version: 87,
    name: 'api-key-project-scope',
    statements: [
      // Opt-in single-project scoping for API keys. NULL = full-instance access
      // (the historical default), so this is a no-op for every existing key.
      // ALTER ADD COLUMN is idempotent (the runner swallows duplicate-column on retry).
      `ALTER TABLE api_keys ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id)`,
    ],
  },
  {
    version: 88,
    name: 'discovery-session-seed-source-counts',
    statements: [
      // Diagnostics: split of raw seed candidates by source (answer text vs.
      // grounding fan-out), recorded at seed time. Nullable — legacy sessions
      // stay null. ALTER ADD COLUMN is idempotent (the runner swallows the
      // duplicate-column error on retry).
      `ALTER TABLE discovery_sessions ADD COLUMN seed_from_answer_count INTEGER`,
      `ALTER TABLE discovery_sessions ADD COLUMN seed_from_grounding_count INTEGER`,
    ],
  },
  {
    version: 89,
    name: 'discovery-session-brand-filter-count',
    statements: [
      // Diagnostics: raw candidates dropped by the branded self-query filter
      // before seed_count_raw was recorded. Nullable — legacy sessions stay
      // null. Idempotent (the runner swallows the duplicate-column error).
      `ALTER TABLE discovery_sessions ADD COLUMN seed_brand_filtered_count INTEGER`,
    ],
  },
  {
    version: 90,
    name: 'discovery-session-buyer-description',
    statements: [
      // Buyer definition the session was seeded with. Part of the in-flight
      // consolidation identity (a request with a different buyer must never
      // reuse another buyer's session) and auditability for seed provenance.
      `ALTER TABLE discovery_sessions ADD COLUMN buyer_description TEXT`,
    ],
  },
  {
    version: 91,
    name: 'discovery-session-locations',
    statements: [
      // Resolved service areas the session was seeded/probed with. Part of the
      // in-flight consolidation identity (a different location subset never
      // reuses another geo's session) and seed/probe provenance. Nullable —
      // legacy sessions stay null.
      `ALTER TABLE discovery_sessions ADD COLUMN locations TEXT`,
    ],
  },
  {
    version: 92,
    name: 'discovery-session-dedup-diagnostics',
    statements: [
      // Seed provenance + dedup calibration diagnostics. Additive + nullable —
      // legacy sessions stay null; old writers omit them (downgrade-safe).
      `ALTER TABLE discovery_sessions ADD COLUMN seed_raw_candidates TEXT`,
      `ALTER TABLE discovery_sessions ADD COLUMN dedup_cluster_min_sims TEXT`,
      `ALTER TABLE discovery_sessions ADD COLUMN dedup_band_pair_fraction REAL`,
      `ALTER TABLE discovery_sessions ADD COLUMN dedup_pairs_total INTEGER`,
    ],
  },
  {
    version: 93,
    name: 'discovery-session-seed-providers',
    statements: [
      // Seed provider set (consolidation identity) + per-provider candidate
      // counts. Additive + nullable — legacy rows stay null (downgrade-safe).
      `ALTER TABLE discovery_sessions ADD COLUMN seed_providers TEXT`,
      `ALTER TABLE discovery_sessions ADD COLUMN seed_provider_counts TEXT`,
    ],
  },
]

/**
 * Rebuilds a backlink table to add the `source` discriminator, make
 * `release_sync_id` nullable, and widen the per-window UNIQUE to include
 * `source`. No-op when the table already carries `source` (replay-safe).
 *
 * The copy hardcodes `source='commoncrawl'` — every pre-v78 row is a Common
 * Crawl row — so it must NOT run over an already-migrated table that may hold
 * real `bing-webmaster` rows. The `columnExists` guard guarantees that.
 *
 * Defensive copy guards (mirroring v58/v60): rows whose `project_id` no longer
 * resolves are dropped (the new column stays NOT NULL); a `release_sync_id`
 * that dangles (pre-FK era / a write with PRAGMA foreign_keys=OFF) is nulled
 * rather than failing the now-validated FK.
 */
function rebuildBacklinkTableWithSource(
  tx: MigrationDb,
  table: 'backlink_domains' | 'backlink_summaries',
): void {
  // The backlink tables are created in v41 (not the bootstrap block), so a DB
  // that recorded a later version without ever running v41 (a synthetic legacy
  // fixture, or a partial install) may not have them yet. Nothing to rebuild —
  // a real upgrade always ran v41 first, so the table exists when it matters.
  if (!tableExists(tx, table)) return
  if (columnExists(tx, table, 'source')) return

  if (table === 'backlink_domains') {
    // Drop any temp table left behind by a crashed/aborted prior apply so a
    // retry rebuilds cleanly instead of failing on a stale CREATE (v53/v58 do
    // the same — the bare CREATE would wedge the migration every boot).
    tx.run(sql.raw(`DROP TABLE IF EXISTS backlink_domains_v78`))
    tx.run(sql.raw(`CREATE TABLE backlink_domains_v78 (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      release_sync_id  TEXT REFERENCES cc_release_syncs(id) ON DELETE CASCADE,
      source           TEXT NOT NULL DEFAULT 'commoncrawl',
      release          TEXT NOT NULL,
      target_domain    TEXT NOT NULL,
      linking_domain   TEXT NOT NULL,
      num_hosts        INTEGER NOT NULL,
      created_at       TEXT NOT NULL
    )`))
    tx.run(sql.raw(`INSERT INTO backlink_domains_v78
        (id, project_id, release_sync_id, source, release, target_domain, linking_domain, num_hosts, created_at)
      SELECT bd.id, bd.project_id,
             CASE WHEN bd.release_sync_id IN (SELECT id FROM cc_release_syncs) THEN bd.release_sync_id ELSE NULL END,
             'commoncrawl', bd.release, bd.target_domain, bd.linking_domain, bd.num_hosts, bd.created_at
      FROM backlink_domains bd
      WHERE bd.project_id IN (SELECT id FROM projects)`))
    tx.run(sql.raw(`DROP TABLE backlink_domains`))
    tx.run(sql.raw(`ALTER TABLE backlink_domains_v78 RENAME TO backlink_domains`))
    tx.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_backlink_domains_project ON backlink_domains(project_id)`))
    tx.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_backlink_domains_release_sync ON backlink_domains(release_sync_id)`))
    tx.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_backlink_domains_project_release ON backlink_domains(project_id, release)`))
    tx.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_backlink_domains_hosts ON backlink_domains(num_hosts)`))
    tx.run(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_backlink_domains_unique ON backlink_domains(project_id, source, release, linking_domain)`))
    return
  }

  tx.run(sql.raw(`DROP TABLE IF EXISTS backlink_summaries_v78`))
  tx.run(sql.raw(`CREATE TABLE backlink_summaries_v78 (
    id                     TEXT PRIMARY KEY,
    project_id             TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    release_sync_id        TEXT REFERENCES cc_release_syncs(id) ON DELETE CASCADE,
    source                 TEXT NOT NULL DEFAULT 'commoncrawl',
    release                TEXT NOT NULL,
    target_domain          TEXT NOT NULL,
    total_linking_domains  INTEGER NOT NULL,
    total_hosts            INTEGER NOT NULL,
    top_10_hosts_share     TEXT NOT NULL,
    queried_at             TEXT NOT NULL,
    created_at             TEXT NOT NULL
  )`))
  tx.run(sql.raw(`INSERT INTO backlink_summaries_v78
      (id, project_id, release_sync_id, source, release, target_domain, total_linking_domains, total_hosts, top_10_hosts_share, queried_at, created_at)
    SELECT bs.id, bs.project_id,
           CASE WHEN bs.release_sync_id IN (SELECT id FROM cc_release_syncs) THEN bs.release_sync_id ELSE NULL END,
           'commoncrawl', bs.release, bs.target_domain, bs.total_linking_domains, bs.total_hosts, bs.top_10_hosts_share, bs.queried_at, bs.created_at
    FROM backlink_summaries bs
    WHERE bs.project_id IN (SELECT id FROM projects)`))
  tx.run(sql.raw(`DROP TABLE backlink_summaries`))
  tx.run(sql.raw(`ALTER TABLE backlink_summaries_v78 RENAME TO backlink_summaries`))
  tx.run(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_backlink_summaries_project_release ON backlink_summaries(project_id, source, release)`))
  tx.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_backlink_summaries_project ON backlink_summaries(project_id)`))
}

function addBacklinkSourceDiscriminator(tx: MigrationDb): void {
  rebuildBacklinkTableWithSource(tx, 'backlink_domains')
  rebuildBacklinkTableWithSource(tx, 'backlink_summaries')
}

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

export interface LegacyGoogleConnectionRow {
  domain: string
  connectionType: 'gsc' | 'ga4'
  propertyId: string | null
  sitemapUrl: string | null
  accessToken: string | null
  refreshToken: string
  tokenExpiresAt: string | null
  scopes: string[]
  createdAt: string
  updatedAt: string
}

export interface LegacyGa4ConnectionRow {
  projectName: string
  propertyId: string
  clientEmail: string
  privateKey: string
  createdAt: string
  updatedAt: string
}

export interface LegacyCredentialRows {
  google: LegacyGoogleConnectionRow[]
  ga4: LegacyGa4ConnectionRow[]
}

function columnExists(db: MigrationDb, table: string, column: string): boolean {
  // Table/column names are hard-coded constants in this module — safe to interpolate.
  const rows = db.all(sql.raw(
    `SELECT COUNT(*) as c FROM pragma_table_info('${table}') WHERE name = '${column}'`,
  )) as Array<{ c: number }>
  return (rows[0]?.c ?? 0) > 0
}

function tableExists(db: MigrationDb, table: string): boolean {
  // Table name is a hard-coded constant in this module — safe to interpolate.
  const rows = db.all(sql.raw(
    `SELECT COUNT(*) as c FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
  )) as Array<{ c: number }>
  return (rows[0]?.c ?? 0) > 0
}

function tableIsEmpty(db: MigrationDb, table: string): boolean {
  // Table name is a hard-coded constant in this module — safe to interpolate.
  const rows = db.all(sql.raw(`SELECT COUNT(*) as c FROM ${table}`)) as Array<{ c: number }>
  return (rows[0]?.c ?? 0) === 0
}

function hasLegacyQuerySchema(db: MigrationDb): boolean {
  return tableExists(db, 'keywords') ||
    columnExists(db, 'query_snapshots', 'keyword_id') ||
    columnExists(db, 'insights', 'keyword')
}

function normalizeLegacyQuerySchema(db: MigrationDb): void {
  if (!hasLegacyQuerySchema(db)) return

  // A previous failed boot with the broken v47 bootstrap may have created the
  // new table before crashing on query_snapshots(query_id). That table is empty
  // in that failure mode, so remove it before renaming the real legacy table.
  if (tableExists(db, 'keywords') && tableExists(db, 'queries')) {
    if (!tableIsEmpty(db, 'queries')) {
      throw new Error('Cannot migrate keywords to queries because both tables contain data')
    }
    db.run(sql.raw(`DROP TABLE queries`))
  }

  db.run(sql.raw(`DROP INDEX IF EXISTS idx_keywords_project`))
  db.run(sql.raw(`DROP INDEX IF EXISTS idx_keywords_project_keyword`))
  db.run(sql.raw(`DROP INDEX IF EXISTS idx_snapshots_keyword`))
  db.run(sql.raw(`DROP INDEX IF EXISTS idx_insights_keyword_provider`))

  if (tableExists(db, 'keywords')) {
    db.run(sql.raw(`ALTER TABLE keywords RENAME TO queries`))
  }
  if (columnExists(db, 'queries', 'keyword')) {
    db.run(sql.raw(`ALTER TABLE queries RENAME COLUMN keyword TO query`))
  }
  if (columnExists(db, 'query_snapshots', 'keyword_id')) {
    db.run(sql.raw(`ALTER TABLE query_snapshots RENAME COLUMN keyword_id TO query_id`))
  }
  if (columnExists(db, 'insights', 'keyword')) {
    db.run(sql.raw(`ALTER TABLE insights RENAME COLUMN keyword TO query`))
  }
}

function dropColumnIfExists(db: DatabaseClient, table: string, column: string): void {
  try {
    db.run(sql.raw(`ALTER TABLE ${table} DROP COLUMN ${column}`))
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err
    const msg = err.message
    const causeMsg = err.cause instanceof Error ? err.cause.message : ''
    // SQLite throws "no such column: <name>" when the column is already gone.
    const expected = `no such column: "${column}"`
    const expectedAlt = `no such column: ${column}`
    if (msg.includes(expected) || msg.includes(expectedAlt)) return
    if (causeMsg.includes(expected) || causeMsg.includes(expectedAlt)) return
    throw err
  }
}

/**
 * Reads any remaining credentials out of the legacy DB columns without
 * mutating the schema. Idempotent: once the columns are gone (after
 * `dropLegacyCredentialColumns`), subsequent calls return empty arrays.
 *
 * Pair with `dropLegacyCredentialColumns(db)`. Callers should extract, persist
 * to config.yaml, and only then drop the columns — dropping first would lose
 * credentials if the config write fails.
 */
export function extractLegacyCredentials(db: DatabaseClient): LegacyCredentialRows {
  const out: LegacyCredentialRows = { google: [], ga4: [] }

  if (columnExists(db, 'google_connections', 'access_token')) {
    const rows = db.all(sql.raw(
      `SELECT domain, connection_type, property_id, sitemap_url, access_token, refresh_token, token_expires_at, scopes, created_at, updated_at
       FROM google_connections
       WHERE refresh_token IS NOT NULL AND refresh_token != ''`,
    )) as Array<{
      domain: string
      connection_type: string
      property_id: string | null
      sitemap_url: string | null
      access_token: string | null
      refresh_token: string
      token_expires_at: string | null
      scopes: string
      created_at: string
      updated_at: string
    }>
    for (const row of rows) {
      out.google.push({
        domain: row.domain,
        connectionType: row.connection_type as 'gsc' | 'ga4',
        propertyId: row.property_id,
        sitemapUrl: row.sitemap_url,
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        tokenExpiresAt: row.token_expires_at,
        scopes: parseJsonColumn<string[]>(row.scopes, []),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    }
  }

  if (columnExists(db, 'ga_connections', 'private_key')) {
    const rows = db.all(sql.raw(
      `SELECT p.name AS project_name, ga.property_id, ga.client_email, ga.private_key, ga.created_at, ga.updated_at
       FROM ga_connections ga
       INNER JOIN projects p ON p.id = ga.project_id
       WHERE ga.private_key IS NOT NULL AND ga.private_key != ''`,
    )) as Array<{
      project_name: string
      property_id: string
      client_email: string
      private_key: string
      created_at: string
      updated_at: string
    }>
    for (const row of rows) {
      out.ga4.push({
        projectName: row.project_name,
        propertyId: row.property_id,
        clientEmail: row.client_email,
        privateKey: row.private_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    }
  }

  return out
}

/**
 * Drops the legacy credential columns. Idempotent — safe to run when columns
 * are already gone. Call only after `extractLegacyCredentials` rows have been
 * durably persisted to config.yaml.
 */
export function dropLegacyCredentialColumns(db: DatabaseClient): void {
  if (columnExists(db, 'google_connections', 'access_token')) {
    dropColumnIfExists(db, 'google_connections', 'access_token')
  }
  if (columnExists(db, 'google_connections', 'refresh_token')) {
    dropColumnIfExists(db, 'google_connections', 'refresh_token')
  }
  if (columnExists(db, 'google_connections', 'token_expires_at')) {
    dropColumnIfExists(db, 'google_connections', 'token_expires_at')
  }
  if (columnExists(db, 'ga_connections', 'private_key')) {
    dropColumnIfExists(db, 'ga_connections', 'private_key')
  }
}

/**
 * Returns the highest applied migration version, or 0 if none.
 */
function getAppliedVersion(db: DatabaseClient): number {
  const rows = db.all(sql`SELECT MAX(version) as max_version FROM _migrations`) as Array<{
    max_version: number | null
  }>
  return rows[0]?.max_version ?? 0
}

/**
 * Records a migration version as successfully applied. Uses Drizzle's
 * tagged-template binding so version/name are passed as bound parameters,
 * not interpolated into SQL.
 */
function recordMigration(
  db: Pick<DatabaseClient, 'run'>,
  version: number,
  name: string,
): void {
  db.run(sql`INSERT OR IGNORE INTO _migrations (version, name) VALUES (${version}, ${name})`)
}

export function migrate(
  db: DatabaseClient,
  /** Test seam for downgrade-safety: an "older binary" is simulated by passing
   *  a truncated version list. Production always uses the full list. */
  versions: ReadonlyArray<MigrationVersion> = MIGRATION_VERSIONS,
) {
  // Normalize legacy table/column names before bootstrap SQL runs. Bootstrap
  // creates final-shape indexes, so existing DBs must expose final column names
  // before those statements execute. The same call also runs inside v48's
  // `run` (defense in depth — the in-version call is what gets recorded in
  // `_migrations` for the cutover); both invocations no-op once the schema
  // is already on the new names.
  db.transaction((tx) => {
    normalizeLegacyQuerySchema(tx)
  })

  // Phase 1: base schema (idempotent — all CREATE IF NOT EXISTS).
  // Includes the _migrations table itself, so subsequent reads from
  // getAppliedVersion always succeed.
  const statements = MIGRATION_SQL.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const statement of statements) {
    db.run(sql.raw(statement))
  }

  // Phase 2: incremental migrations with version tracking.
  // Only run versions that haven't been applied yet. On first deploy of this
  // code over an existing DB, _migrations is empty so appliedVersion=0 and
  // every version is replayed once — that replay is safe because every
  // statement is either CREATE/INDEX IF NOT EXISTS, an idempotent UPDATE,
  // or an ALTER TABLE ADD COLUMN whose duplicate-column error we swallow.
  const appliedVersion = getAppliedVersion(db)

  for (const mv of versions) {
    if (mv.version <= appliedVersion) continue

    // Each version's statements + its row in _migrations commit atomically.
    // If a non-recoverable error fires mid-version, the whole version is
    // rolled back and not recorded, so the next boot retries it cleanly.
    db.transaction((tx) => {
      for (const statement of mv.statements) {
        try {
          tx.run(sql.raw(statement))
        } catch (err: unknown) {
          if (isDuplicateColumnError(err)) continue
          throw err
        }
      }
      mv.run?.(tx)
      recordMigration(tx, mv.version, mv.name)
    })
  }
}

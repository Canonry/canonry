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
interface MigrationVersion {
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

export function migrate(db: DatabaseClient) {
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

  for (const mv of MIGRATION_VERSIONS) {
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

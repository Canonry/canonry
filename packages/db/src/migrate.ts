import { sql } from 'drizzle-orm'
import {
  classifyAiReferralTrafficClass,
  createTemplateLinkPairIndex,
  deriveSiteHealthState,
  isTemplateLinkRatio,
  normalizeQueryText,
  observeTemplateLinkEdges,
  SiteHealthTemplateDetections,
  templateLinkRatio,
  templateLinkUbiquityAvailable,
  type TemplateLinkEdgeInput,
} from '@ainyc/canonry-contracts'
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
  provider_models   TEXT NOT NULL DEFAULT '{}',
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
  /** SQLite must have FK enforcement off before a referenced table can be rebuilt. */
  disableForeignKeys?: boolean
}

/**
 * Relink orphaned snapshot attribution (v98). Historical declarative writes
 * (`canonry apply`, `PUT /queries`, `PUT /keywords`) replaced tracked-query
 * rows with delete-all + reinsert even when the texts were unchanged, so
 * `query_snapshots.query_id` (ON DELETE SET NULL) was silently nulled on
 * every apply — FK-based readers (the analytics/metrics trend) lost the
 * project's whole history while text-fallback readers kept working. The
 * write paths now preserve row identity for unchanged texts; this one-time
 * fix re-links every already-orphaned snapshot whose `query_text` matches
 * (via the SHARED `normalizeQueryText` — trim + lowercase) a tracked query
 * in the snapshot's own project. Matching runs in TS, not SQL: SQLite's
 * `lower()` folds ASCII only, so a SQL match would strand non-ASCII pairs
 * like `ÉCOLE` / `école` that the runtime normalizer considers equal — and
 * since v98 runs once per install, those FKs would stay broken forever.
 * Snapshots for genuinely retired queries have no match and correctly stay
 * unlinked. Idempotent: only `query_id IS NULL` rows are candidates, so a
 * re-run is a no-op. Exported so the migration test can exercise it against
 * seeded orphans.
 */
/**
 * Split every stored dead-link finding into the two claims it was conflating,
 * and drop the ones that were never evidence of anything.
 *
 * A finding carries `evidence.statusCode`. A number means the target ANSWERED
 * with an error and the link really is broken. A null means the crawl never got
 * a response — a timeout, a reset socket, throttling under crawl concurrency —
 * which says nothing about the URL and was being reported to clients as a
 * broken link anyway.
 *
 * Counts are rewritten to ABSOLUTE values derived from the surviving rows, and
 * `dead_links_checked` loses exactly the targets that were never reached (it
 * had counted them as checked). `unverified` is per TARGET, matching `checked`:
 * one unreachable URL linked from five pages is one unchecked target, not five.
 *
 * Idempotent: the `HAVING` clause selects only attempts that still hold a
 * fabricated row, and the delete removes exactly those, so a re-run selects
 * nothing and `dead_links_checked` cannot be reduced twice.
 */
export function reclassifyFabricatedDeadLinks(tx: MigrationDb): void {
  const affected = tx.all(sql`
    SELECT run_id AS runId, attempt_id AS attemptId,
      COUNT(DISTINCT CASE WHEN json_extract(evidence, '$.statusCode') IS NULL THEN target_url END) AS fabricatedTargets,
      SUM(CASE WHEN json_extract(evidence, '$.statusCode') IS NOT NULL THEN 1 ELSE 0 END) AS realFindings,
      SUM(CASE WHEN json_extract(evidence, '$.statusCode') IS NULL THEN 1 ELSE 0 END) AS fabricatedFindings
    FROM site_crawl_findings
    WHERE finding_type = 'dead-link'
    GROUP BY run_id, attempt_id
    HAVING fabricatedFindings > 0
  `) as Array<{ runId: string; attemptId: string; fabricatedTargets: number; realFindings: number }>

  for (const row of affected) {
    tx.run(sql`
      UPDATE site_crawl_snapshots
         SET dead_links_unverified = ${row.fabricatedTargets},
             dead_links_found = ${row.realFindings},
             findings_count = ${row.realFindings},
             dead_links_checked = MAX(0, dead_links_checked - ${row.fabricatedTargets})
       WHERE run_id = ${row.runId} AND attempt_id = ${row.attemptId}
    `)
  }

  tx.run(sql`
    DELETE FROM site_crawl_findings
     WHERE finding_type = 'dead-link'
       AND json_extract(evidence, '$.statusCode') IS NULL
  `)
}

export function relinkOrphanedSnapshotQueryIds(tx: MigrationDb): void {
  const orphans = tx.all(sql`
    SELECT qs.id AS snapId, qs.query_text AS text, r.project_id AS projectId
    FROM query_snapshots qs
    JOIN runs r ON r.id = qs.run_id
    WHERE qs.query_id IS NULL AND qs.query_text IS NOT NULL
  `) as Array<{ snapId: string; text: string; projectId: string }>
  if (orphans.length === 0) return

  const queryRows = tx.all(sql`SELECT id, project_id AS projectId, query FROM queries`) as Array<{
    id: string
    projectId: string
    query: string
  }>
  // project -> normalized text -> query id (first row wins on raw-text
  // duplicates; identical normalized text means identical attribution).
  const byProject = new Map<string, Map<string, string>>()
  for (const row of queryRows) {
    let perProject = byProject.get(row.projectId)
    if (!perProject) {
      perProject = new Map<string, string>()
      byProject.set(row.projectId, perProject)
    }
    const key = normalizeQueryText(row.query)
    if (!perProject.has(key)) perProject.set(key, row.id)
  }

  for (const orphan of orphans) {
    const queryId = byProject.get(orphan.projectId)?.get(normalizeQueryText(orphan.text))
    if (queryId) {
      tx.run(sql`UPDATE query_snapshots SET query_id = ${queryId} WHERE id = ${orphan.snapId}`)
    }
  }
}

/**
 * Recover the served model from already-stored raw responses (v105).
 * `query_snapshots.model` is the model we REQUESTED; the string the provider
 * reported SERVING was already inside `raw_response` at `$.apiResponse.model`
 * but was never promoted to a queryable column.
 *
 * Pure SQL is correct here (unlike v98): the value is a literal string at a
 * fixed JSON path, so there is nothing for TS to normalize. The extract is
 * naturally per-provider — openai / claude / perplexity / local all store an
 * OpenAI- or Anthropic-shaped envelope carrying `model`, while Gemini's
 * envelope carries `modelVersion`, which the pre-fix `responseToRecord`
 * dropped before storage. Gemini rows therefore yield NULL from this path and
 * stay NULL, which is the truth about them; a CDP row has no model identity at
 * all for the same reason.
 *
 * Guards, in order: the `served_model IS NULL` predicate makes a re-run a
 * no-op (idempotent, and it never overwrites a value written by the live
 * insert path), `json_valid` skips rows whose `raw_response` is truncated or
 * non-JSON rather than throwing, and the `IS NOT NULL` extract check leaves
 * rows whose envelope predates the `apiResponse` wrapper untouched.
 * Exported so the migration test can exercise it against seeded rows.
 */
/**
 * Populate `site_crawl_pages.health_state` for every page written before the
 * column existed (v130).
 *
 * The derivation folds fetch state, indexability, the crawler's reasons, and
 * canonical identity together, so it CANNOT be expressed as SQL without
 * becoming a second implementation that drifts from the contract. It does not
 * need to be: this runs in TypeScript inside the version's transaction and
 * calls `deriveSiteHealthState` directly, which is the same function the crawl
 * executor and every reader use.
 *
 * Batched so a large install does not build one enormous statement, and
 * idempotent: only `health_state IS NULL` rows are candidates, so a re-run is
 * a no-op.
 */
/**
 * Remove stored self-links (v132).
 *
 * Pure data change, no schema change. An older binary reading these tables
 * simply sees fewer edge rows, and the rows removed are ones it was counting
 * INCONSISTENTLY with its own page metrics, so a downgrade is strictly better
 * off without them.
 *
 * The graph sample is cleared by node key because a published sample edge is
 * already resolved to nodes; the source table is cleared by the normalized
 * URLs the writer compares in `isSelfLink`.
 */
export function dropSiteCrawlSelfLinks(tx: MigrationDb): void {
  tx.run(sql.raw('DELETE FROM site_crawl_edges WHERE source_url = target_url'))
  tx.run(sql.raw('DELETE FROM site_crawl_graph_edges WHERE source_node_key = target_node_key'))
}

export function backfillSiteCrawlPageHealthState(tx: MigrationDb): void {
  const BATCH = 500
  for (;;) {
    const rows = tx.all(sql.raw(`
      SELECT id, node_key, fetch_state, indexability_state, indexability_reasons, canonical_node_key
      FROM site_crawl_pages
      WHERE health_state IS NULL
      LIMIT ${BATCH}
    `)) as Array<{
      id: string
      node_key: string
      fetch_state: string
      indexability_state: string
      indexability_reasons: string | null
      canonical_node_key: string | null
    }>
    if (rows.length === 0) return

    for (const row of rows) {
      const healthState = deriveSiteHealthState({
        fetchState: row.fetch_state,
        indexabilityState: row.indexability_state,
        indexabilityReasons: parseJsonColumn<string[]>(row.indexability_reasons, []),
        canonicalNodeKey: row.canonical_node_key,
        nodeKey: row.node_key,
      })
      tx.run(sql`UPDATE site_crawl_pages SET health_state = ${healthState} WHERE id = ${row.id}`)
    }
    if (rows.length < BATCH) return
  }
}

/**
 * Read one attempt's links in `edge_key` order, in bounded batches.
 *
 * Keyset (not OFFSET) paging, so the unique `(project, run, attempt, edge_key)`
 * index seeks straight to each batch instead of re-walking every prior row at
 * the million-link crawl budget.
 */
function* streamSiteCrawlTemplateLinkEdges(
  tx: MigrationDb,
  attemptId: string,
  batchSize = 2_000,
): Generator<TemplateLinkEdgeInput[]> {
  let after = ''
  for (;;) {
    const rows = tx.all(sql`
      SELECT edge_key, source_node_key, target_node_key, anchors, relation
      FROM site_crawl_edges
      WHERE attempt_id = ${attemptId} AND edge_key > ${after}
      ORDER BY edge_key
      LIMIT ${batchSize}
    `) as Array<{
      edge_key: string
      source_node_key: string
      target_node_key: string | null
      anchors: string | null
      relation: string
    }>
    if (rows.length === 0) return
    yield rows.map((row) => ({
      edgeKey: row.edge_key,
      sourceNodeKey: row.source_node_key,
      targetNodeKey: row.target_node_key,
      anchors: parseJsonColumn<string[]>(row.anchors, []),
      relation: row.relation,
    }))
    after = rows[rows.length - 1]!.edge_key
    if (rows.length < batchSize) return
  }
}

/** Bounded `IN (...)` writes: SQLite caps bound parameters, and a JSON array is one. */
function* chunked<T>(values: readonly T[], size = 500): Generator<T[]> {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size)
  }
}

/**
 * Classify every stored scan's links as nav/header/footer chrome or content.
 *
 * The derivation is never rewritten in SQL: this calls the contract's own
 * `templateLinkRatio`, the same function the publish path uses, so there is no
 * second implementation to drift. What it deliberately does NOT do is rewrite
 * a published layout's coordinates, which are immutable per attempt: an old
 * scan gains a working filter and truthful counts, and its graph layout row
 * keeps `template_links_excluded = 0` so the map can say its positions still
 * include the nav mesh.
 *
 * Idempotent: every attempt is reclassified from its own stored rows, so a
 * retry produces the same result.
 *
 * Ubiquity only, on purpose and permanently. This hook runs at migrations 131
 * and 133, both of which land BEFORE the placement columns exist (138), and
 * every scan it can reach was captured by a crawler that never recorded where a
 * link sat. There is no placement to read and none to invent, so a stored scan
 * keeps the ubiquity answer and its snapshot keeps a NULL ruleset version,
 * which is what makes reads report `applied` rather than `applied-placement`.
 */
export function backfillSiteCrawlTemplateLinks(tx: MigrationDb): void {
  // Attempts, not links: the small table drives the loop, an attempt with no
  // links still needs its snapshot state, and nothing scans the link table to
  // find work.
  const attempts = tx.all(sql.raw(`
    SELECT
      a.id                AS attempt_id,
      a.project_id        AS project_id,
      a.run_id            AS run_id,
      COALESCE(NULLIF(a.pages_fetched, 0), s.pages_fetched, 0) AS pages_fetched
    FROM site_crawl_attempts AS a
    LEFT JOIN site_crawl_snapshots AS s
      ON s.project_id = a.project_id AND s.run_id = a.run_id AND s.attempt_id = a.id
  `)) as Array<{ attempt_id: string; project_id: string; run_id: string; pages_fetched: number }>

  for (const attempt of attempts) {
    const ubiquityAvailable = templateLinkUbiquityAvailable(attempt.pages_fetched)
    const detection = ubiquityAvailable
      ? SiteHealthTemplateDetections.applied
      : SiteHealthTemplateDetections['unavailable-too-few-pages']
    const scope = { attemptId: attempt.attempt_id, projectId: attempt.project_id, runId: attempt.run_id }

    // Start from "classified, not a template link" for the whole attempt. A
    // NULL left behind here would be read as an unclassified legacy scan.
    tx.run(sql`
      UPDATE site_crawl_edges SET is_template = 0, template_ratio = NULL
      WHERE project_id = ${scope.projectId} AND run_id = ${scope.runId} AND attempt_id = ${scope.attemptId}
    `)
    tx.run(sql`
      UPDATE site_crawl_graph_edges SET is_template = 0
      WHERE project_id = ${scope.projectId} AND run_id = ${scope.runId} AND attempt_id = ${scope.attemptId}
    `)

    if (detection === SiteHealthTemplateDetections.applied) {
      const index = createTemplateLinkPairIndex()
      for (const batch of streamSiteCrawlTemplateLinkEdges(tx, scope.attemptId)) {
        observeTemplateLinkEdges(index, batch)
      }
      // Grouped by the exact ratio so the number of statements is bounded by
      // distinct source-page counts, not by the link budget.
      const keysByRatio = new Map<number, string[]>()
      const templateEdgeKeys: string[] = []
      for (const batch of streamSiteCrawlTemplateLinkEdges(tx, scope.attemptId)) {
        for (const edge of batch) {
          const ratio = templateLinkRatio(index, attempt.pages_fetched, edge)
          if (ratio == null) continue
          const group = keysByRatio.get(ratio)
          if (group) group.push(edge.edgeKey)
          else keysByRatio.set(ratio, [edge.edgeKey])
          if (isTemplateLinkRatio(ratio)) templateEdgeKeys.push(edge.edgeKey)
        }
      }
      for (const [ratio, edgeKeys] of keysByRatio) {
        const isTemplate = isTemplateLinkRatio(ratio) ? 1 : 0
        for (const chunk of chunked(edgeKeys)) {
          tx.run(sql`
            UPDATE site_crawl_edges SET is_template = ${isTemplate}, template_ratio = ${ratio}
            WHERE project_id = ${scope.projectId} AND run_id = ${scope.runId} AND attempt_id = ${scope.attemptId}
              AND edge_key IN (SELECT value FROM json_each(${JSON.stringify(chunk)}))
          `)
        }
      }
      for (const chunk of chunked(templateEdgeKeys)) {
        tx.run(sql`
          UPDATE site_crawl_graph_edges SET is_template = 1
          WHERE project_id = ${scope.projectId} AND run_id = ${scope.runId} AND attempt_id = ${scope.attemptId}
            AND edge_key IN (SELECT value FROM json_each(${JSON.stringify(chunk)}))
        `)
      }
    }

    // The same graph-compatible scope `prepareSiteCrawlGraphLayout` counts:
    // internal anchor links whose source AND target are both crawl pages.
    tx.run(sql`
      UPDATE site_crawl_graph_layouts
      SET total_template_edges = (
        SELECT COUNT(*)
        FROM site_crawl_edges AS e
        INNER JOIN site_crawl_pages AS source_page
          ON source_page.project_id = e.project_id AND source_page.run_id = e.run_id
          AND source_page.attempt_id = e.attempt_id AND source_page.node_key = e.source_node_key
        INNER JOIN site_crawl_pages AS target_page
          ON target_page.project_id = e.project_id AND target_page.run_id = e.run_id
          AND target_page.attempt_id = e.attempt_id AND target_page.node_key = e.target_node_key
        WHERE e.project_id = ${scope.projectId} AND e.run_id = ${scope.runId} AND e.attempt_id = ${scope.attemptId}
          AND e.internal = 1 AND e.relation = 'anchor' AND e.is_template = 1
      )
      WHERE project_id = ${scope.projectId} AND run_id = ${scope.runId} AND attempt_id = ${scope.attemptId}
    `)
    tx.run(sql`
      UPDATE site_crawl_snapshots SET template_detection = ${detection}
      WHERE project_id = ${scope.projectId} AND run_id = ${scope.runId} AND attempt_id = ${scope.attemptId}
    `)
  }
}

export function backfillQuerySnapshotServedModel(tx: MigrationDb): void {
  tx.run(sql.raw(`
    UPDATE query_snapshots
    SET served_model = json_extract(raw_response, '$.apiResponse.model')
    WHERE served_model IS NULL
      AND raw_response IS NOT NULL
      AND json_valid(raw_response)
      AND json_extract(raw_response, '$.apiResponse.model') IS NOT NULL
  `))
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
  {
    version: 94,
    name: 'discovery-session-canonical-count',
    statements: [
      // True post-dedup, pre-truncation canonical count (seed_count is
      // post-truncation). Additive + nullable (downgrade-safe).
      `ALTER TABLE discovery_sessions ADD COLUMN canonical_count INTEGER`,
    ],
  },
  {
    version: 95,
    name: 'ga-ai-referral-traffic-class',
    statements: [],
    run: (tx) => {
      if (!tableExists(tx, 'ga_ai_referrals')) return
      // Split AI referral traffic into paid vs organic/non-paid at ingest.
      // Rows that already exist take the 'organic' default here; v96 backfills
      // them by re-deriving the class from the columns already on each row.
      if (!columnExists(tx, 'ga_ai_referrals', 'traffic_class')) {
        tx.run(sql.raw(`ALTER TABLE ga_ai_referrals ADD COLUMN traffic_class TEXT NOT NULL DEFAULT 'organic'`))
      }
      tx.run(sql.raw(`CREATE INDEX IF NOT EXISTS idx_ga_ai_ref_traffic_class ON ga_ai_referrals(project_id, date, traffic_class)`))
    },
  },
  {
    // v95 added `ga_ai_referrals.traffic_class` with `DEFAULT 'organic'` and did
    // not classify the rows that already existed. Every historical AI referral
    // was therefore stamped 'organic', including paid ChatGPT-ads traffic
    // carrying `medium='cpc'` / `channel_group='Paid Other'`. That silently
    // reports purchased sessions as organic wins.
    //
    // The class is a pure function of columns already stored on each row, so
    // re-derive it here instead of making an operator delete and re-fetch
    // identical data from GA4.
    //
    // Every row is re-classified, not only the "unclassified" ones: v95's
    // default is indistinguishable from a genuinely-organic classification, so
    // there is no way to tell the two apart. `classifyAiReferralTrafficClass`
    // is pure and deterministic, so re-running it over already-correct rows
    // writes nothing, which is what makes this version safe to replay.
    version: 96,
    name: 'ga-ai-referral-traffic-class-backfill',
    statements: [],
    run: (tx) => {
      backfillGaAiReferralTrafficClass(tx)
    },
  },
  {
    // Splits the server-side AI-referral MEASURE by traffic class rather than
    // adding a class column. Paid-ness lives in the request's UTM tags, which
    // `landing_path_normalized` strips, so one hourly bucket can legitimately
    // hold both paid and organic arrivals: a class column outside the 8-column
    // primary key would silently stamp a mixed bucket with one label, and
    // SQLite cannot extend a composite key with ADD COLUMN anyway.
    //
    // Deliberately NO backfill. The discriminator was never persisted — the
    // request's query string is dropped before the hourly bucket and before
    // `raw_event_samples` — so no honest class exists for historical rows.
    // Leaving both counters at 0 surfaces their whole `sessions_or_hits` as the
    // unknown residual. An older binary writing rows after a downgrade lands in
    // that residual too, which is the truth about those rows.
    version: 97,
    name: 'server-side-ai-referral-traffic-class',
    statements: [
      `ALTER TABLE ai_referral_events_hourly ADD COLUMN paid_sessions_or_hits INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ai_referral_events_hourly ADD COLUMN organic_sessions_or_hits INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // One-time self-heal for installs whose snapshot->query FKs were orphaned
    // by the pre-fix delete-all + reinsert replace paths. Data-only UPDATEs
    // (no schema change) via run() — TS matching because SQLite lower() is
    // ASCII-only; see the doc comment on relinkOrphanedSnapshotQueryIds and
    // the downgrade-safety RUN_HOOK_ALLOWLIST justification.
    version: 98,
    name: 'relink-orphaned-snapshot-query-ids',
    statements: [],
    run: (tx) => {
      relinkOrphanedSnapshotQueryIds(tx)
    },
  },
  {
    version: 99,
    name: 'ads-operator-lifecycle',
    statements: [
      `ALTER TABLE ads_campaigns ADD COLUMN description TEXT`,
      `ALTER TABLE ads_campaigns ADD COLUMN start_time INTEGER`,
      `ALTER TABLE ads_campaigns ADD COLUMN end_time INTEGER`,
      `ALTER TABLE ads_ad_groups ADD COLUMN description TEXT`,
      `CREATE TABLE IF NOT EXISTS ads_operations (
        id                    TEXT PRIMARY KEY,
        project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        operation_key         TEXT NOT NULL,
        request_hash          TEXT NOT NULL,
        kind                  TEXT NOT NULL,
        state                 TEXT NOT NULL,
        entity_type           TEXT,
        entity_id             TEXT,
        upstream_updated_at   INTEGER,
        error_code            TEXT,
        error_message         TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_operations_project_key ON ads_operations(project_id, operation_key)`,
      `CREATE INDEX IF NOT EXISTS idx_ads_operations_project_created ON ads_operations(project_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ads_operations_project_state ON ads_operations(project_id, state)`,
    ],
  },
  {
    version: 100,
    name: 'ads-planning-read-model',
    statements: [
      `ALTER TABLE ads_connections ADD COLUMN review_status TEXT`,
      `ALTER TABLE ads_connections ADD COLUMN integrity_review_status TEXT`,
      `ALTER TABLE ads_connections ADD COLUMN integrity_decision TEXT`,
      `ALTER TABLE ads_campaigns ADD COLUMN conversion_event_setting_ids TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    version: 101,
    name: 'ads-operation-reconciliation',
    statements: [
      `ALTER TABLE ads_operations ADD COLUMN ad_account_id TEXT`,
      `ALTER TABLE ads_operations ADD COLUMN reconcile_strategy TEXT`,
      `ALTER TABLE ads_operations ADD COLUMN reconcile_parent_id TEXT`,
      `ALTER TABLE ads_operations ADD COLUMN reconcile_fingerprint TEXT`,
      `ALTER TABLE ads_operations ADD COLUMN reconcile_fields TEXT`,
      `ALTER TABLE ads_operations ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ads_operations ADD COLUMN last_reconciled_at TEXT`,
      `ALTER TABLE ads_operations ADD COLUMN lease_owner TEXT`,
      `ALTER TABLE ads_operations ADD COLUMN lease_expires_at TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_ads_operations_reconcile_lease ON ads_operations(state, lease_expires_at, updated_at)`,
    ],
  },
  {
    version: 102,
    name: 'ads-approval-bound-activation',
    statements: [
      `CREATE TABLE IF NOT EXISTS ads_activation_grants (
        id                       TEXT PRIMARY KEY,
        project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ad_account_id            TEXT NOT NULL,
        manifest_hash            TEXT NOT NULL,
        manifest                 TEXT NOT NULL,
        executor_api_key_id      TEXT NOT NULL REFERENCES api_keys(id),
        approver_api_key_id      TEXT NOT NULL REFERENCES api_keys(id),
        state                    TEXT NOT NULL CHECK (state IN ('approved', 'executing', 'consumed', 'revoked', 'expired', 'unknown')),
        expires_at               TEXT NOT NULL,
        operation_id             TEXT REFERENCES ads_operations(id),
        approved_at              TEXT NOT NULL,
        execution_started_at     TEXT,
        consumed_at              TEXT,
        revoked_at               TEXT,
        expired_at               TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        CHECK (executor_api_key_id <> approver_api_key_id),
        CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (json_valid(manifest)),
        CHECK (
          (state = 'approved' AND operation_id IS NULL AND execution_started_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL)
          OR (state = 'executing' AND operation_id IS NOT NULL AND execution_started_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL)
          OR (state = 'consumed' AND operation_id IS NOT NULL AND execution_started_at IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL AND expired_at IS NULL)
          OR (state = 'revoked' AND operation_id IS NULL AND execution_started_at IS NULL AND consumed_at IS NULL AND revoked_at IS NOT NULL AND expired_at IS NULL)
          OR (state = 'expired' AND operation_id IS NULL AND execution_started_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NOT NULL)
          OR (state = 'unknown' AND operation_id IS NOT NULL AND execution_started_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL)
        )
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ads_activation_grants_project ON ads_activation_grants(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ads_activation_grants_project_state_expiry ON ads_activation_grants(project_id, state, expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_ads_activation_grants_project_manifest ON ads_activation_grants(project_id, manifest_hash)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_activation_grants_operation ON ads_activation_grants(operation_id)`,
      `CREATE TABLE IF NOT EXISTS ads_operation_steps (
        id                       TEXT PRIMARY KEY,
        operation_id             TEXT NOT NULL REFERENCES ads_operations(id) ON DELETE CASCADE,
        ordinal                  INTEGER NOT NULL CHECK (ordinal >= 0),
        entity_type              TEXT NOT NULL CHECK (entity_type IN ('campaign', 'ad_group', 'ad')),
        entity_id                TEXT NOT NULL,
        expected_updated_at      INTEGER NOT NULL CHECK (expected_updated_at >= 0),
        state                    TEXT NOT NULL CHECK (state IN ('pending', 'executing', 'active', 'failed', 'rollback_executing', 'rolled_back', 'rollback_failed', 'unknown')),
        provider_updated_at      INTEGER,
        error_code               TEXT,
        error_message            TEXT,
        remediation              TEXT,
        started_at               TEXT,
        finished_at              TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        CHECK (provider_updated_at IS NULL OR provider_updated_at >= 0),
        CHECK (
          (state = 'pending' AND provider_updated_at IS NULL AND error_code IS NULL AND error_message IS NULL AND remediation IS NULL AND started_at IS NULL AND finished_at IS NULL)
          OR (state = 'executing' AND provider_updated_at IS NULL AND error_code IS NULL AND error_message IS NULL AND remediation IS NULL AND started_at IS NOT NULL AND finished_at IS NULL)
          OR (state = 'active' AND provider_updated_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND remediation IS NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL)
          OR (state = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL AND remediation IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL)
          OR (state = 'rollback_executing' AND provider_updated_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND remediation IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NULL)
          OR (state = 'rolled_back' AND provider_updated_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND remediation IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL)
          OR (state = 'rollback_failed' AND provider_updated_at IS NOT NULL AND error_code IS NOT NULL AND error_message IS NOT NULL AND remediation IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL)
          OR (state = 'unknown' AND error_code IS NOT NULL AND error_message IS NOT NULL AND remediation IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NOT NULL)
        )
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ads_operation_steps_operation_state ON ads_operation_steps(operation_id, state)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_operation_steps_operation_ordinal ON ads_operation_steps(operation_id, ordinal)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_operation_steps_operation_entity ON ads_operation_steps(operation_id, entity_type, entity_id)`,
    ],
  },
  {
    version: 103,
    name: 'ads-activation-revocation-control',
    // Keep the existing grant-state CHECK downgrade-safe. This nullable control
    // flag lets a human stop an executing receipt. Verified rollback consumes
    // the one-shot grant, while ambiguous rollback remains unknown.
    statements: [
      `ALTER TABLE ads_activation_grants ADD COLUMN revocation_requested_at TEXT`,
    ],
  },
  {
    version: 104,
    name: 'project-provider-models',
    // Additive JSON text default keeps older binaries fully functional after a
    // downgrade; they simply ignore the new column.
    statements: [
      `ALTER TABLE projects ADD COLUMN provider_models TEXT NOT NULL DEFAULT '{}'`,
    ],
  },
  {
    // `query_snapshots.model` records the model we REQUESTED, never what the
    // provider actually served. The two diverge routinely — every stored
    // OpenAI row asked for `gpt-5.4` and was served the dated snapshot
    // `gpt-5.4-2026-03-05` — so `model` alone cannot answer "which model
    // produced this answer".
    //
    // The served string was already being captured inside `raw_response`
    // (`$.apiResponse.model`), just never promoted to a queryable column.
    // The backfill below recovers it for the providers whose stored envelope
    // carries it (openai / claude / perplexity, OpenAI- and Anthropic-shaped
    // responses). Gemini rows stay NULL: it reports `modelVersion`, which the
    // pre-fix `responseToRecord` dropped before storage, so no honest served
    // value exists for those rows and inventing one from the configured model
    // would launder a guess as an observation.
    version: 105,
    name: 'query-snapshot-served-model',
    // Additive + nullable: an older binary after a downgrade neither reads nor
    // writes the column, and its INSERTs that omit it still succeed.
    statements: [
      `ALTER TABLE query_snapshots ADD COLUMN served_model TEXT`,
    ],
    // The backfill lives in run(), not statements[], so the downgrade-safety
    // additive check keeps inspecting only the schema change above.
    run: (tx) => {
      backfillQuerySnapshotServedModel(tx)
    },
  },
  {
    // `users` is not additive across landing pages — one visitor who lands on
    // three pages is one user but contributes to three `ga_traffic_snapshots`
    // rows. Summing that dimensioned table overcounts the day. This table
    // stores the same day fetched with NO landing-page dimension, so GA does
    // the dedup and the stored number matches the GA UI. Same shape and
    // rationale as `gsc_daily_totals`.
    version: 106,
    name: 'ga-daily-totals',
    statements: [
      `CREATE TABLE IF NOT EXISTS ga_daily_totals (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date         TEXT NOT NULL,
        sessions     INTEGER NOT NULL DEFAULT 0,
        users        INTEGER NOT NULL DEFAULT 0,
        synced_at    TEXT NOT NULL,
        sync_run_id  TEXT REFERENCES runs(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_daily_totals_project_date ON ga_daily_totals(project_id, date)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_daily_totals_project ON ga_daily_totals(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_daily_totals_run ON ga_daily_totals(sync_run_id)`,
    ],
  },
  {
    // Per-query daily totals fetched WITHOUT the `page` dimension. Summing
    // `gsc_search_data` by query multiplies impressions by how many of the
    // site's pages ranked on the same SERP — ~0% for single-page queries but
    // ~500% for brand+category terms, which reorders a top-queries table.
    // Dropping `page` makes Google do the dedup. Per-query counterpart to
    // `gsc_daily_totals`.
    version: 107,
    name: 'gsc-query-daily-totals',
    statements: [
      `CREATE TABLE IF NOT EXISTS gsc_query_daily_totals (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date         TEXT NOT NULL,
        query        TEXT NOT NULL,
        clicks       INTEGER NOT NULL DEFAULT 0,
        impressions  INTEGER NOT NULL DEFAULT 0,
        position     TEXT NOT NULL DEFAULT '0',
        synced_at    TEXT NOT NULL,
        sync_run_id  TEXT REFERENCES runs(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_query_daily_totals_project_date_query ON gsc_query_daily_totals(project_id, date, query)`,
      `CREATE INDEX IF NOT EXISTS idx_gsc_query_daily_totals_project_date ON gsc_query_daily_totals(project_id, date)`,
      `CREATE INDEX IF NOT EXISTS idx_gsc_query_daily_totals_query ON gsc_query_daily_totals(query)`,
      `CREATE INDEX IF NOT EXISTS idx_gsc_query_daily_totals_run ON gsc_query_daily_totals(sync_run_id)`,
    ],
  },
  {
    version: 108,
    name: 'research-query-runs',
    statements: [
      `CREATE TABLE IF NOT EXISTS research_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'queued', provider TEXT NOT NULL, requested_model TEXT, resolved_model TEXT NOT NULL, location TEXT, total_queries INTEGER NOT NULL, completed_queries INTEGER NOT NULL DEFAULT 0, failed_queries INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT, request_hash TEXT, error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_research_runs_project_created ON research_runs(project_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_research_runs_status ON research_runs(status)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_research_runs_project_idempotency ON research_runs(project_id, idempotency_key)`,
      `CREATE TABLE IF NOT EXISTS research_run_queries (id TEXT PRIMARY KEY, research_run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE, position INTEGER NOT NULL, query_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', requested_model TEXT, resolved_model TEXT NOT NULL, served_model TEXT, answer_text TEXT, grounding_sources TEXT NOT NULL DEFAULT '[]', cited_domains TEXT NOT NULL DEFAULT '[]', search_queries TEXT NOT NULL DEFAULT '[]', answer_mentioned INTEGER, citation_state TEXT, raw_response TEXT, error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_research_run_queries_run ON research_run_queries(research_run_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_research_run_queries_run_position ON research_run_queries(research_run_id, position)`,
    ],
  },
  {
    version: 109,
    name: 'ga-measurement-foundation',
    statements: [
      `ALTER TABLE projects ADD COLUMN measurement_config TEXT NOT NULL DEFAULT '{"marketingHosts":[],"brandTerms":[],"leadEventNames":["generate_lead"]}'`,
      `CREATE TABLE IF NOT EXISTS ga_acquisition_daily (
        id                       TEXT PRIMARY KEY,
        project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date                     TEXT NOT NULL,
        channel_group            TEXT NOT NULL,
        source                   TEXT NOT NULL,
        medium                   TEXT NOT NULL,
        host_name                TEXT NOT NULL,
        landing_page             TEXT NOT NULL,
        landing_page_normalized  TEXT,
        sessions                 INTEGER NOT NULL DEFAULT 0 CHECK (sessions >= 0),
        synced_at                TEXT NOT NULL,
        sync_run_id              TEXT REFERENCES runs(id) ON DELETE CASCADE,
        created_at               TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_acquisition_daily_grain
        ON ga_acquisition_daily(project_id, date, channel_group, source, medium, host_name, landing_page)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_acquisition_daily_project_date
        ON ga_acquisition_daily(project_id, date)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_acquisition_daily_project_channel
        ON ga_acquisition_daily(project_id, date, channel_group)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_acquisition_daily_project_page
        ON ga_acquisition_daily(project_id, date, landing_page_normalized)`,
      `CREATE TABLE IF NOT EXISTS ga_lead_events_daily (
        id                       TEXT PRIMARY KEY,
        project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        date                     TEXT NOT NULL,
        event_name               TEXT NOT NULL,
        channel_group            TEXT NOT NULL,
        source                   TEXT NOT NULL,
        medium                   TEXT NOT NULL,
        host_name                TEXT NOT NULL,
        landing_page             TEXT NOT NULL,
        landing_page_normalized  TEXT,
        attribution_scope        TEXT NOT NULL CHECK (attribution_scope IN ('landing-page', 'channel')),
        event_count              INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
        synced_at                TEXT NOT NULL,
        sync_run_id              TEXT REFERENCES runs(id) ON DELETE CASCADE,
        created_at               TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ga_lead_events_daily_grain
        ON ga_lead_events_daily(project_id, date, event_name, channel_group, source, medium, host_name, landing_page, attribution_scope)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_lead_events_daily_project_date
        ON ga_lead_events_daily(project_id, date)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_lead_events_daily_project_channel
        ON ga_lead_events_daily(project_id, date, channel_group)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_lead_events_daily_project_event
        ON ga_lead_events_daily(project_id, date, event_name)`,
      `CREATE INDEX IF NOT EXISTS idx_ga_lead_events_daily_project_page
        ON ga_lead_events_daily(project_id, date, landing_page_normalized)`,
      `CREATE TABLE IF NOT EXISTS ga_measurement_sync_state (
        project_id                TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        acquisition_status        TEXT NOT NULL DEFAULT 'never-synced'
                                  CHECK (acquisition_status IN ('never-synced', 'ready', 'error')),
        acquisition_error         TEXT,
        acquisition_synced_at     TEXT,
        lead_status               TEXT NOT NULL DEFAULT 'never-synced'
                                  CHECK (lead_status IN ('never-synced', 'ready', 'error')),
        lead_error                TEXT,
        lead_synced_at            TEXT,
        lead_attribution_scope    TEXT
                                  CHECK (lead_attribution_scope IS NULL OR lead_attribution_scope IN ('landing-page', 'channel')),
        updated_at                TEXT NOT NULL
      )`,
    ],
  },
  {
    // Keep research batches useful as a competitor-comparison workspace while
    // retaining their strict isolation from tracked visibility snapshots.
    version: 110,
    name: 'research-query-named-and-cited-competitors',
    statements: [
      `ALTER TABLE research_run_queries ADD COLUMN named_competitors TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE research_run_queries ADD COLUMN cited_competitor_domains TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    // New live rows capture source URLs; historical snapshots intentionally
    // stay NULL so readers can distinguish absent capture from zero sources.
    version: 111,
    name: 'query-snapshot-cited-url-capture',
    statements: [
      `ALTER TABLE query_snapshots ADD COLUMN cited_urls TEXT`,
      `ALTER TABLE query_snapshots ADD COLUMN capture_status TEXT`,
      `ALTER TABLE query_snapshots ADD COLUMN source_count INTEGER`,
      `ALTER TABLE query_snapshots ADD COLUMN resolved_count INTEGER`,
      `ALTER TABLE query_snapshots ADD COLUMN capture_version INTEGER`,
    ],
  },
  {
    // Records whether retrieval ran and under which search policy, so a change
    // in search policy can never produce an unmarked snapshot. Historical rows
    // stay NULL rather than being backfilled to `native-auto-v1`: they were
    // produced under provider-native behaviour, but writing that in would
    // launder an assumption into an observation. Null means "predates the
    // field", which readers must not treat as `not-used`.
    version: 112,
    name: 'query-snapshot-retrieval-contract',
    statements: [
      `ALTER TABLE query_snapshots ADD COLUMN retrieval_status TEXT`,
      `ALTER TABLE query_snapshots ADD COLUMN retrieval_contract TEXT`,
    ],
  },
  {
    // Records the newest instant a sync clamped past instead of ingesting, so
    // the loss survives the watermark moving on. Purely additive: existing rows
    // read NULL, which means "no known skipped span", not "no loss ever".
    version: 113,
    name: 'traffic-source-skipped-span',
    statements: [
      `ALTER TABLE traffic_sources ADD COLUMN skipped_through_at TEXT`,
    ],
  },
  {
    // Scheduled health checks need somewhere to remember the previous outcome so
    // alerting fires on transitions rather than on every pass. Fresh installs and
    // upgrades both start empty, which reads as "no prior observation" and makes
    // the first degraded pass notify exactly once.
    //
    // The default doctor schedule is NOT seeded here. Migrations after v88 must
    // stay additive so a downgrade is safe, and inserting rows is a data
    // mutation. Scheduler.start() ensures the schedule instead, which also lets
    // an operator who disables it keep it disabled.
    version: 114,
    name: 'doctor-health-state',
    statements: [
      `CREATE TABLE IF NOT EXISTS doctor_health_state (
        project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        status      TEXT NOT NULL,
        code        TEXT NOT NULL,
        summary     TEXT NOT NULL,
        checked_at  TEXT NOT NULL,
        notified_at TEXT
      )`,
    ],
  },
  {
    // A trend is only a trend if the query set held still. Analytics used to
    // approximate that with `query.created_at < bucket_start`, which is a date
    // proxy for measurement-set membership and gets it wrong whenever a query is
    // re-added or renamed (both mint a fresh row that reads as brand new).
    //
    // Recording the basket makes membership a fact instead of an inference, and
    // turns a basket change into a visible event on the chart.
    //
    // Nothing is backfilled. A revision is minted lazily the next time each
    // project runs, and rows written before that stamp keep a NULL revision that
    // analytics reads as "unversioned" and falls back to the date rule for. A
    // synthesised revision-1 covering today's queries would claim historical runs
    // measured a set they did not measure, which is the precise error this table
    // exists to stop.
    version: 115,
    name: 'query-basket-versions',
    statements: [
      `CREATE TABLE IF NOT EXISTS query_basket_versions (
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        revision     INTEGER NOT NULL,
        members_json TEXT NOT NULL,
        checksum     TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (project_id, revision)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_query_basket_checksum
         ON query_basket_versions(project_id, checksum)`,
      `ALTER TABLE runs ADD COLUMN query_basket_revision INTEGER`,
    ],
  },
  {
    // GA4 engagement metrics on the property-level daily series.
    //
    // `engagement_rate` and `new_users` are both real GA4 metrics, requested
    // directly. No returning-users column: GA4 exposes no such metric, and
    // `users - new_users` does not reconstruct one because a visitor can be
    // first-seen AND return inside the same range. That needs the
    // `newVsReturning` dimension, which changes the row shape of the sync.
    //
    // Both columns are NULLABLE with no default. Every row written before this
    // migration has no reading, and NOT NULL DEFAULT 0 would turn that absence
    // into a real "0% engaged" day.
    version: 116,
    name: 'ga-daily-totals-engagement',
    statements: [
      `ALTER TABLE ga_daily_totals ADD COLUMN engagement_rate REAL`,
      `ALTER TABLE ga_daily_totals ADD COLUMN new_users INTEGER`,
    ],
  },
  {
    // Measurement plans are optional per-project aggregates with immutable,
    // project-local revision history. Stable Target/group identities preserve
    // lifecycle semantics, while a plan-aware ordinary run pins one revision.
    version: 117,
    name: 'target-measurement-plan-foundation',
    statements: [
      `CREATE TABLE IF NOT EXISTS measurement_plan_versions (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        revision       INTEGER NOT NULL,
        canonical_json TEXT NOT NULL,
        checksum       TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        UNIQUE (project_id, revision),
        UNIQUE (project_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS measurement_segments (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('target', 'group')),
        retired_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, stable_key),
        UNIQUE (project_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS measurement_plans (
        project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        active_version_id TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        FOREIGN KEY (project_id, active_version_id)
          REFERENCES measurement_plan_versions(project_id, id) ON DELETE RESTRICT
      )`,
      `ALTER TABLE runs ADD COLUMN measurement_plan_version_id TEXT`,
      `ALTER TABLE runs ADD COLUMN measurement_manifest TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_runs_measurement_plan
        ON runs(project_id, measurement_plan_version_id, created_at)`,
    ],
  },
  {
    // Historical snapshots stay readable: the new execution/context columns
    // are nullable. Runs are rebuilt once to enforce a same-project composite
    // FK to the immutable plan version they pin.
    version: 118,
    name: 'target-measurement-execution-context',
    statements: [
      `ALTER TABLE query_snapshots ADD COLUMN measurement_execution_id TEXT`,
      `ALTER TABLE query_snapshots ADD COLUMN requested_context TEXT`,
      `ALTER TABLE query_snapshots ADD COLUMN supported_context TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_measurement_slot
        ON query_snapshots(run_id, measurement_execution_id, provider)`,
    ],
    run: addRunsMeasurementPlanVersionForeignKey,
    disableForeignKeys: true,
  },
  {
    // A spot check measures a slice of a published plan. The slice it was asked
    // for is recorded next to the run so a reader never has to infer it from a
    // shorter manifest. Null on every existing row, which is correct: they all
    // measured whatever their plan or query set said in full.
    version: 119,
    name: 'measurement-run-scope',
    statements: [
      `ALTER TABLE runs ADD COLUMN measurement_scope TEXT`,
    ],
  },
  {
    // Engine and model identity is a property of a run, not of a plan: a plan
    // revision that expects two snapshots per question is satisfied by any two
    // engines. Recording it per run makes a swap a new comparable series
    // instead of either silent drift or a run nobody can make valid.
    version: 120,
    name: 'measurement-run-execution-identity',
    statements: [
      `ALTER TABLE runs ADD COLUMN measurement_execution_identity TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_runs_measurement_series
        ON runs(project_id, measurement_plan_version_id, measurement_execution_identity)`,
    ],
  },
  {
    // Named sign-in accounts. Both tables start empty on every existing
    // install, and empty is exactly the historical behavior: nobody is asked
    // to sign in until the first account is created. Nothing is backfilled -
    // there is no account to infer from an API key, and inventing one would
    // turn sign-in on for installs that never asked for it.
    version: 121,
    name: 'user-accounts-and-sessions',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        name_key      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        created_at    TEXT NOT NULL,
        last_login_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at)`,
    ],
  },
  {
    // Advanced Measurement v2 storage on the existing immutable revisions.
    // Every column is additive and every existing row is v1, so nothing
    // published is rewritten.
    //
    // `compiled_checksum` is a NEW column beside `checksum`, not a redefinition
    // of it. `checksum` hashes the whole stored document, revision included, so
    // reusing it as the publish guard would make identical content at two
    // revisions hash differently — "identical to the active revision is a no-op"
    // and revert would both stop working. It is nullable because it was never
    // computed for a historic v1 row, and inventing one would claim a review
    // that never happened.
    version: 122,
    name: 'measurement-plan-v2-version-columns',
    statements: [
      // NOT NULL DEFAULT 1 is the backfill: SQLite writes the default into
      // every existing row as it adds the column, so each historic revision
      // ends up explicitly marked v1 without a separate UPDATE pass.
      `ALTER TABLE measurement_plan_versions ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE measurement_plan_versions ADD COLUMN compiled_checksum TEXT`,
      `ALTER TABLE measurement_plan_versions ADD COLUMN published_by TEXT`,
      `ALTER TABLE measurement_plan_versions ADD COLUMN source_draft_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_measurement_plan_versions_project_revision_desc
        ON measurement_plan_versions(project_id, revision DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_measurement_plan_versions_project_schema
        ON measurement_plan_versions(project_id, schema_version, revision DESC)`,
      // Lookup only, and NOT unique on purpose: a unique index here would
      // refuse to publish content identical to an older revision, leaving an
      // operator who changed a setting and changed it back with no way out.
      `CREATE INDEX IF NOT EXISTS idx_measurement_plan_versions_compiled_checksum
        ON measurement_plan_versions(project_id, compiled_checksum)`,
    ],
  },
  {
    // Server-side authoring: one draft per project, the query assets a draft
    // authors from, the discovery inputs a rerun must reproduce, and the
    // idempotency receipts every mutating action writes. All new tables, so no
    // existing row is touched and every install starts with them empty.
    version: 123,
    name: 'measurement-authoring-tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS measurement_plan_drafts (
        id                     TEXT PRIMARY KEY,
        project_id             TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        schema_version         INTEGER NOT NULL DEFAULT 2,
        base_active_version_id TEXT,
        base_active_revision   INTEGER,
        authoring_json         TEXT NOT NULL,
        etag_version           INTEGER NOT NULL DEFAULT 1,
        created_by             TEXT NOT NULL,
        updated_by             TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS measurement_query_sets (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        description TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_query_sets_project_name
        ON measurement_query_sets(project_id, name)`,
      // ON DELETE CASCADE from the set drops the membership row; the FK to
      // queries only follows a query that was itself deleted. Deleting a set
      // never reaches a query.
      `CREATE TABLE IF NOT EXISTS measurement_query_set_items (
        id           TEXT PRIMARY KEY,
        query_set_id TEXT NOT NULL REFERENCES measurement_query_sets(id) ON DELETE CASCADE,
        query_id     TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
        position     INTEGER NOT NULL,
        created_at   TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_query_set_items_set_query
        ON measurement_query_set_items(query_set_id, query_id)`,
      `CREATE INDEX IF NOT EXISTS idx_measurement_query_set_items_order
        ON measurement_query_set_items(query_set_id, position)`,
      `CREATE TABLE IF NOT EXISTS measurement_query_templates (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        description    TEXT,
        pattern        TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_query_templates_project_name
        ON measurement_query_templates(project_id, name)`,
      `CREATE TABLE IF NOT EXISTS measurement_discovery_configs (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sitemap_url      TEXT NOT NULL,
        rule_json        TEXT NOT NULL,
        exclusions_json  TEXT NOT NULL DEFAULT '[]',
        input_checksum   TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        reviewed_at      TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_discovery_configs_input
        ON measurement_discovery_configs(project_id, input_checksum)`,
      `CREATE INDEX IF NOT EXISTS idx_measurement_discovery_configs_project
        ON measurement_discovery_configs(project_id)`,
      `CREATE TABLE IF NOT EXISTS measurement_operation_receipts (
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        operation        TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        request_checksum TEXT NOT NULL,
        response_json    TEXT NOT NULL,
        status_code      INTEGER NOT NULL,
        created_at       TEXT NOT NULL,
        expires_at       TEXT NOT NULL,
        PRIMARY KEY (project_id, operation, idempotency_key)
      )`,
      // Nothing on the write path deletes a receipt, so the sweep needs this.
      `CREATE INDEX IF NOT EXISTS idx_measurement_operation_receipts_expires
        ON measurement_operation_receipts(expires_at)`,
    ],
  },
  {
    version: 124,
    name: 'measurement-foundation-named-indexes',
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_plan_versions_project_revision
        ON measurement_plan_versions(project_id, revision)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_plan_versions_project_id
        ON measurement_plan_versions(project_id, id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_segments_project_key
        ON measurement_segments(project_id, stable_key)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_measurement_segments_project_id
        ON measurement_segments(project_id, id)`,
    ],
  },
  {
    version: 125,
    name: 'gsc-coverage-unknown-and-provenance',
    statements: [
      // Create-if-missing first. A database migrating up from a legacy schema
      // may not have this table yet, and `ALTER TABLE` on a missing table
      // raises an error the runner does NOT swallow — it only swallows
      // duplicate-column. Mirrors the original definition so this version is
      // self-sufficient and safely re-runnable.
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
      // A THIRD state, not a rename of anything. Named `unknown_pages`
      // because bare `unknown` is a reserved SQL keyword. A page with no
      // impressions and no inspection is unmeasured, and folding it into
      // `not_indexed` would report every such page as a problem.
      `ALTER TABLE gsc_coverage_snapshots ADD COLUMN unknown_pages INTEGER NOT NULL DEFAULT 0`,
      // Provenance: how much of the number is a real Google verdict versus
      // derived from impressions. Lets the UI say how much it actually checked.
      `ALTER TABLE gsc_coverage_snapshots ADD COLUMN verified_by_inspection INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE gsc_coverage_snapshots ADD COLUMN derived_from_impressions INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // Crawl persistence is intentionally separate from the legacy
    // site_audit_snapshots/site_audit_pages scorecard model. Older engines can
    // keep reading and writing that legacy surface after a rollback; new tables
    // only enrich an audit run when the crawler writes them.
    version: 126,
    name: 'site-crawl-persistence',
    statements: [
      // Composite child FKs below enforce that project_id and run_id are a
      // matched pair. `runs.id` is globally unique already; this named unique
      // index provides SQLite's required parent key for the composite check.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_project_id ON runs(project_id, id)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_run_requests (
        run_id           TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        identity_key     TEXT NOT NULL,
        effective_options TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_run_requests_project
        ON site_crawl_run_requests(project_id, run_id)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_attempts (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id              TEXT NOT NULL,
        attempt_number      INTEGER NOT NULL,
        state               TEXT NOT NULL DEFAULT 'queued',
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        last_event_checksum TEXT,
        pages_discovered    INTEGER NOT NULL DEFAULT 0,
        pages_fetched       INTEGER NOT NULL DEFAULT 0,
        pages_eligible      INTEGER NOT NULL DEFAULT 0,
        pages_errored       INTEGER NOT NULL DEFAULT 0,
        edges_discovered    INTEGER NOT NULL DEFAULT 0,
        started_at          TEXT,
        finished_at         TEXT,
        error               TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_attempts_run_number
        ON site_crawl_attempts(run_id, attempt_number)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_attempts_project_run_id
        ON site_crawl_attempts(project_id, run_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_attempts_project_run
        ON site_crawl_attempts(project_id, run_id)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_snapshots (
        id                    TEXT PRIMARY KEY,
        project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id                TEXT NOT NULL,
        attempt_id            TEXT,
        root_url              TEXT NOT NULL,
        crawl_schema_version  TEXT NOT NULL DEFAULT '1.0',
        engine_version        TEXT NOT NULL DEFAULT '',
        normalization_version TEXT NOT NULL DEFAULT '',
        indexability_version  TEXT NOT NULL DEFAULT '',
        link_score_version    TEXT NOT NULL DEFAULT '',
        effective_options     TEXT NOT NULL DEFAULT '{}',
        page_budget           INTEGER,
        edge_budget           INTEGER,
        max_depth             INTEGER,
        check_dead_links      INTEGER NOT NULL DEFAULT 0,
        complete              INTEGER NOT NULL DEFAULT 0,
        termination           TEXT NOT NULL DEFAULT 'unknown',
        details_available     INTEGER NOT NULL DEFAULT 0,
        pages_discovered      INTEGER NOT NULL DEFAULT 0,
        pages_fetched         INTEGER NOT NULL DEFAULT 0,
        pages_eligible        INTEGER NOT NULL DEFAULT 0,
        pages_errored         INTEGER NOT NULL DEFAULT 0,
        edges_discovered      INTEGER NOT NULL DEFAULT 0,
        findings_count        INTEGER NOT NULL DEFAULT 0,
        dead_link_state       TEXT NOT NULL DEFAULT 'disabled',
        dead_links_checked    INTEGER NOT NULL DEFAULT 0,
        dead_links_found      INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, run_id, attempt_id)
          REFERENCES site_crawl_attempts(project_id, run_id, id)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_snapshots_run ON site_crawl_snapshots(run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_snapshots_project_created
        ON site_crawl_snapshots(project_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_pages (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id               TEXT NOT NULL,
        attempt_id           TEXT NOT NULL,
        node_key             TEXT NOT NULL,
        url                  TEXT NOT NULL,
        path                 TEXT NOT NULL,
        parent_path          TEXT NOT NULL,
        discovery_source     TEXT NOT NULL DEFAULT 'crawl',
        discovery_provenance TEXT NOT NULL DEFAULT '[]',
        sitemap_metadata     TEXT NOT NULL DEFAULT '{}',
        fetch_state          TEXT NOT NULL DEFAULT 'queued',
        fetched_at           TEXT,
        http_status          INTEGER,
        content_type         TEXT,
        final_url            TEXT,
        redirect_chain       TEXT NOT NULL DEFAULT '[]',
        directives           TEXT NOT NULL DEFAULT '{}',
        canonical_url        TEXT,
        canonical_node_key   TEXT,
        indexability_state   TEXT NOT NULL DEFAULT 'unknown',
        indexability_reasons TEXT NOT NULL DEFAULT '[]',
        audit_state          TEXT NOT NULL DEFAULT 'pending',
        audit_score          REAL,
        audit_fields         TEXT NOT NULL DEFAULT '{}',
        inventory_eligible   INTEGER NOT NULL DEFAULT 0,
        depth                INTEGER,
        inbound_unique_edges INTEGER NOT NULL DEFAULT 0,
        outbound_unique_edges INTEGER NOT NULL DEFAULT 0,
        inbound_occurrences  INTEGER NOT NULL DEFAULT 0,
        outbound_occurrences INTEGER NOT NULL DEFAULT 0,
        link_score_raw       REAL,
        link_score_normalized REAL,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id, attempt_id)
          REFERENCES site_crawl_attempts(project_id, run_id, id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_pages_attempt_node
        ON site_crawl_pages(project_id, run_id, attempt_id, node_key)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_pages_read
        ON site_crawl_pages(project_id, run_id, attempt_id, inventory_eligible, audit_score, url)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_pages_parent
        ON site_crawl_pages(project_id, run_id, attempt_id, parent_path, path)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_pages_url
        ON site_crawl_pages(project_id, run_id, attempt_id, url)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_edges (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id          TEXT NOT NULL,
        attempt_id      TEXT NOT NULL,
        edge_key        TEXT NOT NULL,
        source_node_key TEXT NOT NULL,
        source_url      TEXT NOT NULL,
        target_node_key TEXT,
        target_url      TEXT NOT NULL,
        relation        TEXT NOT NULL DEFAULT 'link',
        internal        INTEGER NOT NULL DEFAULT 1,
        followable      INTEGER NOT NULL DEFAULT 1,
        occurrences     INTEGER NOT NULL DEFAULT 1,
        followable_occurrences INTEGER NOT NULL DEFAULT 1,
        nofollow_occurrences   INTEGER NOT NULL DEFAULT 0,
        anchors         TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id, attempt_id)
          REFERENCES site_crawl_attempts(project_id, run_id, id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_edges_attempt_key
        ON site_crawl_edges(project_id, run_id, attempt_id, edge_key)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_edges_outbound
        ON site_crawl_edges(project_id, run_id, attempt_id, source_node_key, edge_key)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_edges_inbound
        ON site_crawl_edges(project_id, run_id, attempt_id, target_node_key, edge_key)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_edges_source_url
        ON site_crawl_edges(project_id, run_id, attempt_id, source_url)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_edges_target_url
        ON site_crawl_edges(project_id, run_id, attempt_id, target_url)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_findings (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id          TEXT NOT NULL,
        attempt_id      TEXT NOT NULL,
        finding_key     TEXT NOT NULL,
        finding_type    TEXT NOT NULL,
        severity        TEXT NOT NULL DEFAULT 'info',
        source_node_key TEXT,
        source_url      TEXT,
        target_node_key TEXT,
        target_url      TEXT,
        evidence        TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id, attempt_id)
          REFERENCES site_crawl_attempts(project_id, run_id, id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_findings_attempt_key
        ON site_crawl_findings(project_id, run_id, attempt_id, finding_key)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_findings_type
        ON site_crawl_findings(project_id, run_id, attempt_id, finding_type, finding_key)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_event_receipts (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id     TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        sequence   INTEGER NOT NULL,
        batch_id   TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        receipt    TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id, attempt_id)
          REFERENCES site_crawl_attempts(project_id, run_id, id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_receipts_attempt_event
        ON site_crawl_event_receipts(attempt_id, sequence, batch_id)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_receipts_project_run
        ON site_crawl_event_receipts(project_id, run_id, attempt_id)`,
    ],
  },
  {
    // Graph coordinates are optional derived snapshot data. Separate tables
    // preserve the canonical crawl-page shape and make a missing row the
    // truthful compatibility signal for snapshots published before v127.
    version: 127,
    name: 'site-crawl-persisted-graph-layout',
    statements: [
      `CREATE TABLE IF NOT EXISTS site_crawl_graph_layouts (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id         TEXT NOT NULL,
        attempt_id     TEXT NOT NULL,
        state          TEXT NOT NULL CHECK (state IN ('ready', 'unavailable')),
        layout_version TEXT,
        failure_code   TEXT,
        total_nodes    INTEGER NOT NULL DEFAULT 0,
        total_edges    INTEGER NOT NULL DEFAULT 0,
        node_count     INTEGER NOT NULL DEFAULT 0,
        edge_count     INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id, attempt_id)
          REFERENCES site_crawl_attempts(project_id, run_id, id) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_graph_layouts_attempt
        ON site_crawl_graph_layouts(project_id, run_id, attempt_id)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_graph_layouts_run
        ON site_crawl_graph_layouts(project_id, run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_edges_graph_sample
        ON site_crawl_edges(project_id, run_id, attempt_id, internal, relation, occurrences DESC, edge_key ASC)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_graph_nodes (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id      TEXT NOT NULL,
        attempt_id  TEXT NOT NULL,
        node_key    TEXT NOT NULL,
        sample_rank INTEGER NOT NULL CHECK (sample_rank >= 0),
        x           REAL NOT NULL,
        y           REAL NOT NULL,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id, attempt_id)
          REFERENCES site_crawl_graph_layouts(project_id, run_id, attempt_id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, run_id, attempt_id, node_key)
          REFERENCES site_crawl_pages(project_id, run_id, attempt_id, node_key) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_graph_nodes_attempt_node
        ON site_crawl_graph_nodes(project_id, run_id, attempt_id, node_key)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_graph_nodes_attempt_rank
        ON site_crawl_graph_nodes(project_id, run_id, attempt_id, sample_rank)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_graph_nodes_read
        ON site_crawl_graph_nodes(project_id, run_id, attempt_id, sample_rank)`,
      `CREATE TABLE IF NOT EXISTS site_crawl_graph_edges (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id          TEXT NOT NULL,
        attempt_id      TEXT NOT NULL,
        edge_key        TEXT NOT NULL,
        sample_rank     INTEGER NOT NULL CHECK (sample_rank >= 0),
        source_node_key TEXT NOT NULL,
        target_node_key TEXT NOT NULL,
        followable      INTEGER NOT NULL,
        occurrences     INTEGER NOT NULL CHECK (occurrences > 0),
        created_at      TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id, attempt_id)
          REFERENCES site_crawl_graph_layouts(project_id, run_id, attempt_id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, run_id, attempt_id, source_node_key)
          REFERENCES site_crawl_graph_nodes(project_id, run_id, attempt_id, node_key) ON DELETE CASCADE,
        FOREIGN KEY (project_id, run_id, attempt_id, target_node_key)
          REFERENCES site_crawl_graph_nodes(project_id, run_id, attempt_id, node_key) ON DELETE CASCADE,
        FOREIGN KEY (project_id, run_id, attempt_id, edge_key)
          REFERENCES site_crawl_edges(project_id, run_id, attempt_id, edge_key) ON DELETE CASCADE
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_graph_edges_attempt_edge
        ON site_crawl_graph_edges(project_id, run_id, attempt_id, edge_key)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_site_crawl_graph_edges_attempt_rank
        ON site_crawl_graph_edges(project_id, run_id, attempt_id, sample_rank)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_graph_edges_read
        ON site_crawl_graph_edges(project_id, run_id, attempt_id, sample_rank)`,
    ],
  },
  {
    // Keep the operator-requested root beside the terminal root without
    // rewriting immutable historical snapshots. The edge indexes make layout
    // cleanup/cascades linear at the graph's 20k/50k publish cap.
    version: 128,
    name: 'site-crawl-requested-root-and-graph-edge-cleanup-indexes',
    statements: [
      `ALTER TABLE site_crawl_snapshots ADD COLUMN requested_root_url TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_graph_edges_source_node
        ON site_crawl_graph_edges(project_id, run_id, attempt_id, source_node_key)`,
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_graph_edges_target_node
        ON site_crawl_graph_edges(project_id, run_id, attempt_id, target_node_key)`,
    ],
  },
  {
    version: 129,
    name: 'traffic-ingest-foundation',
    // Push-receive traffic sources (currently only `cloudflare`) need a
    // per-source bearer for the Worker to authenticate against canonry's
    // ingest endpoint, plus a place to remember the deployed Worker version.
    // Durable receipts are transport-neutral: direct push and Queue pull
    // pull consumer both claim an event in the same transaction as rollups.
    // Cleartext credentials remain outside the database.
    //
    // Idempotent: `ALTER TABLE ADD COLUMN` errors with "duplicate column
    // name" on retry, which the runner already swallows.
    statements: [
      `ALTER TABLE traffic_sources ADD COLUMN ingest_token_hash TEXT`,
      `ALTER TABLE traffic_sources ADD COLUMN last_worker_version TEXT`,
      `CREATE TABLE IF NOT EXISTS traffic_event_receipts (
        source_id  TEXT NOT NULL REFERENCES traffic_sources(id) ON DELETE CASCADE,
        event_id   TEXT NOT NULL,
        received_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (source_id, event_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_traffic_event_receipts_expires
        ON traffic_event_receipts(source_id, expires_at)`,
    ],
  },
  {
    version: 130,
    name: 'site-crawl-pages-persisted-health-state',
    // Site Health state is derived from fetch state, indexability, the
    // crawler's reasons, and canonical identity together. Filtering it by
    // recomputing in JS meant reading every page row on every request. It is
    // now written once at publish time by the SAME contract function the map
    // and the agents use, so reads are an ordinary indexed WHERE.
    //
    // Backfilled in TypeScript inside this transaction (see
    // `backfillSiteCrawlPageHealthState`) so existing scans are filterable
    // immediately. The derivation is never rewritten in SQL: the backfill
    // calls the contract's own function, so there is no second implementation
    // to drift. `unavailable-legacy-scan` therefore survives only as the
    // honest answer for a row this could not reach.
    //
    // Idempotent: `ALTER TABLE ADD COLUMN` errors with "duplicate column
    // name" on retry, which the runner already swallows, and the backfill
    // only touches NULL rows.
    statements: [
      `ALTER TABLE site_crawl_pages ADD COLUMN health_state TEXT`,
      // Trailing columns match the ORDER BY the page list actually issues
      // (`sort=path`), so a filtered read terminates at LIMIT instead of
      // sorting every match in a temp b-tree on every cursor page.
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_pages_health
        ON site_crawl_pages(project_id, run_id, attempt_id, health_state, path, node_key)`,
    ],
    run: backfillSiteCrawlPageHealthState,
  },
  {
    version: 131,
    name: 'site-crawl-template-link-classification',
    // A real site's internal links are bimodal: a (target page, anchor) pair
    // sits on nearly every page or on nearly none. The ubiquitous half is nav,
    // header, and footer chrome, and drawing it buries the content structure
    // the map exists to show. Classification is computed once at publish time
    // by the contract's own function, so the map, the API filters, and the
    // agents cannot disagree about which links are chrome.
    //
    // `is_template` and `template_detection` are deliberately nullable:
    // NULL means "never classified" and reads report it as
    // `unavailable-legacy-scan`. The too-few-pages guard writes an explicit
    // `false` plus its reason on the snapshot, so an empty template-link list
    // can never pass for "this site has no nav".
    //
    // Idempotent: `ALTER TABLE ADD COLUMN` errors with "duplicate column
    // name", which the runner already swallows, and the backfill reclassifies
    // each attempt from its own stored rows.
    statements: [
      `ALTER TABLE site_crawl_edges ADD COLUMN is_template INTEGER`,
      `ALTER TABLE site_crawl_edges ADD COLUMN template_ratio REAL`,
      `ALTER TABLE site_crawl_graph_edges ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE site_crawl_graph_layouts ADD COLUMN total_template_edges INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE site_crawl_graph_layouts ADD COLUMN template_links_excluded INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE site_crawl_snapshots ADD COLUMN template_detection TEXT`,
      // Trailing edge key matches the ORDER BY the internal-link reads issue,
      // so a filtered page terminates at LIMIT.
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_edges_template
        ON site_crawl_edges(project_id, run_id, attempt_id, internal, is_template, edge_key)`,
    ],
    run: backfillSiteCrawlTemplateLinks,
  },
  {
    version: 132,
    name: 'site-crawl-drop-self-links',
    // A page linking to itself is not a link to or from another page, and the
    // crawl engine already excludes self-loops from a page's inbound and
    // outbound metrics. The edge tables kept them, so the stored edges
    // disagreed with the page rows produced by the same crawl: a self-loop
    // appeared in BOTH neighbour lists, so every self-linking page read one
    // higher in each direction than its own tiles.
    //
    // The writer now drops them, which fixes new scans. This clears the ones
    // already stored so an existing scan is correct without a re-crawl.
    // Comparing the stored normalized URLs is exactly the rule the writer
    // applies (`isSelfLink`), expressed as the equality SQL can do without
    // reimplementing any derivation.
    //
    // Idempotent: a re-run deletes nothing once the rows are gone.
    statements: [],
    run: dropSiteCrawlSelfLinks,
  },
  {
    version: 133,
    name: 'site-crawl-reclassify-template-links-per-anchor',
    // v131 classified a link as chrome when its MOST ubiquitous anchor was
    // ubiquitous. One stored link row aggregates every anchor the crawl saw
    // between the same two pages, so on any site with a comprehensive footer
    // (which is most sites) an in-prose link to a footer-linked target shared
    // a row with that page's footer link and inherited its ratio. The
    // editorial link was marked chrome, hidden from the map, and dropped from
    // every content count. Observed on canonry.ai: /aeo-methodology had 24
    // outbound links, all marked chrome at ratio 0.96, with anchors like
    // "Explore the Canonry platform" that are plainly editorial.
    //
    // The rule is now the LEAST ubiquitous anchor: chrome only when every
    // anchor on the link is chrome. This re-runs the same backfill hook, which
    // reclassifies each attempt from its own stored rows through the corrected
    // contract function, so an existing scan is right without a re-crawl.
    //
    // Statements stay empty because v131 already added every column; only the
    // values were wrong. Re-running is safe: the hook resets each attempt to
    // "classified, not chrome" before it writes, so it is idempotent and its
    // result depends on nothing but the stored links.
    statements: [],
    run: backfillSiteCrawlTemplateLinks,
  },
  {
    version: 134,
    name: 'site-crawl-live-page-health-preview-index',
    // The live Page Health preview is deliberately small and stable while a
    // crawl writes more pages: completed audits below the display threshold,
    // ordered worst-first by score and then node key. Cover the exact WHERE +
    // ORDER BY shape so the read stops at LIMIT without sorting every current
    // crawl row in a temporary b-tree. Its standard composite-index SQL is
    // also PostgreSQL-compatible; the query shape has no SQLite-only syntax.
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_site_crawl_pages_live_preview
        ON site_crawl_pages(project_id, run_id, attempt_id, audit_state, audit_score, node_key)`,
    ],
  },
  {
    version: 135,
    name: 'traffic-source-sync-lease',
    // A source-scoped lease serializes external pull consumers. Nullable
    // fields preserve every existing source and let an older binary continue
    // to insert source rows without knowing about leases.
    statements: [
      `ALTER TABLE traffic_sources ADD COLUMN sync_lease_owner TEXT`,
      `ALTER TABLE traffic_sources ADD COLUMN sync_lease_expires_at TEXT`,
    ],
  },
  {
    version: 136,
    name: 'traffic-source-queue-backlog',
    // Persist Cloudflare's residual Queue depth so a bounded successful drain
    // cannot hide that work remains. NULL preserves every legacy source and
    // distinguishes "not observed" from an observed empty Queue.
    statements: [
      `ALTER TABLE traffic_sources ADD COLUMN queue_backlog_count INTEGER`,
      `ALTER TABLE traffic_sources ADD COLUMN queue_backlog_observed_at TEXT`,
    ],
  },
  {
    version: 137,
    name: 'gsc-data-watermark',
    // The furthest GSC reporting date this project has EVER observed.
    //
    // `MAX(date)` over the stored rows is not a frontier: Search Analytics
    // returns no row for a day with no data, so a quiet tail makes the observed
    // max walk BACKWARD and drags every anchored window back with it. This
    // column is monotonic — a sync may only advance it — so a zero-traffic
    // stretch can never move the frontier the wrong way.
    statements: [
      `CREATE TABLE IF NOT EXISTS gsc_data_watermarks (
        project_id          TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        data_through_date   TEXT NOT NULL,
        synced_through_date TEXT,
        updated_at          TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 138,
    name: 'site-crawl-link-placement',
    // The crawler (aeo-audit 4.7.0) now reports where each link occurrence sat
    // in its page, from the page's own landmarks. That is ground truth about a
    // link, and it replaces ubiquity as the rule that separates nav from
    // content: ubiquity keys on (target URL, anchor text), so it cannot see an
    // editorial link whose anchor text matches the nav's, which is the common
    // case because good anchor text reuses the destination's name. Measured on
    // canonry.ai: 53 newly added editorial links moved the content-link count
    // by ZERO.
    //
    // These columns are deliberately nullable and deliberately NOT backfilled.
    // A crawl captured before the landmark ruleset existed never observed
    // placement, so there is nothing to derive from and any value written here
    // would be invented. Those scans keep the ubiquity classification they
    // already have, and their snapshots keep a NULL ruleset version, which is
    // exactly what makes a read say `applied` rather than `applied-placement`.
    // Re-running a scan is what upgrades it.
    //
    // Idempotent: `ALTER TABLE ADD COLUMN` errors with "duplicate column name",
    // which the runner already swallows, and there is no data pass to repeat.
    statements: [
      `ALTER TABLE site_crawl_edges ADD COLUMN placement_navigation_occurrences INTEGER`,
      `ALTER TABLE site_crawl_edges ADD COLUMN placement_content_occurrences INTEGER`,
      `ALTER TABLE site_crawl_edges ADD COLUMN placement_unknown_occurrences INTEGER`,
      `ALTER TABLE site_crawl_snapshots ADD COLUMN link_placement_ruleset_version TEXT`,
    ],
  },
  {
    version: 139,
    name: 'traffic-verification-manifest-provenance',
    // Verification is evidence produced by one exact range manifest. Store
    // that provenance in additive sidecars: the existing rollup keys stay
    // unchanged so an older binary can still upsert them after a rollback.
    // Historical rows deliberately receive no sidecar row because the old
    // schema never recorded which bundle classified them.
    statements: [
      `CREATE TABLE IF NOT EXISTS crawler_verification_manifests_hourly (
        project_id          TEXT NOT NULL,
        source_id           TEXT NOT NULL,
        ts_hour             TEXT NOT NULL,
        bot_id              TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        path_normalized     TEXT NOT NULL,
        status              INTEGER NOT NULL,
        manifest_id         TEXT NOT NULL,
        manifest_json       TEXT,
        hits                INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (
          project_id, source_id, ts_hour, bot_id, verification_status,
          path_normalized, status, manifest_id
        ),
        FOREIGN KEY (
          project_id, source_id, ts_hour, bot_id, verification_status,
          path_normalized, status
        ) REFERENCES crawler_events_hourly (
          project_id, source_id, ts_hour, bot_id, verification_status,
          path_normalized, status
        ) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_crawler_verification_manifests_project_ts
        ON crawler_verification_manifests_hourly(project_id, ts_hour)`,
      `CREATE TABLE IF NOT EXISTS ai_user_fetch_verification_manifests_hourly (
        project_id          TEXT NOT NULL,
        source_id           TEXT NOT NULL,
        ts_hour             TEXT NOT NULL,
        bot_id              TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        path_normalized     TEXT NOT NULL,
        status              INTEGER NOT NULL,
        manifest_id         TEXT NOT NULL,
        manifest_json       TEXT,
        hits                INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (
          project_id, source_id, ts_hour, bot_id, verification_status,
          path_normalized, status, manifest_id
        ),
        FOREIGN KEY (
          project_id, source_id, ts_hour, bot_id, verification_status,
          path_normalized, status
        ) REFERENCES ai_user_fetch_events_hourly (
          project_id, source_id, ts_hour, bot_id, verification_status,
          path_normalized, status
        ) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ai_user_fetch_verification_manifests_project_ts
        ON ai_user_fetch_verification_manifests_hourly(project_id, ts_hour)`,
    ],
  },
  {
    version: 140,
    name: 'site-crawl-dead-links-unverified',
    // A "dead link" and "a link we could not check" were the same bucket, and
    // the second one is far more common than the first. The crawler marks a
    // page `fetch-error` both when the site answers 4xx/5xx AND when the fetch
    // never completed at all, and the dead-link derivation accepted either —
    // so a timeout or a reset connection under crawl concurrency became a
    // reported broken link. On one 228-page site that produced 15 findings
    // across 6 URLs, every one `statusCode: null`, and every one of those 6
    // served a 200 in under a second on a manual check. It was client-facing
    // output.
    //
    // Unverified targets now get their own count, and are excluded from both
    // `dead_links_found` and `dead_links_checked` — calling them "checked"
    // was the other half of the overstatement.
    //
    // The stored rows ARE reclassified, in `run()`, because the evidence to do
    // it survives on the rows themselves: each finding carries its own
    // `evidence.statusCode`, so a fabricated row is identifiable one row at a
    // time and nothing is inferred from the blended totals. Leaving them would
    // keep the bug live on every past scan — the read path serves stored
    // findings, so rescanning one project would fix only that project.
    statements: [
      `ALTER TABLE site_crawl_snapshots ADD COLUMN dead_links_unverified INTEGER NOT NULL DEFAULT 0`,
    ],
    run: (tx) => {
      reclassifyFabricatedDeadLinks(tx)
    },
  },
  {
    version: 141,
    name: 'google-marketing-read-only-foundation',
    // Project-scoped Google Ads / GTM metadata plus append-only, sanitized
    // observations. OAuth credentials and provider bodies are never persisted:
    // snapshots contain only the bounded DTO-shaped projection and raw-body
    // hashes/size for provenance. Composite foreign keys prevent a snapshot
    // from joining a run or connection owned by a different project.
    statements: [
      `CREATE TABLE IF NOT EXISTS google_ads_connections (
        id                              TEXT PRIMARY KEY,
        project_id                      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        selected_login_customer_id      TEXT,
        selected_customer_id            TEXT,
        selected_customer_name          TEXT,
        selected_customer_currency_code TEXT,
        selected_customer_time_zone     TEXT,
        selected_customer_status        TEXT,
        scopes                          TEXT NOT NULL DEFAULT '[]',
        last_validated_at               TEXT,
        last_inventory_snapshot_at      TEXT,
        last_metrics_snapshot_at        TEXT,
        created_at                      TEXT NOT NULL,
        updated_at                      TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_connections_project
        ON google_ads_connections(project_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_connections_project_id
        ON google_ads_connections(project_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_google_ads_connections_selected_customer
        ON google_ads_connections(selected_customer_id)`,
      `CREATE TABLE IF NOT EXISTS gtm_connections (
        id                           TEXT PRIMARY KEY,
        project_id                   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        selected_account_id          TEXT,
        selected_account_name        TEXT,
        selected_container_id        TEXT,
        selected_container_name      TEXT,
        selected_container_public_id TEXT,
        selected_workspace_id        TEXT,
        selected_workspace_name      TEXT,
        scopes                       TEXT NOT NULL DEFAULT '[]',
        last_validated_at            TEXT,
        last_snapshot_at             TEXT,
        created_at                   TEXT NOT NULL,
        updated_at                   TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_gtm_connections_project
        ON gtm_connections(project_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_gtm_connections_project_id
        ON gtm_connections(project_id, id)`,
      `CREATE INDEX IF NOT EXISTS idx_gtm_connections_selected_container
        ON gtm_connections(selected_container_id)`,
      `CREATE TABLE IF NOT EXISTS google_ads_raw_snapshots (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL,
        connection_id        TEXT NOT NULL,
        run_id               TEXT NOT NULL,
        kind                 TEXT NOT NULL,
        customer_id          TEXT,
        payload_checksum     TEXT NOT NULL,
        raw_payload_sha256   TEXT,
        raw_payload_bytes    INTEGER,
        redacted_field_count INTEGER NOT NULL DEFAULT 0,
        payload              TEXT NOT NULL,
        captured_at          TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id)
          REFERENCES runs(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, connection_id)
          REFERENCES google_ads_connections(project_id, id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_project_run
        ON google_ads_raw_snapshots(project_id, run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_connection_kind_captured
        ON google_ads_raw_snapshots(connection_id, kind, captured_at)`,
      `CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_project_captured
        ON google_ads_raw_snapshots(project_id, captured_at)`,
      `CREATE TABLE IF NOT EXISTS gtm_raw_snapshots (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL,
        connection_id        TEXT NOT NULL,
        run_id               TEXT NOT NULL,
        kind                 TEXT NOT NULL,
        account_id           TEXT,
        container_id         TEXT,
        workspace_id         TEXT,
        payload_checksum     TEXT NOT NULL,
        raw_payload_sha256   TEXT,
        raw_payload_bytes    INTEGER,
        redacted_field_count INTEGER NOT NULL DEFAULT 0,
        payload              TEXT NOT NULL,
        captured_at          TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id)
          REFERENCES runs(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, connection_id)
          REFERENCES gtm_connections(project_id, id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_gtm_raw_snapshots_project_run
        ON gtm_raw_snapshots(project_id, run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_gtm_raw_snapshots_connection_kind_captured
        ON gtm_raw_snapshots(connection_id, kind, captured_at)`,
      `CREATE INDEX IF NOT EXISTS idx_gtm_raw_snapshots_project_container_captured
        ON gtm_raw_snapshots(project_id, container_id, captured_at)`,
    ],
  },
  {
    version: 142,
    name: 'conversion-tracking-contracts',
    // A durable desired-state anchor for integrity reads. This intentionally
    // has no FK to a live Google connection or snapshot: a missing provider
    // entity is itself a meaningful static finding. Nested JSON is restricted
    // to the typed contract's safe identifiers and verification requirements.
    statements: [
      `CREATE TABLE IF NOT EXISTS conversion_tracking_contracts (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        event_name  TEXT NOT NULL,
        google_ads  TEXT NOT NULL,
        gtm         TEXT NOT NULL,
        runtime     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_conversion_tracking_contracts_project_name
        ON conversion_tracking_contracts(project_id, name)`,
      `CREATE INDEX IF NOT EXISTS idx_conversion_tracking_contracts_project_event
        ON conversion_tracking_contracts(project_id, event_name)`,
    ],
  },
  {
    version: 143,
    name: 'google-marketing-selection-generation-anchors',
    // Timestamps are presentation metadata, not a generation boundary: an old
    // snapshot and a same-millisecond reselection/sync can share one ISO value.
    // Keep private monotonic CAS tokens on the connections and exact snapshot
    // IDs for current-evidence reads. Existing observations intentionally are
    // not backfilled: their generation provenance was never recorded.
    statements: [
      `ALTER TABLE google_ads_connections ADD COLUMN selection_generation INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE google_ads_connections ADD COLUMN last_customer_snapshot_id TEXT`,
      `ALTER TABLE google_ads_connections ADD COLUMN last_inventory_snapshot_id TEXT`,
      `ALTER TABLE google_ads_connections ADD COLUMN last_metrics_snapshot_id TEXT`,
      `ALTER TABLE gtm_connections ADD COLUMN selection_generation INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE gtm_connections ADD COLUMN last_snapshot_id TEXT`,
    ],
  },
  {
    version: 144,
    name: 'raw-event-sample-retention-index',
    // New sample timestamps are canonical UTC, so the startup/daily retention
    // sweep can use one global expiry index. Legacy offsets are handled by the
    // sweep's compatibility predicate without mutating data in this migration.
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_raw_event_samples_ts ON raw_event_samples(ts)`,
    ],
  },
  {
    version: 145,
    name: 'wordpress-traffic-pending-window',
    // A persisted upper bound makes a capped WordPress cursor drain a finite,
    // repeatable [last_synced_at, wordpress_pending_until) window. Existing
    // non-null cursors deliberately receive NULL here: they were created by
    // the old unbounded route, so treating their already-advanced watermark
    // as a lower bound would silently skip undrained history.
    statements: [
      `ALTER TABLE traffic_sources ADD COLUMN wordpress_pending_until TEXT`,
    ],
  },
  {
    version: 146,
    name: 'oauth-authorization-server',
    // OAuth 2.1 for the remote MCP surface. Hosted clients (ChatGPT, Gemini
    // Enterprise) cannot present an API key, so this is the only way they can
    // authenticate at all.
    //
    // Codes and tokens are stored as SHA-256 digests, the same choice
    // `user_sessions` makes and for the same reason: both are high-entropy
    // bearer credentials, so a copied database must record that they existed
    // without being a way to use them.
    statements: [
      `CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret_hash TEXT,
        redirect_uris TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT,
        scope TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authorization_codes(expires_at)`,
      `CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource TEXT,
        scope TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at)`,
    ],
  },
  {
    version: 147,
    name: 'oauth-client-provenance',
    // A self-registered client picks its own display name, and that name is the
    // trust anchor on the consent screen. Recording HOW a client was created is
    // what lets that screen distinguish a claim from a fact. Existing rows
    // default to 'operator', which is correct: before this, the only way to
    // create one was by hand.
    statements: [
      `ALTER TABLE oauth_clients ADD COLUMN registration TEXT NOT NULL DEFAULT 'operator'`,
    ],
  },
  {
    version: 148,
    name: 'insight-notify-state',
    // Insight dispatch had no memory. Health is edge-triggered and citations are
    // transition-based, but every run recomputed its insights and sent whatever
    // was high or critical, so a finding that persists alerted on every run,
    // forever. Measured on one client: a GBP keyword drop notified daily for over
    // a month with byte-identical text, because Google publishes GBP keyword data
    // about a month behind and the comparison window sat still while the calendar
    // moved on. The insights table held ONE row for it, so nothing in the stored
    // data revealed the repetition.
    statements: [
      `CREATE TABLE IF NOT EXISTS insight_notify_state (
        key         TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        subject     TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        severity    TEXT NOT NULL,
        magnitude   INTEGER,
        notified_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS insight_notify_state_project
         ON insight_notify_state(project_id)`,
    ],
  },
  {
    version: 149,
    name: 'measurement-plan-version-continuity',
    // Every measurement read pins to the active plan version row id, but a
    // publish mints a new row for ANY compiled-checksum change — labels
    // included — so renaming a group blanked the dashboard until the next full
    // sweep. This column records, at publish time, the superseded version a
    // cosmetic (execution-identical) revision stays comparable with, so reads
    // can keep serving the previous run. Historic rows stay NULL on purpose:
    // their execution equality was never verified at publish time, and
    // backfilling one would claim a comparison nobody made.
    statements: [
      `ALTER TABLE measurement_plan_versions ADD COLUMN comparable_to_version_id TEXT`,
    ],
  },
  {
    version: 150,
    name: 'engine-route-research-and-served-provider-provenance',
    // Both columns are nullable/additive. Historic rows stay null rather than
    // pretending an older route choice or an upstream provider identity was
    // known. New text-route preference remains distinct from sweep providers.
    statements: [
      `ALTER TABLE projects ADD COLUMN research_provider TEXT`,
      `ALTER TABLE query_snapshots ADD COLUMN served_provider TEXT`,
    ],
  },
]

function addRunsMeasurementPlanVersionForeignKey(tx: MigrationDb): void {
  const tableSqlRow = tx.all(sql.raw("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'")) as Array<{ sql: string }>
  const tableSql = tableSqlRow[0]?.sql
  if (!tableSql) throw new Error('Cannot add measurement plan FK: runs table definition is missing')
  if (/FOREIGN KEY\s*\(\s*project_id\s*,\s*measurement_plan_version_id\s*\)/i.test(tableSql)) return

  const closingParen = tableSql.lastIndexOf(')')
  if (closingParen < 0) throw new Error('Cannot add measurement plan FK: unexpected runs table definition')
  const repairedSql = `${tableSql.slice(0, closingParen)}, FOREIGN KEY (project_id, measurement_plan_version_id) REFERENCES measurement_plan_versions(project_id, id)${tableSql.slice(closingParen)}`

  const columns = tx.all(sql.raw("PRAGMA table_info('runs')")) as Array<{ name: string }>
  const columnList = columns.map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ')
  const indexes = tx.all(sql.raw("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs' AND sql IS NOT NULL")) as Array<{ name: string; sql: string }>

  rebuildMeasurementTable(tx, 'runs', repairedSql, columnList, indexes)
  // Scoped to the table this function rebuilt. Unscoped, the pragma walks every
  // table in the database, so one pre-existing orphan anywhere aborts the
  // migration and the install can never boot again. Those orphans are not
  // hypothetical here: v98 exists to relink FK-orphaned query_snapshots, and
  // migrations run with foreign keys disabled, so older rows can predate any
  // constraint. This check is meant to catch damage the rebuild itself caused.
  const violations = tx.all(sql.raw("PRAGMA foreign_key_check('runs')"))
  if (violations.length > 0) throw new Error('Measurement-plan migration left foreign-key violations')
}

function rebuildMeasurementTable(
  tx: MigrationDb,
  table: string,
  createSql: string,
  suppliedColumnList?: string,
  suppliedIndexes?: Array<{ name: string; sql: string }>,
): void {
  const temporary = `${table}_v116_target_model`
  const columnList = suppliedColumnList ?? (tx.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{ name: string }>)
    .map(column => `"${column.name.replaceAll('"', '""')}"`).join(', ')
  const indexes = suppliedIndexes ?? tx.all(sql.raw(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND sql IS NOT NULL`)) as Array<{ name: string; sql: string }>
  const temporaryCreateSql = createSql.replace(
    new RegExp(`^CREATE TABLE ${table}\\b`, 'i'),
    `CREATE TABLE ${temporary}`,
  )
  if (temporaryCreateSql === createSql) throw new Error(`Cannot rebuild ${table}: unexpected table definition`)
  for (const index of indexes) tx.run(sql.raw(`DROP INDEX "${index.name.replaceAll('"', '""')}"`))
  tx.run(sql.raw(temporaryCreateSql))
  tx.run(sql.raw(`INSERT INTO ${temporary} (${columnList}) SELECT ${columnList} FROM ${table}`))
  tx.run(sql.raw(`DROP TABLE ${table}`))
  tx.run(sql.raw(`ALTER TABLE ${temporary} RENAME TO ${table}`))
  for (const index of indexes) tx.run(sql.raw(index.sql))
}

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

interface GaAiReferralClassRow {
  id: string
  source: string | null
  medium: string | null
  channel_group: string | null
  landing_page: string | null
  traffic_class: string | null
}

/**
 * Re-derive `ga_ai_referrals.traffic_class` for every row from the same columns
 * the ingest classifier reads (`source`, `medium`, `channel_group`,
 * `landing_page`).
 *
 * Calls the shared `classifyAiReferralTrafficClass` rather than restating the
 * heuristic in SQL, so the backfill can never drift from what ingest writes (a
 * SQL rewrite would also have to drop the landing-page UTM check, which needs
 * URL parsing).
 *
 * Only rows whose stored class actually differs are written, so a replay is a
 * no-op. Returns the number of rows updated.
 */
export function backfillGaAiReferralTrafficClass(tx: MigrationDb): number {
  if (!tableExists(tx, 'ga_ai_referrals')) return 0
  if (!columnExists(tx, 'ga_ai_referrals', 'traffic_class')) return 0

  const rows = tx.all(sql.raw(
    `SELECT id, source, medium, channel_group, landing_page, traffic_class FROM ga_ai_referrals`,
  )) as GaAiReferralClassRow[]

  let updated = 0
  for (const row of rows) {
    const next = classifyAiReferralTrafficClass({
      source: row.source,
      medium: row.medium,
      channelGroup: row.channel_group,
      landingPage: row.landing_page,
    })
    if (next === row.traffic_class) continue
    tx.run(sql`UPDATE ga_ai_referrals SET traffic_class = ${next} WHERE id = ${row.id}`)
    updated += 1
  }
  return updated
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
    if (mv.disableForeignKeys) db.run(sql.raw('PRAGMA foreign_keys = OFF'))
    try {
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
    } finally {
      if (mv.disableForeignKeys) db.run(sql.raw('PRAGMA foreign_keys = ON'))
    }
  }
}

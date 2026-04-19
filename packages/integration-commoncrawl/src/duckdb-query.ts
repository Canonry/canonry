import { forwardDomain, reverseDomain } from './reverse-domain.js'
import type { BacklinkRow } from './types.js'

export interface QueryOptions {
  vertexPath: string
  edgesPath: string
  targets: string[]
  limitPerTarget?: number
  duckdb: unknown
}

interface DuckDbModule {
  DuckDBInstance: {
    create(path: string): Promise<DuckDbInstance>
  }
}
interface DuckDbInstance {
  connect(): Promise<DuckDbConnection>
  closeSync?: () => void
}
interface DuckDbConnection {
  runAndReadAll(sql: string): Promise<DuckDbResultReader>
  closeSync?: () => void
  disconnectSync?: () => void
}
interface DuckDbResultReader {
  getRowObjects(): Record<string, unknown>[]
}

export async function queryBacklinks(opts: QueryOptions): Promise<BacklinkRow[]> {
  if (opts.targets.length === 0) return []

  const duckdb = opts.duckdb as DuckDbModule
  const reversed = opts.targets.map(reverseDomain)
  const targetList = reversed.map(quote).join(', ')

  const limitClause = opts.limitPerTarget
    ? `QUALIFY row_number() OVER (PARTITION BY t.target_rev_domain ORDER BY v.num_hosts DESC) <= ${Math.floor(opts.limitPerTarget)}`
    : ''

  const sql = `
    WITH vertices AS (
      SELECT * FROM read_csv(
        ${quote(opts.vertexPath)},
        delim='\t', header=false,
        columns={'id':'BIGINT','rev_domain':'VARCHAR','num_hosts':'BIGINT'}
      )
    ),
    targets AS (
      SELECT v.id AS target_id, v.rev_domain AS target_rev_domain
      FROM vertices v
      WHERE v.rev_domain IN (${targetList})
    ),
    inbound AS (
      SELECT e.from_id, e.to_id
      FROM read_csv(
        ${quote(opts.edgesPath)},
        delim='\t', header=false,
        columns={'from_id':'BIGINT','to_id':'BIGINT'}
      ) e
      WHERE e.to_id IN (SELECT target_id FROM targets)
    )
    SELECT
      t.target_rev_domain,
      v.rev_domain AS linking_rev_domain,
      v.num_hosts
    FROM inbound i
    JOIN targets t ON t.target_id = i.to_id
    JOIN vertices v ON v.id = i.from_id
    ${limitClause}
    ORDER BY t.target_rev_domain, v.num_hosts DESC
  `

  const instance = await duckdb.DuckDBInstance.create(':memory:')
  const conn = await instance.connect()

  let rows: Record<string, unknown>[]
  try {
    const reader = await conn.runAndReadAll(sql)
    rows = reader.getRowObjects()
  } finally {
    conn.disconnectSync?.()
    conn.closeSync?.()
    instance.closeSync?.()
  }

  return rows.map((r) => ({
    targetDomain: forwardDomain(String(r['target_rev_domain'])),
    linkingDomain: forwardDomain(String(r['linking_rev_domain'])),
    numHosts: Number(r['num_hosts']),
  }))
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

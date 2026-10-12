import fs from 'node:fs'
import { reportedQueryClasses, type QueryClass } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

/** Shown where the server reports no class. The CLI never fills one in. */
const NO_CLASS = '-'
const CLASS_COLUMN_WIDTH = 'non-brand'.length
const NO_CLASS_NOTE = `${NO_CLASS} = no class: the project has no usable brand name, or its measurement plan holds no single class for that query (canonry query workspace shows the class per Property).`
const CLASS_NOT_REPORTED_NOTE = `${NO_CLASS} = class not reported: this server version does not send a query class. Upgrade the server to see it.`

function classCell(queryClass: QueryClass | null | undefined): string {
  return (queryClass ?? NO_CLASS).padEnd(CLASS_COLUMN_WIDTH)
}

/**
 * What a dash stands for in the rows just printed. `null` is the server saying
 * no single class exists; a row with no `queryClass` at all comes from a server
 * older than the field, which says nothing about the class.
 */
function dashNotes(rows: ReadonlyArray<{ queryClass?: QueryClass | null }>): string[] {
  return [
    ...(rows.some(row => row.queryClass === null) ? [NO_CLASS_NOTE] : []),
    ...(rows.some(row => row.queryClass === undefined) ? [CLASS_NOT_REPORTED_NOTE] : []),
  ]
}

export async function addQueries(project: string, queries: string[], format?: string): Promise<void> {
  const client = getClient()
  // The API answers an append with the project's query list, already classed.
  const queryClasses = reportedQueryClasses(queries, await client.appendQueries(project, queries))

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      project,
      queries,
      addedCount: queries.length,
      queryClasses,
    }, null, 2))
    return
  }

  console.log(`Added ${queries.length} ${queries.length === 1 ? 'query' : 'queries'} to "${project}".`)
  for (const entry of queryClasses) {
    console.log(`  ${classCell(entry.queryClass)}  ${entry.query}`)
  }
  for (const note of dashNotes(queryClasses)) console.log(`  ${note}`)
}

export async function replaceQueries(
  project: string,
  queries: string[],
  opts?: { dryRun?: boolean; format?: string },
): Promise<void> {
  const client = getClient()
  const isJson = isMachineFormat(opts?.format)

  if (opts?.dryRun) {
    const preview = await client.previewReplaceQueries(project, queries)
    if (isJson) {
      console.log(JSON.stringify({ dryRun: true, ...preview }, null, 2))
      return
    }
    const { diff, snapshotImpact } = preview
    console.log(`Query replace preview for "${project}":`)
    console.log(`  Current: ${preview.current.length} ${preview.current.length === 1 ? 'query' : 'queries'}`)
    console.log(`  Proposed: ${preview.proposed.length} ${preview.proposed.length === 1 ? 'query' : 'queries'}`)
    console.log(`  Diff:`)
    console.log(`    + added:     ${diff.added.length}${diff.added.length ? `  (${diff.added.join(', ')})` : ''}`)
    console.log(`    - removed:   ${diff.removed.length}${diff.removed.length ? `  (${diff.removed.join(', ')})` : ''}`)
    console.log(`    = unchanged: ${diff.unchanged.length}${diff.unchanged.length ? `  (${diff.unchanged.join(', ')})` : ''}`)
    console.log(`  Snapshot impact:`)
    console.log(`    Replace wipes every queries row and re-inserts with new IDs, so ALL`)
    console.log(`    existing snapshots get detached (queryId → NULL; queryText preserved).`)
    console.log(`    Snapshots affected: ${snapshotImpact.snapshotsDetached} across ${snapshotImpact.affectedQueries} ${snapshotImpact.affectedQueries === 1 ? 'query' : 'queries'}`)
    console.log(``)
    console.log(`No DB writes performed. Re-run without --dry-run to apply.`)
    return
  }

  await client.putQueries(project, queries)

  if (isJson) {
    console.log(JSON.stringify({
      project,
      queries,
      replacedCount: queries.length,
    }, null, 2))
    return
  }

  console.log(`Set ${queries.length} ${queries.length === 1 ? 'query' : 'queries'} for "${project}".`)
}

export async function removeQueries(project: string, queries: string[], format?: string): Promise<void> {
  const client = getClient()
  const existing = await client.listQueries(project) as Array<{ query: string }>
  const existingSet = new Set(existing.map(q => q.query))
  const removedQueries = queries.filter(q => existingSet.has(q))
  await client.deleteQueries(project, queries)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      project,
      queries,
      removedQueries,
      removedCount: removedQueries.length,
    }, null, 2))
    return
  }

  console.log(`Removed ${removedQueries.length} ${removedQueries.length === 1 ? 'query' : 'queries'} from "${project}".`)
}

export async function listQueries(project: string, format?: string): Promise<void> {
  const client = getClient()
  const qs = await client.listQueries(project)

  if (format === 'json') {
    console.log(JSON.stringify(qs, null, 2))
    return
  } else if (format === 'jsonl') {
    // One self-contained query per line. Each line carries `project` so a line
    // lifted out of the array still says which project it belongs to.
    emitJsonl(qs.map(q => ({ project, ...q })))
    return
  }

  if (qs.length === 0) {
    console.log(`No queries found for "${project}".`)
    return
  }

  console.log(`Queries for "${project}" (${qs.length}):\n`)
  console.log(`  ${'CLASS'.padEnd(CLASS_COLUMN_WIDTH)}  QUERY`)
  for (const q of qs) {
    console.log(`  ${classCell(q.queryClass)}  ${q.query}`)
  }
  const notes = dashNotes(qs)
  if (notes.length > 0) console.log(`\n${notes.map(note => `  ${note}`).join('\n')}`)
}

export async function importQueries(project: string, filePath: string, format?: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new CliError({
      code: 'QUERY_IMPORT_FILE_NOT_FOUND',
      message: `File not found: ${filePath}`,
      displayMessage: `Error: file not found: ${filePath}`,
      details: {
        project,
        filePath,
      },
    })
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const queries = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))

  if (queries.length === 0) {
    if (isMachineFormat(format)) {
      console.log(JSON.stringify({
        project,
        filePath,
        queries: [],
        importedCount: 0,
      }, null, 2))
      return
    }

    console.log('No queries found in file.')
    return
  }

  const client = getClient()
  await client.appendQueries(project, queries)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      project,
      filePath,
      queries,
      importedCount: queries.length,
    }, null, 2))
    return
  }

  console.log(`Imported ${queries.length} ${queries.length === 1 ? 'query' : 'queries'} to "${project}".`)
}

export async function generateQueries(
  project: string,
  provider: string,
  opts: { count?: number; save?: boolean; format?: string },
): Promise<void> {
  const client = getClient()
  const result = await client.generateQueries(project, provider, opts.count)
  const saved = Boolean(opts.save && result.queries.length > 0)

  if (!isMachineFormat(opts.format)) {
    console.log(`Generated ${result.queries.length} ${result.queries.length === 1 ? 'query' : 'queries'} using ${result.provider}:\n`)
    for (const q of result.queries) {
      console.log(`  ${q}`)
    }

    if (result.queries.length > 0 && !saved) {
      console.log(`\nTo add these, run: canonry query add ${project} <query>...`)
    }
  }

  if (saved) {
    await client.appendQueries(project, result.queries)
    if (!isMachineFormat(opts.format)) {
      console.log(`\nSaved ${result.queries.length} ${result.queries.length === 1 ? 'query' : 'queries'} to "${project}".`)
    }
  }

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify({
      project,
      provider: result.provider,
      queries: result.queries,
      generatedCount: result.queries.length,
      saved,
      savedCount: saved ? result.queries.length : 0,
    }, null, 2))
  }
}

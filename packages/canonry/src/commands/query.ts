import fs from 'node:fs'
import { createApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

export async function addQueries(project: string, queries: string[], format?: string): Promise<void> {
  const client = getClient()
  await client.appendQueries(project, queries)

  if (format === 'json') {
    console.log(JSON.stringify({
      project,
      queries,
      addedCount: queries.length,
    }, null, 2))
    return
  }

  console.log(`Added ${queries.length} ${queries.length === 1 ? 'query' : 'queries'} to "${project}".`)
}

export async function replaceQueries(
  project: string,
  queries: string[],
  opts?: { dryRun?: boolean; format?: string },
): Promise<void> {
  const client = getClient()
  const isJson = opts?.format === 'json'

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

  if (format === 'json') {
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
  const qs = await client.listQueries(project) as Array<{
    id: string
    query: string
    createdAt: string
  }>

  if (format === 'json') {
    console.log(JSON.stringify(qs, null, 2))
    return
  }

  if (qs.length === 0) {
    console.log(`No queries found for "${project}".`)
    return
  }

  console.log(`Queries for "${project}" (${qs.length}):\n`)
  for (const q of qs) {
    console.log(`  ${q.query}`)
  }
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
    if (format === 'json') {
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

  if (format === 'json') {
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

  if (opts.format !== 'json') {
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
    if (opts.format !== 'json') {
      console.log(`\nSaved ${result.queries.length} ${result.queries.length === 1 ? 'query' : 'queries'} to "${project}".`)
    }
  }

  if (opts.format === 'json') {
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

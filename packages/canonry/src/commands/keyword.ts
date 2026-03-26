import fs from 'node:fs'
import { createApiClient } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

export async function addKeywords(project: string, keywords: string[], format?: string): Promise<void> {
  const client = getClient()
  await client.appendKeywords(project, keywords)

  if (format === 'json') {
    console.log(JSON.stringify({
      project,
      keywords,
      addedCount: keywords.length,
    }, null, 2))
    return
  }

  console.log(`Added ${keywords.length} key phrase(s) to "${project}".`)
}

export async function removeKeywords(project: string, keywords: string[], format?: string): Promise<void> {
  const client = getClient()
  const existing = await client.listKeywords(project) as Array<{ keyword: string }>
  const existingSet = new Set(existing.map(k => k.keyword))
  const removedKeywords = keywords.filter(k => existingSet.has(k))
  await client.deleteKeywords(project, keywords)

  if (format === 'json') {
    console.log(JSON.stringify({
      project,
      keywords,
      removedKeywords,
      removedCount: removedKeywords.length,
    }, null, 2))
    return
  }

  console.log(`Removed ${removedKeywords.length} key phrase(s) from "${project}".`)
}

export async function listKeywords(project: string, format?: string): Promise<void> {
  const client = getClient()
  const kws = await client.listKeywords(project) as Array<{
    id: string
    keyword: string
    createdAt: string
  }>

  if (format === 'json') {
    console.log(JSON.stringify(kws, null, 2))
    return
  }

  if (kws.length === 0) {
    console.log(`No key phrases found for "${project}".`)
    return
  }

  console.log(`Key phrases for "${project}" (${kws.length}):\n`)
  for (const kw of kws) {
    console.log(`  ${kw.keyword}`)
  }
}

export async function importKeywords(project: string, filePath: string, format?: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new CliError({
      code: 'KEYWORD_IMPORT_FILE_NOT_FOUND',
      message: `File not found: ${filePath}`,
      details: {
        project,
        filePath,
      },
    })
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const keywords = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))

  if (keywords.length === 0) {
    if (format === 'json') {
      console.log(JSON.stringify({
        project,
        filePath,
        keywords: [],
        importedCount: 0,
      }, null, 2))
      return
    }

    console.log('No key phrases found in file.')
    return
  }

  const client = getClient()
  await client.appendKeywords(project, keywords)

  if (format === 'json') {
    console.log(JSON.stringify({
      project,
      filePath,
      keywords,
      importedCount: keywords.length,
    }, null, 2))
    return
  }

  console.log(`Imported ${keywords.length} key phrase(s) to "${project}".`)
}

export async function generateKeywords(
  project: string,
  provider: string,
  opts: { count?: number; save?: boolean; format?: string },
): Promise<void> {
  const client = getClient()
  const result = await client.generateKeywords(project, provider, opts.count)
  const saved = Boolean(opts.save && result.keywords.length > 0)

  if (opts.format !== 'json') {
    console.log(`Generated ${result.keywords.length} key phrase(s) using ${result.provider}:\n`)
    for (const kw of result.keywords) {
      console.log(`  ${kw}`)
    }

    if (result.keywords.length > 0 && !saved) {
      console.log(`\nTo add these, run: canonry keyword add ${project} <phrase>...`)
    }
  }

  if (saved) {
    await client.appendKeywords(project, result.keywords)
    if (opts.format !== 'json') {
      console.log(`\nSaved ${result.keywords.length} key phrase(s) to "${project}".`)
    }
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      project,
      provider: result.provider,
      keywords: result.keywords,
      generatedCount: result.keywords.length,
      saved,
      savedCount: saved ? result.keywords.length : 0,
    }, null, 2))
  }
}

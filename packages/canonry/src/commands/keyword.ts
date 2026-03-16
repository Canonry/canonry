import fs from 'node:fs'
import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function addKeywords(project: string, keywords: string[]): Promise<void> {
  const client = getClient()
  await client.appendKeywords(project, keywords)
  console.log(`Added ${keywords.length} key phrase(s) to "${project}".`)
}

export async function removeKeywords(project: string, keywords: string[]): Promise<void> {
  const client = getClient()
  const existing = await client.listKeywords(project) as Array<{ keyword: string }>
  const existingSet = new Set(existing.map(k => k.keyword))
  const actuallyDeleted = keywords.filter(k => existingSet.has(k)).length
  await client.deleteKeywords(project, keywords)
  console.log(`Removed ${actuallyDeleted} key phrase(s) from "${project}".`)
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

export async function importKeywords(project: string, filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const keywords = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))

  if (keywords.length === 0) {
    console.log('No key phrases found in file.')
    return
  }

  const client = getClient()
  await client.appendKeywords(project, keywords)
  console.log(`Imported ${keywords.length} key phrase(s) to "${project}".`)
}

export async function generateKeywords(project: string, provider: string, opts: { count?: number; save?: boolean }): Promise<void> {
  const client = getClient()
  const result = await client.generateKeywords(project, provider, opts.count)

  console.log(`Generated ${result.keywords.length} key phrase(s) using ${result.provider}:\n`)
  for (const kw of result.keywords) {
    console.log(`  ${kw}`)
  }

  if (opts.save && result.keywords.length > 0) {
    await client.appendKeywords(project, result.keywords)
    console.log(`\nSaved ${result.keywords.length} key phrase(s) to "${project}".`)
  } else if (result.keywords.length > 0) {
    console.log(`\nTo add these, run: canonry keyword add ${project} <phrase>...`)
  }
}

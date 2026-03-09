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
  console.log(`Added ${keywords.length} keyword(s) to "${project}".`)
}

export async function listKeywords(project: string): Promise<void> {
  const client = getClient()
  const kws = await client.listKeywords(project) as Array<{
    id: string
    keyword: string
    createdAt: string
  }>

  if (kws.length === 0) {
    console.log(`No keywords found for "${project}".`)
    return
  }

  console.log(`Keywords for "${project}" (${kws.length}):\n`)
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
    console.log('No keywords found in file.')
    return
  }

  const client = getClient()
  await client.appendKeywords(project, keywords)
  console.log(`Imported ${keywords.length} keyword(s) to "${project}".`)
}

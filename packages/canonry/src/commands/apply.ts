import fs from 'node:fs'
import { parseAllDocuments } from 'yaml'
import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

type ApplyResult = {
  id: string
  name: string
  displayName: string
  configRevision: number
}

export async function applyConfig(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const docs = parseAllDocuments(content)

  const clientConfig = loadConfig()
  const client = new ApiClient(clientConfig.apiUrl, clientConfig.apiKey)

  const errors: string[] = []

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!
    if (doc.errors.length > 0) {
      errors.push(`Document ${i + 1}: YAML parse error — ${doc.errors[0]?.message}`)
      continue
    }

    const config = doc.toJSON() as object
    if (!config || typeof config !== 'object') continue

    try {
      const result = await client.apply(config) as ApplyResult
      console.log(`Applied config for "${result.name}" (revision ${result.configRevision})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`Document ${i + 1}: ${msg}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`${errors.length} document(s) failed in ${filePath}:\n${errors.map(e => `  - ${e}`).join('\n')}`)
  }
}

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

  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new Error(`YAML parse error in ${filePath}: ${doc.errors[0]?.message}`)
    }

    const config = doc.toJSON() as object
    if (!config || typeof config !== 'object') continue

    const result = await client.apply(config) as ApplyResult
    console.log(`Applied config for "${result.name}" (revision ${result.configRevision})`)
  }
}

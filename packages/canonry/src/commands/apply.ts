import fs from 'node:fs'
import { parse } from 'yaml'
import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

export async function applyConfig(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const config = parse(content) as object

  const clientConfig = loadConfig()
  const client = new ApiClient(clientConfig.apiUrl, clientConfig.apiKey)

  const result = await client.apply(config) as {
    id: string
    name: string
    displayName: string
    configRevision: number
  }

  console.log(`Applied config for "${result.name}" (revision ${result.configRevision})`)
}

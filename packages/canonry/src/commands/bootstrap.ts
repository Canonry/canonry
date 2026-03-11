import crypto from 'node:crypto'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { getBootstrapEnv } from '@ainyc/canonry-config'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'

import { configExists, getConfigDir, getConfigPath, saveConfig } from '../config.js'

export async function bootstrapCommand(opts?: { force?: boolean }): Promise<void> {
  if (configExists() && !opts?.force) {
    console.log(`Config already exists at ${getConfigPath()}`)
    console.log('Skipping bootstrap.')
    return
  }

  const env = getBootstrapEnv(process.env)
  const providers = env.providers
  const hasProvider = providers?.gemini || providers?.openai || providers?.claude || providers?.local

  if (!hasProvider) {
    throw new Error(
      'Bootstrap requires at least one provider env var. Set GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or LOCAL_BASE_URL.',
    )
  }

  const configDir = getConfigDir()
  const databasePath = env.databasePath || path.join(configDir, 'data.db')
  const generatedApiKey = !env.apiKey ? `cnry_${crypto.randomBytes(16).toString('hex')}` : undefined
  const rawApiKey = env.apiKey || generatedApiKey!
  const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex')
  const keyPrefix = rawApiKey.slice(0, 9)

  const db = createClient(databasePath)
  migrate(db)
  db.delete(apiKeys).where(eq(apiKeys.name, 'default')).run()
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'default',
    keyHash,
    keyPrefix,
    scopes: '["*"]',
    createdAt: new Date().toISOString(),
  }).run()

  saveConfig({
    apiUrl: env.apiUrl || `http://localhost:${process.env.CANONRY_PORT || '4100'}`,
    database: databasePath,
    apiKey: rawApiKey,
    providers,
  })

  console.log(`Bootstrap complete. Config saved to ${getConfigPath()}`)
  console.log(`SQLite database path: ${databasePath}`)
  if (generatedApiKey) {
    console.log(`API key: ${generatedApiKey}`)
  }
}

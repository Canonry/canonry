import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'
import { getConfigDir, getConfigPath, configExists, saveConfig } from '../config.js'
import type { CanonryConfig, ProviderConfigEntry } from '../config.js'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiKeys } from '@ainyc/canonry-db'
import path from 'node:path'

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

const DEFAULT_QUOTA = {
  maxConcurrency: 2,
  maxRequestsPerMinute: 10,
  maxRequestsPerDay: 500,
}

export async function initCommand(opts?: { force?: boolean }): Promise<void> {
  console.log('Initializing canonry...\n')

  if (configExists() && !opts?.force) {
    console.log(`Config already exists at ${getConfigPath()}`)
    console.log('To reinitialize, run "canonry init --force".')
    return
  }

  // Create config directory
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  // Prompt for provider API keys
  const providers: CanonryConfig['providers'] = {}

  console.log('Configure AI providers (at least one required):\n')

  // Gemini
  const geminiApiKey = await prompt('Gemini API key (press Enter to skip): ')
  if (geminiApiKey) {
    const geminiModel = await prompt('  Gemini model [gemini-2.5-flash]: ') || 'gemini-2.5-flash'
    providers.gemini = { apiKey: geminiApiKey, model: geminiModel, quota: DEFAULT_QUOTA }
  }

  // OpenAI
  const openaiApiKey = await prompt('OpenAI API key (press Enter to skip): ')
  if (openaiApiKey) {
    const openaiModel = await prompt('  OpenAI model [gpt-4o]: ') || 'gpt-4o'
    providers.openai = { apiKey: openaiApiKey, model: openaiModel, quota: DEFAULT_QUOTA }
  }

  // Claude
  const claudeApiKey = await prompt('Anthropic API key (press Enter to skip): ')
  if (claudeApiKey) {
    const claudeModel = await prompt('  Claude model [claude-sonnet-4-6]: ') || 'claude-sonnet-4-6'
    providers.claude = { apiKey: claudeApiKey, model: claudeModel, quota: DEFAULT_QUOTA }
  }

  // Local LLM
  console.log('\nLocal LLM (Ollama, LM Studio, llama.cpp, vLLM — any OpenAI-compatible API):')
  const localBaseUrl = await prompt('Local LLM base URL (press Enter to skip, e.g. http://localhost:11434/v1): ')
  if (localBaseUrl) {
    const localModel = await prompt('  Model name [llama3]: ') || 'llama3'
    const localApiKey = await prompt('  API key (press Enter if not needed): ') || undefined
    providers.local = { baseUrl: localBaseUrl, apiKey: localApiKey, model: localModel, quota: DEFAULT_QUOTA }
  }

  // Validate at least one provider
  const hasProvider = providers.gemini || providers.openai || providers.claude || providers.local
  if (!hasProvider) {
    console.error('\nAt least one provider is required.')
    process.exit(1)
  }

  // Generate random API key for the local server
  const rawApiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex')
  const keyPrefix = rawApiKey.slice(0, 9)

  // Database path
  const databasePath = path.join(configDir, 'data.db')

  // Create and migrate database
  const db = createClient(databasePath)
  migrate(db)

  // Insert the API key
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'default',
    keyHash,
    keyPrefix,
    scopes: '["*"]',
    createdAt: new Date().toISOString(),
  }).run()

  // Save config
  saveConfig({
    apiUrl: 'http://localhost:4100',
    database: databasePath,
    apiKey: rawApiKey,
    providers,
  })

  const providerNames = Object.keys(providers).join(', ')
  console.log(`\nConfig saved to ${getConfigPath()}`)
  console.log(`Database created at ${databasePath}`)
  console.log(`API key: ${rawApiKey}`)
  console.log(`Providers: ${providerNames}`)
  console.log('\nRun "canonry serve" to start the server.')
}

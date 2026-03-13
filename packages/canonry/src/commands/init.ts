import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { getBootstrapEnv } from '@ainyc/canonry-config'
import { getConfigDir, getConfigPath, configExists, saveConfig } from '../config.js'
import type { CanonryConfig, ProviderConfigEntry } from '../config.js'
import { trackEvent, showFirstRunNotice } from '../telemetry.js'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiKeys } from '@ainyc/canonry-db'

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

export interface InitOptions {
  force?: boolean
  geminiKey?: string
  openaiKey?: string
  claudeKey?: string
  localUrl?: string
  localModel?: string
  localKey?: string
}

export async function initCommand(opts?: InitOptions): Promise<void> {
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

  // Check for non-interactive mode: CLI flags take priority, env vars are fallback
  const envProviders = getBootstrapEnv(process.env, {
    GEMINI_API_KEY: opts?.geminiKey,
    OPENAI_API_KEY: opts?.openaiKey,
    ANTHROPIC_API_KEY: opts?.claudeKey,
    LOCAL_BASE_URL: opts?.localUrl,
    LOCAL_MODEL: opts?.localModel,
    LOCAL_API_KEY: opts?.localKey,
  }).providers
  const nonInteractive = !!(envProviders.gemini || envProviders.openai || envProviders.claude || envProviders.local)

  const providers: CanonryConfig['providers'] = {}

  if (nonInteractive) {
    // Non-interactive mode — providers fully resolved by getBootstrapEnv
    Object.assign(providers, envProviders)
  } else {
    // Interactive mode — prompt for each provider
    console.log('Configure AI providers (at least one required):\n')
    console.log('Tip: For non-interactive setup, pass --gemini-key, --openai-key,')
    console.log('--claude-key flags or set GEMINI_API_KEY, OPENAI_API_KEY,')
    console.log('ANTHROPIC_API_KEY env vars. Or use "canonry bootstrap".\n')

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

  const providerNames = Object.keys(providers)
  console.log(`\nConfig saved to ${getConfigPath()}`)
  console.log(`Database created at ${databasePath}`)
  console.log(`API key: ${rawApiKey}`)
  console.log(`Providers: ${providerNames.join(', ')}`)

  // Show the first-run telemetry notice during init — this is the natural
  // first command most users run, so the notice must appear here before
  // we generate the anonymousId and fire any telemetry events.
  showFirstRunNotice()

  console.log('Run "canonry serve" to start the server.')

  trackEvent('cli.init', {
    providerCount: providerNames.length,
    providers: providerNames,
  })
}

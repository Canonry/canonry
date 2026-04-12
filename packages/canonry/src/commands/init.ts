import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { getBootstrapEnv } from '@ainyc/canonry-config'
import { getConfigDir, getConfigPath, configExists, saveConfig } from '../config.js'
import type { CanonryConfig } from '../config.js'
import { trackEvent, showFirstRunNotice } from '../telemetry.js'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiKeys } from '@ainyc/canonry-db'
import { CliError, type CliFormat } from '../cli-error.js'

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
  perplexityKey?: string
  localUrl?: string
  localModel?: string
  localKey?: string
  googleClientId?: string
  googleClientSecret?: string
  agentProvider?: string
  agentKey?: string
  agentModel?: string
  format?: CliFormat
}

/** Agent LLM config resolved during init — returned so agentSetup can consume it. */
export interface ResolvedAgentLLM {
  provider: string
  key?: string
  model?: string
}

const DEFAULT_AGENT_MODELS: Record<string, string> = {
  anthropic: 'anthropic/claude-sonnet-4-6',
  openai: 'openai/gpt-4o',
  openrouter: 'openrouter/anthropic/claude-sonnet-4-6',
  groq: 'groq/llama-4-scout-17b',
  google: 'google/gemini-2.5-flash',
  mistral: 'mistral/mistral-large-latest',
  xai: 'xai/grok-2',
}

export async function initCommand(opts?: InitOptions): Promise<ResolvedAgentLLM | undefined> {
  const format = opts?.format ?? 'text'

  if (format !== 'json') {
    console.log('Initializing canonry...\n')
  }

  if (configExists() && !opts?.force) {
    if (format === 'json') {
      console.log(JSON.stringify({
        initialized: false,
        reason: 'config_exists',
        configPath: getConfigPath(),
      }, null, 2))
      return undefined
    }

    console.log(`Config already exists at ${getConfigPath()}`)
    console.log('To reinitialize, run "canonry init --force".')
    return undefined
  }

  // Create config directory
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  // Check for non-interactive mode: CLI flags take priority, env vars are fallback
  const bootstrapEnv = getBootstrapEnv(process.env, {
    GEMINI_API_KEY: opts?.geminiKey,
    OPENAI_API_KEY: opts?.openaiKey,
    ANTHROPIC_API_KEY: opts?.claudeKey,
    PERPLEXITY_API_KEY: opts?.perplexityKey,
    LOCAL_BASE_URL: opts?.localUrl,
    LOCAL_MODEL: opts?.localModel,
    LOCAL_API_KEY: opts?.localKey,
    GOOGLE_CLIENT_ID: opts?.googleClientId,
    GOOGLE_CLIENT_SECRET: opts?.googleClientSecret,
  })
  if ((bootstrapEnv.googleClientId && !bootstrapEnv.googleClientSecret) || (!bootstrapEnv.googleClientId && bootstrapEnv.googleClientSecret)) {
    throw new CliError({
      code: 'GOOGLE_OAUTH_CREDENTIALS_INCOMPLETE',
      message: 'Google OAuth requires both a client ID and client secret when configured non-interactively.',
      displayMessage: 'Google OAuth requires both a client ID and client secret when configured non-interactively.',
      details: {
        required: ['google-client-id', 'google-client-secret'],
      },
    })
  }
  const envProviders = bootstrapEnv.providers
  const envGoogleConfigured = !!(bootstrapEnv.googleClientId && bootstrapEnv.googleClientSecret)
  const nonInteractive = !!(
    envProviders.gemini ||
    envProviders.openai ||
    envProviders.claude ||
    envProviders.perplexity ||
    envProviders.local ||
    envGoogleConfigured
  )

  const providers: CanonryConfig['providers'] = {}
  let google: CanonryConfig['google'] | undefined

  if (format === 'json' && !nonInteractive) {
    throw new CliError({
      code: 'INIT_JSON_REQUIRES_NON_INTERACTIVE',
      message: '--format json requires non-interactive provider configuration via flags or environment variables.',
      displayMessage: '--format json requires non-interactive provider configuration via flags or environment variables.',
      details: {
        required: ['provider flags or environment variables'],
      },
    })
  }

  if (nonInteractive) {
    // Non-interactive mode — providers fully resolved by getBootstrapEnv
    Object.assign(providers, envProviders)
    if (envGoogleConfigured) {
      google = {
        clientId: bootstrapEnv.googleClientId,
        clientSecret: bootstrapEnv.googleClientSecret,
        connections: [],
      }
    }
  } else {
    // Interactive mode — prompt for each provider
    console.log('Configure AI providers (at least one required):\n')
    console.log('Tip: For non-interactive setup, pass provider flags or set')
    console.log('GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY,')
    console.log('GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET env vars.')
    console.log('Or use "canonry bootstrap".\n')

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

    // Perplexity
    const perplexityApiKey = await prompt('Perplexity API key (press Enter to skip): ')
    if (perplexityApiKey) {
      const perplexityModel = await prompt('  Perplexity model [sonar]: ') || 'sonar'
      providers.perplexity = { apiKey: perplexityApiKey, model: perplexityModel, quota: DEFAULT_QUOTA }
    }

    // Local LLM
    console.log('\nLocal LLM (Ollama, LM Studio, llama.cpp, vLLM — any OpenAI-compatible API):')
    const localBaseUrl = await prompt('Local LLM base URL (press Enter to skip, e.g. http://localhost:11434/v1): ')
    if (localBaseUrl) {
      const localModel = await prompt('  Model name [llama3]: ') || 'llama3'
      const localApiKey = await prompt('  API key (press Enter if not needed): ') || undefined
      providers.local = { baseUrl: localBaseUrl, apiKey: localApiKey, model: localModel, quota: DEFAULT_QUOTA }
    }

    console.log('\nGoogle Search Console OAuth (optional):')
    const googleClientId = await prompt('Google OAuth client ID (press Enter to skip): ')
    if (googleClientId) {
      const googleClientSecret = await prompt('  Google OAuth client secret: ')
      if (!googleClientSecret) {
        throw new CliError({
          code: 'GOOGLE_OAUTH_CREDENTIALS_INCOMPLETE',
          message: 'Google OAuth client secret is required when a client ID is provided.',
          displayMessage: '\nGoogle OAuth client secret is required when a client ID is provided.',
          details: {
            required: ['google-client-secret'],
          },
        })
      }
      google = {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        connections: [],
      }
    }
  }

  // Validate at least one provider
  const hasProvider = providers.gemini || providers.openai || providers.claude || providers.perplexity || providers.local
  if (!hasProvider) {
    throw new CliError({
      code: 'INIT_PROVIDER_REQUIRED',
      message: 'At least one provider is required.',
      displayMessage: '\nAt least one provider is required.',
      details: {
        required: ['provider'],
      },
    })
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
    apiUrl: `http://localhost:${process.env.CANONRY_PORT || '4100'}`,
    database: databasePath,
    apiKey: rawApiKey,
    providers,
    google,
  })

  const providerNames = Object.keys(providers)
  if (format === 'json') {
    console.log(JSON.stringify({
      initialized: true,
      configPath: getConfigPath(),
      databasePath,
      apiUrl: `http://localhost:${process.env.CANONRY_PORT || '4100'}`,
      apiKey: rawApiKey,
      providers: providerNames,
      googleConfigured: !!google,
    }, null, 2))
  } else {
    console.log(`\nConfig saved to ${getConfigPath()}`)
    console.log(`Database created at ${databasePath}`)
    console.log(`API key: ${rawApiKey}`)
    console.log(`Providers: ${providerNames.join(', ')}`)
  }

  // Resolve agent LLM config — from flags, or interactive prompt
  let agentLLM: ResolvedAgentLLM | undefined
  const agentProvider = opts?.agentProvider
  const agentKey = opts?.agentKey
  const agentModel = opts?.agentModel

  if (agentProvider || agentKey || agentModel) {
    // Non-interactive: use provided values
    const provider = agentProvider ?? 'anthropic'
    agentLLM = {
      provider,
      key: agentKey,
      model: agentModel ?? DEFAULT_AGENT_MODELS[provider],
    }
  } else if (!nonInteractive) {
    // Interactive: prompt for agent LLM
    console.log('\nConfigure agent LLM (the model that powers the agent):')
    console.log('Supported providers: anthropic, openai, openrouter, groq, mistral, xai, google, cerebras\n')

    const provider = await prompt('Provider [anthropic]: ') || 'anthropic'
    const key = await prompt('API key (press Enter to skip): ')
    if (key) {
      const defaultModel = DEFAULT_AGENT_MODELS[provider]
      const modelText = defaultModel ? `Model [${defaultModel}]: ` : 'Model: '
      const model = await prompt(modelText) || defaultModel
      agentLLM = { provider, key, model }
    }
  }

  // Show the first-run telemetry notice during init — this is the natural
  // first command most users run, so the notice must appear here before
  // we generate the anonymousId and fire any telemetry events.
  if (format !== 'json') {
    showFirstRunNotice()
    console.log('Run "canonry serve" to start the server.')
  }

  trackEvent('cli.init', {
    providerCount: providerNames.length,
    providers: providerNames,
  })

  return agentLLM
}

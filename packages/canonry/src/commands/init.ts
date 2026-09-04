import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { getBootstrapEnv } from '@ainyc/canonry-config'
import { getConfigDir, getConfigPath, configExists, saveConfig } from '../config.js'
import type { CanonryConfig } from '../config.js'
import { trackEvent, showFirstRunNotice, isTelemetryEnabled } from '../telemetry.js'
import { buildSetupState } from '../setup-state.js'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiKeys } from '@ainyc/canonry-db'
import { CliError, type CliFormat, isMachineFormat } from '../cli-error.js'
import { installSkills, type SkillsInstallSummary } from './skills.js'
import { installMcp, type McpInstallResult } from './mcp.js'
import { describeError } from '@ainyc/canonry-contracts'

/**
 * Hand control to `canonry serve` after init finishes.
 *
 * A flag rather than a direct call, because init's own lifecycle telemetry is
 * emitted by the dispatcher when the command RETURNS. Serve never returns, so
 * launching it from inside init would record every init that chose the
 * dashboard as a half-hour command. The dispatcher consumes this after the
 * init event is on the wire.
 */
let pendingServeHandoff = false

export function consumePendingServeHandoff(): boolean {
  const pending = pendingServeHandoff
  pendingServeHandoff = false
  return pending
}

/**
 * Ask for a provider key, offering one the machine ALREADY HAS first.
 *
 * The single biggest activation wall is leaving the terminal to go mint an
 * API key. `bootstrap` has read these env vars for CI since forever; a
 * developer running interactive init very often has one exported too, and
 * making them re-paste a secret they already exported is friction with no
 * upside. The VALUE is never echoed; the prompt names only the variable.
 */
export async function promptProviderApiKey(
  label: string,
  envVar: string,
  promptFn: (question: string) => Promise<string> = prompt,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const fromEnv = env[envVar]?.trim()
  if (fromEnv) {
    const answer = await promptFn(`Found ${envVar} in your environment. Use it? [Y/n]: `)
    if (!/^n/i.test(answer.trim())) return fromEnv
  }
  return promptFn(`${label} API key (press Enter to skip): `)
}

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

const PROJECT_MARKERS = ['.git', 'canonry.yaml', 'canonry.yml', 'package.json'] as const

function cwdLooksLikeProject(dir: string): boolean {
  const home = process.env.HOME ?? ''
  if (home && path.resolve(dir) === path.resolve(home)) return false
  return PROJECT_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)))
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
  skipSkills?: boolean
  skillsDir?: string
  skipMcp?: boolean
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
  const primaryNextStep = 'canonry serve'

  if (!isMachineFormat(format)) {
    console.log('Initializing canonry...\n')
  }

  if (configExists() && !opts?.force) {
    if (isMachineFormat(format)) {
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

  if (isMachineFormat(format) && !nonInteractive) {
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
    const geminiApiKey = await promptProviderApiKey('Gemini', 'GEMINI_API_KEY')
    if (geminiApiKey) {
      const geminiModel = await prompt('  Gemini model [gemini-2.5-flash]: ') || 'gemini-2.5-flash'
      providers.gemini = { apiKey: geminiApiKey, model: geminiModel, quota: DEFAULT_QUOTA }
    }

    // OpenAI
    const openaiApiKey = await promptProviderApiKey('OpenAI', 'OPENAI_API_KEY')
    if (openaiApiKey) {
      const openaiModel = await prompt('  OpenAI model [gpt-4o]: ') || 'gpt-4o'
      providers.openai = { apiKey: openaiApiKey, model: openaiModel, quota: DEFAULT_QUOTA }
    }

    // Claude
    const claudeApiKey = await promptProviderApiKey('Anthropic', 'ANTHROPIC_API_KEY')
    if (claudeApiKey) {
      const claudeModel = await prompt('  Claude model [claude-sonnet-4-6]: ') || 'claude-sonnet-4-6'
      providers.claude = { apiKey: claudeApiKey, model: claudeModel, quota: DEFAULT_QUOTA }
    }

    // Perplexity
    const perplexityApiKey = await promptProviderApiKey('Perplexity', 'PERPLEXITY_API_KEY')
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
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  // Save config
  saveConfig({
    apiUrl: `http://127.0.0.1:${process.env.CANONRY_PORT || '4100'}`,
    database: databasePath,
    apiKey: rawApiKey,
    providers,
    google,
  })

  const providerNames = Object.keys(providers)

  // Skills install — auto-install when cwd looks like a project; otherwise print a tip.
  let skillsSummary: SkillsInstallSummary | undefined
  let skillsTip: string | undefined
  if (!opts?.skipSkills) {
    const skillsTarget = opts?.skillsDir ?? process.cwd()
    if (cwdLooksLikeProject(skillsTarget)) {
      try {
        skillsSummary = await installSkills({ dir: skillsTarget })
      } catch (err) {
        skillsTip = `Skills auto-install failed: ${describeError(err)}. Run "canonry skills install" manually.`
      }
    } else {
      skillsTip = 'Run "canonry skills install" in a project directory to add the canonry + Aero playbook to .claude/skills/ and .codex/skills/.'
    }
  }

  // MCP auto-discovery — when the cwd is project-like, drop a `.mcp.json`
  // alongside the skills install so a Claude Code session opening in this
  // directory picks up the canonry MCP server automatically. Project scope
  // (not global ~/.claude.json) so other projects aren't affected. The same
  // installMcp pipeline `canonry mcp install --client claude-code` uses, so
  // the auto-install and the explicit install converge on identical output.
  let mcpSummary: McpInstallResult | undefined
  let mcpTip: string | undefined
  if (!opts?.skipMcp) {
    const mcpTarget = opts?.skillsDir ?? process.cwd()
    if (cwdLooksLikeProject(mcpTarget)) {
      try {
        const previousCwd = process.cwd()
        try {
          if (opts?.skillsDir) process.chdir(opts.skillsDir)
          mcpSummary = await installMcp({ client: 'claude-code', silent: true })
        } finally {
          process.chdir(previousCwd)
        }
      } catch (err) {
        mcpTip = `MCP auto-install failed: ${describeError(err)}. Run "canonry mcp install --client claude-code" manually.`
      }
    } else {
      mcpTip = 'Run "canonry mcp install --client claude-code" in a project directory to register the canonry MCP server in `.mcp.json` for Claude Code sessions.'
    }
  }

  const nextSteps = buildNextSteps()

  if (isMachineFormat(format)) {
    console.log(JSON.stringify({
      initialized: true,
      configPath: getConfigPath(),
      databasePath,
      apiUrl: `http://127.0.0.1:${process.env.CANONRY_PORT || '4100'}`,
      apiKey: rawApiKey,
      providers: providerNames,
      googleConfigured: !!google,
      skills: skillsSummary,
      skillsTip,
      mcp: mcpSummary,
      mcpTip,
      primaryNextStep,
      nextSteps,
    }, null, 2))
  } else {
    console.log(`\nConfig saved to ${getConfigPath()}`)
    console.log(`Database created at ${databasePath}`)
    console.log(`API key: ${rawApiKey}`)
    console.log(`Providers: ${providerNames.join(', ')}`)
    if (skillsSummary) {
      console.log(`\n${skillsSummary.message}`)
      console.log(`Skills target: ${skillsSummary.targetDir}`)
    }
    if (skillsTip) console.log(`\n${skillsTip}`)
    if (mcpSummary) {
      console.log(`\nMCP server "${mcpSummary.serverName}" ${mcpSummary.status} for Claude Code at ${mcpSummary.configPath}.`)
      console.log('Claude Code sessions opened in this directory will pick it up automatically.')
    }
    if (mcpTip) console.log(`\n${mcpTip}`)
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

  // Show the first-run telemetry notice when an operator chooses interactive
  // init for provider/OAuth provisioning. It must appear before we generate
  // the anonymousId and fire any telemetry events.
  if (!isMachineFormat(format)) {
    showFirstRunNotice()
    console.log('\nNext: canonry serve to map your site and capture a Page Health baseline.')
    console.log('\nNext steps:')
    for (const line of nextSteps) {
      console.log(`  ${line}`)
    }
  }

  if (isTelemetryEnabled()) {
    const postInitSetupState = buildSetupState()
    trackEvent('cli.init', {
      providerCount: providerNames.length,
      providers: providerNames,
      ...(postInitSetupState
        ? {
            setup_state: {
              ...postInitSetupState,
              // This snapshot represents a successfully completed init. The
              // anonymous ID is persisted inside trackEvent immediately after
              // properties are composed, so override the pre-send read here.
              is_first_run: false,
            },
          }
        : {}),
      googleConfigured: !!google,
      agentConfigured: !!agentLLM,
      // Deprecated compact field retained while existing telemetry reports
      // migrate to the structured setup_state object.
      setupState: encodeLegacySetupState({
        hasProvider: !!hasProvider,
        hasGoogle: !!google,
        hasAgent: !!agentLLM,
      }),
      skillsInstalled: !!skillsSummary,
    })
  }

  // End inside the product, not at a printout. Half of new installs run init
  // and never another command; every printed "Next:" line is a place to lose
  // more of them, and the resumable Page Health setup is strictly better than
  // terminal instructions that describe it.
  // Interactive human sessions only: machine formats and piped stdio keep the
  // printed next steps as the contract.
  if (!isMachineFormat(format) && process.stdin.isTTY && process.stdout.isTTY) {
    const answer = await prompt('\nStart the dashboard now? [Y/n]: ')
    if (!/^n/i.test(answer.trim())) {
      pendingServeHandoff = true
      console.log('Handing off to the dashboard. Map your site at /setup once it is up.')
    }
  }

  return agentLLM
}

/**
 * Concrete next-step instructions printed after `canonry init`. Listed in
 * the order the user should follow — analytics on the install funnel show a
 * large "silent bounce" cohort that runs init and never runs another command,
 * so the goal is to make the next action unambiguous and immediate.
 *
 * The dashboard setup (`canonry serve` → `http://127.0.0.1:4100/setup`) is the
 * recommended primary path: it maps a public site and captures a Page Health
 * baseline without requiring an answer-engine provider. AI Visibility remains
 * an optional follow-on. The CLI sequence is listed as the alternative for
 * operators who prefer scripts or non-interactive automation.
 */
function buildNextSteps(): string[] {
  return [
    '1. Start the dashboard and open Page Health setup:',
    '     canonry serve',
    '     → http://127.0.0.1:4100/setup',
    '',
    '   Map your public site and capture a persisted Page Health baseline.',
    '   AI Visibility is optional and can be configured after Page Health.',
    '   For remote/exposed hosts, complete dashboard password setup from loopback first.',
    '',
    'Prefer the terminal? The same flow as CLI commands:',
    '',
    '  a. canonry project create my-site --domain example.com --country US --language en',
    '  b. canonry technical-aeo run my-site --max-pages 100 --wait --format json',
    '  c. canonry technical-aeo score my-site --format json',
    '  d. canonry technical-aeo pages my-site --sort score-asc --limit 10 --format jsonl',
    '',
    'Tip: "canonry doctor" verifies your setup before you start.',
  ]
}

/**
 * Compact, stable encoding of the user's post-init configuration state.
 * Sent with `cli.init` so the install funnel can split bouncers from
 * activated users by what they actually configured.
 *
 * Format: pipe-joined flags (`provider|google` / `provider` / `none`).
 * Sorted alphabetically so the cardinality stays low.
 */
function encodeLegacySetupState(state: {
  hasProvider: boolean
  hasGoogle: boolean
  hasAgent: boolean
}): string {
  const flags: string[] = []
  if (state.hasProvider) flags.push('provider')
  if (state.hasGoogle) flags.push('google')
  if (state.hasAgent) flags.push('agent')
  return flags.length > 0 ? flags.sort().join('|') : 'none'
}

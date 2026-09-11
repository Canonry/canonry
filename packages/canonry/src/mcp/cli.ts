import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isReadOnlyKey } from '@ainyc/canonry-contracts'
import { createApiClient, type ApiClient } from '../client.js'
import { autoSyncSkills } from '../skills-autosync.js'
import { createCanonryMcpServer, type CanonryMcpScope } from './server.js'

export const HELP_TEXT = `Usage: canonry-mcp [--read-only | --scope=<all|read-only>] [--eager]

Stdio MCP adapter over the Canonry public API. Inherits config from
~/.canonry/config.yaml (or $CANONRY_CONFIG_DIR/config.yaml).

Flags:
  --read-only          Expose read tools only
  --scope=<all|read-only>
                       Same as --read-only when "read-only"
  --eager              Load all toolkits at start (skip progressive discovery)
  --help, -h           Show this message

Environment variables:
  CANONRY_MCP_SCOPE    "all" (default) or "read-only"
  CANONRY_MCP_EAGER    "1" / "true" / "yes" to enable eager mode
`

export class HelpRequested extends Error {
  constructor() {
    super('canonry-mcp --help requested')
    this.name = 'HelpRequested'
  }
}

export interface CanonryMcpCliOptions {
  scope: CanonryMcpScope
  eager: boolean
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let options: CanonryMcpCliOptions
  try {
    options = parseCliOptions(argv)
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stderr.write(HELP_TEXT)
      return
    }
    throw error
  }
  // Heal installed skills here too, not only in the `cnry` CLI. A plugin host
  // launches THIS binary and may never invoke the CLI at all, so gating the
  // refresh on a CLI run leaves exactly the MCP-only user — the one who never
  // types a canonry command — reading a playbook for an older engine.
  //
  // SILENT, unlike the CLI. The conflict notice is human guidance ("run
  // `canonry skills install --force`"), and the CLI prints it only on a TTY.
  // Nothing here is a terminal: stdout is the JSON-RPC framing and must never
  // be written to, and stderr is the host's log, where a line addressed to a
  // person who is not reading it is noise on every single launch. The heal
  // itself still happens; only the narration is dropped.
  //
  // Fire-and-forget: the server must not wait on a filesystem refresh, and the
  // sync swallows its own errors.
  void autoSyncSkills()

  // Build the client once, auto-detect a read-only key, then reuse the same
  // client for the server (keeps one client per server instance).
  const client = createApiClient({ clientName: 'canonry-mcp' })
  const authorization = await resolveEffectiveAuthorization(client, options.scope)
  const server = createCanonryMcpServer({ ...authorization, eager: options.eager, clientFactory: () => client })
  await server.connect(new StdioServerTransport())
}

/**
 * Resolve the effective tool scope by combining the requested scope with the
 * configured key's actual capability.
 *
 * A read-only key can only ever NARROW the catalog, never widen it: when the
 * configured key is read-only we force `read-only` so the adapter never
 * advertises write tools that the API would 403 at call time. The explicit
 * `--read-only` flag already means read-only, so we skip the probe there.
 *
 * Best-effort: the probe is a live `GET /keys/self`. On any failure — the API
 * is down, an older server lacks the endpoint, the key is unreadable — we keep
 * the flag/env scope rather than block startup.
 */
export async function resolveEffectiveScope(
  client: Pick<ApiClient, 'getApiKeySelf'>,
  flagScope: CanonryMcpScope,
): Promise<CanonryMcpScope> {
  return (await resolveEffectiveAuthorization(client, flagScope)).scope
}

export async function resolveEffectiveAuthorization(
  client: Pick<ApiClient, 'getApiKeySelf'>,
  flagScope: CanonryMcpScope,
): Promise<{ scope: CanonryMcpScope; credentialScopes?: readonly string[] }> {
  if (flagScope === 'read-only') return { scope: 'read-only' }
  try {
    const self = await client.getApiKeySelf()
    // Compute from `scopes` (the source of truth the server itself derives
    // `readOnly` from) so detection works even if a response omits the flag.
    if (isReadOnlyKey(self.scopes)) {
      process.stderr.write(
        'canonry-mcp: configured API key is read-only — restricting to read tools.\n',
      )
      return { scope: 'read-only', credentialScopes: self.scopes }
    }
    return { scope: flagScope, credentialScopes: self.scopes }
  } catch {
    // Best-effort detection — fall back to the requested scope.
  }
  return { scope: flagScope }
}

export function parseCliOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CanonryMcpCliOptions {
  // Honor --help / -h before consulting env so users with a misconfigured
  // CANONRY_MCP_SCOPE can still recover via `canonry-mcp --help`.
  if (argv.includes('--help') || argv.includes('-h')) {
    throw new HelpRequested()
  }
  let scope = normalizeScope(env.CANONRY_MCP_SCOPE)
  let eager = parseEagerEnv(env.CANONRY_MCP_EAGER)

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--read-only') {
      scope = 'read-only'
      continue
    }
    if (arg === '--eager') {
      eager = true
      continue
    }
    if (arg === '--scope') {
      const next = argv[i + 1]
      if (!next) throw new Error('Missing value for --scope')
      scope = normalizeScope(next)
      i += 1
      continue
    }
    if (arg?.startsWith('--scope=')) {
      scope = normalizeScope(arg.slice('--scope='.length))
      continue
    }
    throw new Error(`Unknown canonry-mcp argument: ${arg}`)
  }
  return { scope, eager }
}

function normalizeScope(value: string | undefined): CanonryMcpScope {
  if (!value || value === 'all') return 'all'
  if (value === 'read-only') return 'read-only'
  throw new Error(`Invalid MCP scope "${value}". Expected "all" or "read-only".`)
}

function parseEagerEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'canonry-mcp failed'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}

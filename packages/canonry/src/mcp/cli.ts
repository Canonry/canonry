import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
  const server = createCanonryMcpServer({ scope: options.scope, eager: options.eager })
  await server.connect(new StdioServerTransport())
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

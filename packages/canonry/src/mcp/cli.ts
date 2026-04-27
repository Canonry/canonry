import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCanonryMcpServer, type CanonryMcpScope } from './server.js'

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const server = createCanonryMcpServer({ scope: parseScope(argv) })
  await server.connect(new StdioServerTransport())
}

export function parseScope(argv: readonly string[], envScope = process.env.CANONRY_MCP_SCOPE): CanonryMcpScope {
  let scope = normalizeScope(envScope)
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--read-only') {
      scope = 'read-only'
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
  return scope
}

function normalizeScope(value: string | undefined): CanonryMcpScope {
  if (!value || value === 'all') return 'all'
  if (value === 'read-only') return 'read-only'
  throw new Error(`Invalid MCP scope "${value}". Expected "all" or "read-only".`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'canonry-mcp failed'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}

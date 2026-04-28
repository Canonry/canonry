import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createApiClient, type ApiClient } from '../client.js'
import { PACKAGE_VERSION } from '../package-version.js'
import { canonryMcpTools, type CanonryMcpTool } from './tool-registry.js'
import { withToolErrors } from './results.js'
import { DynamicToolCatalog, type DynamicCatalogEntry } from './dynamic-catalog.js'
import { CANONRY_MCP_TOOLKIT_NAMES } from './toolkits.js'

export type CanonryMcpScope = 'all' | 'read-only'

export interface CanonryMcpServerOptions {
  clientFactory?: () => ApiClient
  scope?: CanonryMcpScope
  eager?: boolean
}

export interface CreateCanonryMcpServerResult {
  server: McpServer
  catalog: DynamicToolCatalog
}

// The MCP SDK's default Zod validation throws an `McpError(InvalidParams, ...)`
// whose message is rendered to the client as a free-text "MCP error -32602:
// Input validation error: ..." dump. Bypass it so withToolErrors can re-parse
// with the same schema and surface a structured Canonry VALIDATION_ERROR envelope.
type WithValidate = { validateToolInput: (tool: unknown, args: unknown) => Promise<unknown> }

export function createCanonryMcpServer(options: CanonryMcpServerOptions = {}): McpServer {
  return createCanonryMcpServerWithCatalog(options).server
}

export function createCanonryMcpServerWithCatalog(options: CanonryMcpServerOptions = {}): CreateCanonryMcpServerResult {
  const clientFactory = options.clientFactory ?? createApiClient
  const client = clientFactory()
  const scope = options.scope ?? 'all'
  const server = new McpServer({
    name: 'canonry',
    version: PACKAGE_VERSION,
  })

  ;(server as unknown as WithValidate).validateToolInput = async (_tool, args) => args

  const entries: DynamicCatalogEntry[] = []
  for (const registryTool of getCanonryMcpTools(scope)) {
    const tool = registryTool as CanonryMcpTool
    const handler = tool.handler as (client: ApiClient, input: unknown) => Promise<unknown>
    const registered = server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: unknown) => withToolErrors(async () => {
        const parsed = tool.inputSchema.parse(input ?? {})
        return handler(client, parsed)
      }),
    )
    entries.push({ tool, registered })
  }

  const catalog = new DynamicToolCatalog(server, entries, scope, { eager: options.eager })
  catalog.applyInitialEnablement()

  registerMetaTools(server, catalog)

  return { server, catalog }
}

const loadToolkitInputSchema = z.object({
  name: z.enum(CANONRY_MCP_TOOLKIT_NAMES).describe('Toolkit name. List options with canonry_help.'),
})

function registerMetaTools(server: McpServer, catalog: DynamicToolCatalog): void {
  server.registerTool(
    'canonry_help',
    {
      title: 'List Canonry MCP toolkits',
      description: 'List available toolkits and which are loaded. Call before canonry_load_toolkit if unsure which to load.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => withToolErrors(async () => catalog.helpResult()),
  )

  server.registerTool(
    'canonry_load_toolkit',
    {
      title: 'Load a Canonry MCP toolkit',
      description: 'Register a toolkit\'s tools for this session and emit one notifications/tools/list_changed. Idempotent. Loaded toolkits remain loaded for the rest of the session. Wait for this call to return before calling any newly enabled tool — pipelining the call with a tools/call on the same connection can race the registration and fail with "MCP error -32602: Tool ... disabled".',
      inputSchema: loadToolkitInputSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async (input: unknown) => withToolErrors(async () => {
      const parsed = loadToolkitInputSchema.parse(input ?? {})
      return catalog.loadToolkit(parsed.name)
    }),
  )
}

export function getCanonryMcpTools(scope: CanonryMcpScope = 'all') {
  return scope === 'read-only'
    ? canonryMcpTools.filter(tool => tool.access === 'read')
    : [...canonryMcpTools]
}

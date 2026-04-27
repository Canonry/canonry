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
      async (input: unknown) => withToolErrors(() => handler(client, input)),
    )
    entries.push({ tool, registered })
  }

  const catalog = new DynamicToolCatalog(entries, scope, { eager: options.eager })
  catalog.applyInitialEnablement()

  registerMetaTools(server, catalog)

  return { server, catalog }
}

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
      description: 'Register a toolkit\'s tools for this session and emit notifications/tools/list_changed. Idempotent. Loaded toolkits remain loaded for the rest of the session.',
      inputSchema: {
        name: z.enum(CANONRY_MCP_TOOLKIT_NAMES).describe('Toolkit name. List options with canonry_help.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    },
    async ({ name }: { name: string }) => withToolErrors(async () => catalog.loadToolkit(name)),
  )
}

export function getCanonryMcpTools(scope: CanonryMcpScope = 'all') {
  return scope === 'read-only'
    ? canonryMcpTools.filter(tool => tool.access === 'read')
    : [...canonryMcpTools]
}

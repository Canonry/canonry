import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createApiClient, type ApiClient } from '../client.js'
import { PACKAGE_VERSION } from '../package-version.js'
import { canonryMcpTools, type CanonryMcpTool } from './tool-registry.js'
import { withToolErrors } from './results.js'

export type CanonryMcpScope = 'all' | 'read-only'

export interface CanonryMcpServerOptions {
  clientFactory?: () => ApiClient
  scope?: CanonryMcpScope
}

export function createCanonryMcpServer(options: CanonryMcpServerOptions = {}): McpServer {
  const clientFactory = options.clientFactory ?? createApiClient
  const client = clientFactory()
  const scope = options.scope ?? 'all'
  const server = new McpServer({
    name: 'canonry',
    version: PACKAGE_VERSION,
  })

  for (const registryTool of getCanonryMcpTools(scope)) {
    const tool = registryTool as CanonryMcpTool
    const handler = tool.handler as (client: ApiClient, input: unknown) => Promise<unknown>
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: unknown) => withToolErrors(() => handler(client, input)),
    )
  }

  return server
}

export function getCanonryMcpTools(scope: CanonryMcpScope = 'all') {
  return scope === 'read-only'
    ? canonryMcpTools.filter(tool => tool.access === 'read')
    : [...canonryMcpTools]
}

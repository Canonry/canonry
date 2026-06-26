import { Type, type TSchema } from '@sinclair/typebox'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { createLogger } from '../logger.js'
import type { ExternalMcpServerConfig } from '../config.js'

const log = createLogger('RemoteMcp')

/**
 * FROZEN TRANSPORT CONTRACT (OSS-A).
 *
 * Aero loads tools from an injected REMOTE MCP server over MCP Streamable
 * HTTP (`StreamableHTTPClientTransport`), authenticating with a bearer
 * token carried in the transport's request headers
 * (`Authorization: Bearer <token>`). This is the single transport a remote
 * MCP server must speak to be loadable here. SSE is legacy and is NOT used.
 *
 * The server is remote platform-hosted code, never co-located in the OSS
 * container. The injected config carries only `{ url, token, label? }`; Aero
 * connects out. Per-tenant isolation is the responsibility of the token
 * (scoped server-side), not the container boundary.
 *
 * Safety filter (always applied): a remote tool is adapted into an AgentTool
 * ONLY when it is read-only (`annotations.readOnlyHint === true`) AND its name
 * is not in `AERO_EXCLUDED_MCP_TOOLS`. A server that fails to connect is
 * logged and skipped; it never throws the whole load.
 */

/**
 * Remote MCP tool names that must never reach Aero even when a server
 * advertises them as read-only. Distinct from the local-registry exclusion
 * set in `mcp-to-agent-tool.ts`: this guards tools that arrive over the wire
 * from an external server we do not own.
 */
export const AERO_EXCLUDED_MCP_TOOLS: ReadonlySet<string> = new Set<string>([])

/** Max characters of a remote tool result we hand back to the model. */
const MAX_TOOL_RESULT_CHARS = 20_000

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  return text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n... (truncated, result too large)'
}

/** Shape of a single tool entry returned by the MCP SDK `client.listTools()`. */
interface RemoteToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: {
    title?: string
    readOnlyHint?: boolean
  }
}

/**
 * A minimal MCP client surface, just the two methods the adapter needs.
 * Lets tests inject an InMemory-connected client without the production
 * StreamableHTTP transport, while production uses the real SDK `Client`.
 */
export interface RemoteMcpClient {
  listTools(): Promise<{ tools: RemoteToolDescriptor[] }>
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>
}

export interface LoadExternalMcpToolsOptions {
  /**
   * Test seam: connect to a server config and return a ready MCP client.
   * Defaults to `connectStreamableHttp` (the frozen production transport).
   */
  connect?: (server: ExternalMcpServerConfig) => Promise<RemoteMcpClient>
  /** Override the read-only exclusion set (tests). Defaults to `AERO_EXCLUDED_MCP_TOOLS`. */
  excluded?: ReadonlySet<string>
}

/**
 * Build the production MCP client for one server: a `StreamableHTTPClientTransport`
 * pointed at `server.url` with the bearer token in its request headers. This is
 * the frozen transport contract, bearer-gated MCP Streamable HTTP.
 */
export async function connectStreamableHttp(
  server: ExternalMcpServerConfig,
): Promise<RemoteMcpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${server.token}` },
    },
  })
  const client = new Client(
    { name: 'canonry-aero', version: '1.0.0' },
    { capabilities: {} },
  )
  await client.connect(transport)
  return client as unknown as RemoteMcpClient
}

/** True when a remote tool is read-only per its MCP annotations. */
function isReadOnly(tool: RemoteToolDescriptor): boolean {
  return tool.annotations?.readOnlyHint === true
}

/**
 * Adapt one remote read-only MCP tool into a pi-agent-core `AgentTool`. Mirrors
 * the AgentTool shape produced by `mcp-to-agent-tool.ts` (name/label/description/
 * parameters/execute). The remote tool's JSON Schema is wrapped in `Type.Unsafe`
 * so pi-agent-core's TSchema-typed `parameters` accepts it without conversion;
 * `execute` forwards the validated args to `client.callTool` and returns the
 * remote result under the 20 KB truncation guard.
 *
 * No `project` stripping/injection here (unlike the local adapter): a remote
 * server defines its own argument surface and we never inject a canonry project
 * id into a tool we do not own.
 */
function adaptRemoteTool(client: RemoteMcpClient, tool: RemoteToolDescriptor): AgentTool {
  const parameters = Type.Unsafe<Record<string, unknown>>(
    (tool.inputSchema ?? { type: 'object', properties: {} }) as object,
  ) as TSchema

  const execute = async (
    _toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<AgentToolResult<unknown>> => {
    const result = await client.callTool({ name: tool.name, arguments: params })
    return {
      content: [{ type: 'text', text: truncate(JSON.stringify(result, null, 2)) }],
      details: result,
    }
  }

  return {
    name: tool.name,
    label: tool.annotations?.title ?? tool.name,
    description: tool.description ?? '',
    parameters,
    execute,
  } as AgentTool
}

/**
 * Connect to each configured external MCP server, discover its tools, and
 * adapt every read-only, non-excluded tool into an AgentTool for Aero.
 *
 * Resilient by design: a server that fails to connect or list its tools is
 * logged and skipped, one bad server never aborts the whole load. No servers
 * configured returns `[]`.
 *
 * The frozen transport (bearer-gated Streamable HTTP) is constructed in
 * `connectStreamableHttp`; tests inject `opts.connect` to supply an
 * InMemory-connected client instead.
 */
export async function loadExternalMcpTools(
  servers: readonly ExternalMcpServerConfig[] | undefined,
  opts: LoadExternalMcpToolsOptions = {},
): Promise<AgentTool[]> {
  if (!servers || servers.length === 0) return []
  const connect = opts.connect ?? connectStreamableHttp
  const excluded = opts.excluded ?? AERO_EXCLUDED_MCP_TOOLS

  const tools: AgentTool[] = []
  for (const server of servers) {
    const label = server.label ?? server.url
    let client: RemoteMcpClient
    try {
      client = await connect(server)
    } catch (err) {
      log.error('external-mcp.connect-failed', {
        label,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    let listed: { tools: RemoteToolDescriptor[] }
    try {
      listed = await client.listTools()
    } catch (err) {
      log.error('external-mcp.list-failed', {
        label,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    for (const tool of listed.tools) {
      if (excluded.has(tool.name)) continue
      if (!isReadOnly(tool)) continue
      tools.push(adaptRemoteTool(client, tool))
    }
    log.info('external-mcp.loaded', {
      label,
      discovered: listed.tools.length,
      adopted: tools.length,
    })
  }
  return tools
}

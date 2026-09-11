import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isReadOnlyKey, restrictedWriteScopes, RESEARCH_RUN_SCOPE } from '@ainyc/canonry-contracts'
import { createApiClient, type ApiClient } from '../client.js'
import { PACKAGE_VERSION } from '../package-version.js'
import { canonryMcpTools, type CanonryMcpTool } from './tool-registry.js'
import { errorToolResult, jsonToolResult, withToolErrors } from './results.js'
import { DynamicToolCatalog, type DynamicCatalogEntry } from './dynamic-catalog.js'
import { CANONRY_MCP_TOOLKIT_NAMES, type CanonryMcpTier } from './toolkits.js'
import { operationsHelp, type GuideMode } from './operations-guide.js'
import { OPERATIONS_GUIDE } from './operations-guide.generated.js'

export type CanonryMcpScope = 'all' | 'read-only'

export interface CanonryMcpServerOptions {
  clientFactory?: () => ApiClient
  scope?: CanonryMcpScope
  /** Actual credential grants, separate from an explicit read-only endpoint/flag. */
  credentialScopes?: readonly string[]
  eager?: boolean
  /**
   * Restrict this server to a union of tiers.
   *
   * This is the segmentation a hosted client needs. The MCP spec is explicit
   * that a tool set "MUST NOT vary per-connection or as a side effect of other
   * requests on the connection", and equally explicit that it MAY vary "by the
   * authorization presented on the request" — so the surface is narrowed when
   * the connection is opened, never while it is running.
   *
   * Undefined means every tier, which is the stdio default and unchanged.
   */
  tiers?: readonly CanonryMcpTier[]
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


/** Automatic entry point, generated from the public guide; skills are optional. */
const SERVER_INSTRUCTIONS = OPERATIONS_GUIDE.initialize

export function createCanonryMcpServerWithCatalog(options: CanonryMcpServerOptions = {}): CreateCanonryMcpServerResult {
  const clientFactory = options.clientFactory ?? (() => createApiClient({ clientName: 'canonry-mcp' }))
  const client = clientFactory()
  const scope = options.scope ?? 'all'
  const server = new McpServer({
    name: 'canonry',
    version: PACKAGE_VERSION,
  }, {
    instructions: SERVER_INSTRUCTIONS,
  })

  ;(server as unknown as WithValidate).validateToolInput = async (_tool, args) => args

  const entries: DynamicCatalogEntry[] = []
  for (const registryTool of getCanonryMcpTools(scope, options.tiers, options.credentialScopes)) {
    const tool = registryTool as CanonryMcpTool
    const handler = tool.handler as (client: ApiClient, input: unknown) => Promise<unknown>
    const registered = server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (input: unknown) => withToolErrors(async () => {
        const parsed = tool.inputSchema.parse(input ?? {})
        return handler(client, parsed)
      }),
    )
    entries.push({ tool, registered })
  }

  // A tier-filtered server IS the narrowed surface, so everything in it is
  // enabled from the start. Leaving progressive mode on would disable the very
  // tiers the endpoint exists to serve, since the catalog disables anything
  // that is not `core` until a toolkit is loaded.
  const eager = options.eager === true || options.tiers !== undefined
  const catalog = new DynamicToolCatalog(server, entries, scope, { eager })
  catalog.applyInitialEnablement()

  // A tier-filtered server has a FIXED surface, so the toolkit loader is dead
  // weight there: calling it could only widen a surface the endpoint exists to
  // narrow. Excluded structurally rather than by policy, so it cannot be
  // advertised and then fail — and so it stops costing context on a profile
  // whose whole point is not to.
  const mode: GuideMode = options.tiers !== undefined
    ? 'hosted-fixed-catalog'
    : eager ? 'stdio-fixed-catalog' : 'stdio-progressive'
  registerMetaTools(server, catalog, { includeToolkitLoader: options.tiers === undefined, mode })
  server.registerResource('canonry-agent-operations-v1', OPERATIONS_GUIDE.resourceUri, {
    title: 'Canonry Operations Guide v1',
    description: 'Optional public operations guidance. Use canonry_help when resources are unavailable.',
    mimeType: 'text/markdown',
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: OPERATIONS_GUIDE.markdown }] }))

  return { server, catalog }
}

const loadToolkitInputSchema = z.object({
  name: z.enum(CANONRY_MCP_TOOLKIT_NAMES).describe('Toolkit name. List options with canonry_help.'),
})

const helpInputSchema = z.object({
  intent: z.string().max(200).optional().describe('Workflow (status, diagnose, measurement, integrations, reports) or a short task description.'),
  includeCatalog: z.boolean().optional().describe('Include full toolkit details. Omit for a compact, actionable route.'),
})

function registerMetaTools(
  server: McpServer,
  catalog: DynamicToolCatalog,
  opts: { includeToolkitLoader: boolean; mode: GuideMode },
): void {
  server.registerTool(
    'canonry_help',
    {
      title: 'Guide a Canonry workflow',
      description: 'Start here: route an intent to available stored-evidence tools, workflow guidance, and approval boundaries. No provider calls or installation required. Optionally include full toolkit details.',
      inputSchema: helpInputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input: unknown) => {
      try {
        const parsed = helpInputSchema.parse(input ?? {})
        const result = operationsHelp(catalog.helpResult(), opts.mode, parsed.intent, parsed.includeCatalog)
        return { ...jsonToolResult(result), structuredContent: result }
      } catch (error) {
        return errorToolResult(error)
      }
    },
  )

  if (!opts.includeToolkitLoader) return
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

export function getCanonryMcpTools(
  scope: CanonryMcpScope = 'all',
  tiers?: readonly CanonryMcpTier[],
  credentialScopes?: readonly string[],
) {
  const readOnly = scope === 'read-only' || (credentialScopes !== undefined && isReadOnlyKey(credentialScopes))
  const restricted = credentialScopes && restrictedWriteScopes(credentialScopes)
  const byScope = readOnly
    ? canonryMcpTools.filter(tool => tool.access === 'read')
    : canonryMcpTools.filter(tool => {
      if (!restricted || tool.access === 'read') return true
      if (tool.requiredScope && restricted.includes(tool.requiredScope)) return true
      // Preserve existing Ads catalogs; their API handlers enforce individual grants.
      return restricted.some(grant => grant !== RESEARCH_RUN_SCOPE) && tool.tier === 'ads'
    })
  if (!tiers) return byScope
  const wanted = new Set<CanonryMcpTier>(tiers)
  return byScope.filter(tool => wanted.has(tool.tier))
}

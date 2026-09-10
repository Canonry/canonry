import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isReadOnlyKey, restrictedWriteScopes, RESEARCH_RUN_SCOPE } from '@ainyc/canonry-contracts'
import { createApiClient, type ApiClient } from '../client.js'
import { PACKAGE_VERSION } from '../package-version.js'
import { canonryMcpTools, type CanonryMcpTool } from './tool-registry.js'
import { withToolErrors } from './results.js'
import { DynamicToolCatalog, type DynamicCatalogEntry } from './dynamic-catalog.js'
import { CANONRY_MCP_TOOLKIT_NAMES, type CanonryMcpTier } from './toolkits.js'

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


/**
 * Text every MCP client receives at `initialize`, before any tool is called.
 *
 * This is the only channel that is BOTH automatic and impossible to make
 * stale: it ships inside the running engine, so it always describes the build
 * the caller is actually talking to, and the client gets it without the model
 * choosing to load anything. A skill has to be selected; this does not.
 *
 * It is therefore a POINTER AND A WARNING, never a playbook. Keep it under 2KB
 * (Claude Code truncates there) and put procedures in the skill.
 *
 * What earns a place here: a fact whose absence causes a wrong action rather
 * than a slower one.
 */
const SERVER_INSTRUCTIONS = `Canonry tracks how AI answer engines mention a brand and cite a domain.

Load the "canonry" skill before operator work (project setup, integrations, traffic sources, sweeps, diagnosis). It carries the procedures and the failure modes; this text is only a pointer. Use "aero" for analyst work: regression diagnosis, reporting.

Two signals, never interchangeable:
- mentioned = the brand appears in the answer TEXT the model wrote.
- cited = the domain appears in the SOURCE links behind the answer.
A model can do either, both or neither. Never compute one from the other, and never report a number for one under the other's name.

Sweeps, probes, and research runs spend provider quota and write rows. Get explicit approval before any run, apply, or other mutation.

Most reads are free. Five ads reads are NOT: canonry_ads_account, canonry_ads_geo_search, canonry_ads_live_delivery, canonry_ads_conversion_pixels and canonry_ads_conversion_event_settings call the provider live and spend against the advertiser account. They are marked read, so nothing in the tool list warns you. Get approval for those exactly as for a mutation.

Google Marketing also calls providers live. Get approval before canonry_google_ads_customers, canonry_gtm_accounts, canonry_gtm_containers, canonry_gtm_workspaces, canonry_google_ads_sync or canonry_gtm_sync.

A null answerMentioned means NOT CHECKED, not "not mentioned". Never coerce it to false.

If no sweep has run, say so. Never state a mention or citation figure that no run produced.`

export function createCanonryMcpServerWithCatalog(options: CanonryMcpServerOptions = {}): CreateCanonryMcpServerResult {
  const clientFactory = options.clientFactory ?? createApiClient
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
  registerMetaTools(server, catalog, { includeToolkitLoader: options.tiers === undefined })

  return { server, catalog }
}

const loadToolkitInputSchema = z.object({
  name: z.enum(CANONRY_MCP_TOOLKIT_NAMES).describe('Toolkit name. List options with canonry_help.'),
})

function registerMetaTools(
  server: McpServer,
  catalog: DynamicToolCatalog,
  opts: { includeToolkitLoader: boolean },
): void {
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

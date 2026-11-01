/**
 * MCP method dispatch and the HTTP handler for the `/mcp` endpoint.
 *
 * The endpoint is anonymous, which is a deliberate consequence of what it
 * exposes: checks on this val are already public: the web UI serves any of
 * them from `/api/checks/:id` without a credential. A token would gate nothing
 * already unreachable, while making the endpoint useless as something an agent
 * is simply pointed at.
 *
 * `start_check` is the one tool that spends. It is admitted by per-caller
 * quota rather than by a credential, under the same global daily cap as the
 * browser, so an anonymous caller can consume its share of the day's budget
 * but never enlarge it.
 */
import {
  isAllowedOrigin,
  jsonRpcError,
  JsonRpcErrorCodes,
  type JsonRpcResponse,
  jsonRpcResult,
  type ParsedMcpRequest,
  parseMcpRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
} from 'npm:@canonry/val-kit@0.2.0/mcp'
import { callMcpTool, type McpToolContext, mcpTools, type StartCheckFn } from './tools.ts'

/** Version of this MCP surface, not of the Canonry package the val samples. */
export const MCP_SERVER_VERSION = '1.0.0'

const MAX_BODY_BYTES = 262_144

// Named for what this endpoint is, not for the platform it samples. Calling it
// `canonry` would tell an agent it had the whole product, when it has three
// branded questions to one engine. The slug is the identifier a client keys
// off; the display name lives in `title`, which is where a human reads it.
const SERVER_INFO = {
  name: 'brand-perception-check',
  title: 'Brand Perception Check (by Canonry)',
  version: MCP_SERVER_VERSION,
} as const

const INSTRUCTIONS = [
  'Brand Perception Check is a free, bounded sample of Canonry. It measures how an AI answer engine CHARACTERISES a',
  'brand when it is asked about that brand directly. One check is 3 branded questions against Gemini, each answer',
  'read back for the position it takes: enough to see what is being said, not enough to monitor it. Canonry itself is',
  'open source, self-hosted, tracks Gemini, ChatGPT, Claude and Perplexity on a schedule, and has no such limits.',
  'Call self_host for that.',
  '',
  'Every question here NAMES the brand, so the engine was always going to discuss it. These figures are therefore',
  'never comparable to an AI Visibility mention or citation rate, which are measured on non-brand questions and share',
  'no denominator with this. Do not pool them and do not present one as the other.',
  '',
  'A verdict is one of recommends, cautions, mixed, or none, and it is kept only when sentences copied WORD FOR WORD',
  'out of that answer carry it. "none" means the answer took no position, which is a finding. A null verdict means',
  'the check produced none and was not measured — it is not a neutral answer, and it is in no denominator. Nothing',
  'here is a sentiment score; there is no such number and inventing one would misreport what was measured.',
  '',
  'Sources are the ones the engine attributed for these answers, typed as official, community, review, news, or',
  'other. They are not a claim about where opinions about the brand come from on the web.',
  '',
  'Use get_check for the headline counts and get_brand_perception for the per-answer evidence behind them.',
  '',
  'get_check and get_brand_perception read existing checks and never spend. start_check runs a fresh one, blocks for',
  'up to about 45 seconds, and is subject to daily limits; a domain checked in the last 24 hours returns from cache',
  'at no cost. Prefer reading before starting.',
].join('\n')

export interface McpHandlerOptions {
  store: McpToolContext['store']
  now?: () => Date
  /** Omit to keep the endpoint strictly read-only. */
  startCheck?: StartCheckFn
}

function jsonResponse(body: JsonRpcResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function readLimitedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    length += next.value.byteLength
    if (length > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(next.value)
  }
  const merged = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/**
 * Val injects `cf-connecting-ip`. `x-forwarded-for` is caller-controlled on a
 * public val and is deliberately ignored, so a caller cannot mint a fresh
 * quota identity per request.
 */
function edgeIp(request: Request): string | null {
  const value = request.headers.get('cf-connecting-ip')?.trim()
  return value && value.length <= 128 ? value : null
}

/** Dispatch one parsed message. Returns null for a notification, which gets 202. */
async function dispatch(
  context: McpToolContext,
  request: ParsedMcpRequest,
): Promise<{ response: JsonRpcResponse; status: number } | null> {
  const { message, protocolVersion } = request
  const id = message.id ?? null
  const params = message.params ?? {}

  switch (message.method) {
    case 'initialize': {
      // Echo a version the caller asked for when it is one we speak, so a
      // legacy client stays in its own era instead of being pushed forward
      // into rules it does not implement. A client that declared its version
      // only in the `MCP-Protocol-Version` header and omitted it from params
      // still gets its own era back, because `protocolVersion` carries what
      // the envelope declared; falling through to the newest version would
      // answer a 2025 client with 2026 rules it has no code for.
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null
      const negotiated = requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : protocolVersion
      return {
        status: 200,
        response: jsonRpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }),
      }
    }

    // Accepted so a legacy handshake completes. There is no session to advance.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return { status: 200, response: jsonRpcResult(id, {}) }

    case 'tools/list':
      return { status: 200, response: jsonRpcResult(id, { tools: mcpTools(context) }) }

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {}
      if (!name) {
        return {
          status: 200,
          response: jsonRpcError(id, JsonRpcErrorCodes.invalidParams, 'tools/call requires a "name".'),
        }
      }
      const result = await callMcpTool(context, name, args)
      if (!result) {
        return {
          status: 200,
          response: jsonRpcError(id, JsonRpcErrorCodes.invalidParams, `Unknown tool "${name}".`),
        }
      }
      return { status: 200, response: jsonRpcResult(id, result) }
    }

    // Answered rather than refused: several clients probe these during startup,
    // and a method-not-found there reads as a broken server. This endpoint
    // serves no resources or prompts.
    case 'resources/list':
      return { status: 200, response: jsonRpcResult(id, { resources: [] }) }

    case 'resources/templates/list':
      return { status: 200, response: jsonRpcResult(id, { resourceTemplates: [] }) }

    case 'prompts/list':
      return { status: 200, response: jsonRpcResult(id, { prompts: [] }) }

    case 'resources/read': {
      const uri = typeof params.uri === 'string' ? params.uri : ''
      return {
        status: 200,
        response: jsonRpcError(id, JsonRpcErrorCodes.invalidParams, `Resource not found: "${uri}".`),
      }
    }

    default:
      // A notification (no id) must never be answered, even for an unknown
      // method: returning null yields the 202 no-body the handler sends for
      // notifications. A roots-capable client's notifications/roots/list_changed
      // would otherwise get a 404 it can read as "endpoint gone".
      if (request.isNotification) return null
      // Streamable HTTP pairs an unknown request with 404, which is how a client
      // tells a modern server apart from a legacy endpoint that lacks this route.
      return {
        status: 404,
        response: jsonRpcError(id, JsonRpcErrorCodes.methodNotFound, `Unknown method "${message.method}".`),
      }
  }
}

/** Handle one POST to the MCP endpoint. */
export function createMcpHandler(options: McpHandlerOptions): (request: Request) => Promise<Response> {
  const base: McpToolContext = {
    store: options.store,
    now: options.now ?? (() => new Date()),
    startCheck: options.startCheck,
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      // The modern revision removed the GET stream and DELETE teardown.
      return jsonResponse(
        jsonRpcError(null, JsonRpcErrorCodes.invalidRequest, 'The MCP endpoint accepts POST only.'),
        405,
      )
    }

    if (!isAllowedOrigin(request.headers, request.url)) {
      return jsonResponse(jsonRpcError(null, JsonRpcErrorCodes.invalidRequest, 'Origin not allowed.'), 403)
    }

    const raw = await readLimitedBody(request)
    if (raw === null) {
      return jsonResponse(jsonRpcError(null, JsonRpcErrorCodes.invalidRequest, 'Request body is too large.'), 413)
    }

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return jsonResponse(jsonRpcError(null, JsonRpcErrorCodes.parseError, 'Request body is not valid JSON.'), 400)
    }

    const parsed = parseMcpRequest(request.headers, body)
    if (!parsed.ok) return jsonResponse(parsed.response, parsed.status)

    let outcome: Awaited<ReturnType<typeof dispatch>>
    try {
      outcome = await dispatch({ ...base, remoteIp: edgeIp(request) }, parsed.request)
    } catch {
      // Never surface an internal message; a store failure can carry
      // deployment detail that does not belong on a public endpoint.
      return jsonResponse(
        jsonRpcError(parsed.request.message.id ?? null, JsonRpcErrorCodes.internalError, 'Internal error.'),
        200,
      )
    }

    if (!outcome) {
      if (!parsed.request.isNotification) {
        // A request that dispatched as a notification would otherwise hang the
        // caller waiting for a response that is never coming.
        return jsonResponse(
          jsonRpcError(
            parsed.request.message.id ?? null,
            JsonRpcErrorCodes.invalidRequest,
            `"${parsed.request.message.method}" is a notification and must be sent without an "id".`,
          ),
          400,
        )
      }
      return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } })
    }

    return jsonResponse(outcome.response, outcome.status)
  }
}

import type { FastifyInstance } from 'fastify'
import type { AgentTranscriptDto, AgentTranscriptMessageDto } from '@ainyc/canonry-contracts'
import { agentUnavailable } from '@ainyc/canonry-contracts'

export interface AgentTranscriptRoutesOptions {
  agentGatewayPort: number
  agentGatewayToken?: string
  agentSessionKey?: string
}

/**
 * OpenClaw transcript message shape (2026.4.x+).
 * Each item in `items`/`messages` is a raw transcript message with `__openclaw` metadata.
 */
interface OpenClawTranscriptMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | Array<{ type: string; text?: string }>
  timestamp?: number
  __openclaw?: {
    id?: string
    seq?: number
    kind?: string
  }
}

interface OpenClawHistoryResponse {
  sessionKey: string
  items?: OpenClawTranscriptMessage[]
  messages?: OpenClawTranscriptMessage[]
  hasMore?: boolean
  nextCursor?: string
}

function extractContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!)
    .join('\n')
}

function mapEntry(entry: OpenClawTranscriptMessage): AgentTranscriptMessageDto {
  const meta = entry.__openclaw
  const id = meta?.id ?? `seq-${meta?.seq ?? 0}`
  const seq = meta?.seq ?? 0
  // OpenClaw stamps messages with Date.now() (milliseconds)
  const ts = entry.timestamp
    ? new Date(entry.timestamp).toISOString()
    : new Date().toISOString()

  return {
    id,
    role: entry.role,
    content: extractContent(entry.content),
    timestamp: ts,
    seq,
    state: 'final',
  }
}

export async function agentTranscriptRoutes(app: FastifyInstance, opts: AgentTranscriptRoutesOptions) {
  // GET /agent/transcript — proxy to OpenClaw session history
  app.get<{
    Querystring: { limit?: string; cursor?: string }
  }>('/agent/transcript', async (request, reply) => {
    if (!opts.agentGatewayToken) {
      throw agentUnavailable('Agent chat requires re-running "canonry agent setup" to generate gateway credentials')
    }

    const sessionKey = opts.agentSessionKey ?? 'agent:aero:main'
    const limit = request.query.limit ? Math.min(Math.max(parseInt(request.query.limit, 10), 1), 1000) : 50

    const params = new URLSearchParams()
    params.set('limit', String(limit))
    if (request.query.cursor) {
      params.set('cursor', request.query.cursor)
    }

    const gatewayUrl = `http://localhost:${opts.agentGatewayPort}/sessions/${encodeURIComponent(sessionKey)}/history?${params.toString()}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    let gatewayRes: Response
    try {
      gatewayRes = await fetch(gatewayUrl, {
        headers: {
          'Authorization': `Bearer ${opts.agentGatewayToken}`,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      })
    } catch {
      clearTimeout(timeout)
      throw agentUnavailable()
    }

    clearTimeout(timeout)

    // Session not found — no conversation yet
    if (gatewayRes.status === 404) {
      const result: AgentTranscriptDto = { messages: [] }
      return reply.send(result)
    }

    if (!gatewayRes.ok) {
      throw agentUnavailable(`Agent gateway returned ${gatewayRes.status}`)
    }

    const json = await gatewayRes.json() as OpenClawHistoryResponse

    // OpenClaw returns both `items` and `messages` (alias) — prefer `items`
    const rawItems = json.items ?? json.messages ?? []
    const messages: AgentTranscriptMessageDto[] = rawItems.map(mapEntry)
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined

    const result: AgentTranscriptDto = {
      messages,
      cursor: json.nextCursor,
      lastMessageId: lastMessage?.id,
    }

    return reply.send(result)
  })
}

import type { FastifyInstance } from 'fastify'
import type { AgentTranscriptDto, AgentTranscriptMessageDto } from '@ainyc/canonry-contracts'
import { agentUnavailable } from '@ainyc/canonry-contracts'

export interface AgentTranscriptRoutesOptions {
  agentGatewayPort: number
  agentGatewayToken?: string
  agentSessionKey?: string
}

interface OpenClawHistoryEntry {
  runId?: string
  sessionKey?: string
  seq: number
  state: 'delta' | 'final' | 'aborted' | 'error'
  message?: string
  errorKind?: string
  usage?: Record<string, unknown>
  stopReason?: string
}

interface OpenClawHistoryResponse {
  sessionKey: string
  history: OpenClawHistoryEntry[]
}

function mapEntry(entry: OpenClawHistoryEntry, index: number): AgentTranscriptMessageDto {
  // OpenClaw entries use seq for ordering. The `message` field contains the text.
  // Role is inferred: even seq = user, odd seq = assistant (OpenClaw alternates).
  // If OpenClaw provides richer role info in the future, map directly.
  const role: AgentTranscriptMessageDto['role'] = index % 2 === 0 ? 'user' : 'assistant'

  return {
    id: entry.runId ?? `seq-${entry.seq}`,
    role,
    content: entry.message ?? '',
    timestamp: new Date().toISOString(), // OpenClaw history doesn't include timestamp per-entry
    seq: entry.seq,
    state: entry.state,
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

    const messages: AgentTranscriptMessageDto[] = (json.history ?? []).map(mapEntry)
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined

    const result: AgentTranscriptDto = {
      messages,
      lastMessageId: lastMessage?.id,
    }

    return reply.send(result)
  })
}

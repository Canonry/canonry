import type { FastifyInstance } from 'fastify'
import type { AgentChatResponseDto } from '@ainyc/canonry-contracts'
import { agentUnavailable, validationError } from '@ainyc/canonry-contracts'

export interface AgentChatRoutesOptions {
  agentGatewayPort: number
  agentGatewayToken?: string
  agentSessionKey?: string
}

interface ChatRequestBody {
  message: string
  context?: {
    page?: string
    insightId?: string
    runId?: string
    projectName?: string
  }
  stream?: boolean
}

function buildSystemMessage(context: ChatRequestBody['context']): string | null {
  if (!context) return null
  const parts: string[] = []
  if (context.page) parts.push(`User is on ${context.page}.`)
  if (context.projectName) parts.push(`Project: ${context.projectName}.`)
  if (context.insightId) parts.push(`Insight context: ${context.insightId}.`)
  if (context.runId) parts.push(`Run context: ${context.runId}.`)
  return parts.length > 0 ? parts.join(' ') : null
}

export async function agentChatRoutes(app: FastifyInstance, opts: AgentChatRoutesOptions) {
  // POST /agent/chat — proxy to OpenClaw chat completions
  app.post<{ Body: ChatRequestBody }>('/agent/chat', async (request, reply) => {
    const body = request.body
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      throw validationError('"message" is required and must be a non-empty string')
    }

    if (!opts.agentGatewayToken) {
      throw agentUnavailable('Agent chat requires re-running "canonry agent setup" to generate gateway credentials')
    }

    const messages: Array<{ role: string; content: string }> = []

    const systemContent = buildSystemMessage(body.context)
    if (systemContent) {
      messages.push({ role: 'system', content: systemContent })
    }

    messages.push({ role: 'user', content: body.message.trim() })

    const shouldStream = body.stream !== false // default to streaming

    const gatewayUrl = `http://localhost:${opts.agentGatewayPort}/v1/chat/completions`
    const gatewayBody = JSON.stringify({
      model: 'openclaw',
      messages,
      stream: shouldStream,
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300_000) // 5 min timeout for long agent loops

    let gatewayRes: Response
    try {
      gatewayRes = await fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${opts.agentGatewayToken}`,
          'x-openclaw-session-key': opts.agentSessionKey ?? 'agent:aero:main',
          'x-openclaw-message-channel': 'webchat',
        },
        body: gatewayBody,
        signal: controller.signal,
      })
    } catch {
      clearTimeout(timeout)
      throw agentUnavailable()
    }

    if (!gatewayRes.ok) {
      clearTimeout(timeout)
      throw agentUnavailable(`Agent gateway returned ${gatewayRes.status}`)
    }

    if (shouldStream) {
      // Pipe SSE stream back to the client
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      const reader = gatewayRes.body?.getReader()
      if (!reader) {
        clearTimeout(timeout)
        reply.raw.end()
        return reply
      }

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          reply.raw.write(value)
        }
      } catch {
        // Client disconnected or gateway error — close gracefully
      } finally {
        clearTimeout(timeout)
        reply.raw.end()
      }

      return reply
    }

    // Non-streaming: parse JSON response
    clearTimeout(timeout)
    const json = await gatewayRes.json() as {
      choices?: Array<{ message?: { content?: string } }>
      id?: string
    }

    const content = json.choices?.[0]?.message?.content ?? ''
    const result: AgentChatResponseDto = {
      content,
      messageId: json.id ?? '',
    }
    return reply.send(result)
  })
}

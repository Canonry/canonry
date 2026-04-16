import type { FastifyInstance } from 'fastify'
import { agentUnavailable } from '@ainyc/canonry-contracts'

export interface AgentEventsRoutesOptions {
  agentGatewayPort: number
  agentGatewayToken?: string
  agentSessionKey?: string
}

export async function agentEventsRoutes(app: FastifyInstance, opts: AgentEventsRoutesOptions) {
  // GET /agent/events — SSE proxy to OpenClaw session history stream
  app.get('/agent/events', async (request, reply) => {
    if (!opts.agentGatewayToken) {
      throw agentUnavailable('Agent events require re-running "canonry agent setup" to generate gateway credentials')
    }

    const sessionKey = opts.agentSessionKey ?? 'agent:aero:main'
    const gatewayUrl = `http://localhost:${opts.agentGatewayPort}/sessions/${encodeURIComponent(sessionKey)}/history`

    const controller = new AbortController()

    // Abort upstream fetch when the client disconnects
    request.raw.on('close', () => {
      controller.abort()
    })

    let gatewayRes: Response
    try {
      gatewayRes = await fetch(gatewayUrl, {
        headers: {
          'Accept': 'text/event-stream',
          'Authorization': `Bearer ${opts.agentGatewayToken}`,
        },
        signal: controller.signal,
      })
    } catch {
      throw agentUnavailable()
    }

    if (!gatewayRes.ok) {
      throw agentUnavailable(`Agent gateway returned ${gatewayRes.status}`)
    }

    // Pipe SSE stream back to the client
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const reader = gatewayRes.body?.getReader()
    if (!reader) {
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
      reply.raw.end()
    }

    return reply
  })
}

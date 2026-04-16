import type { FastifyInstance } from 'fastify'
import type { AgentStatusDto } from '@ainyc/canonry-contracts'

export interface AgentStatusRoutesOptions {
  agentGatewayPort?: number
  agentGatewayToken?: string
  agentSessionKey?: string
}

export async function agentStatusRoutes(app: FastifyInstance, opts: AgentStatusRoutesOptions) {
  // GET /agent/status — always registered, returns clean state for all installs
  app.get('/agent/status', async (_request, reply) => {
    if (!opts.agentGatewayPort) {
      const result: AgentStatusDto = { configured: false, gatewayState: 'unknown' }
      return reply.send(result)
    }

    // Agent config exists but gateway token is missing — needs re-setup
    if (!opts.agentGatewayToken) {
      const result: AgentStatusDto = {
        configured: true,
        gatewayState: 'needs-setup',
        port: opts.agentGatewayPort,
        sessionKey: opts.agentSessionKey,
      }
      return reply.send(result)
    }

    // Probe the gateway with a short timeout
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)

    try {
      const res = await fetch(`http://localhost:${opts.agentGatewayPort}/health`, {
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const gatewayState = res.ok ? 'running' : 'stopped'
      const result: AgentStatusDto = {
        configured: true,
        gatewayState,
        port: opts.agentGatewayPort,
        sessionKey: opts.agentSessionKey,
      }
      return reply.send(result)
    } catch {
      clearTimeout(timeout)
      const result: AgentStatusDto = {
        configured: true,
        gatewayState: 'stopped',
        port: opts.agentGatewayPort,
        sessionKey: opts.agentSessionKey,
      }
      return reply.send(result)
    }
  })
}

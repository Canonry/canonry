import { forbidden, notImplemented, READ_ONLY_SCOPE, type McpProfileDto } from '@canonry/canonry-contracts'
import type { FastifyInstance } from 'fastify'
import { requireScope } from './auth.js'

export interface McpProfileRoutesOptions {
  oauthResourceUrl?: string
}

/** This read is part of the MCP authorization boundary, not general REST access. */
export async function mcpProfileRoutes(app: FastifyInstance, opts: McpProfileRoutesOptions) {
  app.get('/mcp/profile', async (request, reply): Promise<McpProfileDto> => {
    requireScope(request, READ_ONLY_SCOPE)
    const principal = request.principal
    const user = principal?.kind === 'user' ? principal : principal?.delegatedUser
    if (!user || principal?.projectId) {
      throw forbidden('MCP connection profiles require an instance-wide named account.')
    }
    if (!opts.oauthResourceUrl) {
      throw notImplemented('This instance has no configured MCP OAuth resource.')
    }
    reply.header('Cache-Control', 'no-store')
    return {
      userId: user.id,
      displayName: user.name,
      instance: {
        issuer: new URL(opts.oauthResourceUrl).origin,
        resource: opts.oauthResourceUrl,
      },
      scopes: [READ_ONLY_SCOPE],
    }
  })
}

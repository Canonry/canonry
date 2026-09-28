import type { FastifyRequest } from 'fastify'
import { forbidden } from '@ainyc/canonry-contracts'

/** Spending opt-in requires the full install authority, including delegated identity. */
export function canAdministerSentiment(request: FastifyRequest): boolean {
  const principal = request.principal
  if (!principal) return true // skipAuth test harness, matching existing route helpers
  if (principal.kind === 'user') return principal.role === 'admin'
  return !principal.projectId && principal.scopes.includes('*')
    && (!principal.delegatedUser || principal.delegatedUser.role === 'admin')
}
export function requireSentimentAdministrator(request: FastifyRequest): void {
  if (!canAdministerSentiment(request)) throw forbidden('Sentiment configuration and backfill require an install administrator.')
}

import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { apiKeys } from '@ainyc/canonry-db'
import { authRequired, authInvalid } from '@ainyc/canonry-contracts'

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

const SKIP_PATHS = ['/health']

function shouldSkipAuth(url: string): boolean {
  if (SKIP_PATHS.includes(url)) return true
  if (url.endsWith('/openapi.json')) return true
  return false
}

export async function authPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0]!
    if (shouldSkipAuth(url)) return

    const header = request.headers.authorization
    if (!header) {
      const err = authRequired()
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const parts = header.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      const err = authRequired()
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const token = parts[1]!
    const hash = hashKey(token)

    const key = app.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .get()

    if (!key || key.revokedAt) {
      const err = authInvalid()
      return reply.status(err.statusCode).send(err.toJSON())
    }

    // Update last_used_at
    app.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, key.id))
      .run()
  })
}

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
  if (url.includes('/google/callback')) return true
  if (url.endsWith('/session') || url.endsWith('/session/setup')) return true
  return false
}

export interface AuthPluginOptions {
  sessionCookieName?: string
  resolveSessionApiKeyId?: (sessionId: string) => string | null | Promise<string | null>
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}

  return header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, part) => {
      const eqIdx = part.indexOf('=')
      if (eqIdx <= 0) return cookies
      const name = part.slice(0, eqIdx).trim()
      const value = part.slice(eqIdx + 1).trim()
      if (!name) return cookies
      try {
        cookies[name] = decodeURIComponent(value)
      } catch {
        cookies[name] = value
      }
      return cookies
    }, {})
}

export async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions = {}) {
  app.addHook('onRequest', async (request) => {
    const url = request.url.split('?')[0]!
    if (shouldSkipAuth(url)) return

    const header = request.headers.authorization
    let key: typeof apiKeys.$inferSelect | undefined

    if (header) {
      const parts = header.split(' ')
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw authRequired()
      }

      const token = parts[1]!
      const hash = hashKey(token)

      key = app.db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hash))
        .get()

      if (!key || key.revokedAt) {
        throw authInvalid()
      }
    } else if (opts.resolveSessionApiKeyId && opts.sessionCookieName) {
      const sessionId = parseCookies(request.headers.cookie)[opts.sessionCookieName]
      if (sessionId) {
        const apiKeyId = await opts.resolveSessionApiKeyId(sessionId)
        if (apiKeyId) {
          key = app.db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, apiKeyId))
            .get()
        }
      }

      if (!key || key.revokedAt) {
        throw authRequired()
      }
    } else {
      throw authRequired()
    }

    app.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiKeys.id, key.id))
      .run()
  })
}

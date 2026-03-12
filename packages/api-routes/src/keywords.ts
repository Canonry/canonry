import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { keywords } from '@ainyc/canonry-db'
import { validationError, parseProviderName } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'

export interface KeywordRoutesOptions {
  onGenerateKeywords?: (provider: string, count: number, project: {
    domain: string; displayName?: string; country: string; language: string; existingKeywords: string[]
  }) => Promise<string[]>
}

export async function keywordRoutes(app: FastifyInstance, opts: KeywordRoutesOptions) {
  // GET /projects/:name/keywords
  app.get<{ Params: { name: string } }>('/projects/:name/keywords', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return
    const rows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.keyword, createdAt: r.createdAt })))
  })

  // PUT /projects/:name/keywords — replace all (declarative)
  app.put<{
    Params: { name: string }
    Body: { keywords: string[] }
  }>('/projects/:name/keywords', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const body = request.body
    if (!body || !Array.isArray(body.keywords)) {
      const err = validationError('Body must contain a "keywords" array')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()

    // Atomic replace: delete + insert in a single transaction
    app.db.transaction((tx) => {
      tx.delete(keywords).where(eq(keywords.projectId, project.id)).run()

      for (const kw of body.keywords) {
        tx.insert(keywords).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          keyword: kw,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'keywords.replaced',
        entityType: 'keyword',
        diff: { keywords: body.keywords },
      })
    })

    const rows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.keyword, createdAt: r.createdAt })))
  })

  // POST /projects/:name/keywords — append (skip duplicates)
  app.post<{
    Params: { name: string }
    Body: { keywords: string[] }
  }>('/projects/:name/keywords', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const body = request.body
    if (!body || !Array.isArray(body.keywords)) {
      const err = validationError('Body must contain a "keywords" array')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const now = new Date().toISOString()
    const existing = app.db
      .select()
      .from(keywords)
      .where(eq(keywords.projectId, project.id))
      .all()
    const existingSet = new Set(existing.map(k => k.keyword))

    const added: string[] = []
    for (const kw of body.keywords) {
      if (!existingSet.has(kw)) {
        app.db.insert(keywords).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          keyword: kw,
          createdAt: now,
        }).run()
        added.push(kw)
        existingSet.add(kw)
      }
    }

    if (added.length > 0) {
      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'keywords.appended',
        entityType: 'keyword',
        diff: { added },
      })
    }

    const rows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.keyword, createdAt: r.createdAt })))
  })
  // POST /projects/:name/keywords/generate — auto-generate keyword suggestions
  app.post<{
    Params: { name: string }
    Body: { provider: string; count?: number }
  }>('/projects/:name/keywords/generate', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const body = request.body
    if (!body?.provider || typeof body.provider !== 'string') {
      const err = validationError('Body must contain a "provider" string')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const provider = parseProviderName(body.provider)
    if (!provider) {
      const err = validationError(`Unknown provider "${body.provider}". Valid providers: gemini, openai, claude, local`)
      return reply.status(err.statusCode).send(err.toJSON())
    }
    if (body.count !== undefined && (typeof body.count !== 'number' || !Number.isFinite(body.count) || !Number.isInteger(body.count))) {
      const err = validationError('"count" must be an integer')
      return reply.status(err.statusCode).send(err.toJSON())
    }
    const count = Math.min(Math.max(body.count ?? 5, 1), 20)

    if (!opts.onGenerateKeywords) {
      return reply.status(501).send({ error: 'Key phrase generation is not supported in this deployment' })
    }

    const existingRows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    const existingKeywords = existingRows.map(r => r.keyword)

    try {
      const generated = await opts.onGenerateKeywords(provider, count, {
        domain: project.canonicalDomain,
        displayName: project.displayName,
        country: project.country,
        language: project.language,
        existingKeywords,
      })
      return reply.send({ keywords: generated, provider })
    } catch (err) {
      request.log.error({ err }, 'Key phrase generation failed')
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to generate key phrases',
      })
    }
  })
}

function resolveProjectSafe(app: FastifyInstance, name: string, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  try {
    return resolveProject(app.db, name)
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
      const err = e as { statusCode: number; toJSON(): unknown }
      reply.status(err.statusCode).send(err.toJSON())
      return null
    }
    throw e
  }
}

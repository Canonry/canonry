import type { FastifyInstance } from 'fastify'
import { validationError } from '@ainyc/canonry-contracts'
import type { BingConnectionStore } from '../bing.js'
import { requireCloudBootstrap, resolveProject, writeAuditLog } from '../helpers.js'
import { cloudImportBingKeyRequestSchema } from './schema.js'
import { emitConnectionEvent } from './emit-connection-event.js'

export interface CloudBingKeyRoutesOptions {
  /**
   * Existing Bing connection store — same singleton that `bingRoutes`
   * consumes. Required when this route is registered; the registrar in
   * `index.ts` skips registration when the store isn't wired.
   */
  bingConnectionStore: BingConnectionStore
}

export async function cloudBingKeyRoutes(app: FastifyInstance, opts: CloudBingKeyRoutesOptions) {
  // POST /cloud/bing/import-key — bypasses the legacy `/bing/connect`
  // verify-then-store flow. Bing Webmaster Tools is API-key based; the
  // control plane is trusted to ship a valid key.
  app.post('/cloud/bing/import-key', async (request, reply) => {
    requireCloudBootstrap(request)

    const parsed = cloudImportBingKeyRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid Bing key import request', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    const project = resolveProject(app.db, parsed.data.project_slug)
    const now = new Date().toISOString()
    const existing = opts.bingConnectionStore.getConnection(project.canonicalDomain)

    // Same admin-bypass rationale as `cloud/google/import-tokens`: the
    // cloud bridge owns this tenant's managed-credential surface and is
    // allowed to overwrite an existing connection regardless of owner.
    opts.bingConnectionStore.upsertConnection({
      domain: project.canonicalDomain,
      apiKey: parsed.data.api_key,
      siteUrl: parsed.data.site_url,
      createdByProjectId: existing?.createdByProjectId ?? project.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'cloud',
      action: 'cloud.bing.imported',
      entityType: 'bing_connection',
      entityId: project.canonicalDomain,
      diff: {
        domain: project.canonicalDomain,
        siteUrl: parsed.data.site_url,
      },
    })

    await emitConnectionEvent(app.db, {
      event: 'connection.created',
      project,
      payload: {
        connectionType: 'bing',
        propertyRef: parsed.data.site_url,
        scopes: [],
      },
    })

    return reply.status(200).send({
      imported: true,
      domain: project.canonicalDomain,
      site_url: parsed.data.site_url,
    })
  })
}

import type { FastifyInstance } from 'fastify'
import { validationError } from '@ainyc/canonry-contracts'
import type { GoogleConnectionStore } from '../google.js'
import { requireCloudBootstrap, resolveProject, writeAuditLog } from '../helpers.js'
import { cloudImportGoogleTokensRequestSchema } from './schema.js'
import { emitConnectionEvent } from './emit-connection-event.js'

export interface CloudGoogleTokensRoutesOptions {
  /**
   * Existing Google connection store — same singleton that
   * `googleRoutes` consumes. Reused so the cloud import path lands the
   * same row shape that the legacy OAuth callback would have written.
   * Required when this route is registered; the registrar in `index.ts`
   * skips registration when the store isn't wired (mirrors the legacy
   * `googleRoutes` posture).
   */
  googleConnectionStore: GoogleConnectionStore
}

export async function cloudGoogleTokensRoutes(app: FastifyInstance, opts: CloudGoogleTokensRoutesOptions) {
  // POST /cloud/google/import-tokens — bypasses the normal OAuth dance and
  // accepts pre-exchanged tokens from a trusted control plane.
  app.post('/cloud/google/import-tokens', async (request, reply) => {
    requireCloudBootstrap(request)

    const parsed = cloudImportGoogleTokensRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid Google token import request', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    const project = resolveProject(app.db, parsed.data.project_slug)
    const now = new Date().toISOString()
    const expiresAt = parsed.data.expiry

    const existing = opts.googleConnectionStore.getConnection(
      project.canonicalDomain,
      parsed.data.connection_type,
    )

    // The cloud bridge runs with admin scope and is the source of truth for
    // managed-OAuth tokens for this tenant — bypass the cross-project
    // takeover guard that protects the legacy connect route. There's still
    // one tenant per Canonry runtime per deployment-posture, so the worst
    // case is replacing one of this tenant's own project connections —
    // which is the intended behavior (re-importing tokens for a different
    // tracked project on the same canonical domain).
    opts.googleConnectionStore.upsertConnection({
      domain: project.canonicalDomain,
      connectionType: parsed.data.connection_type,
      propertyId: parsed.data.property_ref,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      tokenExpiresAt: expiresAt,
      scopes: parsed.data.scopes,
      createdByProjectId: existing?.createdByProjectId ?? project.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'cloud',
      action: 'cloud.google.imported',
      entityType: 'google_connection',
      entityId: parsed.data.connection_type,
      diff: {
        domain: project.canonicalDomain,
        connectionType: parsed.data.connection_type,
        propertyRef: parsed.data.property_ref,
        accountEmail: parsed.data.account_email,
        scopes: parsed.data.scopes,
      },
    })

    // Emit the cloud `connection.created` event so any subscriber (notably
    // the control plane registered at bootstrap) can mark the connection
    // surface as live. Fired AFTER the DB write so failures don't leave a
    // partial state.
    await emitConnectionEvent(app.db, {
      event: 'connection.created',
      project,
      payload: {
        connectionType: parsed.data.connection_type,
        propertyRef: parsed.data.property_ref,
        scopes: parsed.data.scopes,
      },
    })

    return reply.status(200).send({
      imported: true,
      domain: project.canonicalDomain,
      connection_type: parsed.data.connection_type,
      property_ref: parsed.data.property_ref,
    })
  })
}

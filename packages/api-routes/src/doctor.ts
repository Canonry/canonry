import type { FastifyInstance } from 'fastify'
import { ALL_CHECKS } from './doctor/registry.js'
import { runChecks } from './doctor/runner.js'
import type { DoctorContext } from './doctor/types.js'
import type { GoogleConnectionStore } from './google.js'
import type { Ga4CredentialStore } from './ga.js'
import type { ProviderSummaryEntry } from './settings.js'
import { resolveProject } from './helpers.js'

export interface DoctorRoutesOptions {
  googleConnectionStore?: GoogleConnectionStore
  ga4CredentialStore?: Ga4CredentialStore
  getGoogleAuthConfig?: () => { clientId?: string; clientSecret?: string }
  /** Used to derive the redirect URI displayed by the redirect-uri check. */
  publicUrl?: string
  /** API route prefix (default: '/api/v1') — used to construct the redirect URI. */
  routePrefix?: string
  providerSummary?: ProviderSummaryEntry[]
}

function parseCheckIds(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

function resolveRedirectUri(opts: DoctorRoutesOptions): string | undefined {
  if (!opts.publicUrl) return undefined
  const base = opts.publicUrl.replace(/\/$/, '')
  const prefix = opts.routePrefix ?? '/api/v1'
  return `${base}${prefix}/google/callback`
}

export async function doctorRoutes(app: FastifyInstance, opts: DoctorRoutesOptions) {
  const redirectUri = resolveRedirectUri(opts)

  // GET /doctor — global checks (config, providers, etc.)
  app.get<{ Querystring: { check?: string } }>('/doctor', async (request) => {
    const checkIds = parseCheckIds(request.query.check)
    const ctx: DoctorContext = {
      db: app.db,
      project: null,
      googleConnectionStore: opts.googleConnectionStore,
      ga4CredentialStore: opts.ga4CredentialStore,
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      redirectUri,
      providerSummary: opts.providerSummary,
    }
    return runChecks(ctx, ALL_CHECKS, { checkIds })
  })

  // GET /projects/:name/doctor — project-scoped checks (Google auth, GA, etc.)
  app.get<{
    Params: { name: string }
    Querystring: { check?: string }
  }>('/projects/:name/doctor', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const checkIds = parseCheckIds(request.query.check)
    const ctx: DoctorContext = {
      db: app.db,
      project: {
        id: project.id,
        name: project.name,
        canonicalDomain: project.canonicalDomain,
        displayName: project.displayName,
      },
      googleConnectionStore: opts.googleConnectionStore,
      ga4CredentialStore: opts.ga4CredentialStore,
      getGoogleAuthConfig: opts.getGoogleAuthConfig,
      redirectUri,
      providerSummary: opts.providerSummary,
    }
    return runChecks(ctx, ALL_CHECKS, { checkIds })
  })
}

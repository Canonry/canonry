/** Provider transport only. The agency outbox owns Discord approval and scheduling. */
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { auditLog, gbpLocations } from '@canonry/canonry-db'
import {
  AppError,
  forbidden,
  validationError,
  providerError,
  GBP_LIVE_READ_SCOPE,
  GBP_POSTS_WRITE_SCOPE,
  gbpAccountNameSchema,
  gbpLocationNameSchema,
  gbpLocalPostNameSchema,
  gbpLocalPostCreateSchema,
  gbpLocalPostAttemptSchema,
  type GbpLocalPostAttempt,
  type GbpLocalPostDto,
} from '@canonry/canonry-contracts'
import {
  createLocalPost,
  getLocalPost,
  listLocalPosts,
  listReviews,
  GbpApiError,
  GbpLocalPostResponseError,
} from '@canonry/canonry-integration-google-business-profile'
import { GoogleAuthError } from '@canonry/canonry-integration-google'
import {
  requireScope,
  requireAdminSession,
  requirePaidReadScope,
} from './auth.js'
import { hotelEditorialDestination } from './gbp-hotel-policy.js'
import { claimAuditLog, resolveProject } from './helpers.js'

export interface GbpLocalPostsOptions {
  token(domain: string): Promise<string>
}
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const READ_REASONS = new Set([
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'RATE_LIMIT_EXCEEDED', 'SERVICE_DISABLED',
  'API_DISABLED', 'CONSUMER_INVALID', 'IAM_PERMISSION_DENIED', 'ACCESS_DENIED',
  'UNAUTHENTICATED', 'NOT_FOUND', 'INVALID_ARGUMENT', 'QUOTA_EXCEEDED',
  'PERMISSION_DENIED', 'FAILED_PRECONDITION', 'INTERNAL', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED',
])
function localPostReadError(error: unknown, stage: 'token' | 'read', message: string) {
  let category = stage === 'token' ? 'token' : 'unclassified'
  let reason = 'UNCLASSIFIED'
  let upstreamStatus: number | undefined
  if (stage === 'token') {
    if (error instanceof GoogleAuthError) {
      reason = 'REFRESH_FAILED'
      // Only the controlled refresh prefix is inspected; never return its body.
      upstreamStatus = error.statusCode ?? Number(error.message.match(/^Token refresh failed \((\d{3})\):/u)?.[1])
    } else if (error instanceof AppError) {
      if (error.code === 'NOT_FOUND') reason = 'NOT_CONNECTED'
      if (error.code === 'VALIDATION_ERROR') reason = 'NOT_CONFIGURED'
    }
  } else if (error instanceof GbpApiError) {
    category = 'google_api'
    const body = error.body as { error?: { status?: unknown } } | null
    const code = body?.error?.status
    reason = error.reason !== null && READ_REASONS.has(error.reason) ? error.reason
      : typeof code === 'string' && READ_REASONS.has(code) ? code : reason
    upstreamStatus = error.status
  } else if (error instanceof GbpLocalPostResponseError) {
    category = 'response'
    reason = error.reason
  }
  return providerError(message, {
    category, reason,
    ...(typeof upstreamStatus === 'number' && Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599
      ? { upstreamStatus } : {}),
  })
}
function readGrant(request: FastifyRequest): void {
  requireAdminSession(request)
  requirePaidReadScope(
    request,
    [GBP_LIVE_READ_SCOPE, GBP_POSTS_WRITE_SCOPE],
    'This API key was not granted live Google Business Profile reads.',
  )
  // An explicit live-read grant, not ordinary stored-data read authority.
  requireScope(request, GBP_LIVE_READ_SCOPE)
}

export async function gbpLocalPostsRoutes(
  app: FastifyInstance,
  options: GbpLocalPostsOptions,
): Promise<void> {
  async function readPostResource<T>(domain: string, read: (token: string) => Promise<T>, message: string): Promise<T> {
    let token: string
    try { token = await options.token(domain) }
    catch (error) { throw localPostReadError(error, 'token', message) }
    try { return await read(token) }
    catch (error) { throw localPostReadError(error, 'read', message) }
  }
  function selected(projectId: string, account: unknown, location: unknown) {
    const a = gbpAccountNameSchema.safeParse(account)
    const l = gbpLocationNameSchema.safeParse(location)
    if (!a.success || !l.success)
      throw validationError(
        'Exact GBP account and location names are required.',
      )
    const row = app.db
      .select()
      .from(gbpLocations)
      .where(
        and(
          eq(gbpLocations.projectId, projectId),
          eq(gbpLocations.accountName, a.data),
          eq(gbpLocations.locationName, l.data),
          eq(gbpLocations.selected, true),
        ),
      )
      .get()
    if (!row)
      throw forbidden(
        'This account/location is not selected on the requested project.',
      )
    return row
  }
  app.get<{
    Params: { name: string }
    Querystring: {
      accountName?: string
      locationName?: string
      pageToken?: string
    }
  }>('/projects/:name/gbp/local-posts', async (request) => {
    readGrant(request)
    const project = resolveProject(app.db, request.params.name)
    const location = selected(
      project.id,
      request.query.accountName,
      request.query.locationName,
    )
    const page = request.query.pageToken
    if (
      page !== undefined &&
      (page.length > 2000 || /[\p{Cc}\p{Cf}]/u.test(page))
    )
      throw validationError('Invalid GBP page token.')
    return readPostResource(project.canonicalDomain,
      (token) => listLocalPosts(token, location.accountName, location.locationName, page),
      'Google Local Posts could not be read; coverage is unknown.')
  })
  app.get<{ Params: { name: string }; Querystring: { postName?: string } }>(
    '/projects/:name/gbp/local-post',
    async (request) => {
      readGrant(request)
      const project = resolveProject(app.db, request.params.name)
      const parsed = gbpLocalPostNameSchema.safeParse(request.query.postName)
      if (!parsed.success)
        throw validationError('An exact GBP post resource name is required.')
      const parts = parsed.data.split('/')
      selected(
        project.id,
        parts.slice(0, 2).join('/'),
        parts.slice(2, 4).join('/'),
      )
      return readPostResource(project.canonicalDomain,
        (token) => getLocalPost(token, parsed.data),
        'Google Local Post could not be verified; do not resubmit it.')
    },
  )
  app.get<{
    Params: { name: string }
    Querystring: { accountName?: string; locationName?: string }
  }>('/projects/:name/gbp/reviews/live', async (request) => {
    readGrant(request)
    const project = resolveProject(app.db, request.params.name)
    const location = selected(
      project.id,
      request.query.accountName,
      request.query.locationName,
    )
    try {
      const listing = await listReviews(
        await options.token(project.canonicalDomain),
        location.accountName,
        location.locationName,
        { maxPages: 20, strict: true },
      )
      const url = location.mapsUri
      const profileUrl =
        url && /^https:\/\/(?:www\.)?google\.com\/maps\//u.test(url)
          ? url
          : location.placeId
            ? `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(location.placeId)}`
            : null
      return {
        accountName: location.accountName,
        locationName: location.locationName,
        profileUrl,
        complete: true as const,
        checkedAt: new Date().toISOString(),
        reviews: listing.reviews.map(
          ({ replyComment: _reply, replyUpdateTime: _time, ...review }) =>
            review,
        ),
      }
    } catch {
      throw providerError(
        'Google reviews could not be read completely; keep the previous baseline.',
      )
    }
  })
  app.get<{
    Params: { name: string }
    Querystring: { attemptId?: string; packageId?: string }
  }>('/projects/:name/gbp/local-post-attempt', async (request) => {
    requireAdminSession(request)
    requireScope(request, GBP_LIVE_READ_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const { attemptId, packageId } = request.query
    if (
      !attemptId ||
      !/^[a-f0-9-]{36}$/u.test(attemptId) ||
      !packageId ||
      !/^[a-f0-9]{64}$/u.test(packageId)
    )
      throw validationError(
        'Exact attempt and package identities are required.',
      )
    const key = `gbp-post:${digest([project.id, attemptId])}`
    const claim = app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.id, key), eq(auditLog.projectId, project.id)))
      .get()
    if (!claim?.diff)
      throw validationError(
        'No saved GBP attempt is available; do not resubmit.',
      )
    const binding = JSON.parse(claim.diff) as { packageId: string }
    if (binding.packageId !== packageId)
      throw validationError('GBP attempt package mismatch.')
    const result = app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, `${key}:result`))
      .get()
    return result?.diff
      ? gbpLocalPostAttemptSchema.parse(JSON.parse(result.diff))
      : { attemptId, packageId, status: 'uncertain' as const, post: null }
  })
  app.post<{ Params: { name: string }; Body: unknown }>(
    '/projects/:name/gbp/local-posts',
    { config: { writeScope: GBP_POSTS_WRITE_SCOPE } },
    async (request): Promise<GbpLocalPostAttempt> => {
      requireAdminSession(request)
      requireScope(request, GBP_POSTS_WRITE_SCOPE)
      const project = resolveProject(app.db, request.params.name)
      const parsed = gbpLocalPostCreateSchema.safeParse(request.body)
      if (!parsed.success)
        throw validationError(
          'A bounded STANDARD article post and exact attempt/package binding are required.',
        )
      const body = parsed.data
      selected(project.id, body.accountName, body.locationName)
      // This first transport supports editorial articles only for every client.
      // Missing/localized category metadata must never bypass hotel restrictions.
      if (
        !(await hotelEditorialDestination(
          project.canonicalDomain,
          body.content.summary,
          body.content.callToAction.url,
        ))
      )
        throw forbidden(
          'Updates and their linked page must be editorial, without offers, deals or promotions. Unavailable checks do not authorize a post.',
        )
      const key = `gbp-post:${digest([project.id, body.attemptId])}`
      const payload = digest(body)
      const existing = app.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.id, key))
        .get()
      const readResult = (): GbpLocalPostAttempt => {
        const result = app.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.id, `${key}:result`))
          .get()
        return result?.diff
          ? gbpLocalPostAttemptSchema.parse(JSON.parse(result.diff))
          : {
              attemptId: body.attemptId,
              packageId: body.packageId,
              status: 'uncertain',
              post: null,
            }
      }
      // A claimed attempt answers only the request it was claimed for.
      const answerExisting = (
        claimed: typeof auditLog.$inferSelect,
      ): GbpLocalPostAttempt => {
        const binding = JSON.parse(claimed.diff ?? 'null') as {
          requestDigest?: unknown
        } | null
        if (
          claimed.projectId !== project.id ||
          binding?.requestDigest !== payload
        )
          throw validationError(
            'GBP attempt identity was already used with different content.',
          )
        return readResult()
      }
      if (existing) return answerExisting(existing)
      const token = await options.token(project.canonicalDomain)
      // Preflight and token refresh yield to selection/project edits. The claim
      // and provider call must use eligibility read after the final await.
      const currentProject = resolveProject(app.db, request.params.name)
      if (
        currentProject.id !== project.id ||
        currentProject.canonicalDomain !== project.canonicalDomain
      )
        throw forbidden('GBP project changed during preflight; prepare a new request.')
      selected(currentProject.id, body.accountName, body.locationName)
      const claim = claimAuditLog(app.db, key, {
        projectId: project.id,
        actor: 'api',
        action: 'gbp.local-post-claimed',
        entityType: 'gbp-local-post',
        entityId: body.attemptId,
        diff: {
          requestDigest: payload,
          packageId: body.packageId,
          accountName: body.accountName,
          locationName: body.locationName,
        },
      })
      if (!claim) {
        // Another request claimed this attempt during the awaits above.
        const winner = app.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.id, key))
          .get()
        if (!winner) return readResult()
        return answerExisting(winner)
      }
      let post: GbpLocalPostDto | null = null
      let status: GbpLocalPostAttempt['status'] = 'uncertain'
      try {
        post = await createLocalPost(
          token,
          body.accountName,
          body.locationName,
          body.content,
        )
        status = 'accepted'
      } catch (error) {
        if (
          error instanceof GbpApiError &&
          [400, 401, 403, 404, 422].includes(error.status)
        )
          status = 'rejected'
      }
      const result = {
        attemptId: body.attemptId,
        packageId: body.packageId,
        status,
        post,
      }
      // An interrupted claim is forever uncertain, never another provider POST.
      claimAuditLog(app.db, `${key}:result`, {
        projectId: project.id,
        actor: 'api',
        action: 'gbp.local-post-result',
        entityType: 'gbp-local-post',
        entityId: body.attemptId,
        diff: result,
      })
      return result
    },
  )
}

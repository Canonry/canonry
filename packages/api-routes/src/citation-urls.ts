import crypto from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { groupRunsByCreatedAt, pickGroupRepresentative, queries, querySnapshots, runs } from '@canonry/canonry-db'
import {
  DASHBOARD_READ_CAPABILITY,
  canonicalCitedUrl,
  categorizeSource,
  citedUrlHost,
  CITATION_URL_CATEGORY_HINT,
  CITATION_URLS_DEFAULT_LIMIT,
  CITATION_URLS_MAX_LIMIT,
  citationUrlSortSchema,
  hostMatchesDomain,
  isCitationStateMeasured,
  metricsWindowSchema,
  parseCitationUrlCategories,
  queryClassFilterSchema,
  readCitationState,
  RunKinds,
  RunStatuses,
  validationError,
  windowCutoff,
  type CitationUrlEntry,
  type CitationUrlsResponse,
  type SourceCategory,
} from '@canonry/canonry-contracts'
import { isProviderInfraDomain, measuredWhole } from './analytics.js'
import { planQueryClassesByRun } from './competitor-landscape.js'
import { notProbeRun, resolveProject, snapshotMentionObserver } from './helpers.js'
import { projectQueryClassifier } from './mention-share-inputs.js'
import { activeMeasurementPlan } from './measurement-overview.js'

const KNOWN_PARAMS = new Set(['window', 'domain', 'category', 'provider', 'queryClass', 'newInLatest', 'sort', 'limit', 'cursor'])

function optionalString(query: Record<string, unknown>, name: string): string | null {
  const value = query[name]
  if (value === undefined) return null
  if (typeof value !== 'string' || value.trim() === '') throw validationError(`"${name}" must be one non-empty value`)
  return value.trim()
}

function cursorDigest(basis: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 16)
}

function encodeCursor(basis: unknown, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset, check: cursorDigest([basis, offset]) })).toString('base64url')
}

function decodeCursor(raw: string, basis: unknown): number {
  try {
    const body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: unknown; offset?: unknown; check?: unknown }
    if (body.v === 1 && typeof body.offset === 'number' && Number.isInteger(body.offset) && body.offset >= 0
      && body.check === cursorDigest([basis, body.offset])) {
      return body.offset
    }
  } catch {
    // fall through to the refusal below
  }
  throw validationError('"cursor" belongs to a read with different filters. Pass the nextCursor of the previous page with the same filters.')
}

interface UrlAggregate {
  url: string
  domain: string
  category: SourceCategory
  label: string
  answers: number
  answersMentioned: number
  answersMentionUnchecked: number
  providers: Map<string, number>
  queries: Map<string, number>
  runIds: Set<string>
}

/**
 * Cited pages, one row per page, from the stored source lists of the sweeps in
 * scope. The same run selection as the sources read: completed or partial
 * sweeps, never probes, measured whole, inside the window. It answers which
 * threads, posts and articles engines cite, when each first appeared, and which
 * ones the latest sweep cited for the first time.
 */
export async function citationUrlRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>('/projects/:name/citations/urls', { config: { readCapability: DASHBOARD_READ_CAPABILITY } }, async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const query = request.query ?? {}
    for (const key of Object.keys(query)) {
      if (!KNOWN_PARAMS.has(key)) throw validationError(`Unknown query parameter "${key}"`)
    }

    const windowValue = optionalString(query, 'window') ?? 'all'
    const windowParsed = metricsWindowSchema.safeParse(windowValue)
    if (!windowParsed.success) throw validationError(`"window" must be one of: ${metricsWindowSchema.options.join(', ')}`)
    const window = windowParsed.data

    const domainParam = optionalString(query, 'domain')
    const domain = domainParam === null ? null : citedUrlHost(domainParam)
    if (domainParam !== null && !domain) throw validationError('"domain" must be a host such as reddit.com')

    const categoryParam = optionalString(query, 'category')
    const categories = categoryParam === null ? [] : parseCitationUrlCategories(categoryParam)
    if (!categories) throw validationError(`"category" must be ${CITATION_URL_CATEGORY_HINT}`)

    const provider = optionalString(query, 'provider')

    const queryClassParsed = queryClassFilterSchema.safeParse(optionalString(query, 'queryClass') ?? 'all')
    if (!queryClassParsed.success) throw validationError(`"queryClass" must be one of: ${queryClassFilterSchema.options.join(', ')}`)
    const queryClass = queryClassParsed.data

    const newInLatestParam = optionalString(query, 'newInLatest')
    if (newInLatestParam !== null && !['true', 'false', '1', '0'].includes(newInLatestParam)) {
      throw validationError('"newInLatest" must be true or false')
    }
    const newInLatest = newInLatestParam === 'true' || newInLatestParam === '1'

    const sortParsed = citationUrlSortSchema.safeParse(optionalString(query, 'sort') ?? 'answers')
    if (!sortParsed.success) throw validationError(`"sort" must be one of: ${citationUrlSortSchema.options.join(', ')}`)
    const sort = sortParsed.data

    const limitParam = optionalString(query, 'limit')
    const limit = limitParam === null ? CITATION_URLS_DEFAULT_LIMIT : Number(limitParam)
    if (!Number.isInteger(limit) || limit < 1 || limit > CITATION_URLS_MAX_LIMIT) {
      throw validationError(`"limit" must be an integer from 1 to ${CITATION_URLS_MAX_LIMIT}`)
    }

    const filters = { window, domain, categories, provider, queryClass, newInLatest, sort }
    const cursorParam = optionalString(query, 'cursor')
    const offset = cursorParam === null ? 0 : decodeCursor(cursorParam, filters)

    const cutoff = windowCutoff(window)
    const scopeRuns = app.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, project.id), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun()))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .all()
      .filter((run) => run.status === RunStatuses.completed || run.status === RunStatuses.partial)
      .filter((run) => measuredWhole(app.db, run))
      .filter((run) => !cutoff || run.createdAt >= cutoff)

    const empty: CitationUrlsResponse = {
      filters, latestRun: null, runCount: 0, answerTotal: 0, sweepsWithPages: 0,
      answersPagesNotCaptured: 0, answersPagesIncomplete: 0, unclassifiedAnswers: 0,
      total: 0, returned: 0, truncated: false, nextCursor: null, urls: [],
    }
    if (scopeRuns.length === 0) return empty

    // A sweep is a group of runs started together (a multi-location sweep is
    // several runs); newest first. Pages are counted per sweep, never per run.
    const sweepGroups = groupRunsByCreatedAt(scopeRuns)
    const latestGroup = sweepGroups[0] ?? []
    const latestRepresentative = pickGroupRepresentative(latestGroup) ?? scopeRuns[0]!
    const sweepOf = new Map<string, number>()
    sweepGroups.forEach((group, index) => {
      for (const run of group) sweepOf.set(run.id, index)
    })
    const runCreatedAt = new Map(scopeRuns.map((run) => [run.id, run.createdAt]))

    // Same class rule as the sources read: a published v2 plan classifies by
    // each run's frozen assignments; otherwise the brand classifier reads the
    // question text.
    const splitByClass = queryClass !== 'all'
    const planClassified = splitByClass && activeMeasurementPlan(app.db, project.id)?.plan.schemaVersion === 2
    const classifyQueryText = splitByClass && !planClassified ? projectQueryClassifier(project) : null
    if (splitByClass && !planClassified && !classifyQueryText) {
      throw validationError(`Query class "${queryClass}" needs a brand name or alias on this project. Add one, or omit queryClass.`)
    }
    const planClasses = planClassified ? planQueryClassesByRun(app.db, project.id, scopeRuns) : null

    const snapshots = app.db
      .select({
        runId: querySnapshots.runId,
        query: queries.query,
        queryText: querySnapshots.queryText,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        retrievalStatus: querySnapshots.retrievalStatus,
        citedDomains: querySnapshots.citedDomains,
        citedUrls: querySnapshots.citedUrls,
        measurementExecutionId: querySnapshots.measurementExecutionId,
        answerText: querySnapshots.answerText,
        captureStatus: querySnapshots.captureStatus,
        answerMentioned: querySnapshots.answerMentioned,
        mentionIdentity: querySnapshots.mentionIdentity,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(inArray(querySnapshots.runId, scopeRuns.map((run) => run.id)))
      .all()

    const mentionOf = snapshotMentionObserver(project)
    const byUrl = new Map<string, UrlAggregate>()
    let answerTotal = 0
    let unclassifiedAnswers = 0
    let answersPagesNotCaptured = 0
    let answersPagesIncomplete = 0
    const sweepsWithPages = new Set<number>()

    for (const snap of snapshots) {
      if (provider !== null && snap.provider !== provider) continue
      const questionText = snap.query ?? snap.queryText ?? ''
      if (splitByClass) {
        const classes = planClasses
          ? snap.measurementExecutionId ? planClasses.get(snap.runId)?.get(snap.measurementExecutionId) : undefined
          : questionText.trim() ? new Set([classifyQueryText!(questionText)]) : undefined
        if (!classes || classes.size === 0) {
          unclassifiedAnswers += 1
          continue
        }
        if (!classes.has(queryClass)) continue
      }
      if (!isCitationStateMeasured(readCitationState(snap))) continue
      // Stored before page capture existed: which pages it cited is unknown,
      // which is not the same as citing none. Counting it would make the
      // first sweep with captured pages read as all new.
      if (snap.captureStatus === null) {
        answersPagesNotCaptured += 1
        continue
      }
      if (snap.captureStatus !== 'complete') answersPagesIncomplete += 1
      answerTotal += 1
      sweepsWithPages.add(sweepOf.get(snap.runId)!)

      const pages = new Set<string>()
      for (const raw of snap.citedUrls ?? []) {
        if (typeof raw !== 'string') continue
        const url = canonicalCitedUrl(raw)
        if (!url || isProviderInfraDomain(url)) continue
        pages.add(url)
      }
      if (pages.size === 0) continue
      const named = mentionOf(snap)

      for (const url of pages) {
        const { category, label, domain: host } = categorizeSource(url)
        if (domain !== null && !hostMatchesDomain(citedUrlHost(url) ?? host, domain)) continue
        if (categories.length > 0 && !categories.includes(category)) continue
        let agg = byUrl.get(url)
        if (!agg) {
          agg = {
            url, domain: host, category, label,
            answers: 0, answersMentioned: 0, answersMentionUnchecked: 0,
            providers: new Map(), queries: new Map(), runIds: new Set(),
          }
          byUrl.set(url, agg)
        }
        agg.answers += 1
        if (named === true) agg.answersMentioned += 1
        if (named === null) agg.answersMentionUnchecked += 1
        agg.providers.set(snap.provider, (agg.providers.get(snap.provider) ?? 0) + 1)
        if (questionText) agg.queries.set(questionText, (agg.queries.get(questionText) ?? 0) + 1)
        agg.runIds.add(snap.runId)
      }
    }

    // Oldest first, ties by id, so first and last are stable.
    const runOrder = (a: string, b: string) => {
      const at = runCreatedAt.get(a)!
      const bt = runCreatedAt.get(b)!
      return at < bt ? -1 : at > bt ? 1 : a < b ? -1 : a > b ? 1 : 0
    }
    // Something to be new against: a sweep older than the latest that captured pages.
    const earlierSweepWithPages = [...sweepsWithPages].some((sweep) => sweep > 0)
    let entries: CitationUrlEntry[] = [...byUrl.values()].map((agg) => {
      const runIds = [...agg.runIds].sort(runOrder)
      const firstRunId = runIds[0]!
      const lastRunId = runIds[runIds.length - 1]!
      const sweeps = new Set(runIds.map((id) => sweepOf.get(id)!))
      const citedInLatest = sweeps.has(0)
      return {
        url: agg.url,
        domain: agg.domain,
        category: agg.category,
        label: agg.label,
        answers: agg.answers,
        answersMentioned: agg.answersMentioned,
        answersMentionUnchecked: agg.answersMentionUnchecked,
        providers: Object.fromEntries([...agg.providers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        queries: [...agg.queries]
          .map(([text, answers]) => ({ query: text, answers }))
          .sort((a, b) => b.answers - a.answers || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0)),
        sweeps: sweeps.size,
        firstSeenAt: runCreatedAt.get(firstRunId)!,
        firstRunId,
        lastSeenAt: runCreatedAt.get(lastRunId)!,
        lastRunId,
        newInLatest: citedInLatest && sweeps.size === 1 && earlierSweepWithPages,
        citedInLatest,
      }
    })
    if (newInLatest) entries = entries.filter((entry) => entry.newInLatest)

    const byUrlText = (a: CitationUrlEntry, b: CitationUrlEntry) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
    entries.sort(sort === 'newest'
      ? (a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : a.firstSeenAt > b.firstSeenAt ? -1 : 0) || b.answers - a.answers || byUrlText(a, b)
      : (a, b) => b.answers - a.answers || (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0) || byUrlText(a, b))

    const page = entries.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    return {
      filters,
      latestRun: { id: latestRepresentative.id, createdAt: latestRepresentative.createdAt },
      runCount: sweepGroups.length,
      answerTotal,
      sweepsWithPages: sweepsWithPages.size,
      answersPagesNotCaptured,
      answersPagesIncomplete,
      unclassifiedAnswers,
      total: entries.length,
      returned: page.length,
      truncated: nextOffset < entries.length,
      nextCursor: nextOffset < entries.length ? encodeCursor(filters, nextOffset) : null,
      urls: page,
    } satisfies CitationUrlsResponse
  })
}

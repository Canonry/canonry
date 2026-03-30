import { runAeoAudit } from '@ainyc/aeo-audit'
import type {
  GroundingSource,
  SnapshotAccuracy,
  SnapshotAuditDto,
  SnapshotProfileDto,
  SnapshotProviderResultDto,
  SnapshotQueryResultDto,
  SnapshotReportDto,
  SnapshotRequestDto,
} from '@ainyc/canonry-contracts'
import type { ProviderName } from '@ainyc/canonry-contracts'
import { fetchSiteText } from './site-fetch.js'
import type { RegisteredProvider, ProviderRegistry } from './provider-registry.js'
import { createLogger } from './logger.js'
import { formatAuditFactorScore } from './snapshot-format.js'

const log = createLogger('Snapshot')

const ANALYSIS_PROVIDER_PRIORITY = ['openai', 'claude', 'gemini', 'perplexity', 'local'] as const
const SNAPSHOT_QUERY_COUNT = 6
class ProviderExecutionGate {
  private readonly window: number[] = []
  private readonly waiters: Array<() => void> = []
  private rateLimitChain = Promise.resolve()
  private inFlight = 0

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxPerMinute: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      await this.waitForRateLimit()
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < Math.max(1, this.maxConcurrency)) {
      this.inFlight++
      return
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
    this.inFlight++
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    const next = this.waiters.shift()
    next?.()
  }

  private async waitForRateLimit(): Promise<void> {
    let releaseChain: (() => void) | undefined
    const previousChain = this.rateLimitChain
    this.rateLimitChain = new Promise<void>((resolve) => {
      releaseChain = resolve
    })

    await previousChain
    try {
      const now = Date.now()
      const windowStart = now - 60_000
      while (this.window.length > 0 && this.window[0]! < windowStart) {
        this.window.shift()
      }

      if (this.window.length >= this.maxPerMinute) {
        const oldestInWindow = this.window[0]!
        const waitMs = oldestInWindow + 60_000 - now + 50
        await new Promise(resolve => setTimeout(resolve, waitMs))
        const nowAfterWait = Date.now()
        const newWindowStart = nowAfterWait - 60_000
        while (this.window.length > 0 && this.window[0]! < newWindowStart) {
          this.window.shift()
        }
      }

      this.window.push(Date.now())
    } finally {
      releaseChain?.()
    }
  }
}

type GeneratedSnapshotProfile = SnapshotProfileDto & {
  phrases: string[]
}

type ResponseAssessment = {
  phrase: string
  provider: string
  mentioned?: boolean
  describedAccurately?: SnapshotAccuracy
  accuracyNotes?: string | null
  incorrectClaims?: string[]
  recommendedCompetitors?: string[]
}

type BatchAssessment = {
  assessments: ResponseAssessment[]
  whatThisMeans: string[]
  recommendedActions: string[]
}

type AeoAuditReport = Awaited<ReturnType<typeof runAeoAudit>>
type AeoAuditFactor = AeoAuditReport['factors'][number]

export class SnapshotService {
  constructor(private readonly registry: ProviderRegistry) {}

  async createReport(input: SnapshotRequestDto): Promise<SnapshotReportDto> {
    const companyName = input.companyName.trim()
    const domain = normalizeDomain(input.domain)
    const manualPhrases = normalizeStringList(input.phrases ?? [])
    const manualCompetitors = normalizeStringList(input.competitors ?? [])
    const providers = this.registry.getAll()
    if (providers.length === 0) {
      throw new Error('No providers configured. Add at least one provider API key before running canonry snapshot.')
    }

    const analysisProvider = pickAnalysisProvider(this.registry.getApiProviders())
    const homepageUrl = `https://${extractHostname(domain)}`

    const [siteText, audit] = await Promise.all([
      fetchSiteText(domain),
      this.runAudit(homepageUrl),
    ])

    if (manualPhrases.length === 0 && !siteText) {
      throw new Error(
        `Could not analyze https://${extractHostname(domain)}. ` +
        'Try again with a reachable homepage or pass manual category queries via --phrases.',
      )
    }

    const profile = await this.buildProfile({
      companyName,
      domain,
      siteText,
      audit,
      manualPhrases,
      analysisProvider,
    })

    const queryResults = await this.runSnapshotQueries({
      companyName,
      domain,
      phrases: profile.phrases,
      providers,
      manualCompetitors,
    })

    const batchAssessment = await this.analyzeResponses({
      companyName,
      domain,
      profile,
      audit,
      queryResults,
      manualCompetitors,
      analysisProvider,
    })

    const enrichedResults = applyBatchAssessment(queryResults, batchAssessment)
    const summary = buildSnapshotSummary(companyName, profile.phrases, providers, enrichedResults, audit, batchAssessment)
    const reportCompetitors = uniqueStrings([
      ...manualCompetitors,
      ...summary.topCompetitors.map(entry => entry.name),
    ])

    return {
      companyName,
      domain,
      homepageUrl,
      generatedAt: new Date().toISOString(),
      phrases: profile.phrases,
      competitors: reportCompetitors,
      profile: {
        industry: profile.industry,
        summary: profile.summary,
        services: profile.services,
        categoryTerms: profile.categoryTerms,
      },
      audit,
      queryResults: enrichedResults,
      summary,
    }
  }

  private async runAudit(homepageUrl: string): Promise<SnapshotAuditDto> {
    try {
      const report = await runAeoAudit(homepageUrl)
      return mapAuditReport(report)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('audit.failed', { homepageUrl, error: message })
      return {
        url: homepageUrl,
        finalUrl: homepageUrl,
        auditedAt: new Date().toISOString(),
        overallScore: 0,
        overallGrade: 'N/A',
        summary: `Technical audit unavailable: ${message}`,
        factors: [],
      }
    }
  }

  private async buildProfile(ctx: {
    companyName: string
    domain: string
    siteText: string
    audit: SnapshotAuditDto
    manualPhrases: string[]
    analysisProvider?: RegisteredProvider
  }): Promise<GeneratedSnapshotProfile> {
    if (ctx.analysisProvider && ctx.siteText) {
      const prompt = buildProfilePrompt(ctx)
      try {
        const raw = await ctx.analysisProvider.adapter.generateText(prompt, ctx.analysisProvider.config)
        const parsed = parseJsonObject<{
          industry?: string
          summary?: string
          services?: string[]
          categoryTerms?: string[]
          phrases?: string[]
        }>(raw)
        const parsedPhrases = ctx.manualPhrases.length > 0
          ? ctx.manualPhrases
          : normalizeStringList(parsed.phrases ?? []).slice(0, SNAPSHOT_QUERY_COUNT)

        if (ctx.manualPhrases.length === 0 && parsedPhrases.length === 0) {
          throw new Error('no phrases returned')
        }

        return {
          industry: parsed.industry?.trim() || 'Unknown',
          summary: parsed.summary?.trim() || ctx.audit.summary,
          services: uniqueStrings(parsed.services ?? []).slice(0, 6),
          categoryTerms: uniqueStrings(parsed.categoryTerms ?? []).slice(0, 8),
          phrases: parsedPhrases,
        }
      } catch (err) {
        log.warn('profile.generation-failed', {
          domain: ctx.domain,
          provider: ctx.analysisProvider.adapter.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (ctx.manualPhrases.length === 0) {
      throw new Error(
        'Automatic category-query generation requires a configured API provider. ' +
        'Add OpenAI, Claude, Gemini, Perplexity, or Local, or pass --phrases manually.',
      )
    }

    return {
      industry: 'Unknown',
      summary: ctx.audit.summary,
      services: [],
      categoryTerms: [],
      phrases: ctx.manualPhrases,
    }
  }

  private async runSnapshotQueries(ctx: {
    companyName: string
    domain: string
    phrases: string[]
    providers: RegisteredProvider[]
    manualCompetitors: string[]
  }): Promise<SnapshotQueryResultDto[]> {
    const gates = new Map<ProviderName, ProviderExecutionGate>()
    for (const provider of ctx.providers) {
      gates.set(
        provider.adapter.name,
        new ProviderExecutionGate(
          provider.config.quotaPolicy.maxConcurrency,
          provider.config.quotaPolicy.maxRequestsPerMinute,
        ),
      )
    }

    const competitorDomains = ctx.manualCompetitors.filter(isDomainLike)

    return Promise.all(ctx.phrases.map(async (phrase) => ({
      phrase,
      providerResults: await Promise.all(ctx.providers.map(async (provider) => {
        const gate = gates.get(provider.adapter.name)!
        return gate.run(async () => {
          try {
            const raw = await provider.adapter.executeTrackedQuery(
              {
                keyword: phrase,
                canonicalDomains: [ctx.domain],
                competitorDomains,
              },
              provider.config,
            )
            const normalized = provider.adapter.normalizeResult(raw)
            const preliminaryCompetitors = extractCompetitorsFromResponse({
              answerText: normalized.answerText,
              citedDomains: normalized.citedDomains,
              manualCompetitors: ctx.manualCompetitors,
              targetDomain: ctx.domain,
            })

            return {
              provider: provider.adapter.name,
              displayName: provider.adapter.displayName,
              model: raw.model,
              mentioned: mentionsTargetCompany(normalized.answerText, ctx.companyName, ctx.domain),
              cited: citesTargetDomain(normalized.citedDomains, normalized.groundingSources, ctx.domain),
              describedAccurately: 'unknown' as const,
              accuracyNotes: null,
              incorrectClaims: [],
              recommendedCompetitors: preliminaryCompetitors,
              citedDomains: uniqueStrings(normalized.citedDomains),
              groundingSources: normalized.groundingSources,
              searchQueries: uniqueStrings(normalized.searchQueries),
              answerText: normalized.answerText,
              error: null,
            } satisfies SnapshotProviderResultDto
          } catch (err) {
            return {
              provider: provider.adapter.name,
              displayName: provider.adapter.displayName,
              model: provider.config.model ?? provider.adapter.modelRegistry.defaultModel,
              mentioned: false,
              cited: false,
              describedAccurately: 'unknown' as const,
              accuracyNotes: null,
              incorrectClaims: [],
              recommendedCompetitors: [],
              citedDomains: [],
              groundingSources: [],
              searchQueries: [],
              answerText: '',
              error: err instanceof Error ? err.message : String(err),
            } satisfies SnapshotProviderResultDto
          }
        })
      })),
    })))
  }

  private async analyzeResponses(ctx: {
    companyName: string
    domain: string
    profile: GeneratedSnapshotProfile
    audit: SnapshotAuditDto
    queryResults: SnapshotQueryResultDto[]
    manualCompetitors: string[]
    analysisProvider?: RegisteredProvider
  }): Promise<BatchAssessment> {
    if (!ctx.analysisProvider) {
      return buildFallbackBatchAssessment(ctx.companyName, ctx.audit)
    }

    const responses = ctx.queryResults.flatMap(query =>
      query.providerResults
        .filter(result => !result.error)
        .map(result => ({
          phrase: query.phrase,
          provider: result.provider,
          displayName: result.displayName,
          heuristicMentioned: result.mentioned,
          heuristicCited: result.cited,
          heuristicCompetitors: result.recommendedCompetitors,
          citedDomains: result.citedDomains,
          groundingSources: result.groundingSources.map(source => source.uri),
          answerText: clipText(result.answerText, 2000),
        })),
    )

    if (responses.length === 0) {
      return buildFallbackBatchAssessment(ctx.companyName, ctx.audit)
    }

    try {
      const prompt = buildBatchAnalysisPrompt({
        companyName: ctx.companyName,
        domain: ctx.domain,
        profile: ctx.profile,
        audit: ctx.audit,
        responses,
        manualCompetitors: ctx.manualCompetitors,
      })
      const raw = await ctx.analysisProvider.adapter.generateText(prompt, ctx.analysisProvider.config)
      const parsed = parseJsonObject<{
        assessments?: Array<{
          phrase?: string
          provider?: string
          mentioned?: boolean
          describedAccurately?: SnapshotAccuracy
          accuracyNotes?: string | null
          incorrectClaims?: string[]
          recommendedCompetitors?: string[]
        }>
        whatThisMeans?: string[]
        recommendedActions?: string[]
      }>(raw)

      return {
        assessments: (parsed.assessments ?? [])
          .filter(assessment => assessment.phrase && assessment.provider)
          .map(assessment => {
            const hasReviewedCompetitors = assessment.recommendedCompetitors !== undefined
            return {
              phrase: assessment.phrase!,
              provider: assessment.provider!,
              mentioned: assessment.mentioned,
              describedAccurately: assessment.describedAccurately,
              accuracyNotes: assessment.accuracyNotes ?? null,
              incorrectClaims: uniqueStrings(assessment.incorrectClaims ?? []).slice(0, 5),
              ...(hasReviewedCompetitors
                ? {
                    recommendedCompetitors: uniqueStrings(assessment.recommendedCompetitors ?? []).slice(0, 10),
                  }
                : {}),
            }
          }),
        whatThisMeans: uniqueStrings(parsed.whatThisMeans ?? []).slice(0, 4),
        recommendedActions: uniqueStrings(parsed.recommendedActions ?? []).slice(0, 4),
      }
    } catch (err) {
      log.warn('response.analysis-failed', {
        provider: ctx.analysisProvider.adapter.name,
        error: err instanceof Error ? err.message : String(err),
      })
      return buildFallbackBatchAssessment(ctx.companyName, ctx.audit)
    }
  }
}

function pickAnalysisProvider(providers: RegisteredProvider[]): RegisteredProvider | undefined {
  return [...providers].sort((a, b) => {
    const aIndex = ANALYSIS_PROVIDER_PRIORITY.indexOf(a.adapter.name as typeof ANALYSIS_PROVIDER_PRIORITY[number])
    const bIndex = ANALYSIS_PROVIDER_PRIORITY.indexOf(b.adapter.name as typeof ANALYSIS_PROVIDER_PRIORITY[number])
    return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) - (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex)
  })[0]
}

function buildProfilePrompt(ctx: {
  companyName: string
  domain: string
  siteText: string
  audit: SnapshotAuditDto
  manualPhrases: string[]
  analysisProvider?: RegisteredProvider
}): string {
  const instructions = [
    'You are an AEO and SEO expert building a sales snapshot for an uninformed corporate prospect.',
    'Use ONLY the homepage text below. Do not browse or invent facts.',
    'Infer the company category, summarize what it sells, and generate non-branded category queries buyers would ask an AI assistant.',
    'Never produce brand queries like "what does Acme do?"',
    `Return strict JSON with keys: industry, summary, services, categoryTerms, phrases.`,
    `phrases must contain exactly ${SNAPSHOT_QUERY_COUNT} buyer-style category/recommendation queries unless manual phrases are provided.`,
  ]

  if (ctx.manualPhrases.length > 0) {
    instructions.push('Manual phrases were already supplied. Echo them back unchanged in the "phrases" array.')
  }

  return [
    ...instructions,
    '',
    `Company: ${ctx.companyName}`,
    `Domain: ${ctx.domain}`,
    `Existing audit summary: ${ctx.audit.summary}`,
    '',
    'Homepage text:',
    ctx.siteText,
  ].join('\n')
}

function buildBatchAnalysisPrompt(ctx: {
  companyName: string
  domain: string
  profile: GeneratedSnapshotProfile
  audit: SnapshotAuditDto
  responses: Array<{
    phrase: string
    provider: string
    displayName: string
    heuristicMentioned: boolean
    heuristicCited: boolean
    heuristicCompetitors: string[]
    citedDomains: string[]
    groundingSources: string[]
    answerText: string
  }>
  manualCompetitors: string[]
}): string {
  return [
    'You are reviewing AI answer-engine responses for a sales-facing AEO snapshot report.',
    'Use ONLY the provided facts and responses. Do not invent companies or claims.',
    'Return strict JSON with keys: assessments, whatThisMeans, recommendedActions.',
    'Each assessment must include: phrase, provider, mentioned, describedAccurately, accuracyNotes, incorrectClaims, recommendedCompetitors.',
    'describedAccurately must be one of: yes, no, unknown, not-mentioned.',
    '',
    'CRITICAL — recommendedCompetitors extraction:',
    'For each response, extract EVERY specific company/brand/product name that the AI recommended or listed as an alternative.',
    'Include the company name exactly as it appears in the response (e.g. "Accenture", "Deloitte", "C3.ai").',
    'Do NOT include generic terms like "consulting firms" or directories like "G2" or "Clutch".',
    'Do NOT include the target company itself.',
    'This is the most important field — it shows the prospect who AI recommends INSTEAD of them.',
    '',
    `Target company: ${ctx.companyName}`,
    `Target domain: ${ctx.domain}`,
    `Industry: ${ctx.profile.industry}`,
    `Summary: ${ctx.profile.summary}`,
    `Services: ${ctx.profile.services.join(', ') || 'unknown'}`,
    `Category terms: ${ctx.profile.categoryTerms.join(', ') || 'unknown'}`,
    `Manual competitor hints: ${ctx.manualCompetitors.join(', ') || 'none'}`,
    `Technical audit: ${ctx.audit.overallScore}/100 (${ctx.audit.overallGrade}) — ${ctx.audit.summary}`,
    '',
    'Responses JSON:',
    JSON.stringify(ctx.responses, null, 2),
  ].join('\n')
}

function buildFallbackBatchAssessment(companyName: string, audit: SnapshotAuditDto): BatchAssessment {
  return {
    assessments: [],
    whatThisMeans: [
      `${companyName} needs category-level visibility, not just branded comprehension.`,
      `The technical baseline is ${audit.overallScore}/100 (${audit.overallGrade}), so weak site signals may be making AI systems prefer better-structured alternatives.`,
    ],
    recommendedActions: buildFallbackRecommendedActions(audit),
  }
}

function applyBatchAssessment(
  queryResults: SnapshotQueryResultDto[],
  batchAssessment: BatchAssessment,
): SnapshotQueryResultDto[] {
  const assessmentMap = new Map<string, ResponseAssessment>()
  for (const assessment of batchAssessment.assessments) {
    assessmentMap.set(`${assessment.phrase}::${assessment.provider}`, assessment)
  }

  return queryResults.map(query => ({
    phrase: query.phrase,
    providerResults: query.providerResults.map(result => {
      const assessment = assessmentMap.get(`${query.phrase}::${result.provider}`)
      if (!assessment) {
        return {
          ...result,
          describedAccurately: result.mentioned ? 'unknown' : 'not-mentioned',
        }
      }

      const reviewedCompetitors = assessment.recommendedCompetitors
      const recommendedCompetitors = reviewedCompetitors !== undefined
        ? uniqueStrings(reviewedCompetitors)
        : result.recommendedCompetitors

      return {
        ...result,
        mentioned: result.mentioned || assessment.mentioned === true,
        describedAccurately: assessment.describedAccurately
          ?? (result.mentioned ? 'unknown' : 'not-mentioned'),
        accuracyNotes: assessment.accuracyNotes ?? result.accuracyNotes ?? null,
        incorrectClaims: uniqueStrings([
          ...result.incorrectClaims,
          ...(assessment.incorrectClaims ?? []),
        ]),
        recommendedCompetitors,
      }
    }),
  }))
}

function buildSnapshotSummary(
  companyName: string,
  phrases: string[],
  providers: RegisteredProvider[],
  queryResults: SnapshotQueryResultDto[],
  audit: SnapshotAuditDto,
  batchAssessment: BatchAssessment,
) {
  const allResults = queryResults.flatMap(query => query.providerResults)
  const successfulResults = allResults.filter(result => !result.error)
  const failedComparisons = allResults.length - successfulResults.length
  const mentionCount = successfulResults.filter(result => result.mentioned).length
  const citationCount = successfulResults.filter(result => result.cited).length
  const totalComparisons = successfulResults.length
  const competitorCounts = new Map<string, number>()

  for (const result of successfulResults) {
    for (const competitor of result.recommendedCompetitors) {
      competitorCounts.set(competitor, (competitorCounts.get(competitor) ?? 0) + 1)
    }
  }

  const topCompetitors = [...competitorCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }))

  const defaultMeaning = totalComparisons > 0
    ? `${companyName} was mentioned in ${mentionCount}/${totalComparisons} successful provider-query response${totalComparisons === 1 ? '' : 's'} across ${phrases.length} category queries.`
    : `No successful provider responses were returned across ${phrases.length} category queries.`
  const failureNote = failedComparisons > 0
    ? [
        `${failedComparisons} provider response${failedComparisons === 1 ? '' : 's'} failed and ${failedComparisons === 1 ? 'was' : 'were'} excluded from visibility totals.`,
      ]
    : []
  const whatThisMeans = batchAssessment.whatThisMeans.length > 0
    ? batchAssessment.whatThisMeans
    : [
        defaultMeaning,
      ]
  const combinedWhatThisMeans = uniqueStrings([...whatThisMeans, ...failureNote]).slice(0, 5)

  const recommendedActions = batchAssessment.recommendedActions.length > 0
    ? batchAssessment.recommendedActions
    : buildFallbackRecommendedActions(audit)

  return {
    totalQueries: phrases.length,
    totalProviders: providers.length,
    totalComparisons,
    mentionCount,
    citationCount,
    topCompetitors,
    visibilityGap: buildVisibilityGap(
      companyName,
      phrases.length,
      providers.length,
      totalComparisons,
      mentionCount,
      citationCount,
      failedComparisons,
    ),
    whatThisMeans: combinedWhatThisMeans,
    recommendedActions,
  }
}

function buildVisibilityGap(
  companyName: string,
  queryCount: number,
  providerCount: number,
  totalComparisons: number,
  mentionCount: number,
  citationCount: number,
  failedComparisons: number,
): string {
  const successfulLabel = `${totalComparisons} successful provider response${totalComparisons === 1 ? '' : 's'}`
  const failureSuffix = failedComparisons > 0
    ? ` ${failedComparisons} provider response${failedComparisons === 1 ? '' : 's'} failed.`
    : ''
  if (totalComparisons === 0) {
    return `No providers returned successful answers across ${queryCount} category queries and ${providerCount} providers.${failureSuffix}`.trim()
  }
  if (mentionCount === 0) {
    return `${companyName} was not mentioned in any of the ${successfulLabel} across ${queryCount} category queries and ${providerCount} providers.${failureSuffix}`.trim()
  }
  if (citationCount === 0) {
    return `${companyName} was mentioned in ${mentionCount}/${totalComparisons} successful provider response${totalComparisons === 1 ? '' : 's'}, but never linked or cited directly.${failureSuffix}`.trim()
  }
  return `${companyName} was mentioned in ${mentionCount}/${totalComparisons} successful provider response${totalComparisons === 1 ? '' : 's'} and cited in ${citationCount}/${totalComparisons}.${failureSuffix}`.trim()
}

function buildFallbackRecommendedActions(audit: SnapshotAuditDto): string[] {
  const weakestFactors = [...audit.factors]
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(factor => `Improve ${factor.name.toLowerCase()}: ${formatAuditFactorScore(factor)}`)

  const defaults = [
    'Publish category pages that explicitly describe the services AI should recommend you for.',
    'Add machine-readable trust signals such as schema, FAQs, and llms.txt support.',
    'Build comparison and proof content that makes the category fit unmistakable.',
  ]

  return uniqueStrings([...weakestFactors, ...defaults]).slice(0, 4)
}

function mentionsTargetCompany(answerText: string, companyName: string, domain: string): boolean {
  const haystack = normalizeText(answerText)
  if (!haystack) return false

  const fullName = normalizeText(companyName)
  if (fullName && haystack.includes(fullName)) {
    return true
  }

  const targetTokens = uniqueStrings([
    ...extractDistinctiveTokens(companyName),
    ...extractDistinctiveTokens(extractHostname(domain).split('.')[0] ?? ''),
  ])

  if (targetTokens.length === 0) return false
  let matches = 0
  for (const token of targetTokens) {
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(answerText)) {
      matches++
    }
  }

  return matches >= Math.min(2, targetTokens.length) || matches >= 1 && targetTokens.length === 1
}

function citesTargetDomain(citedDomains: string[], groundingSources: GroundingSource[], targetDomain: string): boolean {
  const normalizedTarget = extractHostname(targetDomain)
  for (const domain of citedDomains) {
    if (domainMatches(domain, normalizedTarget)) {
      return true
    }
  }
  for (const source of groundingSources) {
    if (source.uri && source.uri.toLowerCase().includes(normalizedTarget.toLowerCase())) {
      return true
    }
    if (source.title && source.title.toLowerCase().includes(normalizedTarget.toLowerCase())) {
      return true
    }
  }
  return false
}

function extractCompetitorsFromResponse(ctx: {
  answerText: string
  citedDomains: string[]
  manualCompetitors: string[]
  targetDomain: string
}): string[] {
  const competitors = new Set<string>()
  const lowerAnswer = ctx.answerText.toLowerCase()
  const targetDomain = extractHostname(ctx.targetDomain)

  for (const hint of ctx.manualCompetitors) {
    if (isDomainLike(hint)) {
      const normalizedHint = normalizeDomain(hint)
      if (domainMatches(normalizedHint, targetDomain)) continue
      if (
        ctx.citedDomains.some(domain => domainMatches(domain, normalizedHint))
        || lowerAnswer.includes(normalizedHint.toLowerCase())
      ) {
        competitors.add(normalizedHint)
      }
      continue
    }
    if (hint.length >= 3 && lowerAnswer.includes(hint.toLowerCase())) {
      competitors.add(hint)
    }
  }

  return [...competitors].slice(0, 6)
}

function mapAuditReport(report: AeoAuditReport): SnapshotAuditDto {
  return {
    url: report.url,
    finalUrl: report.finalUrl,
    auditedAt: report.auditedAt,
    overallScore: report.overallScore,
    overallGrade: report.overallGrade,
    summary: report.summary,
    factors: report.factors.map(mapAuditFactor),
  }
}

function mapAuditFactor(factor: AeoAuditFactor) {
  return {
    id: factor.id,
    name: factor.name,
    weight: factor.weight,
    score: factor.score,
    grade: factor.grade,
    status: factor.status,
    findings: factor.findings.map(finding => ({
      type: finding.type,
      message: finding.message,
    })),
    recommendations: factor.recommendations,
  }
}

function parseJsonObject<T>(input: string): T {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? input
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  const json = start >= 0 && end >= start ? candidate.slice(start, end + 1) : candidate
  return JSON.parse(json) as T
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function normalizeStringList(values: string[]): string[] {
  const items = values.flatMap(value => value.split(','))
  return uniqueStrings(
    items
      .map(value => value.trim())
      .filter(Boolean),
  )
}

function uniqueStrings(values: string[] | unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  )]
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`)
    return url.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase()
  }
}

function extractHostname(value: string): string {
  return normalizeDomain(value)
}

function domainMatches(candidate: string, target: string): boolean {
  const normalizedCandidate = normalizeDomain(candidate)
  const normalizedTarget = normalizeDomain(target)
  return normalizedCandidate === normalizedTarget || normalizedCandidate.endsWith(`.${normalizedTarget}`)
}

function extractDistinctiveTokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter(token => token.length >= 4)
    .filter(token => !['llc', 'inc', 'corp', 'company', 'group', 'services', 'solutions', 'agency'].includes(token))
}

function isDomainLike(value: string): boolean {
  const normalized = normalizeDomain(value)
  return normalized.includes('.') && !normalized.includes(' ')
}

function clipText(value: string, length: number): string {
  if (value.length <= length) return value
  return `${value.slice(0, length - 3)}...`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

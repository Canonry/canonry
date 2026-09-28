import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt } from 'drizzle-orm'
import {
  backoffDelayMs, canonicalSentimentJson, sentimentClassifierInputSchema, sentimentClassifierOutputSchema,
  sentimentSelectionSchema, type SentimentClassifier, type SentimentClassifierInput, type SentimentClassifierOutput, type SentimentOutcome,
} from '@ainyc/canonry-contracts'
import { SentimentRepository, sentimentCompletionReceipts, sentimentSettings, type DatabaseClient } from '@ainyc/canonry-db'
import { SentimentService, selectSentimentSources, sentimentClassifierInput, sentimentHash } from '@ainyc/canonry-api-routes'
import { sentimentInstallReadiness, type SentimentInstallConfig } from '@ainyc/canonry-config'

export interface SentimentWorkerOptions {
  configuration: () => SentimentInstallConfig
  classifier: (configuration: SentimentInstallConfig) => SentimentClassifier
  /** Adapter preflight estimates the final request, including every evidence option. */
  prepare?: (input: SentimentClassifierInput) => { ok: true; estimatedInputTokens: number } | { ok: false; outcome: SentimentOutcome; reason: string }
  now?: () => Date
}
/** Durable scheduler owns the retry budget; each classifier call transmits at most once. */
export class SentimentWorker {
  private readonly owner = randomUUID()
  private readonly repository: SentimentRepository
  constructor(private readonly db: DatabaseClient, private readonly options: SentimentWorkerOptions) { this.repository = new SentimentRepository(db) }
  private now() { return (this.options.now?.() ?? new Date()).toISOString() }
  private service() { return new SentimentService(this.db, { install: () => { const config = this.options.configuration(); return { ...sentimentInstallReadiness(config), model: config.model } }, previewSecret: this.owner, now: this.options.now }) }
  /** The completion callback is merely a wakeup; receipts make a missed callback recoverable. */
  reconcile(): number {
    const configuration = this.options.configuration()
    if (!sentimentInstallReadiness(configuration).ready) { this.cancelDisabled(); return 0 }
    this.repository.resumeInstall(this.now())
    let admitted = 0
    const service = this.service()
    for (const settings of this.db.select().from(sentimentSettings).where(eq(sentimentSettings.enabled, true)).all()) {
      const receipts = this.db.select().from(sentimentCompletionReceipts).where(and(eq(sentimentCompletionReceipts.projectId, settings.projectId), gt(sentimentCompletionReceipts.sequence, settings.completionBoundary))).orderBy(asc(sentimentCompletionReceipts.sequence)).all()
      for (const receipt of receipts) {
        const key = `${settings.enablementEpoch}:${receipt.sequence}`
        const payloadHash = sentimentHash({ receipt: receipt.sequence, definition: settings.evaluationDefinitionId })
        // A definition edit cannot retroactively start another automatic assessment series.
        try {
          if (this.repository.lookupJob(settings.projectId, 'automatic', key, payloadHash)) continue
        } catch { continue }
        const source = selectSentimentSources(this.db, settings.projectId, { runId: receipt.runId })
        if (!source.assessments.length) continue
        const definition = service.definition(settings.evaluationDefinitionId)
        this.repository.admitJob({ projectId: settings.projectId, action: 'automatic', origin: 'automatic', enablementEpoch: settings.enablementEpoch, evaluationDefinitionId: settings.evaluationDefinitionId, idempotencyKey: key, payloadHash, selection: sentimentSelectionSchema.parse({ runId: receipt.runId }), actor: 'system', now: this.now(), work: source.assessments.map(item => { const input = sentimentClassifierInput(item, definition); return { runId: item.runId, snapshotId: item.snapshotId, sourceTextHash: input.sourceTextHash, subjectHash: input.subjectHash, input, edges: item.edges } }) })
        admitted++
      }
    }
    return admitted
  }
  private cancelDisabled() { this.repository.suspendInstall(this.now()) }
  async tick(): Promise<number> {
    const config = this.options.configuration()
    if (!sentimentInstallReadiness(config).ready) { this.cancelDisabled(); return 0 }
    this.reconcile()
    const claims = []
    for (let index = 0; index < config.maxConcurrency; index++) {
      const claim = this.repository.claim({ owner: randomUUID(), now: this.now(), leaseMs: 120_000, maxConcurrent: config.maxConcurrency })
      if (!claim) break
      claims.push(claim)
    }
    await Promise.all(claims.map(work => this.execute(work)))
    return claims.length
  }
  private async execute(work: NonNullable<ReturnType<SentimentRepository['claim']>>): Promise<void> {
    const owner = work.leaseOwner!
    const parsed = sentimentClassifierInputSchema.safeParse(work.input)
    if (!parsed.success) { this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'INVALID_FROZEN_INPUT' }); return }
    const input = parsed.data
    const unavailable = input.subject.mentionNotApplicable ? 'subject-not-applicable' : !input.sourceText.trim() ? 'missing-source-text' : !/^en(?:[-_]|$)/i.test(input.language) ? 'unsupported-language' : null
    const prepared = this.options.prepare?.(input)
    if (unavailable || prepared?.ok === false) {
      const result: SentimentClassifierOutput = { kind: 'abstained', outcome: unavailable ?? (prepared!.ok === false ? prepared!.outcome : 'input-too-large'), reason: unavailable ?? (prepared!.ok === false ? prepared!.reason : 'Input unavailable'), themes: [], returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null } }
      this.repository.completeWork({ workItemId: work.id, owner, outcome: result.outcome, result, returnedModel: null, now: this.now() })
      return
    }
    // Reload immediately before every attempt, including attempts recovered after a restart.
    const config = this.options.configuration()
    if (!sentimentInstallReadiness(config).ready) { this.cancelDisabled(); return }
    const settings = this.repository.getSettings(work.projectId)
    if (!settings?.enabled || settings.enablementEpoch !== work.enablementEpoch) { this.repository.cancelProject(work.projectId, this.now()); return }
    const estimate = prepared?.ok ? prepared.estimatedInputTokens : Math.ceil(canonicalSentimentJson(input).length / 3)
    if (estimate > config.maxInputTokensPerMinute) { this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'INPUT_EXCEEDS_INSTALL_TOKEN_BUDGET' }); return }
    if (work.attemptCount - work.attemptBudgetStart >= config.maxAttempts) { this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'ATTEMPT_BUDGET_EXHAUSTED' }); return }
    const attempt = this.repository.startAttempt({ workItemId: work.id, owner, requestedModel: input.definition.requestedModel, now: this.now(), estimatedInputTokens: estimate, maxRequestsPerMinute: config.maxRequestsPerMinute, maxAttempts: config.maxAttempts, maxInputTokensPerMinute: config.maxInputTokensPerMinute })
    if (!attempt) {
      this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'RATE_LIMIT_WAIT', retryAt: new Date(Date.parse(this.now()) + 60_000).toISOString() })
      return
    }
    let result: SentimentClassifierOutput
    try { result = sentimentClassifierOutputSchema.parse(await this.options.classifier(config).classify(input, { signal: AbortSignal.timeout(60_000) })) }
    catch { result = { kind: 'failed', outcome: 'failed', returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null }, error: { code: 'CLASSIFIER_TRANSPORT_ERROR', message: 'The classifier attempt did not return a usable response.', retryable: true, retryAfterMs: null } } }
    const now = this.now()
    const usage = result.usage.inputTokens !== null && result.usage.outputTokens !== null ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costMillicents: Math.round(result.usage.inputTokens * 0.0042) } : undefined
    this.repository.finishAttempt({ attemptId: attempt.id, now, returnedModel: result.returnedModel, usageStatus: result.usage.kind, usage, safeFailure: result.kind === 'failed' ? result.error.code : null })
    if (result.kind === 'failed') {
      const latest = this.options.configuration()
      if (!sentimentInstallReadiness(latest).ready) { this.cancelDisabled(); return }
      const retryMs = Math.max(result.error.retryAfterMs ?? 0, backoffDelayMs(attempt.attemptNumber - work.attemptBudgetStart - 1))
      this.repository.failWork({ workItemId: work.id, owner, now, errorCode: result.error.code, ...(result.error.retryable && attempt.attemptNumber - work.attemptBudgetStart < latest.maxAttempts ? { retryAt: new Date(Date.parse(now) + retryMs).toISOString() } : {}) })
    } else this.repository.completeWork({ workItemId: work.id, owner, outcome: result.outcome, result, returnedModel: result.returnedModel, now })
  }
}

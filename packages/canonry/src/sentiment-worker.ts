import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, gt } from 'drizzle-orm'
import {
  backoffDelayMs, canonicalSentimentJson, hasCurrentSentimentTemplate, storedSentimentClassifierInputSchema, sentimentClassifierOutputSchema,
  sentimentSelectionSchema, type SentimentClassifier, type SentimentClassifierInput, type SentimentClassifierOutput, type SentimentOutcome,
  OutcomeReasonCodes, OutcomeStatuses, OutcomeSurfaces, OutcomeTriggers, type FeatureCompletedProperties, type OutcomeReasonCode,
} from '@ainyc/canonry-contracts'
import { SentimentIdempotencyConflict, SentimentRepository, sentimentCompletionReceipts, sentimentSettings, type DatabaseClient, type SentimentDispatchBlock } from '@ainyc/canonry-db'
import { SentimentService, selectSentimentSources, sentimentClassifierInput, sentimentHash } from '@ainyc/canonry-api-routes'
import { sentimentInstallReadiness, type SentimentInstallConfig } from '@ainyc/canonry-config'
import { createOutcomeSampler, outcomeFailure, startOutcomeTimer, trackFeatureCompleted } from './outcome-telemetry.js'

export interface SentimentWorkerOptions {
  configuration: () => SentimentInstallConfig
  classifier: (configuration: SentimentInstallConfig) => SentimentClassifier
  /** Adapter preflight estimates the final request, including every evidence option. */
  prepare?: (input: SentimentClassifierInput) => { ok: true; estimatedInputTokens: number } | { ok: false; outcome: SentimentOutcome; reason: string }
  now?: () => Date
}
const RATE_LIMIT_FLOOR_MS = 30_000
const RATE_LIMIT_CEILING_MS = 15 * 60_000
/** A refused credential is retried with one request per interval until the key changes. */
const AUTHORIZATION_PROBE_INTERVAL_MS = 60 * 60_000

/** Rate limit and authorization refusals are install conditions, not faults of one assessment. */
function providerRefusal(code: string): SentimentDispatchBlock | null {
  return code === 'provider-rate-limit' || code === 'provider-authorization' ? code : null
}

/** 30-60s after the first rate limit, doubling with each further one up to 15-30 min; a longer Retry-After wins. */
export function sentimentRateLimitDelayMs(streak: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  const base = Math.min(RATE_LIMIT_CEILING_MS, RATE_LIMIT_FLOOR_MS * 2 ** Math.max(0, streak - 1))
  return Math.max(retryAfterMs ?? 0, base + Math.floor(random() * base))
}

/** TypeSafe failure codes as outcome reasons. `canceled` is the worker's own per-attempt timeout. */
const CLASSIFIER_FAILURE_REASONS: Readonly<Record<string, OutcomeReasonCode>> = {
  'provider-authorization': OutcomeReasonCodes.INVALID_CREDENTIALS,
  'provider-rate-limit': OutcomeReasonCodes.RATE_LIMITED,
  'provider-context-limit': OutcomeReasonCodes.VALIDATION,
  'provider-unavailable': OutcomeReasonCodes.HTTP_5XX,
  'provider-rejected': OutcomeReasonCodes.HTTP_4XX,
  'provider-timeout': OutcomeReasonCodes.TIMEOUT,
  'provider-network': OutcomeReasonCodes.NETWORK,
  canceled: OutcomeReasonCodes.TIMEOUT,
  'credential-missing': OutcomeReasonCodes.NOT_CONNECTED,
  'invalid-timeout': OutcomeReasonCodes.VALIDATION,
  'input-contract': OutcomeReasonCodes.VALIDATION,
  'response-contract': OutcomeReasonCodes.VALIDATION,
  'model-mismatch': OutcomeReasonCodes.VALIDATION,
}

/** Why an answer was not sent to the classifier: nothing to judge, an input it refuses, or one it cannot read. */
function abstentionReason(outcome: SentimentOutcome): OutcomeReasonCode {
  if (outcome === 'input-too-large' || outcome === 'invalid-conclusion-evidence') return OutcomeReasonCodes.VALIDATION
  if (outcome === 'unsupported-language' || outcome === 'ambiguous-judgment') return OutcomeReasonCodes.UNSUPPORTED
  return OutcomeReasonCodes.NO_DATA
}

type WorkOutcome = Pick<FeatureCompletedProperties, 'status' | 'reasonCode' | 'errorName' | 'counts'>

/** One-way, so a rotated key lifts an authorization pause without the key being stored. */
function credentialFingerprint(apiKey: string | undefined): string {
  return createHash('sha256').update('canonry-sentiment-credential\0').update(apiKey ?? '').digest('hex')
}

/** Durable scheduler owns the retry budget; each classifier call transmits at most once. */
export class SentimentWorker {
  private readonly owner = randomUUID()
  private readonly repository: SentimentRepository
  /** A backfill classifies one answer per item, so per-item outcomes are sampled per status and reason. */
  private readonly sampleOutcome = createOutcomeSampler({ burst: 5, refillMs: 120_000 })
  constructor(private readonly db: DatabaseClient, private readonly options: SentimentWorkerOptions) { this.repository = new SentimentRepository(db) }
  private now() { return (this.options.now?.() ?? new Date()).toISOString() }
  private service() { return new SentimentService(this.db, { install: () => { const config = this.options.configuration(); return { ...sentimentInstallReadiness(config), model: config.model } }, previewSecret: this.owner, now: this.options.now }) }
  /** The completion callback is merely a wakeup; receipts make a missed callback recoverable. */
  reconcile(): number {
    const configuration = this.options.configuration()
    if (this.holdUnlessReady(configuration)) return 0
    this.repository.resumeInstall(this.now())
    let admitted = 0
    const service = this.service()
    for (const settings of this.db.select().from(sentimentSettings).where(eq(sentimentSettings.enabled, true)).all()) {
      // Each receipt is reconciled once, so the per-tick cost follows new completions, not history.
      const start = Math.max(settings.completionBoundary, settings.reconciledSequence)
      const receipts = this.db.select().from(sentimentCompletionReceipts).where(and(eq(sentimentCompletionReceipts.projectId, settings.projectId), gt(sentimentCompletionReceipts.sequence, start))).orderBy(asc(sentimentCompletionReceipts.sequence)).all()
      if (!receipts.length) continue
      const definition = service.definition(settings.evaluationDefinitionId)
      // An earlier evaluator template waits for reconfiguration; its receipts stay unreconciled until then.
      if (!hasCurrentSentimentTemplate(definition)) continue
      let reconciled = start
      try {
        for (const receipt of receipts) {
          for (const queryClass of ['branded', 'non-brand'] as const) {
            const key = `${settings.enablementEpoch}:${receipt.sequence}${queryClass === 'branded' ? '' : ':non-brand'}`
            const payloadHash = sentimentHash({ receipt: receipt.sequence, definition: settings.evaluationDefinitionId, ...(queryClass === 'non-brand' ? { queryClass } : {}) })
            // A definition edit cannot retroactively start another automatic assessment series. Any other
            // failure propagates, so the cursor stops before this receipt and the next tick retries it.
            try {
              if (this.repository.lookupJob(settings.projectId, 'automatic', key, payloadHash)) continue
            } catch (error) { if (error instanceof SentimentIdempotencyConflict) continue; throw error }
            const source = selectSentimentSources(this.db, settings.projectId, { runId: receipt.runId, queryClass })
            // A class with nothing to assess is settled; the cursor keeps it from being selected again.
            if (!source.assessments.length) continue
            this.repository.admitJob({ projectId: settings.projectId, action: 'automatic', origin: 'automatic', enablementEpoch: settings.enablementEpoch, evaluationDefinitionId: settings.evaluationDefinitionId, idempotencyKey: key, payloadHash, selection: sentimentSelectionSchema.parse({ runId: receipt.runId, queryClass }), actor: 'system', now: this.now(), work: source.assessments.map(item => { const input = sentimentClassifierInput(item, definition); return { runId: item.runId, snapshotId: item.snapshotId, sourceTextHash: input.sourceTextHash, subjectHash: input.subjectHash, input, edges: item.edges } }) })
            admitted++
          }
          reconciled = receipt.sequence
        }
      } finally {
        // A failed admission stops the cursor before its receipt, so the next tick retries it.
        if (reconciled > start) this.repository.markReconciled(settings.projectId, settings.enablementEpoch, reconciled)
      }
    }
    return admitted
  }
  /**
   * An operator disable cancels queued work; any other unready install (an invalid or unreadable
   * config.yaml, a missing key, an unsupported model) only holds dispatch, so fixing it resumes
   * that work and the completions from the gap.
   */
  private holdUnlessReady(config: SentimentInstallConfig): boolean {
    const { ready, reason } = sentimentInstallReadiness(config)
    if (reason === 'install-disabled') this.repository.suspendInstall(this.now())
    return !ready
  }
  async tick(): Promise<number> {
    const config = this.options.configuration()
    if (this.holdUnlessReady(config)) return 0
    this.reconcile()
    // A provider refusal pauses the whole install; when the pause ends, one request tests the provider first.
    const gate = this.repository.dispatchGate({ now: this.now(), credentialFingerprint: credentialFingerprint(config.apiKey) })
    if (gate === 'closed') return 0
    // Claim only what this minute's budget still allows. startAttempt enforces the same window,
    // but work claimed past it is deferred a minute instead of waiting for the next free slot.
    const used = this.repository.recentDispatch(this.now())
    if (used.tokens >= config.maxInputTokensPerMinute) return 0
    const allowed = Math.min(gate === 'probe' ? 1 : config.maxConcurrency, config.maxRequestsPerMinute - used.requests)
    const claims = []
    for (let index = 0; index < allowed; index++) {
      const claim = this.repository.claim({ owner: randomUUID(), now: this.now(), leaseMs: 120_000, maxConcurrent: config.maxConcurrency })
      if (!claim) break
      claims.push(claim)
    }
    // Work released for lack of budget is not progress, so the poller waits for capacity instead of re-claiming it.
    const outcomes = await Promise.all(claims.map(work => this.execute(work)))
    return outcomes.filter(outcome => outcome !== 'released').length
  }
  /** One item's `sentiment.run` outcome: automatic work is scheduled, a backfill is manual, a second attempt is a retry. */
  private reportOutcome(work: NonNullable<ReturnType<SentimentRepository['claim']>>, elapsed: () => FeatureCompletedProperties['durationBucket'], outcome: WorkOutcome): void {
    const sampled = this.sampleOutcome(`${outcome.status}:${outcome.reasonCode ?? ''}`)
    if (!sampled.send) return
    const trigger = work.attemptCount > 0 ? OutcomeTriggers.retry : work.dispatchPriority === 0 ? OutcomeTriggers.scheduled : OutcomeTriggers.manual
    trackFeatureCompleted({
      feature: 'sentiment',
      operation: 'run',
      trigger,
      ...(trigger === OutcomeTriggers.manual ? {} : { surface: OutcomeSurfaces.system }),
      durationBucket: elapsed(),
      ...outcome,
      ...(sampled.droppedBefore ? { droppedBefore: sampled.droppedBefore } : {}),
    })
  }
  private async execute(work: NonNullable<ReturnType<SentimentRepository['claim']>>): Promise<'released' | void> {
    const owner = work.leaseOwner!
    const elapsed = startOutcomeTimer()
    const report = (outcome: WorkOutcome) => this.reportOutcome(work, elapsed, outcome)
    const parsed = storedSentimentClassifierInputSchema.safeParse(work.input)
    if (!parsed.success) {
      this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'INVALID_FROZEN_INPUT' })
      report({ status: OutcomeStatuses.failed, reasonCode: OutcomeReasonCodes.VALIDATION })
      return
    }
    const input = parsed.data
    if (!hasCurrentSentimentTemplate(input.definition)) {
      this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'UNSUPPORTED_EVALUATOR_DEFINITION' })
      report({ status: OutcomeStatuses.failed, reasonCode: OutcomeReasonCodes.UNSUPPORTED })
      return
    }
    const unavailable = input.subject.mentionNotApplicable ? 'subject-not-applicable' : !input.sourceText.trim() ? 'missing-source-text' : !/^en(?:[-_]|$)/i.test(input.language) ? 'unsupported-language' : null
    const prepared = this.options.prepare?.(input)
    if (unavailable || prepared?.ok === false) {
      const result: SentimentClassifierOutput = { kind: 'abstained', outcome: unavailable ?? (prepared!.ok === false ? prepared!.outcome : 'input-too-large'), reason: unavailable ?? (prepared!.ok === false ? prepared!.reason : 'Input unavailable'), returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null } }
      this.repository.completeWork({ workItemId: work.id, owner, outcome: result.outcome, result, returnedModel: null, now: this.now() })
      report({ status: OutcomeStatuses.skipped, reasonCode: abstentionReason(result.outcome) })
      return
    }
    // Reload immediately before every attempt, including attempts recovered after a restart.
    const config = this.options.configuration()
    if (this.holdUnlessReady(config)) {
      this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'INSTALL_NOT_READY', retryAt: new Date(Date.parse(this.now()) + 60_000).toISOString() })
      report({ status: OutcomeStatuses.skipped, reasonCode: OutcomeReasonCodes.NOT_CONNECTED })
      return
    }
    const settings = this.repository.getSettings(work.projectId)
    if (!settings?.enabled || settings.enablementEpoch !== work.enablementEpoch) {
      this.repository.cancelProject(work.projectId, this.now())
      report({ status: OutcomeStatuses.cancelled, reasonCode: OutcomeReasonCodes.CANCELLED_BY_USER })
      return
    }
    const estimate = prepared?.ok ? prepared.estimatedInputTokens : Math.ceil(canonicalSentimentJson(input).length / 3)
    if (estimate > config.maxInputTokensPerMinute) {
      this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'INPUT_EXCEEDS_INSTALL_TOKEN_BUDGET' })
      report({ status: OutcomeStatuses.failed, reasonCode: OutcomeReasonCodes.QUOTA_EXCEEDED })
      return
    }
    if (work.attemptCount - work.attemptBudgetStart >= config.maxAttempts) {
      this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'ATTEMPT_BUDGET_EXHAUSTED' })
      report({ status: OutcomeStatuses.failed, reasonCode: CLASSIFIER_FAILURE_REASONS[work.errorCode ?? ''] ?? OutcomeReasonCodes.UNKNOWN })
      return
    }
    const attempt = this.repository.startAttempt({ workItemId: work.id, owner, requestedModel: input.definition.requestedModel, now: this.now(), estimatedInputTokens: estimate, maxRequestsPerMinute: config.maxRequestsPerMinute, maxAttempts: config.maxAttempts, maxInputTokensPerMinute: config.maxInputTokensPerMinute })
    if (!attempt) {
      // Out of this minute's request or token budget: leave the work queued so it dispatches as soon
      // as capacity returns. Any other refusal keeps the one-minute wait.
      const used = this.repository.recentDispatch(this.now())
      if (used.requests >= config.maxRequestsPerMinute || used.tokens + estimate > config.maxInputTokensPerMinute) {
        this.repository.releaseWork({ workItemId: work.id, owner, now: this.now() })
        return 'released'
      }
      this.repository.failWork({ workItemId: work.id, owner, now: this.now(), errorCode: 'RATE_LIMIT_WAIT', retryAt: new Date(Date.parse(this.now()) + 60_000).toISOString() })
      report({ status: OutcomeStatuses.skipped, reasonCode: OutcomeReasonCodes.RATE_LIMITED })
      return
    }
    let result: SentimentClassifierOutput
    let transportError: { error: unknown } | undefined
    try { result = sentimentClassifierOutputSchema.parse(await this.options.classifier(config).classify(input, { signal: AbortSignal.timeout(60_000) })) }
    catch (error) {
      transportError = { error }
      result = { kind: 'failed', outcome: 'failed', returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null }, error: { code: 'CLASSIFIER_TRANSPORT_ERROR', message: 'The classifier attempt did not return a usable response.', retryable: true, retryAfterMs: null } }
    }
    const now = this.now()
    const usage = result.usage.inputTokens !== null && result.usage.outputTokens !== null ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costMillicents: Math.round(result.usage.inputTokens * 0.0042) } : undefined
    this.repository.finishAttempt({ attemptId: attempt.id, now, returnedModel: result.returnedModel, usageStatus: result.usage.kind, usage, safeFailure: result.kind === 'failed' ? result.error.code : null })
    const counts = { attempts: attempt.attemptNumber, ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}) }
    if (result.kind === 'failed') {
      const failure = transportError
        ? outcomeFailure(transportError.error)
        : { reasonCode: CLASSIFIER_FAILURE_REASONS[result.error.code] ?? OutcomeReasonCodes.UNKNOWN }
      const reportFailed = () => report({ status: OutcomeStatuses.failed, ...failure, counts })
      const latest = this.options.configuration()
      // The attempt-budget check at the next execution still bounds retries of a held item.
      if (this.holdUnlessReady(latest)) { this.repository.failWork({ workItemId: work.id, owner, now, errorCode: result.error.code, ...(result.error.retryable ? { retryAt: new Date(Date.parse(now) + 60_000).toISOString() } : {}) }); reportFailed(); return }
      const refusal = providerRefusal(result.error.code)
      if (refusal) {
        const retryAfterMs = result.error.retryAfterMs
        this.repository.recordProviderRefusal({ workItemId: work.id, owner, now, dispatchedAt: attempt.dispatchedAt, reason: refusal, credentialFingerprint: credentialFingerprint(config.apiKey),
          delayMs: streak => refusal === 'provider-rate-limit' ? sentimentRateLimitDelayMs(streak, retryAfterMs) : AUTHORIZATION_PROBE_INTERVAL_MS })
        reportFailed()
        return
      }
      const retryMs = Math.max(result.error.retryAfterMs ?? 0, backoffDelayMs(attempt.attemptNumber - work.attemptBudgetStart - 1))
      this.repository.failWork({ workItemId: work.id, owner, now, errorCode: result.error.code, ...(result.error.retryable && attempt.attemptNumber - work.attemptBudgetStart < latest.maxAttempts ? { retryAt: new Date(Date.parse(now) + retryMs).toISOString() } : {}) })
      reportFailed()
    } else {
      this.repository.completeWork({ workItemId: work.id, owner, outcome: result.outcome, result, returnedModel: result.returnedModel, now })
      this.repository.releaseDispatchPause({ now, dispatchedAt: attempt.dispatchedAt })
      report({ status: OutcomeStatuses.succeeded, counts })
    }
  }
}

/**
 * Runs `tick` again straight away while it keeps claiming work, so a queued backfill drains at the
 * install's rate limits rather than one batch per poll interval. A poll that arrives while a tick
 * is in flight is dropped; a failed tick reports through `onError` and waits for the next poll.
 */
export function createSentimentPoller(tick: () => Promise<number>, onError: () => void, schedule: (next: () => void) => void = setImmediate) {
  let inFlight: Promise<void> | null = null
  let stopped = false
  const poll = (): void => {
    if (inFlight || stopped) return
    inFlight = tick()
      .catch(() => { onError(); return 0 })
      .then(claimed => { inFlight = null; if (claimed > 0 && !stopped) schedule(poll) })
  }
  return {
    poll,
    /** The tick in flight, if any. */
    settled: (): Promise<void> | null => inFlight,
    stop: (): void => { stopped = true },
  }
}

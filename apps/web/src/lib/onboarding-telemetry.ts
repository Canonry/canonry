import type { OnboardingBlockReason, OnboardingStep } from '@ainyc/canonry-contracts'
import type { HealthSnapshot } from '../view-models.js'

const SESSION_KEY = 'canonry.onboarding-session.v1'
const LAUNCHED_RUN_KEY = 'canonry.onboarding-launched-run.v1'
const HANDOFF_KEY = 'canonry.onboarding-handoff.v1'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const STEP_NAMES: readonly OnboardingStep[] = [
  'system',
  'project',
  'queries',
  'competitors',
  'run',
]

export function onboardingStepFromIndex(index: number): OnboardingStep {
  return STEP_NAMES[index] ?? 'system'
}

export function onboardingSystemBlockReason(input: {
  apiReady: boolean
  databaseConfigured?: boolean
  workerReady: boolean
  providerReady: boolean
}): OnboardingBlockReason | undefined {
  if (!input.apiReady) return 'api_unavailable'
  if (input.databaseConfigured === false) return 'database_unavailable'
  if (!input.workerReady) return 'worker_unavailable'
  if (!input.providerReady) return 'no_provider'
  return undefined
}

export function isOnboardingHealthSettled(snapshot: HealthSnapshot): boolean {
  return snapshot.apiStatus.state !== 'checking'
    && snapshot.workerStatus.state !== 'checking'
}

/**
 * Every error code the onboarding steps can actually surface, mapped to the
 * block reason an analysis can act on.
 *
 * The query-generation step calls a provider, so its failures are provider
 * failures: rate limits, bad keys, dropped connections. Mapping only
 * `NO_PROVIDER` / `NO_QUERIES` sent all of those to `unknown`, which made the
 * one step with zero recovery the one step nobody could diagnose.
 */
const BLOCK_REASON_BY_ERROR_CODE: Readonly<Record<string, OnboardingBlockReason>> = {
  NO_PROVIDER: 'no_provider',
  NO_QUERIES: 'no_queries',
  RATE_LIMITED: 'rate_limited',
  QUOTA_EXCEEDED: 'rate_limited',
  PROVIDER_AUTH: 'provider_auth',
  AUTH_INVALID: 'provider_auth',
  FORBIDDEN: 'provider_auth',
  NETWORK: 'network',
  CONNECTION_ERROR: 'network',
  RUN_IN_PROGRESS: 'run_rejected',
  RUN_CANCELLED: 'run_cancelled',
}

export function onboardingErrorReason(
  error: unknown,
  fallback: OnboardingBlockReason,
): OnboardingBlockReason {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : ''
  return BLOCK_REASON_BY_ERROR_CODE[code] ?? fallback
}

export function getOrCreateOnboardingSessionId(): string {
  try {
    const existing = typeof window !== 'undefined'
      ? window.sessionStorage.getItem(SESSION_KEY)
      : null
    if (existing && UUID_PATTERN.test(existing)) return existing

    const id = createUuid()
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return createUuid()
  }
}

export function createOnboardingEventId(): string {
  return createUuid()
}

/**
 * The run the wizard launched in this onboarding session, remembered across
 * remounts.
 *
 * `runTriggered` and `launchedRunId` are component state, and the resume path
 * deliberately clears both once the project has a successful baseline. A sweep
 * takes 30 seconds to several minutes; anyone who reloads, navigates, or closes
 * the tab in that window comes back to a page that has already decided the run
 * is old news, so the run-step completion never fires. Failures, which land in
 * under a second, always fired. The funnel could record a failure and not a
 * success, which is exactly backwards.
 *
 * Three fields, and each one is load-bearing:
 *
 * - `projectName` scopes the marker. A bare run id would let a user who
 *   launched a run for project A and then opened setup for project B poll A's
 *   run and attribute its outcome to B's onboarding.
 * - `runId` is what the poll resumes.
 * - `handled` records that the run-step outcome was already emitted, so a
 *   remount cannot double-count it. The per-mount dedupe ref cannot: it is
 *   born empty on every mount, which is the whole problem.
 */
export interface OnboardingLaunchedRun {
  projectName: string
  runId: string
  handled: boolean
}

function isLaunchedRun(value: unknown): value is OnboardingLaunchedRun {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<OnboardingLaunchedRun>
  return typeof candidate.projectName === 'string' && candidate.projectName.length > 0
    && typeof candidate.runId === 'string' && candidate.runId.length > 0
    && typeof candidate.handled === 'boolean'
}

export function markOnboardingRunLaunched(projectName: string, runId: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(
        LAUNCHED_RUN_KEY,
        JSON.stringify({ projectName, runId, handled: false } satisfies OnboardingLaunchedRun),
      )
    }
  } catch {
    // A telemetry marker must never break a launch.
  }
}

/**
 * The pending run for `projectName`, or null.
 *
 * Returns null for another project's run, for an already-handled run, and for
 * anything that does not parse — a marker we cannot read is not a marker we
 * should act on.
 */
export function readOnboardingLaunchedRun(projectName: string | undefined): OnboardingLaunchedRun | null {
  if (!projectName) return null
  try {
    if (typeof window === 'undefined') return null
    const raw = window.sessionStorage.getItem(LAUNCHED_RUN_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isLaunchedRun(parsed)) return null
    if (parsed.projectName !== projectName) return null
    if (parsed.handled) return null
    return parsed
  } catch {
    return null
  }
}

/** Record that this run's outcome has been emitted. Idempotent. */
export function markOnboardingRunHandled(runId: string): void {
  try {
    if (typeof window === 'undefined') return
    const raw = window.sessionStorage.getItem(LAUNCHED_RUN_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!isLaunchedRun(parsed) || parsed.runId !== runId) return
    window.sessionStorage.setItem(
      LAUNCHED_RUN_KEY,
      JSON.stringify({ ...parsed, handled: true } satisfies OnboardingLaunchedRun),
    )
  } catch {
    // Same as above: best effort.
  }
}

/**
 * One-shot marker for the launchpad's hand-off into Site Health.
 *
 * Site Health used to report `resumed: Boolean(initialRunId)`, but the
 * launchpad always hands off WITH the run it just started, so every first-run
 * start read as a resume (14 of 14 in the data). The launchpad now marks the
 * run it handed over; the Site Health page consumes the marker on arrival and
 * reports a fresh start. A later reload finds no marker and is a real resume.
 */
export function markOnboardingHandoff(runId: string): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.setItem(HANDOFF_KEY, runId)
  } catch {
    // A telemetry marker must never break a launch.
  }
}

/** Whether `runId` is the run the launchpad just handed over. Read-only. */
export function isOnboardingHandoff(runId: string | undefined): boolean {
  if (!runId) return false
  try {
    return typeof window !== 'undefined' && window.sessionStorage.getItem(HANDOFF_KEY) === runId
  } catch {
    return false
  }
}

/** Spend the hand-off marker, so the next arrival for this run is a resume. */
export function clearOnboardingHandoff(): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(HANDOFF_KEY)
  } catch {
    // Best effort.
  }
}

export function clearOnboardingRunLaunched(): void {
  try {
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(LAUNCHED_RUN_KEY)
    }
  } catch {
    // Same as above: best effort.
  }
}

function createUuid(): string {
  const cryptoApi = globalThis.crypto as Partial<Pick<Crypto, 'randomUUID' | 'getRandomValues'>>
  if (cryptoApi.randomUUID) return cryptoApi.randomUUID()

  const bytes = new Uint8Array(16)
  if (cryptoApi.getRandomValues) {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

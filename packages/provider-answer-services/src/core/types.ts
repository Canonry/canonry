import type {
  AnswerServiceDescriptor,
  AnswerServiceProfile,
  AnswerSource,
  Completion,
  LocationTreatment,
  SentLocation,
  SseEvent,
  UsageObservation,
} from '@canonry/canonry-contracts'

/**
 * Everything a vendor supplies. The shared factory turns one definition into a
 * provider adapter; a vendor never touches HTTP, retries, evidence assembly,
 * routes or settings.
 */

/** The exact request a profile sends. Built purely from the input; no I/O. */
export interface AnswerServiceHttpRequest {
  method: 'POST' | 'GET'
  /** Path under the descriptor's fixed base URL, starting with `/`. */
  path: string
  body?: Record<string, unknown>
  /** Extra non-secret headers (an API version, an accept type). Auth is added by the factory. */
  headers?: Readonly<Record<string, string>>
}

export interface AnswerServiceRequestInput {
  /** The tracked query, unmodified. The factory has already refused one the profile cannot take. */
  query: string
  profile: AnswerServiceProfile
  /**
   * The location fields the profile's granularity allows (`location.sent`),
   * or none. Send only what the vendor documents accepting, in the vendor's
   * own encoding, and report it as `sentLocation`.
   */
  location: LocationTreatment
}

/**
 * A built request and the location it actually carries. The factory records
 * the location treatment from `sentLocation`, never from the granularity
 * alone, so a builder that drops a value its vendor cannot take (a country
 * outside a documented list, for example) records that location as ignored.
 */
export interface AnswerServiceBuiltRequest {
  request: AnswerServiceHttpRequest
  /**
   * The location fields the request carries, keyed by Canonry's field names
   * (values as sent, in the vendor's encoding), or null when it carries none.
   * Only fields offered in `location.sent` may appear.
   */
  sentLocation: SentLocation | null
}

export interface AnswerServiceParseContext {
  profile: AnswerServiceProfile
  /** The request id from the response headers, when the vendor sends one. */
  headerRequestId: string | null
}

/** How a streamed response ended: on the vendor's final event, at end of stream, or by deadline. */
export type AnswerServiceStreamEnd = 'terminal' | 'eof' | 'aborted'

/**
 * What a vendor parser extracts. Sources carry the relationship the vendor
 * documents; counts and money the vendor does not report stay unknown.
 */
export interface ParsedAnswer {
  /** Verbatim answer text, or null when the response carries none. */
  answerText: string | null
  sources: AnswerSource[]
  searchQueries: string[]
  /** Searches the response shows as events (0 when it shows none). */
  searchEventCount: number
  completion: Completion
  usage: UsageObservation
  /** The model or tier the response names, verbatim, or null. Never the requested one. */
  disclosedModel: string | null
}

/**
 * Members are function-typed properties, not methods: the factory passes them
 * on detached (to the HTTP and stream layers), so none may depend on `this`.
 */
export interface AnswerServiceDefinition {
  descriptor: AnswerServiceDescriptor
  buildRequest: (input: AnswerServiceRequestInput) => AnswerServiceBuiltRequest
  /** Read a JSON response (profiles with transport `json`). */
  parseResponse?: (body: Record<string, unknown>, context: AnswerServiceParseContext) => ParsedAnswer
  /** Read a stream (profiles with transport `sse`). */
  parseEvents?: (events: readonly SseEvent[], context: AnswerServiceParseContext & { ended: AnswerServiceStreamEnd }) => ParsedAnswer
  /** Whether an event is the vendor's documented final event. */
  isTerminalEvent?: (event: SseEvent) => boolean
  /** The vendor's error message from an error body, for the failure text. */
  errorMessage?: (body: unknown) => string | null
  /**
   * Job-based profiles (submit, then poll). Typed now so a job service fits
   * without redesign; the shared factory refuses `execution: 'job'` until the
   * vendor-neutral job executor (submit at most once, resume from the stored
   * job id) exists. That executor reports an unfinished job as an
   * `IncompleteAnswerError` with `resumable: true`, which research stores as a
   * `waiting-upstream` query with its `upstreamJobId`.
   */
  job?: AnswerServiceJobHandlers
}

export interface AnswerServiceJobHandlers {
  submit: (input: AnswerServiceRequestInput) => AnswerServiceBuiltRequest
  /** Read the job handle. Throw `AnswerServiceJobSubmitError` with `definite` set by what the vendor confirmed. */
  parseSubmit: (body: Record<string, unknown>, context: AnswerServiceParseContext) => { jobId: string; completion: Completion }
  poll: (jobId: string, profile: AnswerServiceProfile) => AnswerServiceHttpRequest
  parsePoll: (body: Record<string, unknown>, context: AnswerServiceParseContext) => ParsedAnswer
  cancel?: (jobId: string, profile: AnswerServiceProfile) => AnswerServiceHttpRequest
}

/**
 * A job submission failure. `definite: true` means the vendor confirmed no job
 * exists, so a later attempt may submit again; `definite: false` means the
 * outcome is unknown and the caller must never resubmit (at most once).
 */
export class AnswerServiceJobSubmitError extends Error {
  readonly definite: boolean
  constructor(message: string, opts: { definite: boolean; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'AnswerServiceJobSubmitError'
    this.definite = opts.definite
  }
}

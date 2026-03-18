import type { GroundingSource } from '@ainyc/canonry-contracts'
import type CDP from 'chrome-remote-interface'

/** A CDP-driven extraction target for a specific AI web UI */
export interface CDPTarget {
  /** Target identifier (e.g. 'chatgpt') */
  name: string
  /** Base URL of the AI service */
  baseUrl: string
  /** URL that starts a fresh conversation (navigated to before each query) */
  newConversationUrl: string
  /** CSS selector for the response container element (used for cropped screenshots) */
  responseSelector: string
  /** Type the query and submit it */
  submitQuery(client: CDP.Client, keyword: string): Promise<void>
  /** Wait for the AI response to finish streaming */
  waitForResponse(client: CDP.Client): Promise<void>
  /** Extract the answer text from the DOM */
  extractAnswer(client: CDP.Client): Promise<string>
  /** Extract citation/grounding source links from the DOM */
  extractCitations(client: CDP.Client): Promise<GroundingSource[]>
}

/** Structured error codes for CDP failures */
export type CDPErrorCode =
  | 'CDP_CONNECTION_REFUSED'
  | 'CDP_TARGET_SELECTOR_FAILED'
  | 'CDP_RESPONSE_TIMEOUT'
  | 'CDP_AUTH_REQUIRED'

export class CDPProviderError extends Error {
  constructor(
    public readonly code: CDPErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CDPProviderError'
  }
}

import { z } from 'zod'
import { redactLogString } from './log-redaction.js'

/**
 * Product feedback about Canonry itself, from a person or the agent driving
 * Canonry. Forwarded by the local server to `https://canonry.ai/api/feedback`.
 *
 * Separate from telemetry on purpose: telemetry is anonymous and carries no
 * free text, while feedback is an explicit, user-visible act that does. The
 * collector is the source of truth for the wire limits mirrored here.
 */
export const FEEDBACK_KINDS = ['struggle', 'bug', 'improvement', 'other'] as const
export const feedbackKindSchema = z.enum(FEEDBACK_KINDS)
export type FeedbackKind = z.infer<typeof feedbackKindSchema>

/** Where the feedback was submitted from, as the collector accepts it. */
export const FEEDBACK_SOURCES = ['cli', 'mcp', 'api', 'dashboard'] as const
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number]

export const FEEDBACK_LIMITS = {
  summary: 500,
  details: 4000,
  area: 40,
  command: 120,
  errorCode: 40,
} as const

/** What a client submits. Identity, version and source are added by the server. */
export const feedbackSubmissionSchema = z.object({
  kind: feedbackKindSchema,
  summary: z.string().trim().min(1).max(FEEDBACK_LIMITS.summary),
  details: z.string().trim().min(1).max(FEEDBACK_LIMITS.details).optional(),
  area: z.string().trim().min(1).max(FEEDBACK_LIMITS.area).optional(),
  command: z.string().trim().min(1).max(FEEDBACK_LIMITS.command).optional(),
  errorCode: z.string().trim().min(1).max(FEEDBACK_LIMITS.errorCode).optional(),
}).strict()
export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>

export const feedbackAcceptedDtoSchema = z.object({
  accepted: z.boolean(),
  id: z.string(),
})
export type FeedbackAcceptedDto = z.infer<typeof feedbackAcceptedDtoSchema>

/**
 * Strip credentials from free text before it leaves the machine. Agents paste
 * error output, and error output can echo a key. Reuses the runtime-log policy,
 * then truncates to the collector limit again since redaction can lengthen.
 */
export function redactFeedbackText(value: string, limit: number): string {
  return truncateUtf16(
    redactLogString(value)
      .replace(SECRET_FLAG_VALUE, '$1 [REDACTED]')
      .replace(BARE_CREDENTIAL, '[REDACTED]'),
    limit,
  )
}

/**
 * Cut to `limit` UTF-16 code units (the unit the collector's length limits
 * count), without leaving half of a surrogate pair: a split emoji would send
 * a lone surrogate.
 */
export function truncateUtf16(value: string, limit: number): string {
  if (value.length <= limit) return value
  const cut = value.slice(0, limit)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/**
 * A command line pasted with a credential flag: `--api-key sk-…`,
 * `--client-secret=…`, `--token "…"`. The log policy only catches `key=value`,
 * so the space-separated form reached the collector intact. A flag counts
 * only at the start of a line or after a space or tab, and its value only on
 * the same line, so prose like "the gemini-key setting" or "access-token
 * expired" keeps its words; flag names match by whole hyphen segments, so
 * `--keyword` is left alone.
 */
const SECRET_FLAG_VALUE = /(?<=^|[ \t])(--?(?:[a-z\d]+-)*(?:key|token|secret|password|passwd|credential|credentials|auth|authorization|bearer)(?:-[a-z\d]+)*)(?:[ \t]*=[ \t]*|[ \t]+)(?!\[REDACTED\])(?:"[^"\n]*"|'[^'\n]*'|\S+)/gim

/**
 * Credentials pasted bare, with no `key=` in front for the log policy to key
 * on: provider keys (OpenAI/Anthropic `sk-`, Google `AIza`, Perplexity
 * `pplx-`), GitHub tokens, and Canonry's own `cnry_` keys.
 */
const BARE_CREDENTIAL = /\b(?:sk-[\w-]{16,}|AIza[\w-]{30,}|pplx-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|cnry_[\w-]{16,})/g

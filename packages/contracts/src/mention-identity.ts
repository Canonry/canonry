import { z } from 'zod'
import type { SentimentOutcome } from './sentiment.js'

/**
 * What sentiment's identity check settled about a stored answer, when it
 * changes whether a name match counts as a mention.
 *
 * `wrong-subject`: the answer writes the brand's (or a Property's) name, but the
 * sentiment evaluator found it is about another subject, such as a namesake
 * company or a common word the name shares. The name match is not a mention.
 */
export const mentionIdentitySchema = z.enum(['wrong-subject'])
export const MentionIdentities = mentionIdentitySchema.enum
export type MentionIdentity = z.infer<typeof mentionIdentitySchema>

/**
 * A name match counts as a mention unless sentiment found the answer is about
 * another subject. Every reader that turns a name match into a mention goes
 * through this, so the stored column and the read-time recomputations agree.
 */
export function countsAsMention(nameMatched: boolean, identity: MentionIdentity | null | undefined): boolean {
  return nameMatched && identity !== MentionIdentities['wrong-subject']
}

/**
 * Outcomes that answered the evaluator's identity question. A judgment
 * (favorable through ambiguous judgment, or conclusion evidence it could not
 * use) is only reached once identity resolved as correct. The rest
 * (`input-too-large`, `unsupported-language`, a failure) never asked it.
 */
const IDENTITY_JUDGED_OUTCOMES: ReadonlySet<SentimentOutcome> = new Set<SentimentOutcome>([
  'favorable', 'mixed', 'unfavorable', 'factual', 'ambiguous-judgment', 'invalid-conclusion-evidence',
  'subject-not-mentioned', 'wrong-subject', 'ambiguous-subject',
])

export interface SentimentIdentityResult {
  outcome: SentimentOutcome
  completedAt: string
  /** Breaks a tie between two results completed in the same instant. */
  workItemId: string
}

/**
 * The mention identity one answer's completed sentiment results settle for one
 * subject. The latest result that judged identity decides, so a rerun under a
 * newer evaluator supersedes an older verdict, and an outcome that never
 * reached the identity question decides nothing. Only `wrong-subject` changes
 * a mention: `ambiguous-subject` leaves the name match counted, because the
 * evaluator could not rule the subject out.
 */
export function mentionIdentityFromSentiment(results: readonly SentimentIdentityResult[]): MentionIdentity | null {
  let latest: SentimentIdentityResult | null = null
  for (const result of results) {
    if (!IDENTITY_JUDGED_OUTCOMES.has(result.outcome)) continue
    if (latest === null
      || result.completedAt > latest.completedAt
      || (result.completedAt === latest.completedAt && result.workItemId > latest.workItemId)) latest = result
  }
  return latest?.outcome === 'wrong-subject' ? MentionIdentities['wrong-subject'] : null
}

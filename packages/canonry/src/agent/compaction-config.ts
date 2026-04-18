/**
 * Transcript compaction tuning.
 *
 * Aero keeps one rolling session per project, so transcripts grow
 * unbounded across many turns. Compaction summarizes the oldest chunk of
 * the transcript into a `compaction:` memory note and removes those
 * messages from the live session, keeping recent turns intact.
 */

/**
 * Token budget above which compaction fires at the start of the next
 * turn. Chosen well below the smallest supported context window so we
 * have headroom for the system prompt (incl. hydrated `<memory>` block),
 * tool schemas, and a full assistant reply. The estimate is a chars/4
 * heuristic — see `token-counter.ts` — so this threshold is intentionally
 * conservative.
 */
export const COMPACTION_TOKEN_THRESHOLD = 60_000

/**
 * Fraction of the oldest messages considered for summarization when
 * compaction fires. 0.5 means "summarize roughly the first half of the
 * transcript, keep the second half intact." The actual split is snapped
 * to a safe boundary by `findSafeSplit` so we don't orphan tool calls
 * from their tool results.
 */
export const COMPACTION_TARGET_RATIO = 0.5

/**
 * Minimum number of trailing messages kept verbatim regardless of the
 * target ratio. Guards against a pathological split where the "recent"
 * tail ends up nearly empty — the agent still needs enough immediate
 * context to reason about the current turn.
 */
export const COMPACTION_PRESERVE_TAIL_MESSAGES = 10

/**
 * Hard cap on transcript length before compaction is forced even if the
 * token estimate hasn't crossed the threshold. Pathological patterns
 * (many short tool results) can inflate message count without inflating
 * tokens; this stops the `messages[]` array from growing forever.
 */
export const COMPACTION_MAX_MESSAGES = 400

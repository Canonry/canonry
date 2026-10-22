import { describe, expect, it } from 'vitest'
import { countsAsMention, mentionIdentityFromSentiment, type SentimentIdentityResult } from '../src/mention-identity.js'

const result = (outcome: SentimentIdentityResult['outcome'], completedAt: string, workItemId = completedAt): SentimentIdentityResult =>
  ({ outcome, completedAt, workItemId })

describe('sentiment identity verdicts on mentions', () => {
  it.each([
    ['no results', [], null],
    ['a wrong-subject verdict', [result('wrong-subject', '2026-10-01T00:00:00Z')], 'wrong-subject'],
    ['a later judged result superseding it', [result('wrong-subject', '2026-10-01T00:00:00Z'), result('favorable', '2026-10-02T00:00:00Z')], null],
    ['a later wrong-subject superseding a judgment', [result('mixed', '2026-10-01T00:00:00Z'), result('wrong-subject', '2026-10-02T00:00:00Z')], 'wrong-subject'],
    ['a later result that never asked about identity', [result('wrong-subject', '2026-10-01T00:00:00Z'), result('input-too-large', '2026-10-02T00:00:00Z'), result('failed', '2026-10-03T00:00:00Z')], 'wrong-subject'],
    ['an ambiguous subject', [result('ambiguous-subject', '2026-10-01T00:00:00Z')], null],
    ['an ambiguous subject after wrong-subject', [result('wrong-subject', '2026-10-01T00:00:00Z'), result('ambiguous-subject', '2026-10-02T00:00:00Z')], null],
    ['a tie broken by the later work item', [result('favorable', '2026-10-01T00:00:00Z', 'b'), result('wrong-subject', '2026-10-01T00:00:00Z', 'a')], null],
  ] as const)('settles %s', (_label, results, expected) => {
    expect(mentionIdentityFromSentiment(results)).toBe(expected)
    expect(mentionIdentityFromSentiment([...results].reverse())).toBe(expected)
  })

  it('stops a name match from counting only on a wrong-subject verdict', () => {
    expect(countsAsMention(true, 'wrong-subject')).toBe(false)
    expect(countsAsMention(true, null)).toBe(true)
    expect(countsAsMention(true, undefined)).toBe(true)
    expect(countsAsMention(false, null)).toBe(false)
  })
})

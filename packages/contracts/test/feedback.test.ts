import { describe, expect, it } from 'vitest'
import { FEEDBACK_LIMITS, feedbackSubmissionSchema, redactFeedbackText } from '../src/feedback.js'

describe('feedbackSubmissionSchema', () => {
  it('accepts a minimal struggle report and trims it', () => {
    expect(feedbackSubmissionSchema.parse({ kind: 'struggle', summary: '  run fails on free Gemini key  ' }))
      .toEqual({ kind: 'struggle', summary: 'run fails on free Gemini key' })
  })

  it('rejects blank summaries, unknown kinds, unknown keys and over-limit text', () => {
    expect(feedbackSubmissionSchema.safeParse({ kind: 'struggle', summary: '   ' }).success).toBe(false)
    expect(feedbackSubmissionSchema.safeParse({ kind: 'rant', summary: 'x' }).success).toBe(false)
    expect(feedbackSubmissionSchema.safeParse({ kind: 'bug', summary: 'x', anonymousId: 'y' }).success).toBe(false)
    expect(feedbackSubmissionSchema.safeParse({ kind: 'bug', summary: 'x'.repeat(FEEDBACK_LIMITS.summary + 1) }).success).toBe(false)
  })
})

describe('redactFeedbackText', () => {
  it('removes bare provider and Canonry keys pasted from an error', () => {
    const text = 'Gemini said 401 for AIzaSyA1234567890abcdefghijklmnopqrstuv and sk-proj-abcdefghijklmnop1234 and cnry_abcdefghijklmnopqrst'
    const out = redactFeedbackText(text, 500)
    expect(out).not.toMatch(/AIzaSy|sk-proj|cnry_abc/)
    expect(out).toContain('Gemini said 401')
  })

  it('removes key=value and bearer credentials via the log policy', () => {
    const out = redactFeedbackText('apiKey=supersecretvalue Authorization: Bearer abc.def.ghi', 500)
    expect(out).not.toMatch(/supersecretvalue|abc\.def\.ghi/)
  })

  it('removes space-separated credential flag values from pasted command lines', () => {
    const out = redactFeedbackText(
      'ran cnry settings provider gemini --api-key REALKEY111 --client-secret "two words" --token=tok333 --gemini-key k444',
      500,
    )
    for (const secret of ['REALKEY111', 'two words', 'tok333', 'k444']) expect(out).not.toContain(secret)
    expect(out).toContain('--api-key [REDACTED]')
  })

  it('leaves ordinary flags that merely contain "key" alone', () => {
    expect(redactFeedbackText('cnry query add acme --keyword "dentist brooklyn"', 500)).toContain('dentist brooklyn')
  })

  it('does not mistake hyphenated words in prose for credential flags', () => {
    for (const prose of ['the gemini-key setting is ignored', 'non-auth routes 404', 'access-token expired', 'the --token\nnext line stays']) {
      expect(redactFeedbackText(prose, 500)).toBe(prose)
    }
  })

  it('never ends a truncated text on half of an emoji', () => {
    const out = redactFeedbackText(`${'a'.repeat(499)}😀tail`, 500)
    expect(out).toBe('a'.repeat(499))
    expect(out.length).toBeLessThanOrEqual(500)
  })

  it('keeps the result within the limit', () => {
    expect(redactFeedbackText('x'.repeat(600), 500)).toHaveLength(500)
  })
})

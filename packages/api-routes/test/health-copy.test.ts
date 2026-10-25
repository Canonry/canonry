import { describe, expect, it } from 'vitest'
import { ALL_CHECKS } from '../src/doctor/registry.js'
import { HEALTH_CHECK_LABELS, firstSentence, plainHealthCopy } from '../src/notifications/health-copy.js'

describe('plain alert labels', () => {
  it('name every registered doctor check, and nothing that is not one', () => {
    const ids = ALL_CHECKS.map(check => check.id).sort()
    // A new check without a plain label would page as "Health check failing".
    expect(Object.keys(HEALTH_CHECK_LABELS).sort()).toEqual(ids)
  })

  it('never show a check id, a code or an em dash', () => {
    for (const label of Object.values(HEALTH_CHECK_LABELS)) {
      expect(label).not.toMatch(/[a-z]+\.[a-z-]+\./u)
      expect(label).not.toContain('—')
      expect(label.split(' ').length).toBeLessThanOrEqual(5)
    }
  })
})

describe('firstSentence', () => {
  it('keeps one sentence, and caps a sentence that runs on', () => {
    expect(firstSentence('GA4 stopped. Run a sync.')).toBe('GA4 stopped.')
    expect(firstSentence('Open https://a.test/x.y for details')).toBe('Open https://a.test/x.y for details')
    expect(firstSentence('x'.repeat(400))).toHaveLength(180)
    expect(firstSentence(null)).toBeNull()
  })
})

describe('plainHealthCopy', () => {
  it('prefers the check\'s own words, and falls back to its label and first sentences', () => {
    const own = { label: "Can't reach Google", line: 'The server could not reach Google.', next: null }
    expect(plainHealthCopy({ id: 'ga.auth.connection', status: 'fail', code: 'ga.auth.refresh-unreachable', summary: 'long', alert: own }, 'ignored')).toEqual(own)
    expect(plainHealthCopy({ id: 'ga.data.recent-data', status: 'warn', code: 'ga.data.aging', summary: 'No GA4 data since Oct 20. Check the sync.' }, 'Run a GA4 sync. Then check again.'))
      .toEqual({ label: 'GA4 data stopped', line: 'No GA4 data since Oct 20.', next: 'Run a GA4 sync.' })
  })
})

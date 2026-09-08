import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { MentionLandscape } from '@ainyc/canonry-contracts'
import { ReportShareOfVoice } from '../src/pages/ReportPage.js'

vi.mock('../src/api.js', () => ({ heyClient: {}, isEmbed: false, downloadReportHtml: vi.fn(), ApiError: class extends Error {} }))
afterEach(cleanup)

test('report SPA uses the same basis and unmeasured copy as the HTML report', () => {
  const section = { projectMentionCount: 3, totalAnswerSnapshots: 3, competitors: [] }
  const mentionLandscape: MentionLandscape = {
    ...section, scope: 'non-brand',
    nonBrand: { ...section, shareOfVoice: {
      basis: 'observed', availability: 'measured', reason: null, queryClass: 'non-brand',
      percent: 25, projectMentions: 3, competitorMentions: 9, competitorCount: 3,
      snapshotsWithAnswerText: 3, perCompetitor: [],
    } },
    branded: { ...section, shareOfVoice: {
      basis: null, availability: 'not-measured', reason: 'no-competitors', queryClass: 'branded',
      percent: null, projectMentions: 34, competitorMentions: 0, competitorCount: 0,
      snapshotsWithAnswerText: 34, perCompetitor: [],
    } },
  }
  render(<ReportShareOfVoice report={{ mentionLandscape }} />)
  expect(screen.getByText('Share of voice · non-brand queries: 25.0% · observed competitors')).toBeTruthy()
  expect(screen.getByText('Share of voice · branded queries: Not measured')).toBeTruthy()
  expect(screen.getByText('No competitors configured.')).toBeTruthy()
  expect(screen.queryByText('100.0%')).toBeNull()
})

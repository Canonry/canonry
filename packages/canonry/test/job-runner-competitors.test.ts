import { expect, test } from 'vitest'

import { extractRecommendedCompetitors } from '../src/job-runner.js'

test('extractRecommendedCompetitors excludes headings and the target brand', () => {
  const answer = [
    '### Why it stands out',
    'Use a provider with borough coverage.',
    '',
    '1. **Citypoint Dental** - the target brand',
    '2. **Downtown Smiles** - same-day care',
  ].join('\n')

  expect(
    extractRecommendedCompetitors(
      answer,
      ['citypointdental.com'],
      ['citypointdental.com', 'downtownsmiles.com'],
      [],
    ),
  ).toEqual(['Downtown Smiles'])
})

test('extractRecommendedCompetitors matches spaced company names to compact domains', () => {
  const answer = [
    '1. Regional Joint Care — broad orthopedic network',
    '2. Northstar Ortho — physician bios and outcomes',
  ].join('\n')

  expect(
    extractRecommendedCompetitors(
      answer,
      ['acmehealth.com'],
      ['regionaljointcare.com', 'northstarortho.com'],
      [],
    ),
  ).toEqual(['Regional Joint Care', 'Northstar Ortho'])
})

import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

import { OnboardingProgress } from '../src/components/shared/OnboardingProgress.js'

afterEach(cleanup)

test('keeps the three onboarding stages concise and marks AI Visibility as optional', () => {
  render(<OnboardingProgress current="fixes" />)

  const progress = screen.getByRole('list', { name: 'Onboarding progress' })
  const siteAudit = within(progress).getByText('Scan site').closest('li')
  const fixes = within(progress).getByText('Page health').closest('li')
  const visibility = within(progress).getByText('AI Visibility').closest('li')

  expect(siteAudit?.textContent).not.toContain('Done')
  expect(fixes?.getAttribute('aria-current')).toBe('step')
  expect(visibility?.textContent).toContain('Optional')
  expect(progress.textContent).not.toMatch(/Current|Upcoming/)
})

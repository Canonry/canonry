import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { AdvancedMeasurementSetup } from '../src/components/project/advanced-measurement/AdvancedMeasurementSetup.js'

afterEach(cleanup)

const importProperties = {
  importDraft: {
    sitemapUrl: '',
    examplePropertyUrl: '',
    preferredHost: '',
    propertyPathPattern: '',
    additionalHost: '',
    additionalPathPattern: '',
    excludedPaths: '',
  },
  onImportDraftChange: vi.fn(),
  onReviewSitemap: vi.fn(),
  reviewState: 'idle' as const,
  properties: [],
  propertiesState: 'ready' as const,
  propertiesSearch: '',
  onPropertiesSearchChange: vi.fn(),
  selectedPropertyIds: [],
  onSelectedPropertyIdsChange: vi.fn(),
  onContinue: vi.fn(),
  onRetryProperties: vi.fn(),
  onReturnToImport: vi.fn(),
}

const properties = [{ id: 'harbor-house', label: 'Harbor House', urlCount: 2 }]
const queries = {
  properties,
  queries: [],
  selectedQueryIds: [],
  onSelectedQueryIdsChange: vi.fn(),
  onApplySelectedQueries: vi.fn(),
  onRemoveQuery: vi.fn(),
  groups: [],
  audience: { kind: 'all' as const },
  onAudienceChange: vi.fn(),
  onContinue: vi.fn(),
}

const groups = {
  properties,
  groups: [],
  groupDraft: { name: '', propertyIds: [], competitorDomains: '' },
  onGroupDraftChange: vi.fn(),
  onSaveGroup: vi.fn(),
  onSkipGroups: vi.fn(),
  onContinue: vi.fn(),
}

const review = {
  counts: { properties: 1, queries: 0, groups: 0 },
  flaggedExceptions: [],
  canPublish: false,
  onPublish: vi.fn(),
}

describe('advanced measurement setup composition', () => {
  it.each([
    ['import', 'Sitemap URL'],
    ['properties', 'Locations'],
    ['queries', 'Queries'],
    ['groups', 'Group name'],
    ['review', 'Flagged exceptions'],
  ] as const)('renders the %s step inside the shared draft shell', (currentStep, expectedText) => {
    const stepProps = currentStep === 'import' || currentStep === 'properties'
      ? { currentStep, importProperties }
      : currentStep === 'queries'
        ? { currentStep, queries }
        : currentStep === 'groups'
          ? { currentStep, groups }
          : { currentStep, review }

    render(
      <AdvancedMeasurementSetup
        canEdit
        hasDraft
        onDiscard={vi.fn()}
        {...stepProps}
      />,
    )

    expect(screen.getByText('Draft')).toBeTruthy()
    expect(screen.getAllByText(expectedText).length).toBeGreaterThan(0)
  })

  // Renamed from "threads the empty-library action". The button it clicked was
  // "Manage project queries", the old exit out of the wizard; the escape hatch
  // is now secondary to creating questions in place, so the label moved with it.
  it('threads the project-question actions into the Questions step', () => {
    const onManageProjectQueries = vi.fn()
    render(
      <AdvancedMeasurementSetup
        currentStep="queries"
        canEdit
        hasDraft
        onManageProjectQueries={onManageProjectQueries}
        queries={{ ...queries, onCreateQueries: vi.fn() }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Manage project queries' }))
    expect(onManageProjectQueries).toHaveBeenCalledTimes(1)
  })

  it('forwards optional step navigation without changing the active step content', () => {
    const onStepChange = vi.fn()
    render(
      <AdvancedMeasurementSetup
        currentStep="review"
        canEdit={false}
        hasDraft
        onStepChange={onStepChange}
        review={review}
      />,
    )

    expect(screen.getByText('Flagged exceptions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Queries' }))
    expect(onStepChange).toHaveBeenCalledWith('queries')
  })
})

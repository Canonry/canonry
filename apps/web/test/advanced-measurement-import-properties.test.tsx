import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import {
  SetupImportProperties,
  type AdvancedMeasurementImportDraft,
  type AdvancedMeasurementImportPropertiesProps,
  type AdvancedMeasurementProperty,
} from '../src/components/project/advanced-measurement/SetupImportProperties.js'

const properties: readonly AdvancedMeasurementProperty[] = [
  {
    id: 'north-office',
    name: 'North Office',
    url: 'https://example.com/offices/north',
    urls: ['https://example.com/offices/north', 'https://north.example.com'],
    state: 'proposed',
  },
  {
    id: 'central-office',
    name: 'Central Office',
    url: 'https://example.com/offices/central',
    state: 'confirmed',
  },
  {
    id: 'south-office',
    name: 'South Office',
    url: 'https://example.com/offices/south',
    state: 'excluded',
  },
]

const initialImportDraft: AdvancedMeasurementImportDraft = {
  sitemapUrl: '',
  examplePropertyUrl: '',
  preferredHost: '',
  propertyPathPattern: '',
  additionalHost: '',
  additionalPathPattern: '',
  excludedPaths: '',
}

function buildProps(overrides: Partial<AdvancedMeasurementImportPropertiesProps> = {}): AdvancedMeasurementImportPropertiesProps {
  return {
    activeStep: 'import',
    canEdit: true,
    importDraft: initialImportDraft,
    onImportDraftChange: vi.fn(),
    onReviewSitemap: vi.fn(),
    reviewState: 'idle',
    properties,
    propertiesState: 'ready',
    propertiesSearch: '',
    onPropertiesSearchChange: vi.fn(),
    selectedPropertyIds: [],
    onSelectedPropertyIdsChange: vi.fn(),
    onContinue: vi.fn(),
    onRetryProperties: vi.fn(),
    onReturnToImport: vi.fn(),
    ...overrides,
  }
}

function ImportHarness({ onReviewSitemap = vi.fn() }: { onReviewSitemap?: AdvancedMeasurementImportPropertiesProps['onReviewSitemap'] }) {
  const [importDraft, setImportDraft] = useState(initialImportDraft)

  return (
    <SetupImportProperties
      {...buildProps({ importDraft, onImportDraftChange: setImportDraft, onReviewSitemap })}
    />
  )
}

function PropertiesHarness({
  canEdit = true,
  rows = properties,
  propertiesState = 'ready',
  maxVisibleProperties,
  onContinue = vi.fn(),
  onRetryProperties = vi.fn(),
  onReturnToImport = vi.fn(),
  initialSelectedPropertyIds,
  isContinuing = false,
}: {
  canEdit?: boolean
  rows?: readonly AdvancedMeasurementProperty[]
  propertiesState?: AdvancedMeasurementImportPropertiesProps['propertiesState']
  maxVisibleProperties?: number
  onContinue?: AdvancedMeasurementImportPropertiesProps['onContinue']
  onRetryProperties?: AdvancedMeasurementImportPropertiesProps['onRetryProperties']
  onReturnToImport?: AdvancedMeasurementImportPropertiesProps['onReturnToImport']
  initialSelectedPropertyIds?: readonly string[]
  isContinuing?: boolean
}) {
  const [propertiesSearch, setPropertiesSearch] = useState('')
  const [visiblePropertyLimit, setVisiblePropertyLimit] = useState(maxVisibleProperties)
  const [selectedPropertyIds, setSelectedPropertyIds] = useState<readonly string[]>(
    initialSelectedPropertyIds ?? rows.filter(property => property.state === 'confirmed').map(property => property.id),
  )

  return (
    <SetupImportProperties
      {...buildProps({
        activeStep: 'properties',
        canEdit,
        properties: rows,
        propertiesState,
        propertiesSearch,
        onPropertiesSearchChange: setPropertiesSearch,
        selectedPropertyIds,
        onSelectedPropertyIdsChange: setSelectedPropertyIds,
        maxVisibleProperties: visiblePropertyLimit,
        onShowAllProperties: () => setVisiblePropertyLimit(rows.length),
        onContinue,
        onRetryProperties,
        onReturnToImport,
        isContinuing,
      })}
    />
  )
}

function expectNoImplementationLanguage(container: HTMLElement) {
  const rendered = container.textContent?.toLowerCase() ?? ''
  for (const banned of ['target', 'edge', 'node', 'manifest', 'revision', 'checksum', 'stablekey']) {
    expect(rendered).not.toContain(banned)
  }
}

afterEach(() => {
  cleanup()
})

describe('SetupImportProperties import step', () => {
  test('requires a sitemap and either an example Property page or an explicit path pattern', () => {
    const onReviewSitemap = vi.fn()
    render(<ImportHarness onReviewSitemap={onReviewSitemap} />)

    const reviewButton = screen.getByRole('button', { name: 'Review sitemap' })
    expect(reviewButton).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://example.com/sitemap.xml' } })
    expect(reviewButton).toHaveProperty('disabled', true)
    expect(screen.getByText('This shows Canonry the Property URL pattern. Or enter the pattern under More import options.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Example Property page'), { target: { value: 'https://example.com/offices/north' } })
    expect(reviewButton).toHaveProperty('disabled', false)
  })

  test('keeps the sitemap and an example Property page primary, with advanced rules behind a compact disclosure', () => {
    const onReviewSitemap = vi.fn()
    const { container } = render(<ImportHarness onReviewSitemap={onReviewSitemap} />)

    expect(screen.getByRole('heading', { name: 'Add Properties' })).toBeTruthy()
    expect(screen.getByLabelText('Sitemap URL')).toBeTruthy()
    const examplePropertyPage = screen.getByLabelText('Example Property page')
    expect(examplePropertyPage.closest('details')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review sitemap' })).toBeTruthy()

    const rules = screen.getByText('More import options').closest('details')
    expect(rules).not.toBeNull()
    expect(rules?.open).toBe(false)
    expect(within(rules!).queryByLabelText('Example Property page')).toBeNull()
    expect(within(rules!).getByLabelText('Use URLs from this domain')).toBeTruthy()
    expect(within(rules!).getByLabelText('Property URL pattern')).toBeTruthy()
    expect(within(rules!).getByLabelText('Additional URL domain')).toBeTruthy()
    expect(within(rules!).getByLabelText('Additional URL pattern')).toBeTruthy()
    expect(within(rules!).getByLabelText('Ignore these URL paths')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Sitemap URL'), { target: { value: 'https://example.com/sitemap.xml' } })
    fireEvent.change(examplePropertyPage, { target: { value: 'https://example.com/offices/north' } })
    fireEvent.change(within(rules!).getByLabelText('Use URLs from this domain'), { target: { value: 'example.com' } })
    fireEvent.change(within(rules!).getByLabelText('Property URL pattern'), { target: { value: '/offices/*' } })
    fireEvent.change(within(rules!).getByLabelText('Additional URL domain'), { target: { value: 'offices.example.com' } })
    fireEvent.change(within(rules!).getByLabelText('Additional URL pattern'), { target: { value: '/*' } })
    fireEvent.change(within(rules!).getByLabelText('Ignore these URL paths'), { target: { value: '/offices/archive' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review sitemap' }))

    expect(onReviewSitemap).toHaveBeenCalledWith({
      sitemapUrl: 'https://example.com/sitemap.xml',
      examplePropertyUrl: 'https://example.com/offices/north',
      preferredHost: 'example.com',
      propertyPathPattern: '/offices/*',
      additionalHost: 'offices.example.com',
      additionalPathPattern: '/*',
      excludedPaths: '/offices/archive',
    })
    expect(screen.queryByRole('button', { name: /publish|create/i })).toBeNull()
    expectNoImplementationLanguage(container)
  })
})

describe('SetupImportProperties Properties step', () => {
  test('uses a table, lets users revise every Property, and confirms the whole selection on Continue', () => {
    const onContinue = vi.fn()
    const { container } = render(<PropertiesHarness onContinue={onContinue} />)

    expect(screen.getByRole('heading', { name: 'Properties' })).toBeTruthy()
    expect(screen.getByRole('table', { name: 'Properties to review' })).toBeTruthy()
    expect(screen.getByText('New')).toBeTruthy()
    expect(screen.getByText('Included')).toBeTruthy()
    expect(screen.getByText('Excluded')).toBeTruthy()
    expect(screen.getByText('Showing 3 of 3 Properties')).toBeTruthy()
    expect(screen.getByText('1 of 3 selected')).toBeTruthy()
    const urlCoverage = screen.getByText('2 URLs').closest('details')
    expect(urlCoverage?.open).toBe(false)
    expect(within(urlCoverage!).getByText('https://north.example.com')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /confirm selected/i })).toBeNull()
    expect(screen.getByLabelText('Select North Office').className).toContain('size-6')
    expect(screen.getByLabelText('Select South Office')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    fireEvent.click(screen.getByRole('button', { name: /^Continue(?: with \d+ Propert(?:y|ies))?$/ }))

    expect(onContinue).toHaveBeenCalledWith(['north-office', 'central-office', 'south-office'])
    expectNoImplementationLanguage(container)
  })

  test('supports going back and clearing a prior selection before continuing', () => {
    const onContinue = vi.fn()
    const onReturnToImport = vi.fn()
    render(<PropertiesHarness onContinue={onContinue} onReturnToImport={onReturnToImport} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add Properties' }))
    expect(onReturnToImport).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByRole('button', { name: /^Continue(?: with \d+ Propert(?:y|ies))?$/ })).toHaveProperty('disabled', true)
    expect(onContinue).not.toHaveBeenCalled()
  })

  test('freezes every mutable Property control while the selection is saving', () => {
    const onReturnToImport = vi.fn()
    render(<PropertiesHarness isContinuing onReturnToImport={onReturnToImport} />)

    expect(screen.getByRole('searchbox', { name: 'Search Properties' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Select all shown' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Clear selection' })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Select North Office')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Add Properties' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Saving Properties…' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Add Properties' }))
    expect(onReturnToImport).not.toHaveBeenCalled()
  })

  test('filters with compact search and gives every limited list a Showing N of M count', () => {
    render(<PropertiesHarness maxVisibleProperties={2} />)

    expect(screen.getByText('Showing 2 of 3 Properties')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Properties' }), { target: { value: 'South' } })
    expect(screen.getByText('Showing 1 of 1 Properties')).toBeTruthy()
    expect(screen.getByText('South Office')).toBeTruthy()
    expect(screen.queryByText('North Office')).toBeNull()
  })

  test('keeps a large sitemap review bounded until the operator asks to see all Properties', () => {
    const manyProperties = Array.from({ length: 55 }, (_, index): AdvancedMeasurementProperty => ({
      id: `office-${index + 1}`,
      name: `Office ${index + 1}`,
      url: `https://example.com/offices/${index + 1}`,
      state: 'proposed',
    }))
    render(<PropertiesHarness rows={manyProperties} maxVisibleProperties={50} />)

    expect(screen.getByText('Showing 50 of 55 Properties')).toBeTruthy()
    expect(screen.queryByLabelText('Select Office 51')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show all Properties' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show all Properties' }))

    expect(screen.getByText('Showing 55 of 55 Properties')).toBeTruthy()
    expect(screen.getByLabelText('Select Office 51')).toBeTruthy()
  })

  test('keeps the data visible to a viewer while hiding mutating controls', () => {
    render(<PropertiesHarness canEdit={false} />)

    expect(screen.getByText('North Office')).toBeTruthy()
    expect(screen.getByText('Viewing only. Property changes are unavailable.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Select all shown' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Continue(?: with \d+ Propert(?:y|ies))?$/ })).toBeNull()
  })

  test('allows an existing confirmed setup to continue without new proposals', () => {
    const onContinue = vi.fn()
    render(<PropertiesHarness rows={[properties[1]!]} onContinue={onContinue} />)

    fireEvent.click(screen.getByRole('button', { name: /^Continue(?: with \d+ Propert(?:y|ies))?$/ }))
    expect(onContinue).toHaveBeenCalledWith(['central-office'])
  })

  test('offers truthful recovery for loading, error, and empty data', () => {
    const onRetryProperties = vi.fn()
    const onReturnToImport = vi.fn()
    const loading = render(
      <PropertiesHarness
        propertiesState="loading"
        rows={[]}
        onRetryProperties={onRetryProperties}
      />,
    )

    expect(screen.getByText('Loading Properties…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Properties' }))
    expect(onRetryProperties).toHaveBeenCalledTimes(1)
    loading.unmount()

    render(
      <PropertiesHarness
        propertiesState="error"
        rows={[]}
        onRetryProperties={onRetryProperties}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Could not load Properties.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryProperties).toHaveBeenCalledTimes(2)
    cleanup()

    render(
      <PropertiesHarness
        rows={[]}
        onReturnToImport={onReturnToImport}
      />,
    )
    expect(screen.getByText('No Properties were found.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review sitemap' }))
    expect(onReturnToImport).toHaveBeenCalledTimes(1)
  })
})

import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { mockDownloadResultsExport } = vi.hoisted(() => ({ mockDownloadResultsExport: vi.fn() }))

vi.mock('../src/api.js', () => ({
  addLocation: vi.fn(),
  downloadResultsExport: mockDownloadResultsExport,
  isEmbed: vi.fn(() => false),
  removeLocation: vi.fn(),
  setDefaultLocation: vi.fn(),
}))

import { ProjectSettingsSection } from '../src/components/project/ProjectSettingsSection.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('offers explicit CSV and JSON tracking-results downloads in Project Settings', async () => {
  mockDownloadResultsExport.mockResolvedValue(undefined)
  render(
    <ProjectSettingsSection
      project={{
        name: 'acme',
        displayName: 'Acme',
        canonicalDomain: 'acme.example',
        ownedDomains: [],
        aliases: [],
        country: 'US',
        language: 'en',
        locations: [],
        defaultLocation: null,
      }}
      onUpdateProject={vi.fn().mockResolvedValue(undefined)}
      onRefresh={vi.fn()}
    />,
  )

  expect(screen.getByRole('heading', { name: 'Tracking results' })).toBeTruthy()
  expect(screen.getByText(/historical citation and mention observations/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Download CSV' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Download JSON' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
  await waitFor(() => {
    expect(mockDownloadResultsExport).toHaveBeenCalledWith('acme', 'csv')
  })
})

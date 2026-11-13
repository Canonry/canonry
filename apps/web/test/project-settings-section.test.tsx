import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProjectSettingsSection } from '../src/components/project/ProjectSettingsSection.js'

afterEach(cleanup)

function project(overrides: { country?: string; language?: string } = {}) {
  return {
    name: 'acme',
    displayName: 'Acme',
    canonicalDomain: 'acme.example',
    ownedDomains: ['docs.acme.example'],
    aliases: ['Acme Co'],
    country: 'US',
    language: 'en',
    locations: [],
    defaultLocation: null,
    ...overrides,
  }
}

/** The read-only settings table as label/value pairs, in order. */
function settingsRows(): Array<[string, string]> {
  return [...document.querySelectorAll('section table > tbody > tr')].map(row => [
    row.children[0]?.textContent ?? '',
    row.children[1]?.textContent ?? '',
  ])
}

test.each([
  { country: 'US', language: 'en', market: 'United States · English' },
  { country: 'gb', language: 'FR', market: 'United Kingdom · French' },
])('settings name the $country / $language market as people read it, and the main domain by its plain name', ({ country, language, market }) => {
  render(<ProjectSettingsSection project={project({ country, language })} onUpdateProject={vi.fn()} />)
  expect(settingsRows().map(([label]) => label)).toEqual(['Display name', 'Main domain', 'Owned domains', 'Aliases', 'Market', 'Search locations'])
  expect(settingsRows().find(([label]) => label === 'Market')?.[1]).toBe(market)
  expect(settingsRows().find(([label]) => label === 'Main domain')?.[1]).toBe('acme.example')
  expect(screen.queryByText('Canonical domain')).toBeNull()
  expect(screen.queryByText('Search Locations')).toBeNull()
})

test('the editor names every field, and Main domain still saves the canonical domain', async () => {
  const onUpdateProject = vi.fn().mockResolvedValue(undefined)
  render(<ProjectSettingsSection project={project()} onUpdateProject={onUpdateProject} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit settings' }))

  expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Acme')
  expect((screen.getByLabelText('Country') as HTMLInputElement).value).toBe('US')
  expect((screen.getByLabelText('Language') as HTMLInputElement).value).toBe('en')
  expect((screen.getByLabelText('Owned domains') as HTMLInputElement).placeholder).toBe('docs.example.com')
  expect((screen.getByLabelText('Aliases') as HTMLInputElement).placeholder).toBe('Facebook')
  const mainDomain = screen.getByLabelText('Main domain') as HTMLInputElement
  expect(mainDomain.value).toBe('acme.example')

  fireEvent.change(mainDomain, { target: { value: 'www.acme.example' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(onUpdateProject).toHaveBeenCalledWith('acme', {
    displayName: 'Acme',
    canonicalDomain: 'www.acme.example',
    ownedDomains: ['docs.acme.example'],
    aliases: ['Acme Co'],
    country: 'US',
    language: 'en',
  }))
})

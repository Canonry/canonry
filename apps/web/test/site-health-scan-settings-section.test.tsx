import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { SiteHealthScanSettingsSection } from '../src/components/project/ProjectEngineSettingsSection.js'
import { AccountProvider, type ApiKeyAccess, type SignedInAccount } from '../src/contexts/account-context.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

// Independent literals, not the exported copy constant: a copy change must show up here.
const HELP = "Used by every scan that sets no budget, scheduled or manual. Onboarding's first look always checks 100 pages."
const CUSTOM_ERROR = 'Enter a whole number from 1 to 50,000.'
const OPTIONS = [
  ['full', 'Full site (up to 50,000 pages)'],
  ['100', '100 pages (quick look)'],
  ['500', '500 pages'],
  ['2500', '2,500 pages'],
  ['10000', '10,000 pages'],
  ['custom', 'Custom number...'],
]

const PROJECT_WRITER: ApiKeyAccess = { id: 'project-writer', scopes: ['*'], projectId: 'project-1', readOnly: false }

function renderSection(
  siteAuditMaxPages: number | null | undefined,
  options: { onSave?: (budget: number | null) => Promise<void>; account?: SignedInAccount | null; apiKey?: ApiKeyAccess } = {},
) {
  const onSave = vi.fn(options.onSave ?? (async () => {}))
  const view = render(
    <AccountProvider account={options.account ?? null} apiKey={options.apiKey}>
      <SiteHealthScanSettingsSection project={{ siteAuditMaxPages }} onSave={onSave} />
    </AccountProvider>,
  )
  const rerender = (next: number | null | undefined) => view.rerender(
    <AccountProvider account={options.account ?? null} apiKey={options.apiKey}>
      <SiteHealthScanSettingsSection project={{ siteAuditMaxPages: next }} onSave={onSave} />
    </AccountProvider>,
  )
  return { onSave, rerender }
}

function section() {
  return screen.getByRole('region', { name: 'Site Health scans' })
}
function budgetSelect() {
  return screen.getByRole('combobox', { name: 'Page budget' }) as HTMLSelectElement
}
function saveButton() {
  return screen.getByRole('button', { name: 'Save page budget' }) as HTMLButtonElement
}

test('the heading carries its explanation in a sibling tooltip and the select offers every budget', () => {
  renderSection(null)

  expect(screen.getByRole('heading', { level: 2, name: 'Site Health scans' })).not.toBeNull()
  expect(within(section()).getByRole('button', { name: HELP })).not.toBeNull()
  const options = within(budgetSelect()).getAllByRole('option') as HTMLOptionElement[]
  expect(options.map(option => [option.value, option.textContent])).toEqual(OPTIONS)
})

test.each([
  { saved: null, choice: 'full', custom: null },
  // An unset field from the server is the full site, as the server formats it.
  { saved: undefined, choice: 'full', custom: null },
  { saved: 100, choice: '100', custom: null },
  { saved: 2_500, choice: '2500', custom: null },
  { saved: 10_000, choice: '10000', custom: null },
  { saved: 750, choice: 'custom', custom: '750' },
  { saved: 50_000, choice: 'custom', custom: '50000' },
])('a saved budget of $saved shows as $choice', ({ saved, choice, custom }) => {
  renderSection(saved)

  expect(budgetSelect().value).toBe(choice)
  const input = screen.queryByRole('spinbutton', { name: 'Custom page budget' }) as HTMLInputElement | null
  expect(input?.value ?? null).toBe(custom)
  // Nothing has changed yet, so there is nothing to save or cancel.
  expect(saveButton().disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
})

test('choosing a preset saves that number and the form settles on it', async () => {
  const { onSave } = renderSection(null)

  fireEvent.change(budgetSelect(), { target: { value: '2500' } })
  expect(saveButton().disabled).toBe(false)
  fireEvent.click(saveButton())

  await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(2_500))
  expect((await screen.findByRole('status')).textContent).toBe('Page budget saved.')
  expect(budgetSelect().value).toBe('2500')
  expect(saveButton().disabled).toBe(true)
})

test('choosing Full site saves null, which clears a saved budget', async () => {
  const { onSave } = renderSection(2_500)

  fireEvent.change(budgetSelect(), { target: { value: 'full' } })
  fireEvent.click(saveButton())

  await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(null))
  await screen.findByRole('status')
  expect(budgetSelect().value).toBe('full')
})

test('a custom number must be a whole number from 1 to 50,000 before it can be saved', async () => {
  const { onSave } = renderSection(500)

  act(() => { fireEvent.change(budgetSelect(), { target: { value: 'custom' } }) })
  const input = screen.getByRole('spinbutton', { name: 'Custom page budget' }) as HTMLInputElement
  await waitFor(() => expect(document.activeElement).toBe(input))
  // An empty field opened by the select is not an error yet, but cannot be saved.
  expect(input.value).toBe('')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(saveButton().disabled).toBe(true)

  for (const invalid of ['0', '50001', '2.5', '-3']) {
    fireEvent.change(input, { target: { value: invalid } })
    expect(screen.getByRole('alert').textContent, invalid).toBe(CUSTOM_ERROR)
    expect(input.getAttribute('aria-invalid'), invalid).toBe('true')
    expect(input.getAttribute('aria-describedby'), invalid).toBe(screen.getByRole('alert').id)
    expect(saveButton().disabled, invalid).toBe(true)
  }
  // Clearing a typed number is an error too: the field was touched.
  fireEvent.change(input, { target: { value: '' } })
  expect(screen.getByRole('alert').textContent).toBe(CUSTOM_ERROR)
  expect(saveButton().disabled).toBe(true)

  for (const valid of ['1', '50000', '750']) {
    fireEvent.change(input, { target: { value: valid } })
    expect(screen.queryByRole('alert'), valid).toBeNull()
    expect(input.getAttribute('aria-invalid'), valid).toBe('false')
    expect(saveButton().disabled, valid).toBe(false)
  }
  fireEvent.click(saveButton())
  await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(750))
  expect(budgetSelect().value).toBe('custom')
  expect((screen.getByRole('spinbutton', { name: 'Custom page budget' }) as HTMLInputElement).value).toBe('750')
})

test('a custom number equal to the saved budget is not a change, and one matching a preset saves as it', async () => {
  const { onSave } = renderSection(500)

  fireEvent.change(budgetSelect(), { target: { value: 'custom' } })
  const input = screen.getByRole('spinbutton', { name: 'Custom page budget' })
  fireEvent.change(input, { target: { value: '500' } })
  expect(saveButton().disabled).toBe(true)

  fireEvent.change(input, { target: { value: '10000' } })
  fireEvent.click(saveButton())
  await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(10_000))
  await screen.findByRole('status')
  expect(budgetSelect().value).toBe('10000')
  expect(screen.queryByRole('spinbutton', { name: 'Custom page budget' })).toBeNull()
})

test('Cancel restores the saved budget', () => {
  renderSection(750)

  fireEvent.change(budgetSelect(), { target: { value: '100' } })
  expect(screen.queryByRole('spinbutton', { name: 'Custom page budget' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  expect(budgetSelect().value).toBe('custom')
  expect((screen.getByRole('spinbutton', { name: 'Custom page budget' }) as HTMLInputElement).value).toBe('750')
  expect(saveButton().disabled).toBe(true)
})

test('a background project refetch does not clobber an edit, and a new stored value shows once idle', () => {
  const { rerender } = renderSection(500)

  fireEvent.change(budgetSelect(), { target: { value: '10000' } })
  rerender(2_500)
  expect(budgetSelect().value).toBe('10000')

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  rerender(100)
  expect(budgetSelect().value).toBe('100')
})

test('the section is busy while saving and a refused save keeps the draft with the error', async () => {
  let reject!: (cause: unknown) => void
  const { onSave } = renderSection(null, { onSave: () => new Promise((_, fail) => { reject = fail }) })

  fireEvent.change(budgetSelect(), { target: { value: '500' } })
  fireEvent.click(saveButton())

  expect(section().getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('button', { name: 'Saving page budget…' })).not.toBeNull()
  expect(budgetSelect().disabled).toBe(true)
  await act(async () => { reject(new Error('Page budget must be at most 50000')) })

  expect(onSave).toHaveBeenCalledExactlyOnceWith(500)
  expect(screen.getByRole('alert').textContent).toBe('Page budget must be at most 50000')
  expect(section().getAttribute('aria-busy')).toBe('false')
  expect(budgetSelect().value).toBe('500')
  expect(saveButton().disabled).toBe(false)
})

test.each([
  { label: 'a viewer', account: { name: 'viewer', role: 'viewer' as const }, apiKey: undefined, managed: false },
  { label: 'a read-only key', account: null, apiKey: { ...PROJECT_WRITER, readOnly: true }, managed: false },
  { label: 'a project writer when Site Health scans are managed', account: null, apiKey: PROJECT_WRITER, managed: true },
])('$label reads the saved budget without a control to change it', ({ account, apiKey, managed }) => {
  if (managed) window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  for (const [saved, text] of [
    [null, 'Page budget: Full site (up to 50,000 pages)'],
    [100, 'Page budget: 100 pages (quick look)'],
    [2_500, 'Page budget: 2,500 pages'],
    [750, 'Page budget: 750 pages'],
    [1, 'Page budget: 1 page'],
  ] as const) {
    renderSection(saved, { account, apiKey })
    expect(section().textContent).toBe(`Site Health scans${text}`)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button', { name: /Save|Cancel/ })).toBeNull()
    cleanup()
  }
})

test.each([
  { label: 'embed', config: { embed: { enabled: true } } },
  { label: 'public demo', config: { demo: { enabled: true, readOnly: true, sampleData: true } } },
])('the $label shows the saved budget and nothing editable', ({ config }) => {
  window.__CANONRY_CONFIG__ = config
  renderSection(10_000)

  expect(section().textContent).toBe('Site Health scans' + 'Page budget: 10,000 pages')
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('spinbutton')).toBeNull()
  expect(screen.queryByRole('button', { name: /Save|Cancel/ })).toBeNull()
})

test.each([
  { label: 'a project writer', account: null, apiKey: PROJECT_WRITER, managed: false },
  { label: 'an administrator when Site Health scans are managed', account: { name: 'admin', role: 'admin' as const }, apiKey: undefined, managed: true },
  { label: 'an install without accounts when Site Health scans are managed', account: null, apiKey: undefined, managed: true },
])('$label can change the budget', async ({ account, apiKey, managed }) => {
  if (managed) window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['site-audit'] } }
  const { onSave } = renderSection(null, { account, apiKey })

  fireEvent.change(budgetSelect(), { target: { value: '100' } })
  fireEvent.click(saveButton())
  await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(100))
})

test('a managed answer-visibility deployment alone leaves a project writer able to change it', () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedRunKinds: ['answer-visibility'] } }
  renderSection(null, { apiKey: PROJECT_WRITER })
  expect(budgetSelect().value).toBe('full')
})


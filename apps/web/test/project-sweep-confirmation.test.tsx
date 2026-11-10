import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ProjectSweepConfirmation } from '../src/pages/ProjectPage.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { ProviderErrorCodes, runPreviewDtoSchema } from '@canonry/canonry-contracts'

afterEach(cleanup)

const preview = runPreviewDtoSchema.parse({
  mode: 'advanced', revision: 7, queryCount: 3, assignmentCount: 6,
  queryClasses: [{ queryClass: 'non-brand', queryCount: 2, assignmentCount: 4 }, { queryClass: 'branded', queryCount: 1, assignmentCount: 2 }],
  requestCount: 6, expectedRequestCount: 6,
  engines: [{ provider: 'gemini', models: ['gemini-test'], requestCount: 6, expectedRequestCount: 6, available: true }],
  locations: [{ location: 'Dallas', requestCount: 6 }],
  admission: { refused: false, retryAfter: null, providers: {} }, activeRunId: null, canStart: true, blockedReason: null,
})

test('a project-wide paid sweep requires explicit confirmation and cancel starts nothing', () => {
  const confirm = vi.fn()
  const close = vi.fn()
  render(<ProjectSweepConfirmation open projectLabel="Northstar Demo" onOpenChange={close} onConfirm={confirm} disabled={false} preview={preview} />)
  expect(screen.getByRole('dialog').textContent).toContain('View filters do not limit the check.')
  expect(screen.getByRole('dialog').textContent).toContain('Provider charges apply.')
  expect(screen.getByRole('dialog').textContent).toContain('Published plan · revision 7. Unpublished changes are not included.')
  expect(screen.getByRole('dialog').textContent).toContain('6 Property assignments')
  expect(screen.getByRole('dialog').textContent).toContain('2 non-brand queries · 1 branded query')
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledWith(false)
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Run project-wide check' }))
  expect(confirm).toHaveBeenCalledOnce()
})

test('a viewer or unavailable readiness cannot confirm a sweep', () => {
  const confirm = vi.fn()
  const props = { open: true, projectLabel: 'Northstar Demo', onOpenChange: vi.fn(), onConfirm: confirm, preview }
  const page = render(<ProjectSweepConfirmation {...props} disabled />)
  expect((screen.getByRole('button', { name: 'Run project-wide check' }) as HTMLButtonElement).disabled).toBe(true)
  page.rerender(<AccountProvider account={{ name: 'Viewer', role: 'viewer' }}><ProjectSweepConfirmation {...props} disabled={false} /></AccountProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Run project-wide check' }))
  expect(confirm).not.toHaveBeenCalled()
})

test('explains a held engine and its retry time while allowing the remaining requests', () => {
  const retryAfter = '2026-11-07T16:30:00.000Z'
  const partial = runPreviewDtoSchema.parse({
    ...preview,
    requestCount: 3,
    engines: [
      { provider: 'gemini', models: ['gemini-test'], requestCount: 3, expectedRequestCount: 3, available: true },
      { provider: 'openai', models: ['openai-test'], requestCount: 0, expectedRequestCount: 3, available: true },
    ],
    locations: [{ location: 'Dallas', requestCount: 3 }],
    admission: { refused: false, retryAfter: null, providers: { openai: { code: ProviderErrorCodes.PROVIDER_AUTH, consecutiveRuns: 3, since: '2026-11-06T10:00:00.000Z', latestRunId: 'failed-openai', retryAfter } } },
  })
  const confirm = vi.fn()
  render(<ProjectSweepConfirmation open projectLabel="Northstar Demo" onOpenChange={vi.fn()} onConfirm={confirm} disabled={false} preview={partial} />)
  const details = screen.getByRole('region', { name: 'Check details' })
  const held = within(details).getByRole('row', { name: /OpenAI/ })
  expect(held.textContent).toContain('Skipped: key rejected or access denied. On hold until')
  expect(held.querySelector('time')?.getAttribute('datetime')).toBe(retryAfter)
  expect(within(held).getByRole('cell', { name: '0', exact: true })).toBeTruthy()
  const available = within(details).getByRole('row', { name: /Gemini/ })
  expect(available.textContent).not.toContain('Skipped')
  expect(within(available).getByRole('cell', { name: '3', exact: true })).toBeTruthy()
  expect(within(details).getByText('3 of 6 planned answers can run.')).toBeTruthy()
  const launch = screen.getByRole('button', { name: 'Run project-wide check' })
  expect(launch).toHaveProperty('disabled', false)
  fireEvent.click(launch)
  expect(confirm).toHaveBeenCalledOnce()
})

test.each([
  { state: 'missing', preview: undefined, previewPending: false, previewFailed: false },
  { state: 'loading', preview, previewPending: true, previewFailed: false },
  { state: 'failed', preview, previewPending: false, previewFailed: true },
  { state: 'blocked', preview: { ...preview, canStart: false, blockedReason: 'unpublished-plan' as const }, previewPending: false, previewFailed: false },
])('cannot launch with a $state server preview', ({ state, ...previewProps }) => {
  const confirm = vi.fn()
  const retry = vi.fn()
  render(<ProjectSweepConfirmation open projectLabel="Northstar Demo" onOpenChange={vi.fn()} onConfirm={confirm} disabled={false} onRetryPreview={retry} {...previewProps} />)
  const launch = screen.getByRole('button', { name: 'Run project-wide check' })
  expect(launch).toHaveProperty('disabled', true)
  fireEvent.click(launch)
  expect(confirm).not.toHaveBeenCalled()
  if (state === 'failed') {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh check details' }))
    expect(retry).toHaveBeenCalledOnce()
  }
})


test('managed sweeps cannot expose an already-open confirmation dialog', () => {
  const original = window.__CANONRY_CONFIG__
  try {
    window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
    const confirm = vi.fn()
    render(<ProjectSweepConfirmation open projectLabel="Northstar Demo" onOpenChange={vi.fn()} onConfirm={confirm} disabled={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Run project-wide check' })).toBeNull()
    expect(confirm).not.toHaveBeenCalled()
  } finally {
    window.__CANONRY_CONFIG__ = original
  }
})

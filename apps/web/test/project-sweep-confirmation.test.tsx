import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectSweepConfirmation } from '../src/pages/ProjectPage.js'
import { AccountProvider } from '../src/contexts/account-context.js'

afterEach(cleanup)

test('a project-wide paid sweep requires explicit confirmation and cancel starts nothing', () => {
  const confirm = vi.fn()
  const close = vi.fn()
  render(<ProjectSweepConfirmation open projectLabel="Northstar Demo" onOpenChange={close} onConfirm={confirm} disabled={false} />)
  expect(screen.getByRole('dialog').textContent).toContain('Report filters do not limit the sweep.')
  expect(screen.getByRole('dialog').textContent).toContain('Provider charges apply.')
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledWith(false)
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Run project-wide sweep' }))
  expect(confirm).toHaveBeenCalledOnce()
})

test('a viewer or unavailable readiness cannot confirm a sweep', () => {
  const confirm = vi.fn()
  const props = { open: true, projectLabel: 'Northstar Demo', onOpenChange: vi.fn(), onConfirm: confirm }
  const page = render(<ProjectSweepConfirmation {...props} disabled />)
  expect((screen.getByRole('button', { name: 'Run project-wide sweep' }) as HTMLButtonElement).disabled).toBe(true)
  page.rerender(<AccountProvider account={{ name: 'Viewer', role: 'viewer' }}><ProjectSweepConfirmation {...props} disabled={false} /></AccountProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Run project-wide sweep' }))
  expect(confirm).not.toHaveBeenCalled()
})

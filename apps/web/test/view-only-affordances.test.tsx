/**
 * F5/F6 — a view-only account is told what it cannot do, before it tries.
 *
 * The server refuses these requests either way. The point of these tests is
 * that the dashboard does not offer a control that is going to fail, and that
 * when it leaves one visible it says plainly why it is off.
 */
import { afterEach, describe, expect, test } from 'vitest'

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'

import { AccountProvider, VIEW_ONLY_LABEL } from '../src/contexts/account-context.js'
import { AdminOnly, WriteButton } from '../src/components/shared/AccessControls.js'

afterEach(() => {
  cleanup()
})

function renderAs(role: 'admin' | 'viewer' | null, ui: React.ReactNode) {
  return render(
    <AccountProvider account={role ? { name: 'someone', role } : null}>{ui}</AccountProvider>,
  )
}

describe('a control that changes something', () => {
  test('works normally for an administrator', () => {
    renderAs('admin', <WriteButton>Run now</WriteButton>)
    const button = screen.getByRole('button', { name: 'Run now' })
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  test('works normally when the install has no accounts at all', () => {
    renderAs(null, <WriteButton>Run now</WriteButton>)
    expect(screen.getByRole('button', { name: 'Run now' }).hasAttribute('disabled')).toBe(false)
  })

  test('is switched off for a viewer, with an honest reason attached', () => {
    renderAs('viewer', <WriteButton>Run now</WriteButton>)
    const button = screen.getByRole('button', { name: 'Run now' })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('title')).toBe(VIEW_ONLY_LABEL)
    // The label says what the account can't do, not what the server returned.
    expect(VIEW_ONLY_LABEL).not.toMatch(/403|forbidden|scope/i)
    // Two short sentences, with no dash between them.
    expect(VIEW_ONLY_LABEL).toBe('View only. Your account cannot change this.')
  })

  test('stays off for a viewer even when the caller would have enabled it', () => {
    renderAs('viewer', <WriteButton disabled={false}>Run now</WriteButton>)
    expect(screen.getByRole('button', { name: 'Run now' }).hasAttribute('disabled')).toBe(true)
  })

  test('stays off for an administrator when the caller disabled it for its own reasons', () => {
    renderAs('admin', <WriteButton disabled>Run now</WriteButton>)
    expect(screen.getByRole('button', { name: 'Run now' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('a whole screen that only an administrator can use', () => {
  test('shows the screen to an administrator', () => {
    renderAs('admin', <AdminOnly title="Settings"><p>provider keys</p></AdminOnly>)
    expect(screen.getByText('provider keys')).toBeTruthy()
  })

  test('shows the screen when the install has no accounts', () => {
    renderAs(null, <AdminOnly title="Settings"><p>provider keys</p></AdminOnly>)
    expect(screen.getByText('provider keys')).toBeTruthy()
  })

  test('replaces it for a viewer with a plain explanation, not an error', () => {
    renderAs('viewer', <AdminOnly title="Settings"><p>provider keys</p></AdminOnly>)
    expect(screen.queryByText('provider keys')).toBeNull()
    expect(screen.getByText('Settings is for administrators')).toBeTruthy()
    expect(screen.getByText(/ask an administrator/i)).toBeTruthy()
  })
})

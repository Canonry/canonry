/**
 * P2.5 / P2.7 — the dashboard must not offer a view-only account controls that
 * are going to be refused, and it must not carry one account's data into the
 * next account's session.
 *
 * Hiding a control is never the boundary — the server refuses either way. But a
 * dashboard that lets somebody fill in a form, press the button, and only then
 * says no is lying to them about what their account is.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { AccountProvider, VIEW_ONLY_LABEL } from '../src/contexts/account-context.js'
import { assertCanWrite, ViewOnlyError } from '../src/lib/write-guard.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderAs(role: 'admin' | 'viewer' | null, ui: React.ReactNode) {
  return render(
    <AccountProvider account={role ? { name: 'someone', role } : null}>{ui}</AccountProvider>,
  )
}

/**
 * The write controls a person actually meets on a project. Each is rendered
 * through the same component the page uses, so a control that regresses to a
 * plain button fails here.
 */
describe('project write controls', () => {
  const controls = [
    'Run AI sweep',
    'Delete project',
    'Add competitor',
    'Add queries',
    'Refresh',
  ]

  test.each(controls)('%s is offered to an administrator', async (label) => {
    const { WriteButton } = await import('../src/components/shared/AccessControls.js')
    renderAs('admin', <WriteButton>{label}</WriteButton>)
    expect(screen.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(false)
  })

  test.each(controls)('%s is switched off for a viewer, with the reason attached', async (label) => {
    const { WriteButton } = await import('../src/components/shared/AccessControls.js')
    renderAs('viewer', <WriteButton>{label}</WriteButton>)
    const button = screen.getByRole('button', { name: label })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('title')).toBe(VIEW_ONLY_LABEL)
  })
})

/**
 * The belt to the WriteButton's braces. A page has dozens of controls and one
 * of them will eventually be added without the wrapper; this makes that a
 * refusal rather than a wasted round trip that ends in a 403.
 */
describe('the write guard under every mutation', () => {
  test('lets an administrator through', () => {
    expect(() => assertCanWrite({ account: { name: 'a', role: 'admin' }, canWrite: true, isAdmin: true })).not.toThrow()
  })

  test('lets an install with no accounts through', () => {
    expect(() => assertCanWrite({ account: null, canWrite: true, isAdmin: true })).not.toThrow()
  })

  test('stops a viewer before the request is made', () => {
    expect(() => assertCanWrite({ account: { name: 'a', role: 'viewer' }, canWrite: false, isAdmin: false }))
      .toThrow(ViewOnlyError)
  })

  test('explains itself in the same words the server uses', () => {
    try {
      assertCanWrite({ account: { name: 'a', role: 'viewer' }, canWrite: false, isAdmin: false })
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as Error).message).toBe(VIEW_ONLY_LABEL)
      expect((error as Error).message).not.toMatch(/403|forbidden|scope/i)
    }
  })
})

describe('a control that would still fire', () => {
  test('a viewer pressing a missed control does not reach the network', async () => {
    const { WriteButton } = await import('../src/components/shared/AccessControls.js')
    const onClick = vi.fn()
    renderAs('viewer', <WriteButton onClick={onClick}>Add competitor</WriteButton>)

    fireEvent.click(screen.getByRole('button', { name: 'Add competitor' }))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('every mutation hook carries the guard', () => {
  test('each one refuses before it builds a request', async () => {
    // Enumerated from the module rather than listed by hand, so a hook added
    // later without the guard fails here instead of shipping.
    const mutations = await import('../src/queries/mutations.js')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const url = await import('node:url')
    // Resolve from this file, not from the working directory. A cwd-relative
    // path only holds when vitest is started at the workspace root, so the
    // per-package run (`pnpm --filter … test`) reported this guard as broken
    // when it was fine.
    const here = path.dirname(url.fileURLToPath(import.meta.url))
    const source = fs.readFileSync(path.join(here, '../src/queries/mutations.ts'), 'utf8')

    const hookNames = Object.keys(mutations).filter(name => /^use[A-Z]/.test(name))
    expect(hookNames.length).toBeGreaterThan(5)

    const guarded = source.match(/onMutate: guardWrite,/g) ?? []
    expect(guarded).toHaveLength(hookNames.length)
  })
})

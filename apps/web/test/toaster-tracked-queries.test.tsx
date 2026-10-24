import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Toaster } from '../src/components/layout/Toaster.js'
import { addToast, getToasts, resetToasts, type ToastAction } from '../src/lib/toast-store.js'

const { navigate, openRun } = vi.hoisted(() => ({ navigate: vi.fn(), openRun: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('../src/hooks/use-drawer.js', () => ({ useDrawer: () => ({ openRun }) }))

afterEach(() => { cleanup(); resetToasts(); vi.clearAllMocks() })

test.each([
  { cta: { queryId: 'q-stopped' }, search: { queryWorkspace: 'tracked', trackingQueryId: 'q-stopped' } },
  { cta: { status: 'not-asked' }, search: { queryWorkspace: 'tracked', trackedStatus: 'not-asked' } },
])('a tracking notification opens the intended tracked query destination (%j)', ({ cta, search }) => {
  addToast({ title: '1 stopped', tone: 'positive', cta: { label: 'View', intent: 'view-tracked-queries', projectName: 'demo', ...cta } as ToastAction })
  render(<Toaster />)
  fireEvent.click(screen.getByRole('button', { name: 'View: 1 stopped' }))
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/projects/$projectName/queries', params: { projectName: 'demo' }, search })
  expect(openRun).not.toHaveBeenCalled()
  expect(getToasts()[0]?.state).toBe('closing')
})

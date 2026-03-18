import { describe, it, expect, afterEach } from 'vitest'
import { addToast, dismissToast, subscribe, getToasts } from '../src/lib/toast-store.js'

afterEach(() => {
  // Clear all toasts between tests
  for (const t of getToasts()) {
    dismissToast(t.id)
  }
})

describe('toast-store', () => {
  it('adds and retrieves toasts', () => {
    addToast('Something failed', 'negative')
    const toasts = getToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe('Something failed')
    expect(toasts[0].tone).toBe('negative')
  })

  it('dismisses a toast by id', () => {
    const id = addToast('Error 1', 'negative')
    addToast('Error 2', 'caution')
    expect(getToasts()).toHaveLength(2)
    dismissToast(id)
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0].message).toBe('Error 2')
  })

  it('notifies subscribers on add and dismiss', () => {
    const snapshots: number[] = []
    const unsub = subscribe((toasts) => {
      snapshots.push(toasts.length)
    })

    addToast('A', 'neutral')
    addToast('B', 'positive')
    const [first] = getToasts()
    dismissToast(first.id)

    expect(snapshots).toEqual([1, 2, 1])
    unsub()

    // After unsubscribe, no more notifications
    addToast('C', 'negative')
    expect(snapshots).toEqual([1, 2, 1])
  })

  it('uses negative tone by default', () => {
    addToast('Default tone')
    expect(getToasts()[0].tone).toBe('negative')
  })
})

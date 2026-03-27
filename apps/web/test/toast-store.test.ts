import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addToast,
  dismissToast,
  getToasts,
  resetToasts,
  subscribe,
  toastStoreConstants,
} from '../src/lib/toast-store.js'

beforeEach(() => {
  vi.useFakeTimers()
  resetToasts()
})

afterEach(() => {
  resetToasts()
  vi.useRealTimers()
})

describe('toast-store', () => {
  it('adds and retrieves structured toasts', () => {
    addToast({ title: 'Something failed', detail: 'Retry the request.', tone: 'negative' })
    const toasts = getToasts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toBe('Something failed')
    expect(toasts[0].detail).toBe('Retry the request.')
    expect(toasts[0].tone).toBe('negative')
    expect(toasts[0].state).toBe('open')
  })

  it('replaces a toast in place for dedupeMode replace', () => {
    const firstId = addToast({
      title: 'Queued',
      tone: 'neutral',
      dedupeKey: 'run:1',
      dedupeMode: 'replace',
    })

    const secondId = addToast({
      title: 'Completed',
      tone: 'positive',
      dedupeKey: 'run:1',
      dedupeMode: 'replace',
    })

    expect(firstId).toBe(secondId)
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]?.title).toBe('Completed')
    expect(getToasts()[0]?.tone).toBe('positive')
  })

  it('drops duplicate keyed toasts when dedupeMode is drop', () => {
    const firstId = addToast({
      title: 'Saved',
      tone: 'positive',
      dedupeKey: 'settings:provider',
      dedupeMode: 'drop',
    })

    const secondId = addToast({
      title: 'Saved again',
      tone: 'positive',
      dedupeKey: 'settings:provider',
      dedupeMode: 'drop',
    })

    expect(firstId).toBe(secondId)
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]?.title).toBe('Saved')
  })

  it('marks dismissed toasts as closing before removal', () => {
    const id = addToast({ title: 'Dismiss me', tone: 'neutral' })
    dismissToast(id)
    expect(getToasts()[0]?.state).toBe('closing')
    vi.advanceTimersByTime(toastStoreConstants.closeAnimationMs)
    expect(getToasts()).toHaveLength(0)
  })

  it('evicts the oldest toast immediately when capacity is exceeded', () => {
    for (let i = 0; i < toastStoreConstants.maxToasts; i += 1) {
      addToast({ title: `Toast ${i + 1}`, tone: 'neutral' })
    }

    addToast({ title: 'Toast overflow', tone: 'positive' })

    expect(getToasts()).toHaveLength(toastStoreConstants.maxToasts)
    expect(getToasts()[0]?.title).toBe('Toast 2')
    expect(getToasts().at(-1)?.title).toBe('Toast overflow')
  })

  it('notifies subscribers on add and final removal', () => {
    const snapshots: number[] = []
    const unsubscribe = subscribe((toasts) => {
      snapshots.push(toasts.length)
    })

    const id = addToast({ title: 'A', tone: 'neutral' })
    addToast({ title: 'B', tone: 'positive' })
    dismissToast(id)
    vi.advanceTimersByTime(toastStoreConstants.closeAnimationMs)

    expect(snapshots).toEqual([1, 2, 2, 1])
    unsubscribe()
  })
})

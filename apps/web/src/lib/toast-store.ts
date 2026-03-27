export type ToastTone = 'neutral' | 'positive' | 'caution' | 'negative'
export type ToastState = 'open' | 'closing'
export type ToastDedupeMode = 'replace' | 'drop'

export type ToastAction =
  | {
    label: string
    intent: 'open-run-drawer'
    runId: string
  }
  | {
    label: string
    intent: 'go-to-runs'
  }

export interface Toast {
  id: string
  title: string
  detail?: string
  tone: ToastTone
  durationMs: number
  dedupeKey?: string
  cta?: ToastAction
  state: ToastState
}

export interface ToastInput {
  title: string
  detail?: string
  tone?: ToastTone
  durationMs?: number
  dedupeKey?: string
  dedupeMode?: ToastDedupeMode
  cta?: ToastAction
}

type Listener = (toasts: Toast[]) => void

const DEFAULT_DURATION_MS = 6000
const MAX_TOASTS = 5
const CLOSE_ANIMATION_MS = 180

let toasts: Toast[] = []
let nextId = 0
const listeners = new Set<Listener>()
const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>()
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>()

function emit() {
  const snapshot = [...toasts]
  for (const fn of listeners) fn(snapshot)
}

function clearToastTimers(id: string) {
  const autoDismissTimer = autoDismissTimers.get(id)
  if (autoDismissTimer) {
    clearTimeout(autoDismissTimer)
    autoDismissTimers.delete(id)
  }

  const closeTimer = closeTimers.get(id)
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimers.delete(id)
  }
}

function removeToastImmediately(id: string) {
  clearToastTimers(id)
  const before = toasts.length
  toasts = toasts.filter(toast => toast.id !== id)
  if (toasts.length !== before) emit()
}

function scheduleAutoDismiss(toast: Toast) {
  clearToastTimers(toast.id)
  autoDismissTimers.set(toast.id, setTimeout(() => {
    dismissToast(toast.id)
  }, toast.durationMs))
}

function normalizeToastInput(input: string | ToastInput, tone: ToastTone, durationMs: number): ToastInput {
  if (typeof input === 'string') {
    return {
      title: input,
      tone,
      durationMs,
    }
  }
  return input
}

export function addToast(input: string, tone?: ToastTone, durationMs?: number): string
export function addToast(input: ToastInput): string
export function addToast(input: string | ToastInput, tone: ToastTone = 'negative', durationMs = DEFAULT_DURATION_MS): string {
  const normalized = normalizeToastInput(input, tone, durationMs)
  const nextToast: Toast = {
    id: String(++nextId),
    title: normalized.title,
    detail: normalized.detail,
    tone: normalized.tone ?? tone,
    durationMs: normalized.durationMs ?? durationMs,
    dedupeKey: normalized.dedupeKey,
    cta: normalized.cta,
    state: 'open',
  }

  if (normalized.dedupeKey) {
    const existing = toasts.find((toast) => toast.dedupeKey === normalized.dedupeKey)
    if (existing) {
      if ((normalized.dedupeMode ?? 'drop') === 'drop') {
        return existing.id
      }

      const replacedToast: Toast = {
        ...existing,
        title: nextToast.title,
        detail: nextToast.detail,
        tone: nextToast.tone,
        durationMs: nextToast.durationMs,
        cta: nextToast.cta,
        state: 'open',
      }
      toasts = toasts.map((toast) => toast.id === existing.id ? replacedToast : toast)
      emit()
      scheduleAutoDismiss(replacedToast)
      return existing.id
    }
  }

  if (toasts.length >= MAX_TOASTS) {
    // Capacity eviction is intentionally immediate so the incoming toast can
    // appear without waiting for an out-animation slot to clear.
    removeToastImmediately(toasts[0]!.id)
  }

  toasts = [...toasts, nextToast]
  emit()
  scheduleAutoDismiss(nextToast)
  return nextToast.id
}

export function dismissToast(id: string) {
  const toast = toasts.find((candidate) => candidate.id === id)
  if (!toast || toast.state === 'closing') return

  clearToastTimers(id)
  toasts = toasts.map((candidate) => candidate.id === id
    ? { ...candidate, state: 'closing' }
    : candidate)
  emit()

  closeTimers.set(id, setTimeout(() => {
    removeToastImmediately(id)
  }, CLOSE_ANIMATION_MS))
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getToasts(): Toast[] {
  return toasts
}

export function resetToasts() {
  for (const toast of toasts) {
    clearToastTimers(toast.id)
  }
  toasts = []
  nextId = 0
  emit()
}

export const toastStoreConstants = {
  closeAnimationMs: CLOSE_ANIMATION_MS,
  defaultDurationMs: DEFAULT_DURATION_MS,
  maxToasts: MAX_TOASTS,
}

type ToastTone = 'neutral' | 'positive' | 'caution' | 'negative'

export interface Toast {
  id: string
  message: string
  tone: ToastTone
  expiresAt: number
}

type Listener = (toasts: Toast[]) => void

let toasts: Toast[] = []
let nextId = 0
const listeners = new Set<Listener>()

function emit() {
  const snapshot = [...toasts]
  for (const fn of listeners) fn(snapshot)
}

export function addToast(message: string, tone: ToastTone = 'negative', durationMs = 6000) {
  const id = String(++nextId)
  const toast: Toast = { id, message, tone, expiresAt: Date.now() + durationMs }
  toasts = [...toasts, toast]
  emit()

  setTimeout(() => {
    dismissToast(id)
  }, durationMs)

  return id
}

export function dismissToast(id: string) {
  const before = toasts.length
  toasts = toasts.filter(t => t.id !== id)
  if (toasts.length !== before) emit()
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getToasts(): Toast[] {
  return toasts
}

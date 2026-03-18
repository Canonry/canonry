import { useSyncExternalStore, useCallback } from 'react'
import { X } from 'lucide-react'
import { subscribe, getToasts, dismissToast, type Toast } from '../../lib/toast-store.js'

const toneStyles: Record<Toast['tone'], string> = {
  negative: 'border-rose-700/60 bg-rose-950/80 text-rose-200',
  caution: 'border-amber-700/60 bg-amber-950/80 text-amber-200',
  positive: 'border-emerald-700/60 bg-emerald-950/80 text-emerald-200',
  neutral: 'border-zinc-700/60 bg-zinc-900/80 text-zinc-200',
}

export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, getToasts, getToasts)

  const handleDismiss = useCallback((id: string) => {
    dismissToast(id)
  }, [])

  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm"
    >
      {toasts.map(toast => (
        <div
          key={toast.id}
          role="alert"
          className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-2 ${toneStyles[toast.tone]}`}
        >
          <p className="flex-1 leading-snug">{toast.message}</p>
          <button
            type="button"
            onClick={() => handleDismiss(toast.id)}
            className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

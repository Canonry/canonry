import { useCallback, useSyncExternalStore } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { dismissToast, getToasts, subscribe, type Toast } from '../../lib/toast-store.js'
import { useDrawer } from '../../hooks/use-drawer.js'

const toneStyles: Record<Toast['tone'], string> = {
  negative: 'toast-card-negative',
  caution: 'toast-card-caution',
  positive: 'toast-card-positive',
  neutral: 'toast-card-neutral',
}

function actionAriaLabel(toast: Toast) {
  if (!toast.cta) return undefined
  return `${toast.cta.label}: ${toast.title}`
}

export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, getToasts, getToasts)
  const navigate = useNavigate()
  const { openRun } = useDrawer()

  const handleDismiss = useCallback((id: string) => {
    dismissToast(id)
  }, [])

  const handleAction = useCallback((toast: Toast) => {
    if (!toast.cta) return

    if (toast.cta.intent === 'open-run-drawer') {
      openRun(toast.cta.runId)
    } else {
      navigate({ to: '/runs' })
    }

    dismissToast(toast.id)
  }, [navigate, openRun])

  if (toasts.length === 0) return null

  return (
    <div className="toast-viewport" aria-label="Notifications">
      {toasts.map((toast) => (
        <section
          key={toast.id}
          role={toast.tone === 'negative' ? 'alert' : 'status'}
          aria-live={toast.tone === 'negative' ? 'assertive' : 'polite'}
          data-state={toast.state}
          className={`toast-card ${toneStyles[toast.tone]}`}
        >
          <div className="toast-copy">
            <p className="toast-title">{toast.title}</p>
            {toast.detail ? (
              <p className="toast-detail">{toast.detail}</p>
            ) : null}
            {toast.cta ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => handleAction(toast)}
                aria-label={actionAriaLabel(toast)}
              >
                {toast.cta.label}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => handleDismiss(toast.id)}
            className="toast-dismiss"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </section>
      ))}
    </div>
  )
}

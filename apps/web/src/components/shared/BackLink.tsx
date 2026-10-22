import type { ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

const BASE = 'inline-flex items-center gap-1'

/**
 * Whether "Back" has a page of the app to return to: the router's index for
 * this history entry, when it is past the first. The router's `useCanGoBack()`
 * reads the same index but takes a missing one for a yes, and the router drops
 * the index from its state when it rewrites the URL a page was opened on into
 * its own encoding. A page opened directly would then get a Back that leaves
 * the app, so here a missing index is a no.
 */
export function useInAppBack(): boolean {
  return useRouterState({
    select: state => {
      const index: unknown = state.location.state.__TSR_index
      return typeof index === 'number' && index > 0
    },
  })
}

/**
 * The way back at the top of a detail page. With in-app history it is a "Back"
 * button that pops it, so a reader returns to the page they came from,
 * whichever it was. A direct open (deep link, refresh, new tab) has no entry to
 * pop, so the caller's `fallback` link is drawn instead, named for the one
 * place it goes. `canGoBack` is `useInAppBack()`, read by the page with its
 * other hooks.
 *
 * `fallback` is handed the classes and the arrow, and returns the page's own
 * typed `Link`.
 */
export function BackLink({ canGoBack, className = '', iconClassName = 'size-3', fallback }: {
  canGoBack: boolean
  className?: string
  iconClassName?: string
  fallback: (link: { className: string; icon: ReactNode }) => ReactNode
}) {
  const classes = `${BASE} ${className}`
  const icon = <ArrowLeft className={iconClassName} aria-hidden="true" />
  if (!canGoBack) return <>{fallback({ className: classes, icon })}</>
  // TanStack Router's `router.history.back()` is typed `any` by its generics
  // (trips ESLint's no-unsafe-call). `window.history.back()` is equivalent:
  // the router's history adapter delegates to the same browser history object.
  return (
    <button type="button" onClick={() => { window.history.back() }} className={classes}>
      {icon} Back
    </button>
  )
}

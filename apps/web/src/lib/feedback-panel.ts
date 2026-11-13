import { isEmbed, isPublicDemo } from '../api.js'

let openRequests = 0
const listeners = new Set<() => void>()

/** Opens the dashboard's one Feedback panel, as its top bar button does. */
export function openFeedbackPanel(): void {
  openRequests++
  for (const listener of listeners) listener()
}

/** Subscribes to open requests from elsewhere in the dashboard (`useSyncExternalStore`). */
export function onFeedbackPanelOpen(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** How many times something asked the panel to open: the store's snapshot. */
export function feedbackPanelOpenRequests(): number {
  return openRequests
}

/** Whether this dashboard shows the Feedback panel: it needs write access, and never runs in an embed or the public demo. */
export function feedbackPanelAvailable(canWrite: boolean): boolean {
  return canWrite && !isEmbed() && !isPublicDemo()
}

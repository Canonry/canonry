import type { ReactNode } from 'react'

/**
 * One connection on the Settings page: what it is for on the left, its state
 * and action on the right, and its form below when open. The badge carries the
 * state, so the line under the name says what the connection does rather than
 * restating it.
 */
export function SettingsConnectionRow({ id, title, purpose, status, action, children }: {
  id?: string
  title: string
  purpose: ReactNode
  status: ReactNode
  action: ReactNode
  children?: ReactNode
}) {
  return (
    <div id={id} className="scroll-mt-24 py-4">
      {/* The text column keeps a 16rem basis so the state and action stay on its right
          until the row is too narrow, then wrap below together on every row alike. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 grow basis-64">
          <h3 className="text-copy-14-strong text-heading">{title}</h3>
          <div className="mt-1 max-w-prose text-copy-14 text-secondary">{purpose}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {status}
          {action}
        </div>
      </div>
      {children}
    </div>
  )
}

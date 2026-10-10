import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import type { QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { useAccount } from '../../../../contexts/account-context.js'
import { rowMenuActions, TRACKED_ACTION_LABEL } from './tracked-actions.js'
import type { TrackedRowAction, TrackedRowVm } from './tracked-types.js'

const ITEM = 'flex items-center rounded px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-surface-inset focus-visible:bg-surface-inset focus-visible:outline-none pointer-coarse:min-h-11 max-md:min-h-11'
/** Actions that end tracking read in the negative tone. */
const ITEM_TONE: Partial<Record<TrackedRowAction, string>> = { stop: 'text-negative', remove: 'text-negative' }
const GAP = 4
const EDGE = 8

/**
 * Under the trigger with their right edges level, kept inside the viewport.
 * Above the trigger when the viewport ends first and there is room there, so
 * the last rows of a long table open a whole menu.
 */
function placeMenu(menu: HTMLElement, trigger: HTMLElement) {
  const view = trigger.ownerDocument.defaultView
  if (!view) return
  const anchor = trigger.getBoundingClientRect()
  const box = menu.getBoundingClientRect()
  const below = anchor.bottom + GAP
  const above = anchor.top - GAP - box.height
  menu.style.top = `${below + box.height > view.innerHeight - EDGE && above >= EDGE ? above : below}px`
  menu.style.left = `${Math.max(EDGE, Math.min(anchor.right - box.width, view.innerWidth - box.width - EDGE))}px`
}

/**
 * The actions of one Tracked row, after the project "More" menu: a button
 * that toggles a `role="menu"`, closed by an outside press, Escape, Tab or a
 * choice, with focus back on the button. Arrow keys, Home and End move
 * through it. The items come from `rowMenuActions`, so a viewer gets only
 * Copy link and no dead control. A choice is only reported: the page opens
 * the action sheet, the Add queries sheet or copies the link. The menu is
 * drawn on the body at a fixed position, so no table frame clips it; a scroll
 * or resize that would leave it behind its row closes it.
 */
export function TrackedRowMenu({ row, workspace, onAction }: {
  row: TrackedRowVm
  workspace: QueryTrackingWorkspaceResponse
  onAction: (action: TrackedRowAction, row: TrackedRowVm) => void
}) {
  const { canWrite } = useAccount()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const initialFocus = useRef<'first' | 'last'>('first')
  const menuId = useId()
  const actions = rowMenuActions(row, workspace, canWrite)
  const name = `Actions for ${row.queryText}`

  // Before paint, so the menu never shows at the corner it is measured in.
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return
    placeMenu(menu.current, trigger.current)
    const items = [...menu.current.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    items.at(initialFocus.current === 'last' ? -1 : 0)?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null) => target instanceof Node && (menu.current?.contains(target) || trigger.current?.contains(target))
    const onPointerDown = (event: PointerEvent) => { if (!inside(event.target)) setOpen(false) }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Marked as handled, so a page shortcut on Escape can leave it to the menu.
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && menu.current?.contains(event.target))) setOpen(false) }
    const onResize = () => setOpen(false)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  // Focus goes back first, so a sheet the choice opens returns it to this button when it closes.
  function choose(action: TrackedRowAction) {
    setOpen(false)
    trigger.current?.focus()
    onAction(action, row)
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-inset hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:size-11 max-md:size-11"
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => { initialFocus.current = 'first'; setOpen(previous => !previous) }}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'first'
          setOpen(true)
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={name}
          className="fixed left-0 top-0 z-50 flex max-h-[calc(100vh-1rem)] min-w-52 max-w-[calc(100vw-1rem)] flex-col gap-0.5 overflow-y-auto rounded-md border border-mono-800/80 bg-bg-elevated p-1 shadow-[0_12px_28px_var(--color-shadow-panel)]"
          onKeyDown={event => {
            // Tab leaves the menu from the button, so the next stop is the control after it.
            if (event.key === 'Tab') {
              setOpen(false)
              trigger.current?.focus()
              return
            }
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
            const current = items.indexOf(document.activeElement as HTMLElement)
            const next = event.key === 'Home' ? 0
              : event.key === 'End' ? items.length - 1
                : event.key === 'ArrowDown' ? (current + 1) % items.length
                  : event.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : null
            if (next === null) return
            event.preventDefault()
            items[next]?.focus()
          }}
        >
          {actions.map(action => (
            <Fragment key={action}>
              {action === 'copy-link' && actions.length > 1 ? <div role="separator" className="mx-1 my-0.5 border-t border-default" /> : null}
              <button type="button" role="menuitem" tabIndex={-1} className={`${ITEM} ${ITEM_TONE[action] ?? 'text-strong hover:text-heading focus-visible:text-heading'}`} onClick={() => choose(action)}>
                {TRACKED_ACTION_LABEL[action]}
              </button>
            </Fragment>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  )
}

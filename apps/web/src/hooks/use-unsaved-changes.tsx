import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import * as Dialog from '@radix-ui/react-dialog'

import { Button } from '../components/ui/button.js'

/** Protect a settings draft both when switching an editor and when leaving its route. */
export function useUnsavedChanges(dirty: boolean, busy = false) {
  const router = useRouter({ warn: false })
  const state = useRef({ dirty, busy })
  state.current = { dirty, busy }
  const pending = useRef<{ proceed: () => void; stay?: () => void } | null>(null)
  const afterClose = useRef<(() => void) | null>(null)
  const [open, setOpen] = useState(false)

  const request = useCallback((proceed: () => void) => {
    if (state.current.busy) return
    if (!state.current.dirty) { proceed(); return }
    pending.current?.stay?.()
    pending.current = { proceed }
    setOpen(true)
  }, [])

  useEffect(() => {
    if (!router) return
    const unblock = router.history.block({
      blockerFn: () => {
        if (state.current.busy) return true
        if (!state.current.dirty) return false
        return new Promise<boolean>(resolve => {
          pending.current?.stay?.()
          pending.current = { proceed: () => resolve(false), stay: () => resolve(true) }
          setOpen(true)
        })
      },
      enableBeforeUnload: () => state.current.dirty || state.current.busy,
    })
    return () => { pending.current?.stay?.(); unblock() }
  }, [router])

  function stay() {
    pending.current?.stay?.()
    pending.current = null
    setOpen(false)
  }

  const dialog = <Dialog.Root open={open} onOpenChange={next => { if (!next) stay() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay-scrim/80" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-default bg-bg p-6 shadow-xl" onCloseAutoFocus={event => {
        const proceed = afterClose.current
        afterClose.current = null
        if (!proceed) return
        // The action can replace the focused editor. Let its new control take
        // focus after Radix has released the dialog, not before its cleanup.
        event.preventDefault()
        proceed()
      }}>
        <Dialog.Title className="text-heading-16 text-heading">Discard unsaved changes?</Dialog.Title>
        <Dialog.Description className="mt-2 text-copy-14 text-secondary">Your saved settings have not changed. Keep editing to save this draft, or discard it to continue.</Dialog.Description>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={stay}>Keep editing</Button>
          <Button type="button" variant="destructive" onClick={() => {
            const action = pending.current
            pending.current = null
            afterClose.current = action?.proceed ?? null
            setOpen(false)
          }}>Discard changes</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
  return { request, dialog }
}

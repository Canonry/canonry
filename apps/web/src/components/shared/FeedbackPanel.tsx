import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useMutation } from '@tanstack/react-query'
import { postApiV1FeedbackMutation } from '@canonry/canonry-api-client/react-query'
import { FEEDBACK_LIMITS, feedbackAcceptedDtoSchema, feedbackKindSchema, type FeedbackKind, type UiPage } from '@canonry/canonry-contracts'
import { Check, LoaderCircle, MessageSquare, X } from 'lucide-react'
import { heyClient } from '../../api.js'
import { useAccount } from '../../contexts/account-context.js'
import { extractApiErrorInfo } from '../../lib/extract-error-message.js'
import { currentUiPage, trackUiAction } from '../../lib/ui-telemetry.js'
import { feedbackPanelAvailable, feedbackPanelOpenRequests, onFeedbackPanelOpen } from '../../lib/feedback-panel.js'
import { Button } from '../ui/button.js'

/** One in-memory draft across routes. Explicit feedback never enters usage events. */
export function FeedbackPanel() {
  const { canWrite } = useAccount()
  const id = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<FeedbackKind>('improvement')
  const [message, setMessage] = useState('')
  const [page, setPage] = useState<UiPage>('other')
  const mutation = useMutation({ ...postApiV1FeedbackMutation({ client: heyClient }), retry: false, gcTime: 0 })
  const receipt = feedbackAcceptedDtoSchema.safeParse(mutation.data)
  const sent = mutation.isSuccess && receipt.success && receipt.data.accepted && receipt.data.id.trim().length > 0
  const failed = mutation.isError || (mutation.isSuccess && !sent)
  const errorCode = mutation.isError ? extractApiErrorInfo(mutation.error).code : undefined
  const error = errorCode === 'NOT_IMPLEMENTED'
    ? 'Feedback isn’t available on this server.'
    : errorCode === 'QUOTA_EXCEEDED'
      ? 'Please wait a minute, then try again. Your message is saved here.'
      : 'Delivery wasn’t confirmed. Your message is still here.'

  const changeOpen = (next: boolean) => {
    if (next && !message && !mutation.isPending) {
      mutation.reset()
      setPage(currentUiPage())
    }
    setOpen(next)
  }
  // Other places (Settings) open this same panel, so there is one draft and one way to send.
  // The server render has no open requests either, so both snapshots read the same count.
  const openRequests = useSyncExternalStore(onFeedbackPanelOpen, feedbackPanelOpenRequests, feedbackPanelOpenRequests)
  const handledRequests = useRef(openRequests)
  useEffect(() => {
    if (openRequests === handledRequests.current) return
    handledRequests.current = openRequests
    changeOpen(true)
  })

  // The existing feedback endpoint requires write authority. Embeds and demos
  // must not collect feedback on behalf of their viewers.
  if (!feedbackPanelAvailable(canWrite)) return null

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen} modal={false}>
      <div className="relative">
        <Dialog.Trigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-label="Feedback" title="Feedback" className="max-sm:px-2">
            <MessageSquare className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Feedback</span>
          </Button>
        </Dialog.Trigger>
        <Dialog.Content
          className="material-menu fixed right-3 top-16 z-50 max-h-[calc(100dvh-5rem)] w-[min(360px,calc(100vw-24px))] overflow-y-auto p-5 sm:absolute sm:right-0 sm:top-full sm:mt-2"
          aria-describedby={`${id}-privacy`}
          onOpenAutoFocus={event => {
            if (input.current && !input.current.disabled) { event.preventDefault(); input.current.focus() }
          }}
        >
          <div className="mb-4 flex items-center justify-between gap-4">
            <Dialog.Title className="text-heading-16 text-primary">Share feedback</Dialog.Title>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" className="-mr-2 -mt-2" aria-label="Close feedback">
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          {sent ? (
            <div className="space-y-4">
              <p role="status" className="flex items-center gap-2 text-copy-14 text-primary">
                <Check className="size-4 text-positive" aria-hidden="true" />
                Feedback sent. Thank you.
              </p>
              <Dialog.Close asChild><Button type="button" variant="secondary" size="sm">Done</Button></Dialog.Close>
            </div>
          ) : (
            <form className="space-y-4" aria-busy={mutation.isPending} onSubmit={event => {
              event.preventDefault()
              if (!message.trim() || submitting.current || mutation.isPending) return
              submitting.current = true
              mutation.mutate({ body: { kind, summary: message.trim(), area: 'dashboard', details: `Screen: ${page}` } }, {
                onSuccess: result => {
                  const accepted = feedbackAcceptedDtoSchema.safeParse(result)
                  if (!accepted.success || !accepted.data.accepted || !accepted.data.id.trim()) return
                  setMessage('')
                  setKind('improvement')
                  trackUiAction('feedback.submit')
                },
                onSettled: () => { submitting.current = false },
              })
            }}>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={`${id}-kind`} className="text-label-13 text-secondary">About</label>
                <select id={`${id}-kind`} className="setup-input max-w-full" value={kind} disabled={mutation.isPending}
                  onChange={event => setKind(feedbackKindSchema.parse(event.target.value))}>
                  <option value="improvement">An idea</option>
                  <option value="bug">A problem</option>
                  <option value="struggle">Something confusing</option>
                  <option value="other">Something else</option>
                </select>
              </div>
              <div className="space-y-2">
                <label htmlFor={`${id}-message`} className="sr-only">Your feedback</label>
                <textarea ref={input} id={`${id}-message`} className="setup-input block min-h-32 w-full resize-y text-copy-14"
                  placeholder="What happened, or what would you change?" rows={5} maxLength={FEEDBACK_LIMITS.summary}
                  required value={message} disabled={mutation.isPending} aria-describedby={`${id}-privacy`}
                  onChange={event => { setMessage(event.target.value); if (failed) mutation.reset() }} />
                <div className="text-right text-label-12 text-secondary" aria-hidden="true">{message.length}/{FEEDBACK_LIMITS.summary}</div>
              </div>
              {failed ? <p role="alert" className="text-copy-13 text-negative">{error}</p> : null}
              <Button type="submit" className="w-full" disabled={!message.trim() || mutation.isPending}>
                {mutation.isPending ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
                {mutation.isPending ? 'Sending…' : failed ? 'Try again' : 'Send feedback'}
              </Button>
            </form>
          )}
          <Dialog.Description id={`${id}-privacy`} className="mt-4 text-copy-13 text-secondary">
            Sent to the Canonry team with screen type and app version. Please leave out private data.
          </Dialog.Description>
        </Dialog.Content>
      </div>
    </Dialog.Root>
  )
}

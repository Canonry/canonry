import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { normalizeIdentityText } from '@ainyc/canonry-contracts'
import type {
  QueryTrackingMutation,
  QueryTrackingPreviewResponse,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import { useQueryTrackingPublish } from '../../queries/use-query-tracking-publish.js'
import { WriteButton } from '../shared/AccessControls.js'
import { SegmentedRadioGroup, type SegmentedRadioOption } from '../shared/SegmentedRadioGroup.js'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'
import { VisibilityScopePicker } from './VisibilityScopePicker.js'

type Subject = 'market' | 'location' | 'company'
type QueryType = 'auto' | 'branded' | 'non-brand'

const SUBJECTS: readonly SegmentedRadioOption<Subject>[] = [
  { value: 'market', label: 'Market' },
  { value: 'location', label: 'Location' },
  { value: 'company', label: 'Company', description: 'Not available yet', disabled: true },
]
const TYPES: readonly SegmentedRadioOption<QueryType>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'branded', label: 'Branded' },
  { value: 'non-brand', label: 'Non-brand' },
]
const FIELD_LABEL = 'mb-1 block text-sm font-medium text-heading'
const FIELD_HINT = 'mt-2 text-[13px] leading-5 text-secondary'

/** One query per line. Blank lines go, and so does a line the server would match to an earlier one. */
function queryLines(text: string): string[] {
  const seen = new Set<string>()
  return text.split('\n').map(line => line.trim()).filter(line => {
    const identity = normalizeIdentityText(line)
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

/**
 * Add several queries to one market. Each line becomes one addition whose only
 * audience is that market and which names no contexts, so the server gives it
 * the market's engines and search locations, exactly as the Add query form
 * does for a market. Location, hand-picked, template and saved-research adds
 * stay in that form, which `onOpenComposer` opens. Location is a choice that
 * offers the form, never a jump to it: arrow keys move this control's choice.
 */
export function AddQueriesSheet({ projectName, workspace, defaultMarketKey, onOpenComposer, onClose, renderReview }: {
  projectName: string
  workspace: QueryTrackingWorkspaceResponse
  /** The market the Tracked view is filtered to, chosen to start with. */
  defaultMarketKey?: string
  onOpenComposer: () => void
  onClose: () => void
  /** The caller draws the review, so this sheet shows the same one as every other tracking change. */
  renderReview: (review: { preview: QueryTrackingPreviewResponse; isCommitting: boolean; onConfirm: () => void }) => ReactNode
}) {
  const publish = useQueryTrackingPublish(projectName, { onCommitted: onClose })
  const [subject, setSubject] = useState<Subject>('market')
  const [marketKey, setMarketKey] = useState(defaultMarketKey)
  const [text, setText] = useState('')
  const [type, setType] = useState<QueryType>('auto')
  const [reviewed, setReviewed] = useState<QueryTrackingMutation | null>(null)
  const picker = useRef<HTMLDivElement>(null)
  const [opener] = useState(() => document.activeElement)
  const openingComposer = useRef(false)
  const id = useId()

  const places = (workspace.scopeOptions ?? []).filter(option => option.kind === 'group' || option.kind === 'market')
  const market = places.find(option => option.kind === 'market' && option.id === marketKey)
  const lines = queryLines(text)
  const preview = reviewed ? publish.preview : null
  const canReview = subject === 'market' && market !== undefined && lines.length > 0 && !publish.isPreviewing

  /** A change to the draft drops a review still in flight, so the sheet never shows a review of an older draft. */
  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setReviewed(null)
    }
  }

  function openComposer() {
    openingComposer.current = true
    onOpenComposer()
  }

  // A sheet opened without a Radix trigger returns focus to its opener itself.
  // The Add query form focuses its own heading, so a hand-off leaves focus there.
  function restoreFocus(event: Event) {
    event.preventDefault()
    if (!openingComposer.current && opener instanceof HTMLElement) opener.focus()
  }

  // Escape closes an open market picker first, not the whole sheet.
  function keepOpenForPicker(event: KeyboardEvent) {
    if (event.target instanceof Node && picker.current?.querySelector('details[open]')?.contains(event.target)) event.preventDefault()
  }

  function review() {
    if (!canReview) return
    const mutation: QueryTrackingMutation = {
      additions: lines.map(line => ({
        input: { source: 'manual', text: line },
        audience: { marketKeys: [market.id] },
        ...(type === 'auto' ? {} : { queryClass: type }),
      })),
      removals: [],
    }
    setReviewed(mutation)
    publish.requestPreview({ ...mutation, expectedWorkspaceVersion: workspace.workspaceVersion })
  }

  return (
    <Sheet open onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent onCloseAutoFocus={restoreFocus} onEscapeKeyDown={keepOpenForPicker}>
        <SheetHeader>
          <SheetTitle>Add queries</SheetTitle>
          <SheetDescription>Each query is tracked in one market, with that market's engines and search locations.</SheetDescription>
        </SheetHeader>
        {reviewed && preview ? <>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
            {renderReview({
              preview,
              isCommitting: publish.isCommitting,
              onConfirm: () => publish.commit({
                ...reviewed,
                expectedWorkspaceVersion: preview.workspaceVersion,
                previewToken: preview.previewToken,
                reviewedAt: preview.reviewedAt,
              }),
            })}
          </div>
          <div className="mt-4 border-t border-default pt-4">
            <Button type="button" variant="ghost" size="sm" onClick={() => setReviewed(null)}>Back</Button>
          </div>
        </> : <>
          <div className="-mx-1 mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto px-1">
            <div>
              <span aria-hidden="true" className={FIELD_LABEL}>Subject</span>
              <SegmentedRadioGroup label="Subject" options={SUBJECTS} value={subject} onChange={edit(setSubject)} />
              <p className={FIELD_HINT}>Company is not available yet.</p>
            </div>
            {subject === 'location' ? <div>
              <p className="text-sm leading-6 text-secondary">Location queries use the Add query form.</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={openComposer}>Open the Add query form</Button>
            </div> : <>
              <div ref={picker}>
                {places.some(option => option.kind === 'market')
                  ? <VisibilityScopePicker label="Market" placeholder="Choose a market" options={places} selected={market} allowGroupSelect={false} onSelect={scope => edit(setMarketKey)(scope.id)} />
                  : <p className="text-sm leading-6 text-secondary">This project has no markets yet. Use hand-picked locations below.</p>}
              </div>
              <div>
                <label className={FIELD_LABEL} htmlFor={`${id}-queries`}>Queries</label>
                <textarea
                  id={`${id}-queries`}
                  aria-describedby={`${id}-queries-hint`}
                  className="block min-h-40 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
                  value={text}
                  onChange={event => edit(setText)(event.target.value)}
                />
                <p id={`${id}-queries-hint`} className={FIELD_HINT}>
                  One per line. Blank and repeated lines are skipped.{lines.length > 0 ? ` ${lines.length.toLocaleString('en-US')} ${lines.length === 1 ? 'query' : 'queries'} to add.` : ''}
                </p>
              </div>
              <details className="border-t border-default text-sm text-secondary">
                <summary className="min-h-11 cursor-pointer py-3">More options</summary>
                <div className="pb-3">
                  <span aria-hidden="true" className={FIELD_LABEL}>Type</span>
                  <SegmentedRadioGroup label="Type" options={TYPES} value={type} onChange={edit(setType)} />
                </div>
              </details>
              <button type="button" className="min-h-11 text-left text-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" onClick={openComposer}>
                Hand-picked locations, templates or saved research
              </button>
            </>}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-default pt-4">
            <WriteButton type="button" size="sm" disabled={!canReview} onClick={review}>
              {publish.isPreviewing ? 'Reviewing…' : 'Review'}
            </WriteButton>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <p className="text-sm leading-5 text-secondary">Publishing does not run a sweep.</p>
          </div>
        </>}
      </SheetContent>
    </Sheet>
  )
}

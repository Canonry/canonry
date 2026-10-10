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

/** Markets, and only the groups that lead to one, so browsing a group never ends in an empty list. */
function marketPlaces(options: NonNullable<QueryTrackingWorkspaceResponse['scopeOptions']>) {
  const groups = new Map(options.filter(option => option.kind === 'group').map(group => [group.id, group]))
  const leading = new Set<string>()
  const pending = options.filter(option => option.kind === 'market').flatMap(market => market.parentGroupIds ?? [])
  while (pending.length) {
    const key = pending.pop()!
    if (leading.has(key)) continue
    leading.add(key)
    pending.push(...(groups.get(key)?.parentGroupIds ?? []))
  }
  return options.filter(option => option.kind === 'market' || (option.kind === 'group' && leading.has(option.id)))
}

/**
 * Add several queries to one market. Each line becomes one addition whose only
 * audience is that market and which names no contexts, so the server gives it
 * the market's engines and search locations, exactly as the Add query form
 * does for a market. Location, hand-picked, template and saved-research adds
 * stay in that form, which `onOpenComposer` opens. Location is a choice that
 * offers the form, never a jump to it: arrow keys move this control's choice.
 * The form holds one query, so a hand-off takes the first line with it and
 * says so when there are more. The chosen market stays behind: checked in the
 * form it would narrow hand-picked locations to that market.
 */
export function AddQueriesSheet({ projectName, workspace, defaultMarketKey, onOpenComposer, onClose, renderReview }: {
  projectName: string
  workspace: QueryTrackingWorkspaceResponse
  /** The market the Tracked view is filtered to, chosen to start with. */
  defaultMarketKey?: string
  /** `text` is the first query line, or empty when nothing is typed yet. */
  onOpenComposer: (carried: { text: string }) => void
  onClose: () => void
  /**
   * The caller draws the review, so this sheet shows the same one as every other tracking change.
   * `actions` (confirm and the sweep pause) go in the footer, in reach however long the list is.
   */
  renderReview: (review: { preview: QueryTrackingPreviewResponse; isCommitting: boolean; onConfirm: () => void }) => { changes: ReactNode; actions: ReactNode }
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

  const places = marketPlaces(workspace.scopeOptions ?? [])
  const market = places.find(option => option.kind === 'market' && option.id === marketKey)
  const lines = queryLines(text)
  const preview = reviewed ? publish.preview : null
  const canReview = subject === 'market' && market !== undefined && lines.length > 0 && !publish.isPreviewing
  const reviewStep = reviewed && preview ? renderReview({
    preview,
    isCommitting: publish.isCommitting,
    onConfirm: () => publish.commit({
      ...reviewed,
      expectedWorkspaceVersion: preview.workspaceVersion,
      previewToken: preview.previewToken,
      reviewedAt: preview.reviewedAt,
    }),
  }) : null
  // The toast for a refused review or publish sits under this sheet, so the refusal is repeated here.
  const refusal = publish.error ? <p role="alert" className="mt-4 text-sm leading-5 text-negative"><span className="font-medium">{publish.error.title}.</span> {publish.error.detail}</p> : null
  const firstLineOnly = lines.length > 1 ? 'The Add query form adds one query at a time. It opens with your first line only.' : null

  /** A change to the draft drops a review still in flight, so the sheet never shows a review of an older draft. */
  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setReviewed(null)
    }
  }

  function openComposer() {
    openingComposer.current = true
    onOpenComposer({ text: lines[0] ?? '' })
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
        {reviewStep ? <>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto">{reviewStep.changes}</div>
          {refusal}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-default pt-4">
            {reviewStep.actions}
            {/* A publish in flight closes the sheet when it lands, so the draft stays out of reach until then. */}
            <Button type="button" variant="ghost" size="sm" disabled={publish.isCommitting} onClick={() => setReviewed(null)}>Back</Button>
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
              {firstLineOnly ? <p className={FIELD_HINT}>{firstLineOnly}</p> : null}
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
                {/* A Type other than Automatic is sent on every line, so it shows while this is closed. */}
                <summary className="min-h-11 cursor-pointer py-3">More options{type === 'auto' ? '' : ` · Type: ${TYPES.find(option => option.value === type)!.label}`}</summary>
                <div className="pb-3">
                  <span aria-hidden="true" className={FIELD_LABEL}>Type</span>
                  <SegmentedRadioGroup label="Type" options={TYPES} value={type} onChange={edit(setType)} />
                </div>
              </details>
              <div>
                <button type="button" className="min-h-11 text-left text-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" onClick={openComposer}>
                  Hand-picked locations, templates or saved research
                </button>
                {firstLineOnly ? <p className="text-[13px] leading-5 text-secondary">{firstLineOnly}</p> : null}
              </div>
            </>}
          </div>
          {refusal}
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

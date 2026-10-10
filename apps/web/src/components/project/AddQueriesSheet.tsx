import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { normalizeIdentityText } from '@ainyc/canonry-contracts'
import type {
  QueryTrackingCommitResponse,
  QueryTrackingContextInput,
  QueryTrackingMutation,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import { useQueryTrackingPublish } from '../../queries/use-query-tracking-publish.js'
import { WriteButton } from '../shared/AccessControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { SegmentedRadioGroup, type SegmentedRadioOption } from '../shared/SegmentedRadioGroup.js'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'
import type { TrackingReviewState } from './TrackingReview.js'
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
/** The wire calls a location a property; this sheet never does. */
const LOCATION_NOUN = ['location', 'locations'] as const
const PLACES = {
  market: { kind: 'market', label: 'Market', placeholder: 'Choose a market', none: 'This project has no markets yet.' },
  location: { kind: 'property', label: 'Location', placeholder: 'Choose a location', none: 'This project has no locations yet.' },
} as const
const FIELD_LABEL_TEXT = 'text-sm font-medium text-heading'
const FIELD_LABEL = `mb-1 block ${FIELD_LABEL_TEXT}`
const FIELD_HINT = 'mt-2 text-[13px] leading-5 text-secondary'
const FIELD_NOTE = 'text-[13px] leading-5 text-secondary'
const FIELD_CONTROL = 'block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500'

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

/** Places of one kind, and only the groups that lead to one, so browsing a group never ends in an empty list. */
export function placesOf(options: NonNullable<QueryTrackingWorkspaceResponse['scopeOptions']>, kind: 'market' | 'property') {
  const groups = new Map(options.filter(option => option.kind === 'group').map(group => [group.id, group]))
  const leading = new Set<string>()
  const pending = options.filter(option => option.kind === kind).flatMap(place => place.parentGroupIds ?? [])
  while (pending.length) {
    const key = pending.pop()!
    if (leading.has(key)) continue
    leading.add(key)
    pending.push(...(groups.get(key)?.parentGroupIds ?? []))
  }
  return options.filter(option => option.kind === kind || (option.kind === 'group' && leading.has(option.id)))
}

/**
 * Add several queries to one market or one location, one addition per line.
 * A market addition names only that market and no contexts, so the server
 * gives it the market's engines and search locations, exactly as the Add
 * query form does for a market. A location addition names the location and
 * every market that already holds it (a market with a usage edge for it),
 * again with no contexts, so the query is asked where those markets are asked
 * and counts in their numbers. A location in no market has nothing to take
 * them from: it names the location alone and one of `contextChoices`, which
 * the server requires for a new assignment outside a market. A query has one
 * subject, so a Subject change drops the place chosen for the other one.
 * Hand-picked, template and saved-research adds stay in the Add query form,
 * which `onOpenComposer` opens. The form holds one query, so a hand-off takes
 * the first line with it and says so when there are more. The chosen place
 * stays behind: a market checked in the form would narrow hand-picked
 * locations to that market. A caller with no form (the location page) leaves
 * `onOpenComposer` out, and the sheet shows no link to it.
 */
export function AddQueriesSheet({ projectName, workspace, contextChoices, defaultMarketKey, defaultLocationKey, onOpenComposer, onPublished, onClose, renderReview }: {
  projectName: string
  workspace: QueryTrackingWorkspaceResponse
  /** The search location and engines choices the Add query form offers, so a location in no market gets the same ones. */
  contextChoices: readonly { label: string; input: QueryTrackingContextInput }[]
  /** The market the Tracked view is filtered to, chosen to start with. */
  defaultMarketKey?: string
  /** The location the Tracked view is filtered to, or the location page the sheet opened from. Subject starts on Location with it chosen. */
  defaultLocationKey?: string
  /** `text` is the first query line, or empty when nothing is typed yet. */
  onOpenComposer?: (carried: { text: string }) => void
  /** Runs once a publish succeeds, just before the sheet closes, with what the server published. */
  onPublished?: (result: QueryTrackingCommitResponse) => void
  onClose: () => void
  /**
   * The caller draws the review, so this sheet shows the same one as every other advanced tracking change.
   * `actions` (publish or review again, Back and the sweep pause) go in the footer, in reach however long the list is.
   */
  renderReview: (review: TrackingReviewState) => { changes: ReactNode; actions: ReactNode }
}) {
  const publish = useQueryTrackingPublish(projectName, { onCommitted: result => { onPublished?.(result); onClose() } })
  const [subject, setSubject] = useState<Subject>(defaultLocationKey ? 'location' : 'market')
  const [placeKey, setPlaceKey] = useState(defaultLocationKey ?? defaultMarketKey)
  const [contextLabel, setContextLabel] = useState('')
  const [text, setText] = useState('')
  const [type, setType] = useState<QueryType>('auto')
  const [reviewed, setReviewed] = useState<QueryTrackingMutation | null>(null)
  const picker = useRef<HTMLDivElement>(null)
  const [opener] = useState(() => document.activeElement)
  const openingComposer = useRef(false)
  const id = useId()

  const placing = PLACES[subject === 'location' ? 'location' : 'market']
  const places = placesOf(workspace.scopeOptions ?? [], placing.kind)
  const place = places.find(option => option.kind === placing.kind && option.id === placeKey)
  // The markets a location's queries already count in: those with a usage edge for it.
  const locationMarkets = subject === 'location' && place ? workspace.markets.filter(market => market.usageEdges.some(edge => edge.targetKey === place.id)) : []
  const marketNames = locationMarkets.map(market => market.label).join(', ')
  // A project with one search location and engines choice needs no pick.
  const context = contextChoices.length === 1 ? contextChoices[0] : contextChoices.find(choice => choice.label === contextLabel)
  // What every line is added with, or null until the place (and, outside a market, its context) is chosen.
  const placement = !place ? null
    : subject !== 'location' ? { audience: { marketKeys: [place.id] } }
      : locationMarkets.length > 0 ? { audience: { targetKeys: [place.id], marketKeys: locationMarkets.map(market => market.stableKey) } }
        : context ? { audience: { targetKeys: [place.id] }, contexts: [context.input] } : null
  const lines = queryLines(text)
  const preview = reviewed ? publish.preview : null
  const canReview = placement !== null && lines.length > 0 && !publish.isPreviewing
  // The toast for a refused review or publish sits under this sheet, so the review stays up to show the
  // refusal and offer another review. Back keeps showing it beside the draft, until the next request.
  const reviewStep = reviewed && (preview || publish.error) ? renderReview({
    preview,
    error: publish.error,
    isCommitting: publish.isCommitting,
    onPublish: () => {
      if (preview) publish.commit({
        ...reviewed,
        expectedWorkspaceVersion: preview.workspaceVersion,
        previewToken: preview.previewToken,
        reviewedAt: preview.reviewedAt,
      })
    },
    // A draft that still resolves is rebuilt from the refreshed workspace. One whose place is gone
    // goes again as it was reviewed, so the server says why.
    onReviewAgain: () => {
      if (canReview) review()
      else publish.requestPreview({ ...reviewed, expectedWorkspaceVersion: workspace.workspaceVersion })
    },
    onBack: () => setReviewed(null),
  }) : null
  const refusal = publish.error ? <p role="alert" className="mt-4 text-sm leading-5 text-negative"><span className="font-medium">{publish.error.title}.</span> {publish.error.detail}</p> : null
  const firstLineOnly = lines.length > 1 ? 'The Add query form adds one query at a time. It opens with your first line only.' : null

  /** A change to the draft drops a review still in flight, so the sheet never shows a review of an older draft. */
  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setReviewed(null)
    }
  }

  // The control reports a click on the current choice too, which must keep the place.
  function changeSubject(next: Subject) {
    if (next === subject) return
    setSubject(next)
    edit(setPlaceKey)(undefined)
  }

  function openComposer() {
    openingComposer.current = true
    onOpenComposer?.({ text: lines[0] ?? '' })
  }

  // A sheet opened without a Radix trigger returns focus to its opener itself.
  // The Add query form focuses its own heading, so a hand-off leaves focus there.
  function restoreFocus(event: Event) {
    event.preventDefault()
    if (!openingComposer.current && opener instanceof HTMLElement) opener.focus()
  }

  // Escape closes an open place picker or an open help bubble first, not the whole sheet.
  function keepOpenForInner(event: KeyboardEvent) {
    const target = event.target
    if (!(target instanceof Element)) return
    if (picker.current?.querySelector('details[open]')?.contains(target) || target.closest('.info-tooltip-trigger[aria-expanded="true"]')) event.preventDefault()
  }

  function review() {
    if (!canReview) return
    const mutation: QueryTrackingMutation = {
      additions: lines.map(line => ({
        input: { source: 'manual', text: line },
        ...placement,
        ...(type === 'auto' ? {} : { queryClass: type }),
      })),
      removals: [],
    }
    setReviewed(mutation)
    publish.requestPreview({ ...mutation, expectedWorkspaceVersion: workspace.workspaceVersion })
  }

  return (
    <Sheet open onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent onCloseAutoFocus={restoreFocus} onEscapeKeyDown={keepOpenForInner}>
        <SheetHeader>
          <SheetTitle>Add queries</SheetTitle>
          <SheetDescription className="sr-only">Each query is tracked for one market or one location.</SheetDescription>
        </SheetHeader>
        {reviewStep ? <>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto">{reviewStep.changes}</div>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-default pt-4">{reviewStep.actions}</div>
        </> : <>
          <div className="-mx-1 mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto px-1">
            <div>
              <span aria-hidden="true" className={FIELD_LABEL}>Subject</span>
              {/* A hover title shows on neither a tap nor keyboard focus, so the help says why Company is off. After the control, so the sheet opens with focus on the Subject, not on the help. */}
              <div className="flex items-center">
                <SegmentedRadioGroup label="Subject" options={SUBJECTS} value={subject} onChange={changeSubject} />
                <InfoTooltip text="Company is not available yet." placement="bottom" />
              </div>
            </div>
            <div ref={picker}>
              {places.some(option => option.kind === placing.kind)
                ? <VisibilityScopePicker key={subject} label={placing.label} placeholder={placing.placeholder} options={places} selected={place} allowGroupSelect={false} propertyNoun={LOCATION_NOUN} onSelect={scope => edit(setPlaceKey)(scope.id)} />
                : <p className="text-sm leading-6 text-secondary">{placing.none}{subject !== 'location' && onOpenComposer ? ' Use hand-picked locations below.' : ''}</p>}
              {subject !== 'location' || !place ? null : locationMarkets.length > 0 ? (
                <div className={`${FIELD_HINT} flex items-center`}>
                  <p>Counts in: {marketNames}</p>
                  <InfoTooltip text="Asked with these markets' engines and search locations." placement="bottom" />
                </div>
              ) : <>
                <p className={FIELD_HINT}>This location is in no market.</p>
                {contextChoices.length === 1 ? <p className={FIELD_NOTE}>Search location and engines: {contextChoices[0]!.label}</p>
                  : contextChoices.length === 0 ? <p className={FIELD_NOTE}>No search location and engines are set up for this project.</p>
                    : <>
                      <label className={`${FIELD_LABEL} mt-3`} htmlFor={`${id}-context`}>Search location and engines</label>
                      <select id={`${id}-context`} required className={`${FIELD_CONTROL} min-h-11`} value={context?.label ?? ''} onChange={event => edit(setContextLabel)(event.target.value)}>
                        <option value="">Choose a search location and engines</option>
                        {contextChoices.map(choice => <option key={choice.label} value={choice.label}>{choice.label}</option>)}
                      </select>
                    </>}
              </>}
            </div>
            <div>
              {/* The help is a sibling of the label, so its text stays out of the field's name. */}
              <div className="mb-1 flex items-center">
                <label className={FIELD_LABEL_TEXT} htmlFor={`${id}-queries`}>Queries</label>
                <InfoTooltip text="Blank and repeated lines are skipped." placement="bottom" />
              </div>
              <textarea
                id={`${id}-queries`}
                aria-describedby={lines.length > 0 ? `${id}-queries-count` : undefined}
                placeholder="One query per line"
                className={`${FIELD_CONTROL} min-h-40 placeholder-mono-500`}
                value={text}
                onChange={event => edit(setText)(event.target.value)}
              />
              {/* Stays in place, empty until there are lines, so the first line typed does not push the form down. */}
              <p id={`${id}-queries-count`} className={`${FIELD_HINT} min-h-5`}>{lines.length > 0 ? `${lines.length.toLocaleString('en-US')} ${lines.length === 1 ? 'query' : 'queries'}` : null}</p>
            </div>
            <details className="border-t border-default text-sm text-secondary">
              {/* A Type other than Automatic is sent on every line, so it shows while this is closed. */}
              <summary className="min-h-11 cursor-pointer py-3">More options{type === 'auto' ? '' : ` · Type: ${TYPES.find(option => option.value === type)!.label}`}</summary>
              <div className="pb-3">
                <span aria-hidden="true" className={FIELD_LABEL}>Type</span>
                <SegmentedRadioGroup label="Type" options={TYPES} value={type} onChange={edit(setType)} />
              </div>
            </details>
            {onOpenComposer ? <div>
              <button type="button" className="min-h-11 text-left text-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" onClick={openComposer}>
                Hand-picked locations, templates or saved research
              </button>
              {firstLineOnly ? <p className={FIELD_NOTE}>{firstLineOnly}</p> : null}
            </div> : null}
          </div>
          {refusal}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-default pt-4">
            <WriteButton type="button" size="sm" disabled={!canReview} onClick={review}>
              {publish.isPreviewing ? 'Reviewing…' : 'Review'}
            </WriteButton>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          </div>
        </>}
      </SheetContent>
    </Sheet>
  )
}

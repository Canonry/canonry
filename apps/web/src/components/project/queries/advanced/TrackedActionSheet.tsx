import { useId, useRef, useState } from 'react'
import { AlertTriangle, Ban, GitBranch, Info } from 'lucide-react'
import type {
  QueryTrackingCommitResponse,
  QueryTrackingContextInput,
  QueryTrackingMutation,
  QueryTrackingWorkspaceResponse,
} from '@ainyc/canonry-contracts'

import { useQueryTrackingPublish } from '../../../../queries/use-query-tracking-publish.js'
import { WriteButton } from '../../../shared/AccessControls.js'
import { InfoTooltip } from '../../../shared/InfoTooltip.js'
import { SegmentedRadioGroup, type SegmentedRadioOption } from '../../../shared/SegmentedRadioGroup.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../../ui/sheet.js'
import { placesOf } from '../../AddQueriesSheet.js'
import { TrackingReview, TrackingReviewActions, type TrackingReviewState } from '../../TrackingReview.js'
import { VisibilityScopePicker } from '../../VisibilityScopePicker.js'
import { contextLabels } from '../tracking-contexts.js'
import {
  allowedTypes,
  changeSubject,
  changeType,
  editWording,
  marketsHolding,
  moveLocation,
  operatorType,
  sameSubject,
  stopTracking,
  TRACKED_ACTION_LABEL,
  TRACKED_BULK_MAX,
  typeChangeRows,
  typeSetsSubject,
  type TrackedPlace,
  type TrackedTypeChoice,
} from './tracked-actions.js'
import type { TrackedRowAction, TrackedRowVm } from './tracked-types.js'

/** The actions that end in a review. Track opens the Add queries sheet and Copy link writes no change, so the page handles both. */
export type TrackedSheetAction = Exclude<TrackedRowAction, 'track' | 'copy-link'>

type SubjectChoice = 'market' | 'location' | 'company'

const DESCRIPTION: Record<TrackedSheetAction, string> = {
  'edit-wording': 'Change the wording of a tracked query, then review the change.',
  'change-subject': 'Track a query for another market or location, then review the change.',
  'move-location': 'Track a query for another location, then review the change.',
  'change-type': 'Set tracked queries to Branded or Non-brand, then review the change.',
  stop: 'Stop tracking queries, then review the change.',
  remove: 'Remove queries that are not asked, then review the change.',
}
const SUBJECTS: readonly SegmentedRadioOption<SubjectChoice>[] = [
  { value: 'market', label: 'Market' },
  { value: 'location', label: 'Location' },
  { value: 'company', label: 'Company', description: 'Not available yet', disabled: true },
]
const TYPE_LABEL: Record<TrackedTypeChoice, string> = { auto: 'Automatic', branded: 'Branded', 'non-brand': 'Non-brand' }
const TYPE_ORDER: readonly TrackedTypeChoice[] = ['auto', 'branded', 'non-brand']
/** The wire calls a location a property; this sheet never does. */
const LOCATION_NOUN = ['location', 'locations'] as const
const PLACES = {
  market: { kind: 'market', label: 'Market', placeholder: 'Choose a market', none: 'No markets yet' },
  location: { kind: 'property', label: 'Location', placeholder: 'Choose a location', none: 'No locations yet' },
} as const
/** A stop or a bulk change names this many queries, then counts the rest. */
const LISTED = 5
const NEW_TREND_LINE = 'New wording is tracked as a new query. Its trend starts at the next sweep and its Source becomes Manual. Past answers stay with the old wording.'
const TYPE_FOLLOWS_SUBJECT = 'A market query is Non-brand and a location query is Branded. Only a hand-picked query takes either.'
const TYPE_SETS_SUBJECT = 'This market has one location, so the type decides the Subject. Branded reads as a location query and Non-brand as a market query.'
const FIELD_LABEL = 'mb-1 block text-sm font-medium text-heading'
const FIELD_HINT = 'mt-2 text-[13px] leading-5 text-secondary'
const FIELD_CONTROL = 'block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500'
const count = (value: number) => value.toLocaleString('en-US')

interface TrackedActionSheetProps {
  projectName: string
  workspace: QueryTrackingWorkspaceResponse
  action: TrackedSheetAction
  /** One row from its menu, or the selected rows from the bulk bar. */
  rows: readonly TrackedRowVm[]
  /** The place the page is filtered to. */
  place?: TrackedPlace
  /** The search location and engines choices of the Add queries sheet, for a move to a location in no market. */
  contextChoices: readonly { label: string; input: QueryTrackingContextInput }[]
  sweepActive: boolean
  /** The next scheduled sweep, for the review. */
  nextSweepDate?: string | null
  onClose: () => void
  /** Runs once a publish succeeds, just before the sheet closes, with what the server published. */
  onPublished?: (result: QueryTrackingCommitResponse) => void
}

/**
 * One sheet for every Tracked row and bulk action that changes tracking: a
 * small form, then the shared review, exactly as the Add queries sheet ends.
 * The form only fills one of the `tracked-actions` builders; the review shows
 * what the server will do, and a refused review or publish stays in the sheet
 * with Review again. Mount it once per action: the form starts from the rows
 * and the place it is given.
 *
 * With a `place`, Edit wording, Change type and Stop tracking start on "Only
 * {place}", which narrows the change to that place, and "Everywhere" sends it
 * for the whole query. Change Subject and Move replace the query's whole
 * placement, so they take no place. Edit wording, Change Subject and Move act
 * on the first row.
 */
export function TrackedActionSheet(props: TrackedActionSheetProps) {
  const row = props.rows.at(0)
  return row ? <ActionSheet {...props} row={row} /> : null
}

function ActionSheet({ projectName, workspace, action, rows, row, place, contextChoices, sweepActive, nextSweepDate, onClose, onPublished }: TrackedActionSheetProps & { row: TrackedRowVm }) {
  const publish = useQueryTrackingPublish(projectName, { onCommitted: result => { onPublished?.(result); onClose() } })
  const [appliesTo, setAppliesTo] = useState<'place' | 'everywhere'>('place')
  const [text, setText] = useState(row.queryText)
  // One row starts on the type an operator gave it, so the control shows what a change would replace.
  const [type, setType] = useState<TrackedTypeChoice>(() => {
    const current = rows.length === 1 ? operatorType(row) : null
    return current && allowedTypes(row, workspace).includes(current) ? current : 'auto'
  })
  const [subject, setSubject] = useState<'market' | 'location'>(action === 'move-location' || row.subject.kind === 'location' ? 'location' : 'market')
  // The row's own market or location, so the form opens on the Subject it has and Review stays off until that changes.
  const [placeKey, setPlaceKey] = useState(row.subject.kind === 'market' || row.subject.kind === 'location' ? row.subject.key : undefined)
  const [contextLabel, setContextLabel] = useState('')
  const [reviewed, setReviewed] = useState<QueryTrackingMutation | null>(null)
  const picker = useRef<HTMLDivElement>(null)
  const [opener] = useState(() => document.activeElement)
  const id = useId()

  const narrows = action === 'edit-wording' || action === 'change-type' || action === 'stop'
  const placed = action === 'change-subject' || action === 'move-location'
  const within = place && narrows && appliesTo === 'place' ? place : undefined
  const types = TYPE_ORDER.filter(choice => rows.some(candidate => allowedTypes(candidate, workspace).includes(choice)))
  const { changed, skipped } = typeChangeRows(rows, type, workspace)
  const placing = PLACES[subject]
  const places = placesOf(workspace.scopeOptions ?? [], placing.kind)
  const chosen = places.find(option => option.kind === placing.kind && option.id === placeKey)
  const target = chosen ? { kind: subject, key: chosen.id } : null
  // The markets a location's queries already count in: those with a usage edge for it.
  const locationMarkets = subject === 'location' && chosen ? marketsHolding(workspace, chosen.id) : []
  // A project with one search location and engines choice needs no pick.
  const context = contextChoices.length === 1 ? contextChoices[0] : contextChoices.find(choice => choice.label === contextLabel)
  const mutation = draft()
  const tooMany = rows.length > TRACKED_BULK_MAX
  const canReview = mutation !== null && !tooMany && !publish.isPreviewing
  const preview = reviewed ? publish.preview : null
  // The toast for a refused review or publish sits under this sheet, so the review stays up to show the
  // refusal and offer another review. Back keeps showing it beside the form, until the next request.
  const reviewState: TrackingReviewState | null = reviewed && (preview || publish.error) ? {
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
    // A form that still resolves is rebuilt from the refreshed workspace. One whose place is gone
    // goes again as it was reviewed, so the server says why.
    onReviewAgain: () => {
      if (canReview) review()
      else publish.requestPreview({ ...reviewed, expectedWorkspaceVersion: workspace.workspaceVersion })
    },
    onBack: () => setReviewed(null),
  } : null
  // The review reads no next sweep date yet. It is passed along with the sweep state, so the review can show it with no change here.
  const reviewContext = { sweepActive, nextSweepDate }

  /** The request the form stands for, or null while it would change nothing or is not complete. */
  function draft(): QueryTrackingMutation | null {
    switch (action) {
      case 'edit-wording': {
        const next = text.trim()
        return next && next !== row.queryText ? editWording(row, next, within) : null
      }
      // Rows an operator already set to this type have nothing to change.
      case 'change-type': return changed.some(candidate => operatorType(candidate) !== type) ? changeType(changed, type, within) : null
      case 'stop': return stopTracking(rows, within)
      case 'remove': return stopTracking(rows)
      case 'change-subject': return target && !sameSubject(row, target) ? changeSubject(row, target, workspace, context?.input) : null
      case 'move-location': return target && !sameSubject(row, target) ? moveLocation(row, target.key, workspace, context?.input) : null
    }
  }

  /** A change to the form drops a review still in flight, so the sheet never shows a review of an older form. */
  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setReviewed(null)
    }
  }

  // The control reports a click on the current choice too, which must keep the place. A query has one Subject, so a change drops it.
  function chooseSubject(next: SubjectChoice) {
    if (next === subject || next === 'company') return
    setSubject(next)
    edit(setPlaceKey)(undefined)
  }

  function review() {
    if (!mutation || !canReview) return
    setReviewed(mutation)
    publish.requestPreview({ ...mutation, expectedWorkspaceVersion: workspace.workspaceVersion })
  }

  // A sheet opened without a Radix trigger returns focus to its opener itself.
  function restoreFocus(event: Event) {
    event.preventDefault()
    if (opener instanceof HTMLElement) opener.focus()
  }

  // Escape closes an open place picker or an open help bubble first, not the whole sheet.
  function keepOpenForInner(event: KeyboardEvent) {
    const eventTarget = event.target
    if (!(eventTarget instanceof Element)) return
    if (picker.current?.querySelector('details[open]')?.contains(eventTarget) || eventTarget.closest('.info-tooltip-trigger[aria-expanded="true"]')) event.preventDefault()
  }

  return (
    <Sheet open onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent onCloseAutoFocus={restoreFocus} onEscapeKeyDown={keepOpenForInner}>
        <SheetHeader>
          <SheetTitle>{TRACKED_ACTION_LABEL[action]}</SheetTitle>
          <SheetDescription className="sr-only">{DESCRIPTION[action]}</SheetDescription>
        </SheetHeader>
        {reviewState ? <>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
            <TrackingReview {...reviewState} {...reviewContext} workspace={workspace} contextLabels={contextLabels} showActions={false} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-default pt-4">
            <TrackingReviewActions {...reviewState} {...reviewContext} />
          </div>
        </> : <>
          {/* The place picker opens under its trigger, inside this scroller. On a phone the sheet is only as tall as its form, so a form with a picker keeps room for the open list. */}
          <div className={`-mx-1 mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto px-1${placed ? ' max-md:min-h-[55vh]' : ''}`}>
            {action === 'edit-wording' ? (
              <div>
                <label className={FIELD_LABEL} htmlFor={`${id}-text`}>Query</label>
                <textarea id={`${id}-text`} className={`${FIELD_CONTROL} min-h-24`} value={text} onChange={event => edit(setText)(event.target.value)} />
                <div className="mt-2"><StatusNote icon={GitBranch} label="New trend line" detail={NEW_TREND_LINE} /></div>
              </div>
            ) : (
              <div>
                <span className={FIELD_LABEL}>{rows.length === 1 ? 'Query' : `${count(rows.length)} queries`}</span>
                <ul className="space-y-1 text-sm leading-5 text-strong">
                  {rows.slice(0, LISTED).map(listed => <li key={listed.queryId} className="break-words">{listed.queryText}</li>)}
                </ul>
                {rows.length > LISTED ? <p className="mt-1 text-[13px] leading-5 text-secondary">+{count(rows.length - LISTED)} more</p> : null}
              </div>
            )}
            {action === 'change-type' ? (
              <div>
                <span aria-hidden="true" className={FIELD_LABEL}>Type</span>
                {/* After the control, so the sheet opens with focus on the Type, not on the help. */}
                <div className="flex items-center">
                  <SegmentedRadioGroup label="Type" options={types.map(value => ({ value, label: TYPE_LABEL[value] }))} value={type} onChange={edit(setType)} />
                  {rows.some(candidate => allowedTypes(candidate, workspace).length < TYPE_ORDER.length) ? <InfoTooltip text={TYPE_FOLLOWS_SUBJECT} placement="bottom" /> : null}
                </div>
                {/* Here the type is the only way to move the query between its market and its location. */}
                {rows.length === 1 && (row.subject.kind === 'market' || row.subject.kind === 'location') && typeSetsSubject(row.subject, workspace)
                  ? <div className="mt-2"><StatusNote icon={Info} label="Type sets Subject" detail={TYPE_SETS_SUBJECT} /></div> : null}
                {skipped.length > 0 ? (
                  <details className="mt-3 border-t border-default text-sm text-secondary">
                    <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">{count(skipped.length)} skipped</summary>
                    <ul className="max-h-40 space-y-1 overflow-y-auto pb-3 leading-5">
                      {skipped.map(left => <li key={left.queryId} className="break-words">{left.queryText}</li>)}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}
            {action === 'change-subject' ? (
              <div>
                <span aria-hidden="true" className={FIELD_LABEL}>Subject</span>
                {/* A hover title shows on neither a tap nor keyboard focus, so the help says why Company is off. */}
                <div className="flex items-center">
                  <SegmentedRadioGroup label="Subject" options={SUBJECTS} value={subject} onChange={chooseSubject} />
                  <InfoTooltip text="Company is not available yet." placement="bottom" />
                </div>
              </div>
            ) : null}
            {placed ? (
              <div ref={picker}>
                {places.some(option => option.kind === placing.kind)
                  ? <VisibilityScopePicker key={subject} label={placing.label} placeholder={placing.placeholder} options={places} selected={chosen} allowGroupSelect={false} propertyNoun={LOCATION_NOUN} onSelect={option => edit(setPlaceKey)(option.id)} />
                  : <p className="text-sm leading-6 text-secondary">{placing.none}</p>}
                {subject !== 'location' || !chosen ? null : locationMarkets.length > 0 ? (
                  <div className={`${FIELD_HINT} flex items-center`}>
                    <p>Counts in: {locationMarkets.map(market => market.label).join(', ')}</p>
                    <InfoTooltip text="Asked with these markets' engines and search locations." placement="bottom" />
                  </div>
                ) : (
                  <div className="mt-2">
                    <StatusNote icon={AlertTriangle} tone="caution" label="In no market" detail="A query for a location in no market needs its own search location and engines." />
                    {contextChoices.length === 0 ? <div><StatusNote icon={AlertTriangle} tone="caution" label="No search location" detail="No search location and engines are set up for this project, so this location cannot take the query." /></div>
                      : contextChoices.length === 1 ? <p className={FIELD_HINT}>Search location and engines: {contextChoices[0]!.label}</p>
                        : <>
                          <label className={`${FIELD_LABEL} mt-3`} htmlFor={`${id}-context`}>Search location and engines</label>
                          <select id={`${id}-context`} required className={`${FIELD_CONTROL} min-h-11`} value={context?.label ?? ''} onChange={event => edit(setContextLabel)(event.target.value)}>
                            <option value="">Choose a search location and engines</option>
                            {contextChoices.map(choice => <option key={choice.label} value={choice.label}>{choice.label}</option>)}
                          </select>
                        </>}
                  </div>
                )}
                {/* The same pairings read as the market's or the location's query there, whichever Subject was picked. */}
                {target && typeSetsSubject(target, workspace) ? <div className="mt-2"><StatusNote icon={Info} label="Type sets Subject" detail={TYPE_SETS_SUBJECT} /></div> : null}
              </div>
            ) : null}
            {place && narrows ? (
              <div>
                <span aria-hidden="true" className={FIELD_LABEL}>Applies to</span>
                <SegmentedRadioGroup
                  label="Applies to"
                  className="max-w-full flex-wrap"
                  options={[{ value: 'place', label: `Only ${place.label}` }, { value: 'everywhere', label: 'Everywhere' }]}
                  value={appliesTo}
                  onChange={edit(setAppliesTo)}
                />
              </div>
            ) : null}
            {/* No sentence behind it: with Review off this would be the sheet's first stop, and focus would open its bubble. */}
            {tooMany ? <div><StatusNote icon={Ban} tone="caution" label={`Max ${TRACKED_BULK_MAX} rows`} /></div> : null}
          </div>
          {publish.error ? <p role="alert" className="mt-4 text-sm leading-5 text-negative"><span className="font-medium">{publish.error.title}.</span> {publish.error.detail}</p> : null}
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Ban, MapPinOff, X } from 'lucide-react'
import { normalizeIdentityText } from '@canonry/canonry-contracts'
import type {
  QueryTrackingCommitResponse,
  QueryTrackingContextInput,
  QueryTrackingMutation,
  QueryTrackingSourceInput,
  QueryTrackingWorkspaceResponse,
} from '@canonry/canonry-contracts'

import { isAeroPreview, shouldShowDashboardAgentBar } from '../../../../api.js'
import { useAccount } from '../../../../contexts/account-context.js'
import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { useQueryTrackingPublish } from '../../../../queries/use-query-tracking-publish.js'
import { WriteButton } from '../../../shared/AccessControls.js'
import { aeroAllowedFor } from '../../../shared/AeroBar.js'
import { InfoTooltip } from '../../../shared/InfoTooltip.js'
import { SegmentedRadioGroup, type SegmentedRadioOption } from '../../../shared/SegmentedRadioGroup.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, useSheetDiscardGuard } from '../../../ui/sheet.js'
import { placesOf } from '../../AddQueriesForm.js'
import { expectedSubject, SearchLocationText, TrackingReview, TrackingReviewActions, type TrackingReviewState } from '../../TrackingReview.js'
import { VisibilityScopePicker } from '../../VisibilityScopePicker.js'
import { TrackedBulkBar } from '../advanced/TrackedBulkBar.js'
import { marketsHolding, subjectPlacement, TRACKED_BULK_MAX, type TrackedSubjectTarget } from '../advanced/tracked-actions.js'
import { subjectKindLabel } from '../advanced/tracked-view-model.js'
import { contextLabels, sheetContextChoices } from '../tracking-contexts.js'
import { RESEARCH_TABLE, RESEARCH_TD, RESEARCH_TH } from './ResearchResults.js'

/** One ticked row of a Research table: a saved research query or a Find ideas result. */
export type TrackResearchItem = {
  text: string
  /** The saved row the server reads the text from, so the tracked query keeps Research as its Source. */
  input: Extract<QueryTrackingSourceInput, { source: 'research' | 'discovery' }>
  /** The market or location the row's run was saved under. Left out, the sheet asks. */
  subject?: TrackedSubjectTarget
}

type SubjectChoice = 'market' | 'location' | 'company'

const SUBJECTS: readonly SegmentedRadioOption<SubjectChoice>[] = [
  { value: 'market', label: 'Market' },
  { value: 'location', label: 'Location' },
  { value: 'company', label: 'Company', description: 'Not available yet', disabled: true },
]
/** The wire calls a location a property; this sheet never does. */
const LOCATION_NOUN = ['location', 'locations'] as const
const PLACES = {
  market: { kind: 'market', label: 'Market', placeholder: 'Choose a market', none: 'No markets yet' },
  location: { kind: 'property', label: 'Location', placeholder: 'Choose a location', none: 'No locations yet' },
} as const
/** A location's markets are named up to this many, then counted, with the names in the help. */
const NAMED_MARKETS = 2
const COUNTS_IN = "Asked with these markets' engines and search locations."
/** A location in no market takes the project's one search location and engines choice. With none, or more than one, it cannot be placed here. */
const IN_NO_MARKET = {
  one: 'A query for a location in no market needs its own search location and engines.',
  none: 'No search location and engines are set up for this project, so a location in no market cannot take a query.',
  several: 'A location in no market needs its own search location and engines, and this project has more than one. Add its queries with Add queries on the Tracked tab, which asks for one.',
}
/** Why Review waits when one query text is ticked in runs saved under different Subjects: the server would track it once, for both. */
const ONE_SUBJECT = 'This query is ticked under more than one Subject, and a query is tracked for one. Remove the rows you do not want.'
const FIELD_LABEL = 'mb-1 block text-sm font-medium text-heading'
const FIELD_HINT = 'mt-2 text-[13px] leading-5 text-secondary'
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
// A row's Remove, drawn as the sheet's own Close is. 44px where a finger is the pointer.
const REMOVE = 'inline-grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-bg-elevated hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:size-11 max-md:size-11'
const count = (value: number) => value.toLocaleString('en-US')

/** A ticked row's identity: the id of its saved research query or Find ideas result. */
export const trackItemId = (item: TrackResearchItem): string => item.input.source === 'research' ? item.input.researchRunQueryId : item.input.discoveryProbeId

/**
 * The ticked rows of a Research table, in the order they were ticked. They
 * outlive the rows on screen, so rows from several runs, or several pages, go
 * in one publish. A row whose query has since been tracked leaves the
 * selection: `subjects` holds every tracked query by its identity text.
 */
export function useTrackSelection(subjects: ReadonlyMap<string, string> | undefined) {
  const [picked, setPicked] = useState<readonly TrackResearchItem[]>([])
  const items = useMemo(() => subjects ? picked.filter(item => !subjects.has(normalizeIdentityText(item.text))) : picked, [picked, subjects])
  const pickedIds = useMemo(() => new Set(items.map(trackItemId)), [items])
  const pick = useCallback((rows: readonly TrackResearchItem[], on: boolean) => setPicked(current => {
    const ids = new Set(rows.map(trackItemId))
    const rest = current.filter(item => !ids.has(trackItemId(item)))
    return on ? [...rest, ...rows] : rest
  }), [])
  const clear = useCallback(() => setPicked([]), [])
  return { items, pickedIds, pick, clear }
}

/**
 * The bar for the ticked rows of a Research table, and the sheet its Track
 * button opens. It is the Tracked page's bar with one action. A view-only
 * account ticks nothing, so it never sees the bar.
 *
 * Track and Clear both take the bar off the page once they are done, so
 * `returnFocus` names where the focus goes then.
 */
export function TrackResearchBar({ id, projectName, workspace, items, sweepActive, nextSweepDate, onClear, onRemove, returnFocus }: {
  /** With an id, the table can hold a "Selected actions" link that jumps here. */
  id?: string
  projectName: string
  workspace: QueryTrackingWorkspaceResponse
  items: readonly TrackResearchItem[]
  sweepActive: boolean
  nextSweepDate?: string | null
  onClear: () => void
  /** Unticks rows from inside the sheet, so one row that cannot be tracked never holds the rest back. */
  onRemove?: (items: readonly TrackResearchItem[]) => void
  returnFocus?: () => void
}) {
  const { isAdmin, account } = useAccount()
  const [open, setOpen] = useState(false)
  // The sheet hands the focus back to the Track button. After a publish that button is gone with the bar, so the caller's table takes it.
  const wasOpen = useRef(false)
  useEffect(() => {
    const closed = wasOpen.current && !open
    wasOpen.current = open
    if (!closed) return
    // After the sheet's own hand-back, which waits a tick.
    const timer = setTimeout(() => { if (document.activeElement === document.body) returnFocus?.() })
    return () => clearTimeout(timer)
  }, [open])
  if (items.length === 0) {
    // The sheet goes with its last row, and stays shut when the next one is ticked.
    if (open) setOpen(false)
    return null
  }
  return (
    <>
      <TrackedBulkBar
        id={id}
        selectedCount={items.length}
        maxRows={TRACKED_BULK_MAX}
        // The bar names its own actions, and this one carries the count, so it is drawn in the bar's note slot. Over the limit the bar says so in its place.
        actions={[]}
        onAction={() => {}}
        note={<WriteButton type="button" size="sm" className={TOUCH} onClick={() => setOpen(true)}>Track {count(items.length)}</WriteButton>}
        onClear={() => { onClear(); returnFocus?.() }}
        aeroBarVisible={isAeroPreview() || (shouldShowDashboardAgentBar() && aeroAllowedFor({ isAdmin, account }))}
      />
      {open ? (
        <TrackResearchSheet
          projectName={projectName}
          workspace={workspace}
          contextChoices={sheetContextChoices(workspace)}
          sweepActive={sweepActive}
          nextSweepDate={nextSweepDate}
          items={items}
          onClose={() => setOpen(false)}
          onPublished={onClear}
          onRemove={onRemove}
        />
      ) : null}
    </>
  )
}

interface TrackResearchSheetProps {
  projectName: string
  workspace: QueryTrackingWorkspaceResponse
  /** The search location and engines choices of the Add queries sheet, for a location in no market. */
  contextChoices: readonly { label: string; input: QueryTrackingContextInput }[]
  sweepActive: boolean
  /** The next scheduled sweep, for the review. */
  nextSweepDate?: string | null
  items: readonly TrackResearchItem[]
  onClose: () => void
  /** Runs once a publish succeeds, just before the sheet closes, with what the server published. */
  onPublished?: (result: QueryTrackingCommitResponse) => void
  /** Takes rows out of `items`. With it, each row of a list of two or more has a Remove. */
  onRemove?: (items: readonly TrackResearchItem[]) => void
}

/**
 * Track the ticked rows of a Research table: one addition per query, each
 * with the place it is about, then the shared review. A row whose run was
 * saved under a market or a location that the plan still holds keeps that
 * Subject. The rest share one Subject control and place picker, are listed
 * first under it, and Review waits until every row has a place.
 *
 * The server tracks a query by its text, so two ticked rows with one text
 * are one query. Under one Subject they are listed and sent once. Under two
 * the server would track the query once for both, as a hand-picked one, so
 * both rows are marked and Review waits until one Subject is left.
 *
 * An addition is placed exactly as the Add queries sheet places one
 * (`subjectPlacement`): a market names itself alone, and a location names
 * itself and every market that holds it, so the query counts in those markets
 * too. A location in no market takes the project's one search location and
 * engines choice. With none, or more than one, the row cannot be placed here
 * and is removed to review the rest. No row is ever sent without its place.
 * A view-only account gets no sheet.
 */
export function TrackResearchSheet(props: TrackResearchSheetProps) {
  const { canWrite } = useAccount()
  if (!canWrite || props.items.length === 0) return null
  return <TrackSheet {...props} />
}

function TrackSheet({ projectName, workspace, contextChoices, sweepActive, nextSweepDate, items, onClose, onPublished, onRemove }: TrackResearchSheetProps) {
  const publish = useQueryTrackingPublish(projectName, { onCommitted: result => { onPublished?.(result); onClose() } })
  const [subject, setSubject] = useState<'market' | 'location'>('market')
  const [placeKey, setPlaceKey] = useState<string>()
  const [reviewed, setReviewed] = useState<QueryTrackingMutation | null>(null)
  const picker = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLTableSectionElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  // The row whose Remove was pressed. Its button goes with it, so the next row's takes the focus.
  const removedAt = useRef<number | null>(null)
  const [opener] = useState(() => document.activeElement)

  const placing = PLACES[subject]
  const places = placesOf(workspace.scopeOptions ?? [], placing.kind)
  const chosen = places.find(option => option.kind === placing.kind && option.id === placeKey)
  const shared = chosen ? { target: { kind: subject, key: chosen.id }, label: chosen.label } : null
  // The markets a location's queries already count in: those with a usage edge for it.
  const locationMarkets = subject === 'location' && chosen ? marketsHolding(workspace, chosen.id) : []
  // A location in no market takes the project's one choice. With several there is no saying which.
  const context = contextChoices.length === 1 ? contextChoices[0]!.input : undefined
  const labels = {
    market: new Map(workspace.markets.map(market => [market.stableKey, market.label])),
    location: new Map(workspace.targets.map(target => [target.stableKey, target.label])),
  }
  const placedItems = items.map(item => {
    // A Subject the plan no longer holds is no Subject.
    const ownLabel = item.subject ? labels[item.subject.kind].get(item.subject.key) : undefined
    const placed = item.subject && ownLabel !== undefined ? { target: item.subject, label: ownLabel } : shared
    return { item, own: ownLabel !== undefined, placed, identity: normalizeIdentityText(item.text) }
  })
  // One row per query text and Subject, the rows that take the shared Subject first. A text ticked twice under one Subject is one row, which holds every ticked row it stands for.
  const queries = new Map<string, (typeof placedItems)[number] & { items: TrackResearchItem[] }>()
  const subjectsOf = new Map<string, number>()
  for (const row of [...placedItems.filter(row => !row.own), ...placedItems.filter(row => row.own)]) {
    const key = `${row.identity}\n${row.placed ? `${row.placed.target.kind}:${row.placed.target.key}` : ''}`
    const listed = queries.get(key)
    if (listed) listed.items.push(row.item)
    else {
      queries.set(key, { ...row, items: [row.item] })
      if (row.placed) subjectsOf.set(row.identity, (subjectsOf.get(row.identity) ?? 0) + 1)
    }
  }
  const rows = [...queries.values()].map(({ item, items: ticked, own, placed, identity }) => {
    const placement = placed ? subjectPlacement(placed.target, workspace, context) : null
    // A row that keeps its run's own location says where else it counts, as the picker does for a chosen one.
    const markets = own && placed?.target.kind === 'location' ? marketsHolding(workspace, placed.target.key) : null
    return {
      item,
      ticked,
      own,
      target: placed?.target ?? null,
      subject: placed ? `${subjectKindLabel(placed.target.kind)} · ${placed.label}` : null,
      placement,
      counts: !markets ? null
        : markets.length > NAMED_MARKETS ? `Counts in ${count(markets.length)} markets`
          : markets.length > 0 ? `Counts in: ${markets.map(market => market.label).join(' · ')}`
            : placement ? 'In no market' : null,
      // The same text under another Subject: the server would track one query for both.
      clash: placed !== null && subjectsOf.get(identity)! > 1,
    }
  })
  const sharing = rows.filter(row => !row.own).length
  const subjectLabel = `Subject for ${count(sharing)} ${sharing === 1 ? 'query' : 'queries'}`
  // Only a location in no market has a Subject and still no place.
  const unplaced = rows.some(row => row.subject !== null && row.placement === null)
  const clashing = rows.some(row => row.clash)
  const tooMany = rows.length > TRACKED_BULK_MAX
  const canReview = rows.every(row => row.placement !== null && !row.clash) && !tooMany && !publish.isPreviewing
  // The last row has Cancel.
  const removable = onRemove !== undefined && rows.length > 1
  const guard = useSheetDiscardGuard({ dirty: subject !== 'market' || placeKey !== undefined || reviewed !== null, busy: publish.isCommitting, onClose })
  const preview = reviewed ? publish.preview : null
  // The toast for a refused review or publish sits under this sheet, so the review stays up to show the
  // refusal and offer another review. Back keeps showing it beside the rows, until the next request.
  const reviewState: TrackingReviewState | null = reviewed && (preview || publish.error) ? {
    preview,
    error: publish.error,
    isCommitting: publish.isCommitting,
    // Each row is tracked for its own Subject, so the review checks each lands there and nowhere else.
    expectedSubjects: rows.flatMap(row => row.target ? [expectedSubject(row.item.text, row.target, workspace)] : []),
    onPublish: () => {
      if (preview) publish.commit({
        ...reviewed,
        expectedWorkspaceVersion: preview.workspaceVersion,
        previewToken: preview.previewToken,
        reviewedAt: preview.reviewedAt,
      })
    },
    // Rows that still resolve are placed again from the refreshed workspace. When one no longer does,
    // the change goes again as it was reviewed, so the server says why.
    onReviewAgain: () => {
      if (canReview) review()
      else publish.requestPreview({ ...reviewed, expectedWorkspaceVersion: workspace.workspaceVersion })
    },
    onBack: () => setReviewed(null),
  } : null
  const reviewContext = { sweepActive, nextSweepDate }

  useEffect(() => {
    if (removedAt.current === null) return
    const removes = list.current?.querySelectorAll<HTMLElement>('button')
    ;(removes?.[Math.min(removedAt.current, removes.length - 1)] ?? actions.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
    removedAt.current = null
  }, [items])

  /** A change to the Subject drops a review still in flight, so the sheet never shows a review of an older choice. */
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
    if (!canReview) return
    const mutation: QueryTrackingMutation = {
      additions: rows.map(row => ({ input: row.item.input, ...row.placement, ...(row.target?.kind === 'location' ? { queryClass: 'branded' as const } : {}) })),
      removals: [],
    }
    setReviewed(mutation)
    publish.requestPreview({ ...mutation, expectedWorkspaceVersion: workspace.workspaceVersion })
  }

  // A sheet opened without a Radix trigger returns focus to its opener itself.
  function restoreFocus(event: Event) {
    event.preventDefault()
    if (opener instanceof HTMLElement) opener.focus()
  }

  // A sheet opens on its first control. With no Subject to choose that would be a row's Remove, so it opens on Review, or on Cancel while Review waits.
  function openOnActions(event: Event) {
    if (sharing > 0) return
    event.preventDefault()
    actions.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }

  // Escape closes an open place picker or an open help bubble first, not the whole sheet.
  function keepOpenForInner(event: KeyboardEvent) {
    const eventTarget = event.target
    if (!(eventTarget instanceof Element)) return
    if (picker.current?.querySelector('details[open]')?.contains(eventTarget) || eventTarget.closest('.info-tooltip-trigger[aria-expanded="true"]')) event.preventDefault()
  }

  return (
    <Sheet open onOpenChange={open => { if (!open) guard.requestClose() }}>
      <SheetContent onPointerDownOutside={guard.onPointerDownOutside} onOpenAutoFocus={openOnActions} onCloseAutoFocus={restoreFocus} onEscapeKeyDown={keepOpenForInner}>
        <SheetHeader>
          <SheetTitle>Track {count(rows.length)} {rows.length === 1 ? 'query' : 'queries'}</SheetTitle>
          <SheetDescription className="sr-only">Each query is tracked for one market or one location. Review the change before it is published.</SheetDescription>
        </SheetHeader>
        {reviewState ? <>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
            <TrackingReview {...reviewState} {...reviewContext} workspace={workspace} contextLabels={contextLabels} showActions={false} />
          </div>
          {/* The review's buttons are 44px on a phone. */}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-default pt-4 max-md:[&>button]:h-11">
            <TrackingReviewActions {...reviewState} {...reviewContext} />
          </div>
        </> : <>
          {/* The place picker opens under its trigger, inside this scroller. On a phone the sheet is only as tall as its form, so a form with a picker keeps room for the open list. */}
          <div className={`-mx-1 mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto px-1${sharing > 0 ? ' max-md:min-h-[55vh]' : ''}`}>
            {sharing > 0 ? <>
              <div>
                {/* Named for the rows it sets, which are listed first: the rows under them keep their run's own Subject. */}
                <span aria-hidden="true" className={FIELD_LABEL}>{subjectLabel}</span>
                {/* A hover title shows on neither a tap nor keyboard focus, so the help says why Company is off. After the control, so the sheet opens with focus on the Subject, not on the help. */}
                <div className="flex items-center">
                  <SegmentedRadioGroup label={subjectLabel} options={SUBJECTS} value={subject} onChange={chooseSubject} />
                  <InfoTooltip text="Company is not available yet." placement="bottom" />
                </div>
              </div>
              <div ref={picker}>
                {places.some(option => option.kind === placing.kind)
                  ? <VisibilityScopePicker key={subject} label={placing.label} placeholder={placing.placeholder} options={places} selected={chosen} allowGroupSelect={false} propertyNoun={LOCATION_NOUN} onSelect={option => edit(setPlaceKey)(option.id)} />
                  : <>
                    <span className={FIELD_LABEL}>{placing.label}</span>
                    <StatusNote icon={MapPinOff} label={placing.none} />
                  </>}
                {subject !== 'location' || !chosen ? null : locationMarkets.length > 0 ? (
                  <div className={`${FIELD_HINT} flex items-center`}>
                    {locationMarkets.length > NAMED_MARKETS ? <>
                      <p>Counts in {count(locationMarkets.length)} markets</p>
                      <InfoTooltip text={`${locationMarkets.map(market => market.label).join(' · ')}. ${COUNTS_IN}`} placement="bottom" />
                    </> : <>
                      <p>Counts in: {locationMarkets.map(market => market.label).join(' · ')}</p>
                      <InfoTooltip text={COUNTS_IN} placement="bottom" />
                    </>}
                  </div>
                ) : contextChoices.length === 1 ? (
                  // As the Add queries sheet says it: the location is in no market, and what its query is asked with instead.
                  <div className="mt-2">
                    <StatusNote icon={AlertTriangle} tone="caution" label="In no market" detail={IN_NO_MARKET.one} />
                    <dl className={`${FIELD_HINT} flex flex-wrap items-center gap-x-2`}>
                      <dt className="shrink-0">Search location and engines</dt>
                      <dd className="min-w-0 text-strong">
                        <SearchLocationText
                          label={`${contextChoices[0]!.input.location ?? 'No search location'} · ${contextChoices[0]!.input.providers.map(name => providerDisplayName(name)).join(', ')}`}
                          detail={contextChoices[0]!.label}
                        />
                      </dd>
                    </dl>
                  </div>
                ) : null}
              </div>
            </> : null}
            <table className={`${RESEARCH_TABLE} [&_tbody_tr:last-child_td]:border-b-0`}>
              <thead><tr>
                <th scope="col" className={RESEARCH_TH}>Query</th>
                <th scope="col" className={`${RESEARCH_TH} w-2/5`}>Subject</th>
                {removable ? <th scope="col" className="w-8 border-b border-default p-0 pointer-coarse:w-11 max-md:w-11"><span className="sr-only">Remove</span></th> : null}
              </tr></thead>
              <tbody ref={list}>
                {rows.map((row, index) => (
                  <tr key={trackItemId(row.item)}>
                    <td className={`${RESEARCH_TD} font-medium text-heading`}>{row.item.text}</td>
                    <td className={`${RESEARCH_TD} text-secondary`}>
                      {/* No sentence behind any mark, so a row has one stop, its Remove. The sentence is behind the note beside the buttons. */}
                      {row.subject ?? <StatusNote icon={AlertTriangle} tone="caution" label="Subject not set" />}
                      {row.counts ? <span className="block text-[13px] text-muted">{row.counts}</span> : null}
                      {row.subject !== null && row.placement === null ? <span className="block"><StatusNote icon={AlertTriangle} tone="caution" label="In no market" /></span> : null}
                      {row.clash ? <span className="block"><StatusNote icon={AlertTriangle} tone="caution" label="Keep one Subject" /></span> : null}
                    </td>
                    {removable ? <td className="border-b border-subtle p-0 text-center align-middle">
                      <button type="button" className={REMOVE} aria-label={`Remove ${row.item.text}`} onClick={() => { removedAt.current = index; setReviewed(null); onRemove(row.ticked) }}>
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    </td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {tooMany ? <div><StatusNote icon={Ban} tone="caution" label={`Max ${TRACKED_BULK_MAX} rows`} /></div> : null}
          </div>
          {publish.error ? <p role="alert" className="mt-4 text-sm leading-5 text-negative"><span className="font-medium">{publish.error.title}.</span> {publish.error.detail}</p> : null}
          <div ref={actions} className="mt-4 flex flex-wrap items-center gap-3 border-t border-default pt-4">
            <WriteButton type="button" size="sm" className="max-md:h-11" disabled={!canReview} onClick={review}>
              {publish.isPreviewing ? 'Reviewing…' : 'Review'}
            </WriteButton>
            <Button type="button" variant="ghost" size="sm" className="max-md:h-11" onClick={guard.requestClose}>Cancel</Button>
            {/* After the buttons, so neither is ever the sheet's first stop. */}
            {unplaced ? <StatusNote icon={AlertTriangle} tone="caution" label="In no market" detail={contextChoices.length === 0 ? IN_NO_MARKET.none : IN_NO_MARKET.several} /> : null}
            {clashing ? <StatusNote icon={AlertTriangle} tone="caution" label="Keep one Subject" detail={ONE_SUBJECT} /> : null}
          </div>
        </>}
        {guard.prompt}
      </SheetContent>
    </Sheet>
  )
}

import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { TrackedPageHostProps } from '../../DiscoverySection.js'
import { Button } from '../../../ui/button.js'
import { TrackingReview, expectedSubject } from '../../TrackingReview.js'
import { TrackingAddQueriesPage, useAddQueriesNavigation } from '../AddQueriesEntry.js'
import { TrackingComposer } from '../TrackingComposer.js'
import { contextLabels } from '../tracking-contexts.js'
import { defaultTrackingDraft } from '../tracking-draft.js'
import type { TrackedQueriesPageProps, TrackingComposerState } from '../use-tracking-composer.js'

/** The route owns this full-page task; the list's URL filters remain its return context. */
export function AddTrackedQueriesPage({ projectName, workspace, selection, templates, composer, preview, publishError, isPreviewing, isCommitting, onPreview, nextSweepDate }: TrackedQueriesPageProps & TrackedPageHostProps & { composer: TrackingComposerState }) {
  const [carriedDraft, setCarriedDraft] = useState(false)
  const { search, returnToQueries } = useAddQueriesNavigation(projectName)
  const { action, draft, setDraft, setReviewedMutation, reviewedMutation, openAdd, editorHeadingRef, canReview, mutation, sweepActive, commitReviewed } = composer
  const location = search.addLocation ?? (selection.measurementScope === 'property' ? selection.measurementScopeKey : undefined)
  const market = search.addMarket ?? (selection.measurementScope === 'market' ? selection.measurementScopeKey : undefined)
  const queryIds = new Set(search.addQueryIds?.split(',') ?? [])
  const text = workspace.tracked.filter(row => queryIds.has(row.queryId)).map(row => row.queryText).join('\n')
  // Only guarded form cancellation or a successful publication uses the permitted exit.
  const close = () => returnToQueries(true)
  if (action?.kind !== 'add') return (
    <TrackingAddQueriesPage
      key={`${location ?? ''}:${market ?? ''}:${search.addQueryIds ?? ''}`}
      backLabel={search.returnLocation ? 'Back to location' : 'Back to queries'}
      projectName={projectName}
      workspace={workspace}
      sweepActive={sweepActive}
      defaultLocationKey={location}
      defaultMarketKey={market}
      defaultText={text}
      onClose={close}
      onOpenComposer={({ text: firstLine }) => {
        setCarriedDraft(firstLine.trim().length > 0)
        openAdd('manual', firstLine)
        // Opening from a saved view names its place separately from the list's filters.
        if (search.addLocation || search.addMarket) setDraft({ ...defaultTrackingDraft({ measurementScope: search.addLocation ? 'property' : 'market', measurementScopeKey: search.addLocation ?? search.addMarket, queryClass: 'all' }, workspace), text: firstLine })
      }}
    />
  )
  const expectedSubjects = preview && !draft.wholeSite && draft.targetKeys.length === 0 && draft.groupKeys.length === 0 && draft.marketKeys.length === 1
    ? [...preview.diff.added, ...preview.diff.reused].map(row => expectedSubject(row.queryText, { kind: 'market', key: draft.marketKeys[0]! }, workspace))
    : undefined
  return (
    <section aria-label="Add queries" className="mx-auto w-full max-w-5xl space-y-6 pb-8">
      <Button type="button" variant="ghost" size="sm" className="-ml-2" disabled={isCommitting} onClick={() => returnToQueries()}>
        <ArrowLeft aria-hidden="true" size={16} /> {search.returnLocation ? 'Back to location' : 'Back to queries'}
      </Button>
      <TrackingComposer
        workspace={workspace} templates={templates} action={action} draft={draft}
        onDraftChange={next => { setDraft(next); setReviewedMutation(null) }}
        onClose={close} canReview={canReview} isPreviewing={isPreviewing} isCommitting={isCommitting}
        initiallyDirty={carriedDraft} editorHeadingRef={editorHeadingRef}
        onReview={() => { if (mutation) { setReviewedMutation(mutation); onPreview(mutation) } }}
      />
      {reviewedMutation && (preview || publishError) ? (
        <div className="border-t border-default pt-6">
          <TrackingReview
            preview={preview} expectedSubjects={expectedSubjects} error={publishError} workspace={workspace}
            contextLabels={contextLabels} isCommitting={isCommitting} sweepActive={sweepActive} nextSweepDate={nextSweepDate}
            onPublish={() => commitReviewed(reviewedMutation)} onReviewAgain={() => onPreview(reviewedMutation)}
          />
        </div>
      ) : null}
    </section>
  )
}

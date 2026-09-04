import { useId, useState, type KeyboardEvent } from 'react'
import type { CompetitorLandscapeResponse, CompetitorLandscapeRow as CompetitorLandscapeRowDto } from '@ainyc/canonry-contracts'

import { Button } from '../ui/button.js'

export type CompetitorLandscapeWindow = '7d' | '30d' | '90d' | 'all'
/** Shared API types, re-exported so presentational tests use the public wire contract. */
export type CompetitorLandscapeRow = CompetitorLandscapeRowDto
export type CompetitorLandscapeData = CompetitorLandscapeResponse
type CompetitorMutation = (domain: string) => boolean | void | Promise<boolean | void>

const WINDOW_OPTIONS: readonly { value: CompetitorLandscapeWindow; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
]

function formatShare(share: number | null): string {
  return share === null ? 'Not measured' : `${share.toFixed(1)}%`
}

function sourceClassLabel(sourceClass: CompetitorLandscapeRow['surfaceClass']): string {
  switch (sourceClass) {
    case 'own': return 'Your domain'
    case 'direct-competitor': return 'Competitor'
    case 'ota-aggregator': return 'Aggregator'
    case 'editorial-media': return 'Editorial'
    case 'other': return 'Other'
    default: return 'Unclassified'
  }
}

function WindowControl({
  value,
  onChange,
}: {
  value: CompetitorLandscapeWindow
  onChange: (value: CompetitorLandscapeWindow) => void
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = WINDOW_OPTIONS.findIndex(option => option.value === value)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % WINDOW_OPTIONS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + WINDOW_OPTIONS.length) % WINDOW_OPTIONS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = WINDOW_OPTIONS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = WINDOW_OPTIONS[nextIndex]!
    onChange(next.value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]!.focus()
  }

  return (
    <div className="space-y-1">
      <span className="block text-sm font-medium text-heading">History</span>
      <div
        role="radiogroup"
        aria-label="Competitor history window"
        className="segmented"
        onKeyDown={handleKeyDown}
      >
        {WINDOW_OPTIONS.map(option => {
          const checked = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={`segmented-option min-h-11 ${checked ? 'segmented-option-active' : ''}`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function LandscapeRow({
  row,
  isProject = false,
  canManage,
  onPin,
  onUnpin,
}: {
  row: CompetitorLandscapeRow
  isProject?: boolean
  canManage: boolean
  onPin?: CompetitorMutation
  onUnpin?: CompetitorMutation
}) {
  // This table is a windowed historical reading. Do not link rows to the
  // project’s latest-only evidence table, which would make an older result
  // look like current evidence. Pinning is the only truthful row action here.
  const canPin = !isProject && canManage && !row.pinned && Boolean(onPin)
  const canUnpin = !isProject && canManage && row.pinned && Boolean(onUnpin)
  const hasWindowSources = row.sampleUrls.length > 0
  const [mutationPending, setMutationPending] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)

  async function runMutation(action: 'pin' | 'unpin', mutation: CompetitorMutation | undefined) {
    if (!mutation || mutationPending) return
    setMutationPending(true)
    setMutationError(null)
    try {
      if (await mutation(row.domain) === false) {
        setMutationError(`Could not ${action} competitor. Try again.`)
      }
    } catch {
      setMutationError(`Could not ${action} competitor. Try again.`)
    } finally {
      setMutationPending(false)
    }
  }

  return (
    <tr>
      <th scope="row" className="font-medium text-heading">
        {row.label}
        {isProject ? <span className="ml-1 text-secondary">(you)</span> : null}
      </th>
      <td className="text-secondary">{isProject ? 'Your brand' : sourceClassLabel(row.surfaceClass)}</td>
      <td className="tabular-nums text-strong">{formatShare(row.shareOfVoice)}</td>
      <td className="tabular-nums text-secondary">{row.mentionCount}</td>
      <td className="tabular-nums text-secondary">{row.citationCount}</td>
      <td className="text-right">
        {canPin || canUnpin || hasWindowSources ? (
          <div className="flex min-w-max items-start justify-end gap-2">
            {hasWindowSources ? (
              <details className="inline-disclosure text-left text-xs text-secondary">
                <summary>Source URLs</summary>
                <ul className="mt-2 max-w-72 space-y-1 font-mono text-[11px] font-normal">
                  {row.sampleUrls.map(url => <li key={url} className="break-all">{url}</li>)}
                </ul>
              </details>
            ) : null}
            {canUnpin && onUnpin ? (
              <Button type="button" size="sm" variant="outline" disabled={mutationPending} onClick={() => { void runMutation('unpin', onUnpin) }}>
                Unpin{' '}
                <span className="sr-only">{row.domain}</span>
              </Button>
            ) : null}
            {canPin && onPin ? (
              <Button type="button" size="sm" variant="outline" disabled={mutationPending} onClick={() => { void runMutation('pin', onPin) }}>
                Pin{' '}
                <span className="sr-only">{row.domain}</span>
              </Button>
            ) : null}
            {mutationError ? <span role="alert" className="sr-only">{mutationError}</span> : null}
          </div>
        ) : <span className="text-faint">—</span>}
      </td>
    </tr>
  )
}

function GroupHeading({ children }: { children: string }) {
  return (
    <tr className="competitor-landscape-group">
      <th scope="rowgroup" colSpan={6}>{children}</th>
    </tr>
  )
}

function ManageCompetitors({ onAddCompetitor }: { onAddCompetitor: CompetitorMutation }) {
  const inputId = useId()
  const [domain, setDomain] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  async function submit() {
    const next = domain.trim()
    if (!next || isSubmitting) return
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      if (await onAddCompetitor(next) === false) {
        setSubmitError('Could not add competitor. Try again.')
        return
      }
      setDomain('')
    } catch {
      setSubmitError('Could not add competitor. Try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <details className="inline-disclosure competitor-landscape-manage">
      <summary>Manage competitors</summary>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        aria-busy={isSubmitting}
      >
        <label htmlFor={inputId} className="min-w-56 flex-1 text-sm font-medium text-heading">
          Competitor domain
          <input
            id={inputId}
            type="text"
            value={domain}
            onChange={event => setDomain(event.target.value)}
            placeholder="competitor.com"
            className="mt-1 h-10 w-full rounded-md border border-default bg-surface px-3 text-sm text-primary placeholder-mono-600 focus:outline-none focus:ring-2 focus:ring-mono-400"
          />
        </label>
        <Button type="submit" size="sm" className="min-h-10" disabled={isSubmitting || !domain.trim()}>
          {isSubmitting ? 'Adding…' : 'Add competitor'}
        </Button>
        {submitError ? <p role="alert" className="w-full text-sm text-negative">{submitError}</p> : null}
      </form>
    </details>
  )
}

export function CompetitorLandscape({
  window,
  landscape,
  pinnedFallback = [],
  canWrite,
  isEmbed,
  onWindowChange,
  onPin,
  onUnpin,
  onAddCompetitor,
  error,
  onRetry,
  isLoading = false,
  scopeLabel,
}: {
  window: CompetitorLandscapeWindow
  landscape?: CompetitorLandscapeData
  /** Current pins remain visible when the exploratory-history read fails. */
  pinnedFallback?: readonly CompetitorLandscapeRow[]
  canWrite: boolean
  isEmbed: boolean
  onWindowChange: (value: CompetitorLandscapeWindow) => void
  onPin?: CompetitorMutation
  onUnpin?: CompetitorMutation
  onAddCompetitor?: CompetitorMutation
  error?: string
  onRetry?: () => void
  isLoading?: boolean
  /** Names the selected Advanced Measurement market, when this is not project-wide. */
  scopeLabel?: string
}) {
  const canManage = canWrite && !isEmbed
  const pinned = landscape?.pinned ?? pinnedFallback
  const observed = landscape?.observed ?? []
  const otherSources = landscape?.otherSources ?? []
  const evidence = landscape?.evidence
  const pendingDraftCompetitorCount = landscape?.marketState?.draft?.pendingCompetitorDomains.length ?? 0

  return (
    <section aria-labelledby="competitor-landscape-title" aria-busy={isLoading} className="competitor-landscape">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Competitive</p>
          <h2 id="competitor-landscape-title">Competitor landscape</h2>
          {scopeLabel ? <p className="supporting-copy mt-1">{scopeLabel}</p> : null}
        </div>
        <WindowControl value={window} onChange={onWindowChange} />
      </div>

      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-y border-negative-800/40 bg-negative-950/20 py-3 text-sm text-negative">
          <span>{error}</span>
          {onRetry ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry competitor history</Button> : null}
        </div>
      ) : null}

      {isLoading && !landscape && pinned.length === 0 ? (
        <div role="status" aria-live="polite" className="h-48 animate-pulse rounded-md bg-surface-subtle">
          <span className="sr-only">Loading competitor history</span>
        </div>
      ) : (
        <>
          <div className="competitor-table-wrap">
            <table className="competitor-table" aria-label="Competitor landscape">
              <caption className="sr-only">Pinned competitors followed by competitors observed in the selected history window.</caption>
              <thead>
                <tr>
                  <th scope="col">Competitor</th>
                  <th scope="col">Type</th>
                  <th scope="col">Mention SOV</th>
                  <th scope="col">Mentions</th>
                  <th scope="col">Citations</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {landscape ? (
                  <>
                    <GroupHeading>You</GroupHeading>
                    <LandscapeRow row={landscape.project} isProject canManage={false} />
                  </>
                ) : null}
                <GroupHeading>Pinned</GroupHeading>
                {pinned.length > 0 ? pinned.map(row => (
                  <LandscapeRow key={row.domain} row={{ ...row, pinned: true }} canManage={canManage} onUnpin={onUnpin} />
                )) : (
                  <tr><td colSpan={6} className="text-secondary">No pinned competitors.</td></tr>
                )}
                {landscape ? (
                  <>
                    <GroupHeading>Observed in this window</GroupHeading>
                    {observed.length > 0 ? observed.map(row => (
                      <LandscapeRow key={row.domain} row={{ ...row, pinned: false }} canManage={canManage} onPin={onPin} />
                    )) : (
                      <tr><td colSpan={6} className="text-secondary">No direct competitors were observed in this window.</td></tr>
                    )}
                  </>
                ) : null}
              </tbody>
            </table>
          </div>

          {evidence ? (
            <p className="text-sm text-secondary">
              {evidence.answeredResults} answer results and {evidence.sourceResults} source results in this window.
              {evidence.missingAnswerTextResults > 0 ? ` ${evidence.missingAnswerTextResults} result${evidence.missingAnswerTextResults === 1 ? '' : 's'} without answer text excluded from mention share.` : ''}
              {evidence.incompleteSourceResults > 0 ? ` ${evidence.incompleteSourceResults} incomplete source result${evidence.incompleteSourceResults === 1 ? '' : 's'} excluded from negative citation evidence.` : ''}
              {evidence.excludedProbeResults > 0 || evidence.excludedNonCompletedResults > 0
                ? ` ${evidence.excludedProbeResults + evidence.excludedNonCompletedResults} probe or incomplete run${evidence.excludedProbeResults + evidence.excludedNonCompletedResults === 1 ? '' : 's'} excluded.`
                : ''}
            </p>
          ) : null}

          {landscape?.truncated ? (
            <p className="text-sm text-secondary">
              Showing the top 100 observed competitors and other sources. Pinned competitors are complete.
            </p>
          ) : null}

          {pendingDraftCompetitorCount > 0 ? (
            <p className="text-sm text-secondary">
              {landscape?.scope.kind === 'all-markets'
                ? `${pendingDraftCompetitorCount} competitor${pendingDraftCompetitorCount === 1 ? ' is' : 's are'} pending publication across markets.`
                : `${pendingDraftCompetitorCount} competitor${pendingDraftCompetitorCount === 1 ? ' is' : 's are'} pending publication for this market.`}
            </p>
          ) : null}

          {otherSources.length > 0 ? (
            <details className="inline-disclosure">
              <summary>Other observed sources ({otherSources.length})</summary>
              <ul className="mt-3 space-y-2 text-sm text-secondary">
                {otherSources.map(source => (
                  <li key={source.domain}>
                    <span>{source.label} · {sourceClassLabel(source.surfaceClass)} · {source.citationCount} citations</span>
                    {source.sampleUrls.length > 0 ? (
                      <ul className="mt-1 space-y-1 font-mono text-[11px] text-muted">
                        {source.sampleUrls.map(url => <li key={url} className="break-all">{url}</li>)}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}

      {canManage && onAddCompetitor ? <ManageCompetitors onAddCompetitor={onAddCompetitor} /> : null}
    </section>
  )
}

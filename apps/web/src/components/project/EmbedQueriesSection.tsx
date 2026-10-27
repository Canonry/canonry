import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import type {
  QueryTrackingMutation,
  QueryTrackingPreviewResponse,
  QueryTrackingTrackedRow,
} from '@canonry/canonry-contracts'
import {
  postApiV1ProjectsByNameQueryTrackingCommit,
  postApiV1ProjectsByNameQueryTrackingPreview,
} from '@canonry/canonry-api-client'
import { getApiV1ProjectsByNameQueryTrackingOptions } from '@canonry/canonry-api-client/react-query'
import { ApiError, heyClient, invokeWeb } from '../../api.js'
import { invalidateQueryTrackingPublication } from '../../queries/query-invalidation.js'
import { Button } from '../ui/button.js'

/** The longest query the engine accepts. */
const QUERY_MAX = 4_000

export const EMBED_QUERIES_COPY = {
  heading: 'Queries',
  count: (count: number, limit: number) => `${count} of ${limit} ${count === 1 ? 'query' : 'queries'}`,
  nextCheck: 'New queries show results after the next check',
  inputLabel: 'Add a query',
  placeholder: 'Add a query customers would ask',
  add: 'Add',
  adding: 'Adding…',
  remove: 'Remove',
  removing: 'Removing…',
  added: (query: string) => `Added “${query}”.`,
  removed: (query: string) => `Removed “${query}”.`,
  undo: 'Undo',
  duplicate: 'You already track this query.',
  limit: (limit: number) => `Your plan tracks up to ${limit} queries. Remove one to add another.`,
  failed: 'Couldn’t save. Try again.',
  loading: 'Loading your queries…',
  loadFailed: 'Couldn’t load your queries.',
  retry: 'Try again',
  empty: 'No queries yet.',
  agencyManaged: 'Your agency manages these queries.',
} as const

type SaveOutcome = 'saved' | 'unchanged' | 'limit'

type Message =
  | { kind: 'error'; text: string }
  | { kind: 'removed'; query: string }
  | { kind: 'added'; query: string }

function draftKey(projectName: string): string {
  return `canonry:embed-query-draft:${projectName}`
}

/** The host page re-loads the dashboard every few minutes, so an unsent query is kept for the tab session. */
function readDraft(projectName: string): string {
  try {
    return window.sessionStorage.getItem(draftKey(projectName)) ?? ''
  } catch {
    return ''
  }
}

function writeDraft(projectName: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(draftKey(projectName), value)
    else window.sessionStorage.removeItem(draftKey(projectName))
  } catch {
    // Storage is unavailable: the draft just does not survive a reload.
  }
}

function sameQuery(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === b.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

/**
 * The client view of a project's tracked queries inside an embedded dashboard.
 * Shown only when the agency lets clients manage their own queries; `limit` is
 * the plan's query limit from the embed config.
 *
 * Each add or remove runs the same review-and-save API as the operator Queries
 * tab, back to back, so the engine still checks the change, the limit, and
 * concurrent edits. A list that changed underneath is reviewed once more against
 * the fresh list before giving up.
 */
export function EmbedQueriesSection({ projectName, limit }: { projectName: string; limit: number }) {
  const queryClient = useQueryClient()
  const workspaceOptions = getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name: projectName } })
  const workspaceQuery = useQuery(workspaceOptions)
  const [draft, setDraft] = useState(() => readDraft(projectName))
  const [busy, setBusy] = useState<'add' | 'undo' | { removing: string } | null>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const removeButtons = useRef(new Map<string, HTMLButtonElement>())
  // After a removal its button is gone; focus moves to the row that took its place.
  const focusAfterRemoval = useRef<number | null>(null)

  const tracked: readonly QueryTrackingTrackedRow[] = workspaceQuery.data?.tracked ?? []
  // Embedded editing covers simple projects; the engine refuses it for an advanced portfolio.
  const editable = workspaceQuery.data?.mode === 'simple'
  const atLimit = tracked.length >= limit

  useEffect(() => {
    const index = focusAfterRemoval.current
    if (index === null || busy !== null) return
    focusAfterRemoval.current = null
    const next = tracked[Math.min(index, tracked.length - 1)]
    const target = next ? removeButtons.current.get(next.queryId) : undefined
    if (target) target.focus()
    else inputRef.current?.focus()
  }, [busy, tracked])

  async function saveChange(mutation: QueryTrackingMutation): Promise<SaveOutcome> {
    let version = workspaceQuery.data?.workspaceVersion
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!version || attempt > 0) version = (await queryClient.fetchQuery({ ...workspaceOptions, staleTime: 0 })).workspaceVersion
      try {
        const preview = await invokeWeb<QueryTrackingPreviewResponse>(() => postApiV1ProjectsByNameQueryTrackingPreview({
          client: heyClient,
          path: { name: projectName },
          body: { ...mutation, expectedWorkspaceVersion: version! },
        }))
        if (preview.diff.noOp) return 'unchanged'
        await invokeWeb(() => postApiV1ProjectsByNameQueryTrackingCommit({
          client: heyClient,
          path: { name: projectName },
          body: {
            ...mutation,
            expectedWorkspaceVersion: preview.workspaceVersion,
            previewToken: preview.previewToken,
            reviewedAt: preview.reviewedAt,
          },
        }))
        return 'saved'
      } catch (error) {
        if (error instanceof ApiError && error.code === 'EMBED_QUERY_LIMIT') return 'limit'
        if (attempt === 0 && error instanceof ApiError && error.code === 'QUERY_TRACKING_PREVIEW_STALE') continue
        throw error
      }
    }
    throw new Error('The query list kept changing.')
  }

  async function addQuery(query: string, mode: 'add' | 'undo'): Promise<boolean> {
    if (tracked.some(row => sameQuery(row.queryText, query))) {
      setMessage({ kind: 'error', text: EMBED_QUERIES_COPY.duplicate })
      return false
    }
    setBusy(mode)
    setMessage(null)
    try {
      const outcome = await saveChange({ additions: [{ input: { source: 'manual', text: query } }], removals: [] })
      if (outcome === 'unchanged') {
        setMessage({ kind: 'error', text: EMBED_QUERIES_COPY.duplicate })
        return false
      }
      if (outcome === 'limit') {
        setMessage({ kind: 'error', text: EMBED_QUERIES_COPY.limit(limit) })
        return false
      }
      await invalidateQueryTrackingPublication(queryClient, projectName)
      setMessage({ kind: 'added', query })
      return true
    } catch {
      setMessage({ kind: 'error', text: EMBED_QUERIES_COPY.failed })
      return false
    } finally {
      setBusy(null)
    }
  }

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = draft.trim()
    if (!query || busy !== null || atLimit) return
    if (await addQuery(query, 'add')) {
      setDraft('')
      writeDraft(projectName, '')
      inputRef.current?.focus()
    }
  }

  async function onRemove(row: QueryTrackingTrackedRow, index: number) {
    if (busy !== null) return
    setBusy({ removing: row.queryId })
    setMessage(null)
    try {
      await saveChange({ additions: [], removals: [{ queryId: row.queryId }] })
      await invalidateQueryTrackingPublication(queryClient, projectName)
      focusAfterRemoval.current = index
      setMessage({ kind: 'removed', query: row.queryText })
    } catch {
      setMessage({ kind: 'error', text: EMBED_QUERIES_COPY.failed })
    } finally {
      setBusy(null)
    }
  }

  async function onUndo(query: string) {
    if (busy !== null) return
    if (await addQuery(query, 'undo')) inputRef.current?.focus()
  }

  if (workspaceQuery.isLoading) {
    return <p className="text-sm text-secondary" role="status">{EMBED_QUERIES_COPY.loading}</p>
  }
  if (workspaceQuery.isError || !workspaceQuery.data) {
    return (
      <div role="alert">
        <p className="text-sm text-negative">{EMBED_QUERIES_COPY.loadFailed}</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void workspaceQuery.refetch()}>
          {EMBED_QUERIES_COPY.retry}
        </Button>
      </div>
    )
  }

  const error = message?.kind === 'error' ? message.text : null
  const lineId = 'embed-query-line'

  // Same page header as the other embed tabs (Site Health): the title sits right under the tab bar.
  return (
    <section aria-labelledby="embed-queries-heading">
      <header>
        <div>
          <h2 id="embed-queries-heading" className="text-xl font-semibold tracking-tight text-heading">{EMBED_QUERIES_COPY.heading}</h2>
          <p className="mt-1 text-sm text-secondary">
            <span className="font-medium text-strong">{EMBED_QUERIES_COPY.count(tracked.length, limit)}</span>
            {' · '}
            {editable ? EMBED_QUERIES_COPY.nextCheck : EMBED_QUERIES_COPY.agencyManaged}
          </p>
        </div>
      </header>

      {editable ? (
        <form className="mt-4 flex max-w-2xl gap-2" onSubmit={event => void onAdd(event)} aria-busy={busy === 'add'}>
          <label htmlFor="embed-query-input" className="sr-only">{EMBED_QUERIES_COPY.inputLabel}</label>
          <input
            ref={inputRef}
            id="embed-query-input"
            type="text"
            className="h-9 min-w-0 flex-1 rounded-md pointer-coarse:h-11 border border-default bg-surface px-3 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500 aria-disabled:opacity-50 aria-[invalid=true]:border-negative-500"
            placeholder={EMBED_QUERIES_COPY.placeholder}
            maxLength={QUERY_MAX}
            value={draft}
            // Read-only rather than disabled, so focus stays put while saving or at the limit.
            readOnly={atLimit || busy !== null}
            aria-disabled={atLimit || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={lineId}
            onChange={event => {
              setDraft(event.target.value)
              writeDraft(projectName, event.target.value)
              if (message?.kind === 'error') setMessage(null)
            }}
          />
          <Button type="submit" className="pointer-coarse:min-h-11" disabled={atLimit || busy !== null || !draft.trim()}>
            {busy === 'add' ? EMBED_QUERIES_COPY.adding : EMBED_QUERIES_COPY.add}
          </Button>
        </form>
      ) : null}

      <div id={lineId} className="mt-2 min-h-5 text-sm">
        {error ? <p className="text-negative" role="alert">{error}</p> : null}
        <p className="text-secondary" role="status">
          {message?.kind === 'removed' ? (
            <>
              {EMBED_QUERIES_COPY.removed(message.query)}{' '}
              <button
                type="button"
                className="inline-flex items-center text-link hover:underline pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500 disabled:opacity-50"
                disabled={busy !== null || atLimit}
                onClick={() => void onUndo(message.query)}
              >
                {busy === 'undo' ? EMBED_QUERIES_COPY.adding : EMBED_QUERIES_COPY.undo}
              </button>
            </>
          ) : message?.kind === 'added' ? (
            <span className="sr-only">{EMBED_QUERIES_COPY.added(message.query)}</span>
          ) : null}
          {/* Shown whenever the list is full, including right after the add that filled it. */}
          {editable && atLimit && !error ? (
            <span className="block">{EMBED_QUERIES_COPY.limit(limit)}</span>
          ) : null}
        </p>
      </div>

      {tracked.length === 0 ? (
        <p className="mt-4 text-sm text-secondary">{EMBED_QUERIES_COPY.empty}</p>
      ) : (
        <ul className="mt-4 divide-y divide-default border-y border-default" aria-label="Tracked queries">
          {tracked.map((row, index) => {
            const removing = typeof busy === 'object' && busy?.removing === row.queryId
            return (
              <li key={row.queryId} className="flex items-center justify-between gap-4 py-2">
                <span className="min-w-0 break-words text-sm font-medium text-heading">{row.queryText}</span>
                {editable ? (
                  <Button
                    ref={(node: HTMLButtonElement | null) => {
                      if (node) removeButtons.current.set(row.queryId, node)
                      else removeButtons.current.delete(row.queryId)
                    }}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="pointer-coarse:min-h-11"
                    aria-label={`${EMBED_QUERIES_COPY.remove} ${row.queryText}`}
                    disabled={busy !== null}
                    onClick={() => void onRemove(row, index)}
                  >
                    <Trash2 aria-hidden="true" size={13} />
                    {removing ? EMBED_QUERIES_COPY.removing : EMBED_QUERIES_COPY.remove}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

import type { ReactNode } from 'react'
import { isOpenRouterRoute } from '@canonry/canonry-contracts'

import { asyncHandler } from '../../lib/async-handler.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'
import { SETUP_TOUCH_TARGET } from './AiEnginesSection.js'
import type { SetupQueries } from './use-setup-queries.js'

/**
 * The "Add queries" step: the saved list, or the form that edits it, with
 * engine suggestions and agent research behind disclosures. The caller puts
 * it on its own surface.
 */
export function SetupQueriesForm({
  queries,
  headingLevel,
  loading,
  loadFailed,
  onRetryLoad,
  onBack,
  note,
  skipAction,
  saveVariant,
}: {
  queries: SetupQueries
  /** h2 on a setup page; h3 inside the tracker's row, whose title is the h2. */
  headingLevel: 'h2' | 'h3'
  /** The saved queries are still loading. */
  loading: boolean
  /** The saved queries could not be read. */
  loadFailed: boolean
  onRetryLoad: () => void
  onBack: () => void
  /** A line under the list, such as which queries count as branded. */
  note?: ReactNode
  /** Leaves setup without saving queries. */
  skipAction?: ReactNode
  /** Secondary while another form on the same surface carries the primary action. */
  saveVariant: 'default' | 'secondary'
}) {
  const Heading = headingLevel
  const count = queries.parsed.length
  return (
    <>
      <div className="section-head">
        <div>
          <div className="flex items-center gap-2"><Heading id="setup-queries-heading" className={headingLevel === 'h3' ? 'text-heading-16 text-heading' : undefined}>Add queries</Heading><InfoTooltip text="Queries your customers ask AI assistants, one per line. You can refine the list later." /></div>
        </div>
        {loading ? (
          <ToneBadge tone="neutral">Loading</ToneBadge>
        ) : loadFailed ? (
          <ToneBadge tone="negative">Load failed</ToneBadge>
        ) : queries.saved ? (
          <ToneBadge tone="positive">{count} saved</ToneBadge>
        ) : (
          <ToneBadge tone="neutral">{count} quer{count !== 1 ? 'ies' : 'y'}</ToneBadge>
        )}
      </div>
      {loading ? (
        <div className="material-base p-4 text-label-14 text-secondary" role="status">
          Loading saved queries…
        </div>
      ) : loadFailed ? (
        <div className="compact-stack">
          <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-label-14 text-negative">
            Saved queries could not be loaded. Retry before changing the query basket.
          </div>
          <div className="setup-nav">
            <Button type="button" variant="outline" onClick={onBack}>Back</Button>
            <Button type="button" onClick={onRetryLoad}>
              Retry loading queries
            </Button>
          </div>
        </div>
      ) : queries.saved ? (
        <div className="compact-stack">
          <ul className="detail-list">
            {queries.parsed.map((query) => <li key={query}>{query}</li>)}
          </ul>
          <div className="setup-nav">
            <Button type="button" variant="outline" onClick={onBack}>Back</Button>
            <Button type="button" variant="outline" onClick={() => queries.setSaved(false)}>Edit queries</Button>
            <Button type="button" onClick={queries.continueWithSaved}>Continue</Button>
          </div>
        </div>
      ) : (
        <div className="compact-stack">
          <div className="setup-field">
            <label className="setup-label" htmlFor="queries">Queries (one per line)</label>
            <textarea
              id="queries"
              className="setup-textarea text-copy-14"
              rows={6}
              placeholder="One query per line"
              value={queries.text}
              onChange={(e) => queries.setText(e.target.value)}
            />
          </div>
          {note}
          {queries.generateProviders.length > 0 ? (
            <details className="compact-stack"><summary className="cursor-pointer py-2 text-label-14 text-link">Generate query suggestions</summary>
              <div className="flex items-end gap-2">
                <div className="setup-field flex-1">
                  <label className="setup-label" htmlFor="gen-provider">Provider</label>
                  <select
                    id="gen-provider"
                    className="setup-input"
                    value={queries.selectedProvider}
                    onChange={(e) => queries.setSelectedProvider(e.target.value)}
                  >
                    {queries.generateProviders.map((p) => (
                      <option key={p.name} value={p.name}>{p.displayName ?? p.name}{p.model && !isOpenRouterRoute(p.name) ? ` (${p.model})` : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="setup-field">
                  <label className="setup-label" htmlFor="gen-count">Count</label>
                  <select
                    id="gen-count"
                    className="setup-input"
                    value={queries.generateCount}
                    onChange={(e) => queries.setGenerateCount(Number(e.target.value))}
                  >
                    {[3, 5, 10, 15, 20].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={queries.generating || !queries.selectedProvider}
                  onClick={asyncHandler(queries.generate)}
                >
                  {queries.generating ? 'Analyzing site…' : 'Generate'}
                </Button>
              </div>
              {queries.generateError ? <p role="alert" className="text-negative-400 text-copy-14">{queries.generateError}</p> : null}
              {/* Always mounted, so the count is announced when it appears. */}
              <p role="status" className={queries.generatedDuplicates > 0 ? 'pt-2 text-copy-13 text-secondary' : undefined}>
                {queries.generatedDuplicates > 0 ? `${queries.generatedDuplicates} ${queries.generatedDuplicates === 1 ? 'duplicate' : 'duplicates'} skipped` : ''}
              </p>
            </details>
          ) : null}
          <details open={queries.researchCopyError || undefined} className="space-y-2">
            <summary className="cursor-pointer py-2 text-label-14 text-link">Research queries with your agent</summary>
            <textarea aria-label="Agent query research prompt" readOnly className="setup-textarea w-full text-copy-14" rows={8} value={queries.researchPrompt} />
            <Button type="button" variant="outline" size="sm" className={`shrink-0 self-start ${SETUP_TOUCH_TARGET}`} onClick={asyncHandler(queries.copyResearchPrompt)}>
              {queries.researchPromptCopied ? 'Research prompt copied' : 'Copy research prompt'}
            </Button>
            {queries.researchCopyError ? <p role="alert" className="text-copy-14 text-negative">Could not copy. Select and copy the prompt above.</p> : null}
          </details>
          {queries.error ? <p role="alert" className="text-negative-400 text-copy-14">{queries.error}</p> : null}
          <div className="setup-nav">
            <Button type="button" variant="outline" onClick={onBack}>Back</Button>
            {skipAction}
            <Button type="button" variant={saveVariant} disabled={count === 0 || queries.saving} onClick={asyncHandler(queries.save)}>
              {queries.saving ? 'Saving…' : `Save ${count} quer${count !== 1 ? 'ies' : 'y'}`}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

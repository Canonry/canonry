import { useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { AlertTriangle, History, Info } from 'lucide-react'
import type { MeasurementQueryTemplate, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { useAccount } from '../../../contexts/account-context.js'
import { WriteButton } from '../../shared/AccessControls.js'
import { DataTableSearch } from '../../shared/DataTableControls.js'
import { InfoTooltip } from '../../shared/InfoTooltip.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { Button } from '../../ui/button.js'
import { Card } from '../../ui/card.js'
import { contextInput, contextKey, contextLabel, uniqueContextInputs } from './tracking-contexts.js'
import { hasMarketOnlyAudience, needsTemplateMarket, type TrackingAction, type TrackingDraft } from './tracking-draft.js'

export function TrackingComposer({
  workspace,
  templates,
  action,
  draft,
  onDraftChange,
  onClose,
  canReview,
  isPreviewing,
  editorHeadingRef,
  onReview,
}: {
  workspace: QueryTrackingWorkspaceResponse
  templates: readonly MeasurementQueryTemplate[]
  action: TrackingAction
  draft: TrackingDraft
  onDraftChange: (draft: TrackingDraft) => void
  onClose: () => void
  canReview: boolean
  isPreviewing: boolean
  editorHeadingRef: RefObject<HTMLHeadingElement | null>
  onReview: () => void
}) {
  const hasSavedTemplates = templates.length > 0
  if (action.kind === 'remove') {
    return (
      <Card className="surface-card">
        <div className="section-head">
          <div>
            <h3>Remove query</h3>
            <p className="mt-1 break-words text-sm font-medium leading-6 text-strong">{action.row.queryText}</p>
            <ChangeFacts action={action} advanced={workspace.mode === 'advanced'} detail="Removal applies to future sweeps. Earlier results stay unchanged." />
          </div>
        </div>
        <ComposerActions canReview={canReview} isPreviewing={isPreviewing} onCancel={onClose} onReview={onReview} />
      </Card>
    )
  }

  if (action.kind === 'edit') {
    return (
      <Card className="surface-card">
        <div className="section-head section-head-inline gap-4">
          <h3 ref={editorHeadingRef} tabIndex={-1}>Edit query</h3>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        </div>
        <ChangeFacts action={action} advanced={workspace.mode === 'advanced'} detail="Changes apply to future sweeps. Earlier results stay unchanged." />
        <div className="mt-4 max-w-2xl space-y-4">
          <label className="block" htmlFor="tracking-query-text">
            <span className="text-xs font-medium text-secondary">Query text</span>
            <textarea
              id="tracking-query-text"
              className="mt-1 min-h-28 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
              value={draft.text}
              onChange={event => onDraftChange({ ...draft, text: event.target.value })}
            />
          </label>
          {workspace.mode === 'advanced' && (
            <label className="block" htmlFor="tracking-query-class">
              <span className="text-xs font-medium text-secondary">Type</span>
              <select
                id="tracking-query-class"
                className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
                value={draft.queryClass}
                onChange={event => onDraftChange({ ...draft, queryClass: event.target.value as TrackingDraft['queryClass'] })}
              >
                <option value="keep">Keep type</option>
                <option value="auto">Automatic</option>
                <option value="branded">Branded</option>
                <option value="non-brand">Non-brand</option>
              </select>
            </label>
          )}
          <div><StatusNote icon={Info} label="Locations and engines kept" detail={`An edit keeps the query's locations and engines. Use ${workspace.mode === 'advanced' ? 'Add queries' : 'Add query'} to track it somewhere else.`} /></div>
        </div>
        <ComposerActions canReview={canReview} isPreviewing={isPreviewing} onCancel={onClose} onReview={onReview} />
      </Card>
    )
  }

  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline gap-4">
        <h3 ref={editorHeadingRef} tabIndex={-1}>Add query</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
      </div>

      <div className={`mt-4 grid gap-4 ${workspace.mode === 'advanced' ? 'lg:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.2fr)]' : 'max-w-2xl'}`}>
        {/* Both columns may shrink to a phone's width: a long option or location name is cut, never wider than the card. */}
        <div className="min-w-0 space-y-4">
          {draft.source === 'manual' ? (
            <label className="block" htmlFor="tracking-query-text">
              <span className="text-sm font-medium text-secondary">Query</span>
              <textarea
                id="tracking-query-text"
                className="mt-1 min-h-28 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
                placeholder="e.g. How do teams compare AEO platforms?"
                value={draft.text}
                onChange={(event) => onDraftChange({ ...draft, text: event.target.value })}
              />
            </label>
          ) : null}

          {draft.source === 'template' ? (
            <TemplateSourceField templates={templates} advanced={workspace.mode === 'advanced'} draft={draft} onDraftChange={onDraftChange} />
          ) : null}

          {draft.source === 'research' ? (
            <SavedSourceField
              id="tracking-research-source"
              label="Saved research query"
              value={draft.researchRunQueryId}
              options={workspace.savedSources.research.map(candidate => ({ id: candidate.researchRunQueryId, label: candidate.queryText, detail: candidate.researchRunId }))}
              onChange={(researchRunQueryId) => onDraftChange({ ...draft, researchRunQueryId })}
            />
          ) : null}

          {draft.source === 'discovery' ? (
            <SavedSourceField
              id="tracking-discovery-source"
              label="Discovery query"
              value={draft.discoveryProbeId}
              options={workspace.savedSources.discovery.map(candidate => ({ id: candidate.discoveryProbeId, label: candidate.queryText, detail: candidate.discoverySessionId }))}
              onChange={(discoveryProbeId) => onDraftChange({ ...draft, discoveryProbeId })}
            />
          ) : null}

          <label className="block" htmlFor="tracking-query-source">
            <span className="text-sm font-medium text-secondary">Query source</span>
            <select
              id="tracking-query-source"
              aria-describedby={hasSavedTemplates ? undefined : 'tracking-query-source-no-templates'}
              className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
              value={draft.source}
              onChange={(event) => onDraftChange({ ...draft, source: event.target.value as TrackingDraft['source'] })}
            >
              <option value="manual">Write a query</option>
              {hasSavedTemplates ? <option value="template">Saved pattern</option> : null}
              <option value="research" disabled={workspace.savedSources.research.length === 0}>Saved research{workspace.savedSources.research.length === 0 ? ' (none available)' : ''}</option>
              <option value="discovery" disabled={workspace.savedSources.discovery.length === 0}>Discovery result{workspace.savedSources.discovery.length === 0 ? ' (none available)' : ''}</option>
            </select>
          </label>
          {!hasSavedTemplates ? <div id="tracking-query-source-no-templates"><StatusNote icon={Info} label="No saved patterns" detail="No saved patterns are set up for this project. Write a query, or use saved research or a discovery result." /></div> : null}
        </div>

        {workspace.mode === 'advanced' ? <AssignmentSelector workspace={workspace} draft={draft} onDraftChange={onDraftChange} /> : null}
      </div>

      {workspace.mode === 'advanced' && !hasMarketOnlyAudience(draft) ? (
        <div className="mt-4">
          <TrackingContextSelector workspace={workspace} draft={draft} onDraftChange={onDraftChange} />
        </div>
      ) : null}
      <details className="mt-4 border-t border-default text-sm text-secondary">
        <summary className="min-h-11 cursor-pointer py-3">Measurement options</summary>
        <div className="grid gap-4 pb-3 sm:grid-cols-2">
          {workspace.mode === 'advanced' ? (
            <div className="block">
              <label className="text-xs font-medium text-secondary" htmlFor="tracking-query-class">Type</label>
              <select
                id="tracking-query-class"
                className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
                value={draft.queryClass}
                onChange={(event) => onDraftChange({ ...draft, queryClass: event.target.value as TrackingDraft['queryClass'] })}
              >
                <option value="auto">Automatic</option>
                <option value="branded">Branded</option>
                <option value="non-brand">Non-brand</option>
              </select>
            </div>
          ) : (
            <div className="rounded-md border border-default bg-surface-subtle px-3 py-2">
              <p className="text-xs font-medium text-secondary">Type</p>
              <p className="mt-1 text-sm text-strong">Automatic</p>
            </div>
          )}
        </div>
      </details>

      {draft.source === 'research' && (
        <div className="mt-4"><StatusNote icon={Info} label="Saved query only" detail="Only the saved query is added, not its saved answer." /></div>
      )}
      <ComposerActions canReview={canReview} isPreviewing={isPreviewing} onCancel={onClose} onReview={onReview} />
    </Card>
  )
}

function TemplateSourceField({
  templates,
  advanced,
  draft,
  onDraftChange,
}: {
  templates: readonly MeasurementQueryTemplate[]
  advanced: boolean
  draft: TrackingDraft
  onDraftChange: (draft: TrackingDraft) => void
}) {
  return (
    <div>
      <label className="block" htmlFor="tracking-template-source">
        <span className="text-xs font-medium text-secondary">Saved pattern</span>
        <select
          id="tracking-template-source"
          aria-describedby={needsTemplateMarket(draft) ? 'tracking-template-market-required' : undefined}
          className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
          value={draft.templateId}
          onChange={(event) => {
            const template = templates.find(candidate => candidate.id === event.target.value)
            onDraftChange({
              ...draft,
              templateId: template?.id ?? '',
              templateVersion: template?.updatedAt ?? '',
              template: template?.pattern ?? '',
            })
          }}
        >
          <option value="">Choose a pattern</option>
          {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
        {draft.template ? <span className="mt-1 block text-xs leading-5 text-muted">{draft.template}</span> : null}
      </label>
      {needsTemplateMarket(draft) ? (
        <div id="tracking-template-market-required" role="status" className="mt-2">
          <StatusNote
            icon={AlertTriangle}
            tone="caution"
            label="Needs a market"
            detail={advanced
              ? 'This pattern needs a market. Choose one under Apply to. A location alone does not select a market.'
              : 'This pattern needs a market, and this project has no markets. Write a query instead.'}
          />
        </div>
      ) : null}
    </div>
  )
}

function SavedSourceField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: readonly { id: string; label: string; detail: string }[]
  onChange: (value: string) => void
}) {
  return (
    <label className="block" htmlFor={id}>
      <span className="text-xs font-medium text-secondary">{label}</span>
      <select
        id={id}
        className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a saved query</option>
        {options.map(option => <option key={option.id} value={option.id}>{option.label} · {option.detail}</option>)}
      </select>
    </label>
  )
}

function TrackingContextSelector({
  workspace,
  draft,
  onDraftChange,
}: {
  workspace: QueryTrackingWorkspaceResponse
  draft: TrackingDraft
  onDraftChange: (draft: TrackingDraft) => void
}) {
  const options = useMemo(
    () => uniqueContextInputs([...workspace.defaultContexts.map(contextInput), ...draft.contexts]),
    [draft.contexts, workspace.defaultContexts],
  )
  const selected = draft.contexts.length === 1 ? contextKey(draft.contexts[0]!) : draft.contexts.length > 1 ? '__existing__' : ''

  return (
    <div>
      {/* The help is a sibling of the label, so its text stays out of the field's name. */}
      <div className="flex items-center">
        <label className="text-xs font-medium text-secondary" htmlFor="tracking-query-context">Search location and engines</label>
        <InfoTooltip text="Where this query is asked, and on which engines." />
      </div>
      <select
        id="tracking-query-context"
        aria-label="Search location and engines"
        className="mt-1 h-9 w-full rounded-md border border-default bg-surface px-3 text-sm text-strong focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500"
        value={selected}
        onChange={event => {
          const selectedContext = options.find(context => contextKey(context) === event.target.value)
          const next = event.target.value === '__existing__'
            ? draft.contexts
            : selectedContext ? [selectedContext] : []
          onDraftChange({ ...draft, contexts: next })
        }}
      >
        <option value="">Choose a search location and engines</option>
        {draft.contexts.length > 1 ? <option value="__existing__">Keep {draft.contexts.length} current combinations</option> : null}
        {options.map(context => <option key={contextKey(context)} value={contextKey(context)}>{contextLabel(context)}</option>)}
      </select>
      {options.length === 0 ? <div className="mt-1"><StatusNote icon={AlertTriangle} tone="caution" label="No search location" detail="No search location and engines are set up for this project." /></div> : null}
    </div>
  )
}

function AssignmentSelector({
  workspace,
  draft,
  onDraftChange,
}: {
  workspace: QueryTrackingWorkspaceResponse
  draft: TrackingDraft
  onDraftChange: (draft: TrackingDraft) => void
}) {
  const { canWrite } = useAccount()
  const [filter, setFilter] = useState('')
  const [changingDestination, setChangingDestination] = useState(() => draft.wholeSite || draft.targetKeys.length !== 1 || draft.groupKeys.length > 0 || draft.marketKeys.length > 0)
  const options = useMemo(() => [
    ...workspace.targets.map(target => ({ kind: 'target' as const, key: target.stableKey, label: target.label, detail: 'Location' })),
    ...workspace.groups.map(group => ({ kind: 'group' as const, key: group.stableKey, label: group.label, detail: 'Group' })),
    ...workspace.markets.map(market => ({ kind: 'market' as const, key: market.stableKey, label: market.label, detail: 'Market' })),
  ], [workspace.groups, workspace.markets, workspace.targets])
  const normalizedFilter = filter.trim().toLocaleLowerCase()
  const visible = normalizedFilter ? options.filter(option => `${option.label} ${option.detail}`.toLocaleLowerCase().includes(normalizedFilter)) : options
  const hasAudience = draft.targetKeys.length + draft.groupKeys.length + draft.marketKeys.length > 0

  function toggle(kind: 'target' | 'group' | 'market', key: string, checked: boolean) {
    const field = kind === 'target' ? 'targetKeys' : kind === 'group' ? 'groupKeys' : 'marketKeys'
    const values = draft[field]
    onDraftChange({ ...draft, wholeSite: false, [field]: checked ? [...values, key] : values.filter(value => value !== key) })
  }

  function isChecked(kind: 'target' | 'group' | 'market', key: string): boolean {
    return (kind === 'target' ? draft.targetKeys : kind === 'group' ? draft.groupKeys : draft.marketKeys).includes(key)
  }

  if (!changingDestination) {
    const target = workspace.targets.find(candidate => candidate.stableKey === draft.targetKeys[0])
    return (
      <fieldset className="min-w-0 self-start rounded-md border border-default bg-surface-subtle p-3">
        <legend className="px-1 text-xs font-medium text-secondary">Apply to</legend>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-strong">Location: {target?.label ?? draft.targetKeys[0]}</p>
          <Button type="button" variant="ghost" size="sm" aria-label="Change tracking destination" onClick={() => setChangingDestination(true)}>Change</Button>
        </div>
      </fieldset>
    )
  }

  return (
    <fieldset className="min-w-0 rounded-md border border-default bg-surface-subtle p-3">
      <legend className="px-1 text-xs font-medium text-secondary">Apply to</legend>
      {canWrite ? (
        <label className="flex min-h-9 items-center gap-2 rounded px-1 text-sm text-strong">
          <input
            type="checkbox"
            checked={draft.wholeSite}
            onChange={(event) => {
              onDraftChange({ ...draft, wholeSite: event.target.checked, targetKeys: [], groupKeys: [], marketKeys: [] })
            }}
          />
          Every location ({workspace.targets.length})
        </label>
      ) : null}
      {!draft.wholeSite && !hasAudience ? <div role="status" className="mt-2 px-1"><StatusNote icon={AlertTriangle} tone="caution" label="Choose a place" detail="Choose at least one location, group, or market." /></div> : null}
      {/* What a group and a market are is the help beside the search, outside the legend, so it stays out of the group's name. */}
      <div className="mt-3 flex items-center">
        <DataTableSearch value={filter} onChange={setFilter} label="Filter places" placeholder="Search locations, groups, markets" className="min-w-0 flex-1" />
        <InfoTooltip text="A group is a set of locations. A market asks its queries with its own search location and engines." />
      </div>
      <div className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
        {visible.length === 0 ? <p className="px-1 py-2 text-sm text-muted">No matches</p> : visible.map(option => (
          <label key={`${option.kind}:${option.key}`} className="flex min-h-9 items-center gap-2 rounded px-1 py-1 text-sm text-strong hover:bg-surface-hover">
            <input
              type="checkbox"
              aria-label={`${option.label}, ${option.detail}`}
              checked={isChecked(option.kind, option.key)}
              onChange={(event) => toggle(option.kind, option.key, event.target.checked)}
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span className="text-xs text-muted">{option.detail}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function ComposerActions({
  canReview,
  isPreviewing,
  onCancel,
  onReview,
}: {
  canReview: boolean
  isPreviewing: boolean
  onCancel: () => void
  onReview: () => void
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-default pt-4">
      <WriteButton type="button" size="sm" disabled={!canReview} onClick={onReview}>
        {isPreviewing ? 'Reviewing…' : 'Review changes'}
      </WriteButton>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      <StatusNote icon={Info} label="Publish runs no sweep" />
    </div>
  )
}

/**
 * Where an edit or a removal applies, and that it leaves past answers alone. A simple project has
 * one place, so it names none.
 */
function ChangeFacts({ action, advanced, detail }: { action: Exclude<TrackingAction, { kind: 'add' }>; advanced: boolean; detail: string }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
      {advanced ? (
        <dl className="flex gap-2 text-[13px] leading-5">
          <dt className="shrink-0 text-secondary">Applies to</dt>
          <dd className="min-w-0 break-words font-medium text-strong">{action.audience ? `Only ${action.scopeLabel}` : 'Everywhere'}</dd>
        </dl>
      ) : null}
      <StatusNote icon={History} label="Past answers kept" detail={detail} />
    </div>
  )
}

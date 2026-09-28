import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SentimentEvidenceItem, SentimentJob, SentimentSettings, SentimentSummary, SentimentSelection, SentimentBackfillPreview } from '@ainyc/canonry-contracts'
import { SentimentOutcomes, SENTIMENT_MAX_THEMES, describeError, sentimentPresetThemes } from '@ainyc/canonry-contracts'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { WriteButton } from '../shared/AccessControls.js'
import { formatTimestamp } from '../../lib/format-helpers.js'

export const SENTIMENT_COPY = {
  states: { disabled: 'Sentiment is disabled.', 'not-measured': 'No sentiment assessments yet.', processing: 'Sentiment classification is in progress.', canceled: 'Sentiment work was canceled.', partial: 'Sentiment results are partial.', failed: 'Sentiment classification failed.', complete: 'Sentiment classification is complete.', unsupported: 'Sentiment is unavailable for this selection.' },
  noJudgments: 'No evaluative answers were classified.',
  nonBrand: 'Non-brand sentiment is not available yet.',
  themeHelp: 'Theme discussion can be neutral. Praise and criticism may overlap, including in the same answer. Unclassified decisions remain excluded from theme counts.',
} as const
const OUTCOME_LABELS: Record<string, string> = {
  favorable: 'Favorable', mixed: 'Mixed', unfavorable: 'Unfavorable', factual: 'Factual', 'wrong-subject': 'Wrong subject', 'ambiguous-subject': 'Ambiguous subject', 'ambiguous-judgment': 'Uncertain judgment',
  'subject-not-applicable': 'Subject not applicable', 'unsupported-language': 'Unsupported language', 'missing-source-text': 'Missing source text', 'input-too-large': 'Input too large',
  'invalid-conclusion-evidence': 'Invalid conclusion evidence', pending: 'Pending', running: 'Running', 'waiting-to-retry': 'Waiting to retry', failed: 'Failed', canceled: 'Canceled', complete: 'Complete', partial: 'Partial',
}
function outcomeLabel(value: string) { return OUTCOME_LABELS[value] ?? value }

export function SentimentReport({ summary, settings, onOpenEvidence, onConfigure }: {
  summary: SentimentSummary; settings?: SentimentSettings; onOpenEvidence: () => void; onConfigure?: () => void
}) {
  const exclusions = Object.entries(summary.coverage.counts).filter(([outcome, count]) => count > 0 && outcome !== SentimentOutcomes.favorable && outcome !== SentimentOutcomes.mixed && outcome !== SentimentOutcomes.unfavorable)
  return <section aria-label="Branded sentiment" className="page-section-divider">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2"><h2>Branded sentiment</h2><ToneBadge tone="caution">Experimental</ToneBadge><InfoTooltip text={settings?.disclosure ?? 'Sentiment quality has not completed independent evaluation.'} /></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={onOpenEvidence}>View sentiment evidence</Button>{settings?.actions.configure && onConfigure && <Button variant="outline" onClick={onConfigure}>Manage sentiment</Button>}</div>
    </div>
    <p role="status" className="mt-3 text-sm text-secondary">{summary.state === 'complete' && summary.coverage.judged === 0 ? SENTIMENT_COPY.noJudgments : SENTIMENT_COPY.states[summary.state]}</p>
    {summary.reason && <p className="mt-2 text-sm text-secondary">{summary.reason}</p>}
    <dl className="my-5 flex flex-wrap gap-x-10 gap-y-4">
      {(['favorable', 'mixed', 'unfavorable'] as const).map(stance => <div key={stance} aria-label={`Branded ${stance} share`}><dt className="text-sm text-secondary">{outcomeLabel(stance)} <span className="sr-only">branded share</span></dt><dd className="font-mono text-2xl text-primary">{summary.score[`${stance}Display`]}</dd></div>)}
    </dl>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-secondary"><span>{summary.coverage.judged} judged of {summary.coverage.selected} selected assessments</span><span>{summary.coverage.distinctSourceAnswers} distinct source answers</span><span>{summary.coverage.eligibleAssessments} eligible assessments</span>{summary.coverage.unadmittedAssessments > 0 && <span>{summary.coverage.unadmittedAssessments} awaiting admission</span>}{summary.provisional && <ToneBadge tone="caution">Provisional</ToneBadge>}</div>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-secondary"><span>95% Wilson interval: {summary.score.interval ? `${summary.score.interval.low} to ${summary.score.interval.high}` : 'Unavailable'}</span><InfoTooltip text={summary.score.limitation} /></div>
    {exclusions.length > 0 && <details className="mt-4"><summary className="cursor-pointer text-sm text-secondary">Coverage and exclusions</summary><dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">{exclusions.map(([outcome, count]) => <div className="contents" key={outcome}><dt>{outcomeLabel(outcome)}</dt><dd className="font-mono">{count}</dd></div>)}<dt>Completed source slots</dt><dd className="font-mono">{summary.coverage.completedProviderSlots} / {summary.coverage.expectedProviderSlots}</dd></dl></details>}
    {summary.breakdowns.length > 0 && <details className="mt-5"><summary className="cursor-pointer text-sm text-secondary">Engine, Property, and market breakdowns</summary><div className="data-table-wrapper mt-3"><table className="data-table"><thead><tr><th>Scope</th><th>Favorable · branded</th><th>Mixed · branded</th><th>Unfavorable · branded</th><th>Judged / selected</th></tr></thead><tbody>{summary.breakdowns.map(row => <tr key={`${row.dimension}:${row.key}`}><th scope="row">{row.label} <span className="text-secondary">({row.dimension})</span></th><td>{row.score.favorableDisplay}</td><td>{row.score.mixedDisplay}</td><td>{row.score.unfavorableDisplay}</td><td>{row.coverage.judged} / {row.coverage.selected}</td></tr>)}</tbody></table></div></details>}
    {summary.themes.length > 0 && <div className="mt-5"><div className="flex items-center gap-2"><h3>Theme evidence</h3><InfoTooltip text={SENTIMENT_COPY.themeHelp} /></div><div className="data-table-wrapper mt-3"><table className="data-table"><thead><tr><th>Theme</th><th>Discussed</th><th>Praised</th><th>Criticized</th><th>Both</th><th>Unclassified</th></tr></thead><tbody>{summary.themes.map(row => <tr key={row.theme.id}><th scope="row"><span>{row.theme.name}</span>{row.theme.evaluationStatus === 'custom-not-evaluated' && <span className="block text-sm font-normal text-secondary">Custom theme: not evaluated</span>}</th><td>{row.discussed}</td><td>{row.praised}</td><td>{row.criticized}</td><td data-overlap>{row.both}</td><td>{row.unclassified}</td></tr>)}</tbody></table></div></div>}
    <p className="mt-4 text-sm text-secondary">{SENTIMENT_COPY.nonBrand}</p>
  </section>
}

export function SentimentEvidenceDrawer({ item, onClose, onRestoreFocus }: { item: SentimentEvidenceItem | null; onClose: () => void; onRestoreFocus?: () => void }) {
  return <Sheet open={item !== null} onOpenChange={open => { if (!open) onClose() }}><SheetContent onCloseAutoFocus={event => { if (onRestoreFocus) { event.preventDefault(); onRestoreFocus() } }}><SheetHeader><SheetTitle>Sentiment evidence: {item?.subject.displayName}</SheetTitle><SheetDescription>Stored answer and verbatim quotations for this branded assessment.</SheetDescription></SheetHeader>{item && <div className="mt-5 space-y-5 overflow-y-auto text-sm text-secondary">
    <div className="flex flex-wrap gap-2"><ToneBadge tone="neutral">{outcomeLabel(item.outcome)}</ToneBadge><span>{item.context.provider}</span><span>{item.context.servedModel ?? 'Source model unavailable'}</span><span>{item.context.location ?? 'No location'}</span></div>
    <p className="text-primary">{item.context.queryText}</p>
    {item.reason && <p>{item.reason}</p>}
    <section><h3 className="mb-2 text-heading">Conclusion evidence</h3>{item.conclusion.length ? item.conclusion.map(span => <blockquote className="mb-2 border-l border-strong pl-3 text-primary" key={`${span.id}:${span.start}`}>{span.text}</blockquote>) : <p>No valid conclusion evidence is available.</p>}</section>
    <section><h3 className="mb-2 text-heading">Complaint evidence</h3>{item.complaint?.length ? item.complaint.map(span => <blockquote className="mb-2 border-l border-strong pl-3 text-primary" key={`${span.id}:${span.start}`}>{span.text}</blockquote>) : <p>No complaint was identified.</p>}</section>
    {item.themes.map(theme => <details key={theme.themeId}><summary className="cursor-pointer">Theme: {theme.themeId}</summary>{theme.reason && <p className="mt-2">{theme.reason}</p>}{(['discussed', 'praised', 'criticized'] as const).map(dimension => <div className="mt-2" key={dimension}><strong className="font-medium text-heading">{dimension}: {theme[dimension] === null ? 'Unclassified' : theme[dimension] ? 'Yes' : 'No'}</strong>{theme.evidence[dimension].map(span => <blockquote className="mt-1 border-l border-strong pl-3" key={`${dimension}:${span.id}`}>{span.text}</blockquote>)}</div>)}</details>)}
    <section><h3 className="mb-2 text-heading">Original source answer</h3><p className="whitespace-pre-wrap break-words text-primary">{item.sourceText}</p></section>
    <details><summary className="cursor-pointer">Assessment provenance</summary><dl className="mt-3 space-y-2 break-all"><dt>Subject</dt><dd>{item.subject.displayName} ({item.subject.id})</dd><dt>Run</dt><dd>{item.runId}</dd><dt>Revision</dt><dd>{item.context.revision ?? 'Unavailable'}</dd><dt>Evaluator</dt><dd>{item.returnedModel ?? 'Unavailable'}</dd><dt>Evaluation definition</dt><dd>{item.evaluationDefinitionId}</dd><dt>Source snapshot</dt><dd>{item.sourceSnapshotId}</dd><dt>Source hash</dt><dd>{item.sourceTextHash}</dd>{item.context.usageEdges.map((edge, index) => <div key={index}><dt>Assignment</dt><dd>Target {edge.targetId}; Property {edge.propertyId ?? 'None'}; market {edge.marketId ?? 'None'}; {edge.queryClass}</dd></div>)}</dl></details>
  </div>}</SheetContent></Sheet>
}

export function SentimentJobs({ jobs }: { jobs: SentimentJob[] }) {
  return <section aria-label="Sentiment jobs"><h3>Recent jobs</h3>{jobs.length === 0 ? <p className="mt-2 text-sm text-secondary">No sentiment jobs have been submitted.</p> : <div className="data-table-wrapper mt-3"><table className="data-table"><thead><tr><th>Submitted</th><th>State</th><th>Selected</th><th>Details</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td>{formatTimestamp(job.createdAt)}</td><td><ToneBadge tone={job.state === 'failed' ? 'negative' : job.state === 'complete' ? 'positive' : 'neutral'}>{outcomeLabel(job.state)}</ToneBadge></td><td>{job.selected}</td><td><details><summary className="cursor-pointer">Job details</summary>{job.cancellationReason && <p>{job.cancellationReason}</p>}<dl className="mt-2 space-y-1">{Object.entries(job.counts).filter(([, count]) => count > 0).map(([state, count]) => <div className="flex gap-2" key={state}><dt>{outcomeLabel(state)}</dt><dd>{count}</dd></div>)}</dl>{job.attempts.map(attempt => <div className="mt-2" key={attempt.id}><span>{attempt.errorCode ?? 'Request complete'}</span><span className="ml-2">{attempt.usage.kind === 'unknown' ? 'Usage unknown' : `${attempt.usage.inputTokens ?? 'Unknown'} input tokens (${attempt.usage.kind})`}</span></div>)}</details></td></tr>)}</tbody></table></div>}</section>
}


import { fetchSentimentEvidence, fetchSentimentSettings, previewSentimentBackfill, submitSentimentBackfill, updateSentimentSettings, fetchSentimentComparison, isEmbed } from '../../api.js'
import { sentimentQueryKey, useSentiment } from '../../queries/sentiment.js'

type SentimentRunOption = { id: string; label: string }

export function SentimentSection({ projectName, selection, runOptions = [] }: { projectName: string; selection: SentimentSelection; runOptions?: SentimentRunOption[] }) {
  return <SentimentScope key={JSON.stringify([projectName, selection])} projectName={projectName} selection={selection} runOptions={runOptions} />
}

function SentimentScope({ projectName, selection, runOptions }: { projectName: string; selection: SentimentSelection; runOptions: SentimentRunOption[] }) {
  const { settings, summary, jobs } = useSentiment(projectName, selection)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const effective = summary.data?.selection
  const evidenceSelection: SentimentSelection = { ...selection, ...(effective ? { ...effective, runId: effective.runId ?? undefined, revision: effective.revision ?? undefined, evaluationDefinitionId: effective.evaluationDefinitionId ?? undefined } : {}) }
  const sweepOptions = evidenceSelection.runId && !runOptions.some(run => run.id === evidenceSelection.runId) ? [{ id: evidenceSelection.runId, label: 'Displayed sweep' }, ...runOptions] : runOptions
  const readonlySettings = settings.data && isEmbed() ? { ...settings.data, actions: { configure: false, backfill: false } } : settings.data
  if (selection.queryClass === 'non-brand') return <section className="page-section-divider" aria-label="Non-brand sentiment"><h2>Non-brand sentiment</h2><p className="mt-3 text-sm text-secondary">{SENTIMENT_COPY.nonBrand}</p></section>
  if (summary.isPending) return <section className="page-section-divider" aria-label="Branded sentiment"><h2>Branded sentiment</h2><p role="status" className="mt-3 text-sm text-secondary">Loading sentiment…</p></section>
  if (summary.isError) return <section className="page-section-divider" aria-label="Branded sentiment"><h2>Branded sentiment</h2><p role="alert" className="my-3 text-sm text-secondary">Could not load sentiment. {describeError(summary.error)}</p><Button variant="outline" onClick={() => { void summary.refetch() }}>Retry sentiment</Button></section>
  return <>
    <SentimentReport summary={summary.data} settings={readonlySettings} onOpenEvidence={() => setEvidenceOpen(value => !value)} onConfigure={() => setManageOpen(value => !value)} />
    {settings.isError && <p role="alert" className="text-sm text-secondary">Sentiment controls are unavailable. Refresh to check permissions.</p>}
    {evidenceOpen && <SentimentEvidenceExplorer key={JSON.stringify(evidenceSelection)} projectName={projectName} selection={evidenceSelection} />}
    {manageOpen && readonlySettings?.actions.configure && <SentimentSettingsEditor key={JSON.stringify([readonlySettings.evaluationDefinitionId, readonlySettings.enabled, readonlySettings.enablementEpoch])} projectName={projectName} settings={readonlySettings} selection={evidenceSelection} runOptions={sweepOptions} />}
    <details className="my-4"><summary className="cursor-pointer text-sm text-secondary">Sentiment jobs and comparison</summary><div className="mt-4">{jobs.data ? <SentimentJobs jobs={jobs.data.jobs} /> : <p role={jobs.isError ? 'alert' : 'status'} className="text-sm text-secondary">{jobs.isError ? 'Could not load sentiment jobs.' : 'Loading sentiment jobs…'}</p>}<SentimentCompare projectName={projectName} selection={evidenceSelection} runOptions={sweepOptions} /></div></details>
  </>
}

function SentimentEvidenceExplorer({ projectName, selection }: { projectName: string; selection: SentimentSelection }) {
  const [cursor, setCursor] = useState<string | undefined>()
  const [item, setItem] = useState<SentimentEvidenceItem | null>(null)
  const evidenceOpener = useRef<HTMLButtonElement | null>(null)
  const query = useQuery({ queryKey: sentimentQueryKey(projectName, 'evidence', selection, cursor), queryFn: () => fetchSentimentEvidence(projectName, selection, cursor), retry: false })
  return <section aria-label="Branded sentiment evidence" className="my-4">
    <h3>Branded sentiment evidence</h3>
    {query.isPending ? <p role="status" className="mt-2 text-sm text-secondary">Loading evidence…</p> : query.isError ? <div role="alert" className="mt-2 text-sm text-secondary">Could not load evidence. <Button variant="outline" onClick={() => { void query.refetch() }}>Retry evidence</Button></div> : query.data.items.length === 0 ? <p className="mt-2 text-sm text-secondary">No stored evidence for this selection.</p> : <div className="data-table-wrapper mt-3"><table className="data-table"><thead><tr><th>Subject</th><th>Query</th><th>Engine</th><th>Outcome</th><th>Evidence</th></tr></thead><tbody>{query.data.items.map(row => <tr key={row.assessmentId}><th scope="row">{row.subject.displayName}</th><td>{row.context.queryText}</td><td>{row.context.provider}</td><td>{outcomeLabel(row.outcome)}</td><td><Button variant="outline" onClick={event => { evidenceOpener.current = event.currentTarget; setItem(row) }} aria-label={`Open sentiment evidence for ${row.subject.displayName}`}>Open evidence</Button></td></tr>)}</tbody></table></div>}
    <div className="mt-3 flex gap-2">{cursor && <Button variant="outline" onClick={() => setCursor(undefined)}>First evidence page</Button>}{query.data?.nextCursor && <Button variant="outline" disabled={query.isFetching} onClick={() => setCursor(query.data.nextCursor ?? undefined)}>Next evidence page</Button>}</div>
    <SentimentEvidenceDrawer item={item} onClose={() => setItem(null)} onRestoreFocus={() => evidenceOpener.current?.focus()} />
  </section>
}

function SentimentSettingsEditor({ projectName, settings, selection, runOptions }: { projectName: string; settings: SentimentSettings; selection: SentimentSelection; runOptions: SentimentRunOption[] }) {
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(settings.enabled)
  const [preset, setPreset] = useState(settings.preset)
  const [customThemes, setCustomThemes] = useState(settings.themes.filter(theme => theme.source === 'custom').map(({ id, name, description }) => ({ id, name, description })))
  const [preview, setPreview] = useState<SentimentBackfillPreview | null>(null)
  const [previewInput, setPreviewInput] = useState(selection.runId ?? '')
  const receiptKey = useRef<string | null>(null)
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['sentiment', projectName] }) }
  const save = useMutation({ mutationFn: async () => {
    const authority = await fetchSentimentSettings(projectName)
    if (!authority.actions.configure) throw new Error('Administrator permission is required to configure sentiment.')
    return updateSentimentSettings(projectName, { enabled, preset, customThemes })
  }, onSuccess: async () => { setPreview(null); receiptKey.current = null; await refresh() }, onError: refresh })
  const inspect = useMutation({ mutationFn: async () => {
    const authority = await fetchSentimentSettings(projectName)
    if (!authority.actions.backfill) throw new Error('Administrator permission is required to backfill sentiment.')
    return previewSentimentBackfill(projectName, { ...selection, runId: previewInput.trim() })
  }, onSuccess: result => { setPreview(result); receiptKey.current = crypto.randomUUID() }, onError: refresh })
  const submit = useMutation({ mutationFn: async () => {
    if (!preview?.previewToken || !receiptKey.current) throw new Error('Create and review a backfill preview first.')
    const authority = await fetchSentimentSettings(projectName)
    if (!authority.actions.backfill) throw new Error('Administrator permission is required to backfill sentiment.')
    return submitSentimentBackfill(projectName, preview.previewToken, receiptKey.current)
  }, onSuccess: async () => { setPreview(null); receiptKey.current = null; await refresh() }, onError: refresh })
  const pending = save.isPending || inspect.isPending || submit.isPending
  const change = () => { setPreview(null); receiptKey.current = null }
  return <section aria-label="Manage sentiment" className="my-5 border-y border-default py-5 text-sm text-secondary">
    <h3>Manage sentiment</h3>
    {!settings.ready && <p className="mt-2">{settings.readinessReasons.join('; ') || 'An operator must configure sentiment on this installation.'}</p>}
    <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); save.mutate() }}>
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={pending} onChange={event => { setEnabled(event.target.checked); change() }} />Enable project sentiment</label>
      <p>Enabling applies to future completed sweeps. Past sweeps require an explicit backfill.</p>
      <label className="flex flex-wrap items-center gap-3">Theme preset<select className="rounded-md border border-default bg-bg p-2 text-primary" value={preset} disabled={pending} onChange={event => { setPreset(event.target.value as 'default' | 'multifamily'); change() }}><option value="default">Default</option><option value="multifamily">Multifamily</option></select></label>
      <details><summary className="cursor-pointer">Effective themes ({settings.themes.length})</summary><ul className="mt-2 list-disc pl-5">{settings.themes.map(theme => <li key={theme.id}>{theme.name}{theme.source === 'custom' ? ' · Custom theme: not evaluated' : ' · Experimental'}</li>)}</ul></details>
      <details><summary className="cursor-pointer">Edit custom themes</summary><div className="mt-3 space-y-3">{customThemes.map((theme, index) => <fieldset className="space-y-2 border-l border-default pl-3" key={theme.id}><legend>Custom theme {index + 1}</legend><label className="block">Name<input className="mt-1 block w-full rounded-md border border-default bg-bg p-2 text-primary" required maxLength={80} value={theme.name} disabled={pending} onChange={event => { setCustomThemes(value => value.map(row => row.id === theme.id ? { ...row, name: event.target.value } : row)); change() }} /></label><label className="block">Description<textarea className="mt-1 block w-full rounded-md border border-default bg-bg p-2 text-primary" required maxLength={400} value={theme.description} disabled={pending} onChange={event => { setCustomThemes(value => value.map(row => row.id === theme.id ? { ...row, description: event.target.value } : row)); change() }} /></label><Button type="button" variant="outline" disabled={pending} onClick={() => { setCustomThemes(value => value.filter(row => row.id !== theme.id)); change() }}>Remove theme {index + 1}</Button></fieldset>)}<Button type="button" variant="outline" disabled={pending || customThemes.length + sentimentPresetThemes(preset).length >= SENTIMENT_MAX_THEMES} onClick={() => { setCustomThemes(value => [...value, { id: `custom-${crypto.randomUUID()}`, name: '', description: '' }]); change() }}>Add custom theme</Button></div></details>
      <WriteButton type="submit" disabled={pending}>{save.isPending ? 'Saving…' : 'Save sentiment settings'}</WriteButton>{save.isSuccess && <p role="status">Sentiment settings saved.</p>}{save.isError && <p role="alert">{describeError(save.error)}</p>}
    </form>
    {settings.actions.backfill && <div className="mt-5 space-y-3"><h4>Backfill a saved sweep</h4><label className="block">Saved sweep<select className="mt-1 block w-full rounded-md border border-default bg-bg p-2 text-primary" value={previewInput} disabled={pending} onChange={event => { setPreviewInput(event.target.value); change() }}><option value="">Select a saved sweep</option>{runOptions.map(run => <option key={run.id} value={run.id}>{run.label}</option>)}</select></label><Button variant="outline" disabled={pending || !previewInput.trim() || !settings.enabled || !settings.ready} onClick={() => { change(); inspect.mutate() }}>{inspect.isPending ? 'Preparing preview…' : 'Preview sentiment backfill'}</Button>{inspect.isError && <p role="alert">{describeError(inspect.error)}</p>}
      {preview && <div className="space-y-3"><dl className="grid grid-cols-[1fr_auto] gap-2"><dt>Eligible assessments</dt><dd>{preview.eligibleAssessments}</dd><dt>Already classified</dt><dd>{preview.alreadyClassified}</dd><dt>Estimated input tokens</dt><dd>{preview.estimatedInputTokens}</dd><dt>Estimated cost (USD)</dt><dd>{preview.estimatedCostUsd ?? 'Unavailable'}</dd></dl><InfoTooltip text={preview.estimateMethod} />{preview.skipped.length > 0 && <ul>{preview.skipped.map((row, index) => <li key={index}>{row.runId}: {row.reason} ({row.count})</li>)}</ul>}<WriteButton disabled={pending || !preview.previewToken || preview.eligibleAssessments === 0} onClick={() => submit.mutate()}>{submit.isPending ? 'Submitting…' : 'Confirm sentiment backfill'}</WriteButton></div>}
      {submit.isError && <p role="alert">{describeError(submit.error)} Retry uses the same request key.</p>}{submit.isSuccess && <p role="status">Backfill submitted. Progress is available in Recent jobs.</p>}
    </div>}
  </section>
}

function SentimentCompare({ projectName, selection, runOptions }: { projectName: string; selection: SentimentSelection; runOptions: SentimentRunOption[] }) {
  const [fromRunId, setFromRunId] = useState('')
  const comparison = useMutation({ mutationFn: () => fetchSentimentComparison(projectName, selection, fromRunId.trim(), selection.runId!) })
  return <section aria-label="Compare sentiment sweeps" className="mt-5 text-sm text-secondary"><h3>Compare saved sweeps</h3><form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); comparison.mutate() }}><label>Earlier sweep<select className="mt-1 block rounded-md border border-default bg-bg p-2 text-primary" value={fromRunId} onChange={event => { setFromRunId(event.target.value); comparison.reset() }}><option value="">Select a saved sweep</option>{runOptions.filter(run => run.id !== selection.runId).map(run => <option key={run.id} value={run.id}>{run.label}</option>)}</select></label><Button variant="outline" type="submit" disabled={!fromRunId.trim() || !selection.runId || comparison.isPending}>Compare with displayed sweep</Button></form>{comparison.isError && <p role="alert" className="mt-2">{describeError(comparison.error)}</p>}{comparison.data && <div className="mt-3"><p>{comparison.data.verdict === 'improved' ? 'Favorable share improved.' : comparison.data.verdict === 'declined' ? 'Favorable share declined.' : comparison.data.verdict === 'no-clear-change' ? 'No clear change in favorable share.' : 'These sweeps cannot be compared.'}</p>{comparison.data.refusalReasons.map(reason => <p key={reason}>{reason}</p>)}<p>{comparison.data.commonUnits} common assessments; {comparison.data.excludedFrom} earlier and {comparison.data.excludedTo} current exclusions.</p><InfoTooltip text={comparison.data.limitation} /></div>}</section>
}

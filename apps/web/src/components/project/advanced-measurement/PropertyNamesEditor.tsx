import { useId, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  effectiveBrandNames,
  measurementTargetNameIssueMessage,
  measurementTargetNameIssues,
  type MeasurementDraftResponse,
  type MeasurementDraftTarget,
  type MeasurementTargetNameIssue,
} from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameMeasurementPlanDraftOptions,
  getApiV1ProjectsByNameOptions,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../../api.js'
import { useAccount } from '../../../contexts/account-context.js'
import { WriteButton } from '../../shared/AccessControls.js'
import { InfoTooltip } from '../../shared/InfoTooltip.js'
import { Button } from '../../ui/button.js'
import { advancedMeasurementService, isDraftConflict, type AdvancedMeasurementService } from './service.js'

/**
 * Copy for the Property name editor. Exported so tests assert the shipped
 * strings rather than a second copy of them.
 */
export const PROPERTY_NAMES_COPY = {
  heading: 'Names that count as this Property',
  help: 'An answer mentions this Property when its text contains one of these names as whole words. Source titles and source links never count, but a link in the answer whose text is one of these names does. Qualified names are longer forms, such as the name with its street or city, for a name that other places share.',
  names: 'Names',
  qualifiedNames: 'Qualified names',
  noNames: 'No names are set, so answers can cite this Property but never mention it.',
  edit: 'Edit names',
  save: 'Save to draft',
  saving: 'Saving…',
  cancel: 'Cancel',
  namesHint: 'One name per line.',
  qualifiedHint: 'One per line. Each must include one of the names above plus more words, such as a street or city.',
  qualifiedNote: 'With qualified names set, an answer that uses only a plain name counts as a mention only when it also cites this Property’s own page. Otherwise it is left out as not tied to one property.',
  draftOnly: 'Saving changes the draft only. Nothing is measured differently until the setup is published.',
  saved: 'Saved to the draft. Publish the setup to start using these names.',
  pending: 'Name changes are saved in the draft and not published yet.',
  review: 'Review and publish',
  noChanges: 'No changes to save.',
  staleDraft: 'The draft is based on an older published setup. Open measurement setup to restart it before editing names.',
  missingFromDraft: 'This Property is not included in the current draft. Open measurement setup to review it.',
  conflict: 'The draft changed in another session. The latest names are loaded; review them and save again.',
  failed: 'Could not save these names. Try again.',
} as const

type DraftTarget = MeasurementDraftTarget

/** A Property's names and qualified names, wherever they are stored. */
interface TargetNames {
  aliases: readonly string[]
  identityAliases?: readonly string[]
}

type SaveResult =
  | { outcome: 'saved' | 'unchanged' | 'stale' | 'missing' }
  /** These names changed in the draft after the editor opened; `latest` is what it holds now. */
  | { outcome: 'conflict'; latest: TargetNames }

function linesOf(value: string): string[] {
  return [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))]
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

function sameTargetNames(left: TargetNames, right: TargetNames): boolean {
  return sameNames(left.aliases, right.aliases) && sameNames(left.identityAliases ?? [], right.identityAliases ?? [])
}

/** A draft Target carrying these names, dropping an empty qualified list rather than storing `[]`. */
function withNames(target: DraftTarget, aliases: string[], identityAliases: string[]): DraftTarget {
  const { identityAliases: _previous, ...rest } = target
  return identityAliases.length > 0 ? { ...rest, aliases, identityAliases } : { ...rest, aliases }
}

function NameList({ label, names }: { label: string; names: readonly string[] }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium text-heading">{label}</h3>
      <ul className="space-y-1">
        {names.map(name => <li key={name} className="text-sm text-secondary">{name}</li>)}
      </ul>
    </div>
  )
}

function IssueList({ id, issues }: { id: string; issues: readonly MeasurementTargetNameIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul id={id} className="mt-2 space-y-1" aria-label="Name warnings">
      {issues.map(issue => (
        <li key={`${issue.field}:${issue.index}`} className="text-sm text-caution">{measurementTargetNameIssueMessage(issue)}</li>
      ))}
    </ul>
  )
}

/**
 * The names a Property is matched by in answer text, and, for an operator, an
 * editor that writes them into the measurement draft.
 *
 * Saving is `upsert-target` on the draft and never a publish: the published
 * revision keeps matching the old names until someone reviews and publishes the
 * draft. Warnings come from the same contracts helper the draft API attaches to
 * its response, checked against the same brand names (the project's current
 * ones, which the next publish freezes), so this editor and
 * `canonry measurement-plan advanced` say the same thing about the same name.
 */
export function PropertyNamesSection({
  projectName,
  targetKey,
  published,
  activeRevision,
  publishedBrandNames,
  service = advancedMeasurementService,
}: {
  projectName: string
  targetKey: string
  published: TargetNames
  activeRevision: number
  /**
   * The published revision's brand names. Used only when the project read
   * fails; otherwise names are checked against the project's current ones.
   */
  publishedBrandNames: readonly string[]
  service?: AdvancedMeasurementService
}) {
  const { canWrite } = useAccount()
  const fieldId = useId()
  const draftQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementPlanDraftOptions({ client: heyClient, path: { name: projectName } }),
    enabled: canWrite,
  })
  const projectQuery = useQuery({
    ...getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: projectName } }),
    enabled: canWrite,
  })
  const draftTarget = draftQuery.data?.draft?.authoring.targets.find(target => target.stableKey === targetKey)
  const publishedQualified = published.identityAliases ?? []
  const pending = draftTarget !== undefined
    && draftQuery.data?.draft?.baseActiveRevision === activeRevision
    && !sameTargetNames(draftTarget, published)
  // The editor opens on what the draft holds now, so it waits for the draft
  // read (and any refresh of it) and for the brand names it checks against.
  const ready = !draftQuery.isFetching && !projectQuery.isPending
  const projectData = projectQuery.data
  const brandNames = useMemo(
    () => projectData ? effectiveBrandNames(projectData) : publishedBrandNames,
    [projectData, publishedBrandNames],
  )

  const [editing, setEditing] = useState(false)
  const [namesText, setNamesText] = useState('')
  const [qualifiedText, setQualifiedText] = useState('')
  // The names the editor opened on. A save compares the draft against these,
  // so a change made elsewhere while the editor was open is never overwritten.
  const [base, setBase] = useState<TargetNames>(published)
  const [notice, setNotice] = useState<{ tone: 'positive' | 'negative'; text: string; review: boolean } | null>(null)

  const names = useMemo(() => linesOf(namesText), [namesText])
  const qualified = useMemo(() => linesOf(qualifiedText), [qualifiedText])
  const issues = useMemo(
    () => measurementTargetNameIssues({ aliases: names, identityAliases: qualified, brandNames }),
    [names, qualified, brandNames],
  )
  const nameIssues = issues.filter(issue => issue.field === 'aliases')
  const qualifiedIssues = issues.filter(issue => issue.field === 'identityAliases')

  function loadNames(source: TargetNames) {
    setNamesText(source.aliases.join('\n'))
    setQualifiedText((source.identityAliases ?? []).join('\n'))
    setBase({ aliases: [...source.aliases], identityAliases: [...(source.identityAliases ?? [])] })
  }

  /** What a save would replace: the draft's copy of this Property, or the published names with no draft. */
  function namesInForce(response: MeasurementDraftResponse): TargetNames | null {
    if (!response.draft) return published
    return response.draft.authoring.targets.find(target => target.stableKey === targetKey) ?? null
  }

  function openEditor() {
    loadNames(pending ? draftTarget : published)
    setNotice(null)
    setEditing(true)
  }

  function showConflict(latest: TargetNames | null) {
    if (latest) loadNames(latest)
    setNotice({ tone: 'negative', text: PROPERTY_NAMES_COPY.conflict, review: false })
  }

  const save = useMutation({
    mutationFn: async (input: { names: { aliases: string[]; identityAliases: string[] }; base: TargetNames }): Promise<SaveResult> => {
      let current = await service.loadDraft(projectName)
      if (!current.draft) {
        // With no draft the published names are in force. Compare first: an
        // open draft changes what the whole project is asked to do next, so a
        // save that changes nothing must not start one.
        if (sameTargetNames(input.names, published)) return { outcome: 'unchanged' }
        if (!sameTargetNames(input.base, published)) return { outcome: 'conflict', latest: published }
        await service.createDraft(projectName, activeRevision)
        current = await service.loadDraft(projectName)
      }
      const draft = current.draft
      if (!draft || !current.etag) throw new Error(PROPERTY_NAMES_COPY.failed)
      if (draft.baseActiveRevision !== activeRevision) return { outcome: 'stale' }
      const target = draft.authoring.targets.find(candidate => candidate.stableKey === targetKey)
      if (!target || target.status !== 'included') return { outcome: 'missing' }
      if (sameTargetNames(input.names, target)) return { outcome: 'unchanged' }
      // The ETag below covers only this read. Names changed by another session
      // or an agent since the editor opened would be replaced silently, so
      // compare with what the editor started from.
      if (!sameTargetNames(input.base, target)) return { outcome: 'conflict', latest: target }
      await service.upsertTarget(projectName, current.etag, withNames(target, input.names.aliases, input.names.identityAliases))
      return { outcome: 'saved' }
    },
    // The inline notice is the error message; a toast would repeat it.
    meta: { skipGlobalErrorToast: true },
    onSuccess: result => {
      switch (result.outcome) {
        case 'saved':
          setEditing(false)
          setNotice({ tone: 'positive', text: PROPERTY_NAMES_COPY.saved, review: true })
          return
        case 'unchanged':
          setEditing(false)
          setNotice({ tone: 'positive', text: PROPERTY_NAMES_COPY.noChanges, review: false })
          return
        case 'stale':
          setNotice({ tone: 'negative', text: PROPERTY_NAMES_COPY.staleDraft, review: true })
          return
        case 'missing':
          setNotice({ tone: 'negative', text: PROPERTY_NAMES_COPY.missingFromDraft, review: true })
          return
        case 'conflict':
          showConflict(result.latest)
          void draftQuery.refetch()
          return
      }
    },
    onError: error => {
      if (isDraftConflict(error)) {
        showConflict(null)
        void draftQuery.refetch().then(result => {
          if (result.isSuccess) showConflict(namesInForce(result.data))
        })
        return
      }
      setNotice({ tone: 'negative', text: PROPERTY_NAMES_COPY.failed, review: false })
    },
  })

  const reviewLink = (
    <Link to="/projects/$projectName/portfolio" params={{ projectName }} className="text-link underline-offset-2 hover:underline">
      {PROPERTY_NAMES_COPY.review}
    </Link>
  )
  const nameCount = published.aliases.length + publishedQualified.length

  return (
    <section aria-labelledby="property-names" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1">
          <h2 id="property-names" className="text-base font-semibold text-heading">{PROPERTY_NAMES_COPY.heading}</h2>
          <InfoTooltip text={PROPERTY_NAMES_COPY.help} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="supporting-copy">{nameCount} {nameCount === 1 ? 'name' : 'names'}</p>
          {canWrite && !editing ? (
            <Button type="button" size="sm" variant="outline" className="h-11 px-4 text-sm md:h-11" disabled={!ready} onClick={openEditor}>
              {PROPERTY_NAMES_COPY.edit}
            </Button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <p role={notice.tone === 'negative' ? 'alert' : 'status'} className={`mb-3 text-sm ${notice.tone === 'negative' ? 'text-negative' : 'text-positive'}`}>
          {notice.text}
          {notice.review ? <>{' '}{reviewLink}</> : null}
        </p>
      ) : pending && !editing ? (
        <p role="status" className="mb-3 text-sm text-caution">{PROPERTY_NAMES_COPY.pending}{' '}{reviewLink}</p>
      ) : null}

      {editing ? (
        <form
          className="space-y-4"
          aria-label="Edit names"
          onSubmit={event => {
            event.preventDefault()
            if (save.isPending) return
            save.mutate({ names: { aliases: names, identityAliases: qualified }, base })
          }}
        >
          <div>
            <label htmlFor={`${fieldId}-names`} className="block text-sm font-medium text-heading">{PROPERTY_NAMES_COPY.names}</label>
            <p id={`${fieldId}-names-hint`} className="text-sm text-secondary">{PROPERTY_NAMES_COPY.namesHint}</p>
            <textarea
              id={`${fieldId}-names`}
              className="mt-1 min-h-24 w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
              aria-describedby={`${fieldId}-names-hint${nameIssues.length ? ` ${fieldId}-names-issues` : ''}`}
              value={namesText}
              onChange={event => setNamesText(event.target.value)}
            />
            <IssueList id={`${fieldId}-names-issues`} issues={nameIssues} />
            {names.length === 0 ? <p className="mt-2 text-sm text-caution">{PROPERTY_NAMES_COPY.noNames}</p> : null}
          </div>
          <div>
            <label htmlFor={`${fieldId}-qualified`} className="block text-sm font-medium text-heading">{PROPERTY_NAMES_COPY.qualifiedNames}</label>
            <p id={`${fieldId}-qualified-hint`} className="text-sm text-secondary">{PROPERTY_NAMES_COPY.qualifiedHint}</p>
            <textarea
              id={`${fieldId}-qualified`}
              className="mt-1 min-h-20 w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
              aria-describedby={`${fieldId}-qualified-hint ${fieldId}-qualified-note${qualifiedIssues.length ? ` ${fieldId}-qualified-issues` : ''}`}
              value={qualifiedText}
              onChange={event => setQualifiedText(event.target.value)}
            />
            <IssueList id={`${fieldId}-qualified-issues`} issues={qualifiedIssues} />
            <p id={`${fieldId}-qualified-note`} className="mt-2 max-w-3xl text-sm text-secondary">{PROPERTY_NAMES_COPY.qualifiedNote}</p>
          </div>
          <p className="text-sm text-secondary">{PROPERTY_NAMES_COPY.draftOnly}</p>
          <div className="flex flex-wrap items-center gap-3">
            <WriteButton type="submit" className="h-11 px-4 text-sm md:h-11" disabled={save.isPending}>
              {save.isPending ? PROPERTY_NAMES_COPY.saving : PROPERTY_NAMES_COPY.save}
            </WriteButton>
            <Button type="button" variant="ghost" className="h-11 px-4 text-sm md:h-11" disabled={save.isPending} onClick={() => { setEditing(false); setNotice(null) }}>
              {PROPERTY_NAMES_COPY.cancel}
            </Button>
          </div>
        </form>
      ) : nameCount === 0 ? (
        <p className="text-sm text-secondary">{PROPERTY_NAMES_COPY.noNames}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {published.aliases.length > 0 ? <NameList label={PROPERTY_NAMES_COPY.names} names={published.aliases} /> : null}
          {publishedQualified.length > 0 ? <NameList label={PROPERTY_NAMES_COPY.qualifiedNames} names={publishedQualified} /> : null}
        </div>
      )}
    </section>
  )
}

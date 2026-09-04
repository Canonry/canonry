import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  DraftMutationResponse,
  MeasurementDraftAuthoring,
  MeasurementDraftCompilePreviewResponse,
  MeasurementDraftDiffPreviewResponse,
  MeasurementDraftResponse,
  MeasurementDraftWarning,
  MeasurementPlanV2PublishResponse,
  MeasurementSetupResponse,
} from '@ainyc/canonry-contracts'
import type { QueryDto } from '@ainyc/canonry-api-client'

import { ApiError } from '../src/api.js'
import {
  AdvancedMeasurementSection,
  sitemapImportInput,
} from '../src/components/project/advanced-measurement/AdvancedMeasurementSection.js'
import {
  assignmentPreviewErrorMessage,
  setupErrorMessage,
  type AdvancedMeasurementService,
  type GroupMembershipPreview,
  type SitemapImportInput,
  type SitemapSelectionInput,
} from '../src/components/project/advanced-measurement/service.js'

const PROJECT = 'synthetic-portfolio'
const NOW = '2026-08-02T12:00:00.000Z'
const COMPILED_CHECKSUM = 'a'.repeat(64)
const DOCUMENT_CHECKSUM = 'b'.repeat(64)
const QUERIES: QueryDto[] = [
  { id: 'q-nearby', query: 'event venues nearby', createdAt: NOW },
  { id: 'q-private', query: 'private event spaces', createdAt: NOW },
]

type Draft = NonNullable<MeasurementDraftResponse['draft']>
type DraftTarget = MeasurementDraftAuthoring['targets'][number]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function property(index: number, status: DraftTarget['status'] = 'included'): DraftTarget {
  const suffix = String(index).padStart(3, '0')
  const url = `https://portfolio.example/properties/property-${suffix}`
  return {
    stableKey: `property-${suffix}`,
    label: `Property ${suffix}`,
    status,
    aliases: [`Property ${suffix}`],
    urlMatchers: [url],
    source: 'sitemap',
    discoveredUrl: url,
    discoveryIdentity: `portfolio.example/properties/{slug}#property-${suffix}`,
  }
}

function draftFixture(input: {
  targets?: DraftTarget[]
  assignedQueryIds?: string[]
  baseActiveRevision?: number | null
} = {}): Draft {
  const targets = input.targets ?? []
  const assignedQueryIds = input.assignedQueryIds ?? []
  const baseActiveRevision = input.baseActiveRevision ?? null
  return {
    id: 'draft-synthetic',
    projectId: 'project-synthetic',
    schemaVersion: 2,
    baseActiveVersionId: baseActiveRevision === null ? null : `version-${baseActiveRevision}`,
    baseActiveRevision,
    authoring: {
      defaultContext: { providers: ['gemini'], models: { gemini: 'gemini-test' }, locations: [] },
      targets,
      assignments: targets.flatMap(target => assignedQueryIds.map(queryId => ({
        targetKey: target.stableKey,
        queryId,
        queryClass: 'non-brand' as const,
        classificationSource: 'rule' as const,
      }))),
      groups: [],
    },
    createdBy: { kind: 'user', id: 'user-editor', label: 'Editor' },
    updatedBy: { kind: 'user', id: 'user-editor', label: 'Editor' },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function setupFixture(draft: Draft | null): MeasurementSetupResponse {
  if (!draft) {
    return {
      state: 'simple',
      nextAction: 'start_setup',
      mode: 'simple',
      answerVisibilityProviderReady: true,
      activeRevision: null,
      activeSchemaVersion: null,
      draft: null,
    }
  }
  const active = draft.baseActiveRevision
  return {
    state: 'setup_in_progress',
    nextAction: 'continue_setup',
    mode: active === null ? 'draft-only' : 'active-v2',
    answerVisibilityProviderReady: true,
    activeRevision: active,
    activeSchemaVersion: active === null ? null : 2,
    draft: { etag: '"mpd_7"', updatedAt: NOW },
  }
}

function compiledPlan(checksum: string) {
  return {
    schemaVersion: 2 as const,
    identities: {
      projectBrand: {
        canonicalHost: 'portfolio.example',
        ownedHosts: ['portfolio.example'],
        names: ['Example Portfolio'],
      },
    },
    targets: [],
    groups: [],
    querySnapshots: [],
    assignments: [],
    executionNodes: [],
    usageEdges: [],
    compiledChecksum: checksum,
  }
}

interface FakeServiceOptions {
  initialDraft?: Draft | null
  importedTargets?: DraftTarget[]
  importError?: Error
  compileChecks?: MeasurementDraftCompilePreviewResponse['checks']
  diffChecks?: MeasurementDraftDiffPreviewResponse['checks']
  assignmentConflictStatus?: 409 | 412
  discardConflictStatus?: 404
  diffActiveRevision?: number | null
  latestBaseActiveRevision?: number | null
  setupActiveRevision?: number | null
  publishConflictRevision?: number
  etagVersion?: number
  sitemapSelectionGate?: Promise<void>
  importWarnings?: MeasurementDraftWarning[]
  assignmentWarnings?: MeasurementDraftWarning[]
  groupWarnings?: MeasurementDraftWarning[]
  pairedAssignmentError?: Error
  pairedAssignmentGate?: Promise<void>
  groupMembershipPreview?: GroupMembershipPreview
}

function createFakeService(options: FakeServiceOptions = {}) {
  let currentDraft = options.initialDraft === undefined ? null : clone(options.initialDraft)
  let currentSetup = setupFixture(currentDraft)
  if (options.setupActiveRevision !== undefined) {
    currentSetup = {
      ...currentSetup,
      state: 'setup_in_progress',
      mode: 'active-v2',
      activeRevision: options.setupActiveRevision,
      activeSchemaVersion: 2,
    }
  }
  let etagVersion = options.etagVersion ?? (currentDraft ? 7 : 0)
  let assignmentConflictStatus = options.assignmentConflictStatus
  let movedDraftDuringDiff = false

  const currentEtag = () => currentDraft ? `"mpd_${etagVersion}"` : null
  const draftResponse = (): MeasurementDraftResponse => ({
    draft: currentDraft ? clone(currentDraft) : null,
    etag: currentEtag(),
  })
  const setupResponse = (): MeasurementSetupResponse => ({
    ...clone(currentSetup),
    draft: currentDraft ? { etag: currentEtag()!, updatedAt: currentDraft.updatedAt } : null,
  })
  const counts = () => ({
    targets: currentDraft?.authoring.targets.length ?? 0,
    includedTargets: currentDraft?.authoring.targets.filter(target => target.status === 'included').length ?? 0,
    assignments: currentDraft?.authoring.assignments.length ?? 0,
    unclassifiedAssignments: currentDraft?.authoring.assignments.filter(assignment => assignment.queryClass === 'unclassified').length ?? 0,
    groups: currentDraft?.authoring.groups.length ?? 0,
    competitors: currentDraft?.authoring.groups.reduce((total, group) => total + group.competitors.length, 0) ?? 0,
  })
  const requireDraft = (etag: string): Draft => {
    if (!currentDraft || etag !== currentEtag()) throw new ApiError('The draft changed.', 412)
    return currentDraft
  }
  const mutation = (warnings: MeasurementDraftWarning[] = []): DraftMutationResponse => {
    etagVersion += 1
    if (currentDraft) currentDraft.updatedAt = NOW
    return { etag: currentEtag()!, changed: true, warnings: clone(warnings), counts: counts() }
  }
  const preview = (): MeasurementDraftCompilePreviewResponse => ({
    ok: true,
    compiledChecksum: COMPILED_CHECKSUM,
    checks: options.compileChecks ?? [],
    counts: counts(),
    plan: compiledPlan(COMPILED_CHECKSUM),
  })

  const service: AdvancedMeasurementService = {
    loadSetup: vi.fn(async () => setupResponse()),
    loadDraft: vi.fn(async () => draftResponse()),
    createDraft: vi.fn(async (_projectName, expectedActiveRevision) => {
      currentDraft = draftFixture({ baseActiveRevision: expectedActiveRevision })
      currentSetup = setupFixture(currentDraft)
      return mutation()
    }),
    importSitemap: vi.fn(async (_projectName, etag, input: SitemapImportInput) => {
      const draft = requireDraft(etag)
      if (options.importError) throw options.importError
      draft.authoring.targets = clone(options.importedTargets ?? [property(1, 'proposed')])
      draft.authoring.discovery = {
        sitemapUrl: input.sitemapUrl,
        rule: input.rule,
        exclusions: input.exclusions ?? [],
        inputChecksum: 'c'.repeat(64),
      }
      return mutation(options.importWarnings)
    }),
    applySitemapSelection: vi.fn(async (_projectName, etag, selections: SitemapSelectionInput[], selectedTargetKeys: string[]) => {
      await options.sitemapSelectionGate
      const draft = requireDraft(etag)
      const byIdentity = new Map(selections.map(selection => [selection.discoveryIdentity, selection]))
      const selected = new Set(selectedTargetKeys)
      draft.authoring.targets = draft.authoring.targets.map(target => {
        const selection = target.discoveryIdentity ? byIdentity.get(target.discoveryIdentity) : undefined
        const reviewed = selection
          ? { ...target, status: selection.action === 'ignore' ? 'excluded' as const : 'included' as const }
          : target
        return { ...reviewed, status: selected.has(target.stableKey) ? 'included' as const : 'excluded' as const }
      })
      draft.authoring.assignments = draft.authoring.assignments.filter(assignment => selected.has(assignment.targetKey))
      draft.authoring.groups = draft.authoring.groups.map(group => ({
        ...group,
        targetKeys: group.targetKeys.filter(targetKey => selected.has(targetKey)),
      }))
      return mutation()
    }),
    previewAssignments: vi.fn(async (_projectName, input) => {
      const draft = currentDraft
      if (!draft || !currentEtag()) throw new ApiError('The draft changed.', 412)
      const selectedGroups = new Set(input.groupKeys ?? [])
      const targetKeys = input.groupKeys
        ? unique(draft.authoring.groups
          .filter(group => selectedGroups.has(group.stableKey))
          .flatMap(group => group.targetKeys))
        : unique(input.targetKeys ?? [])
      const queryIds = unique(input.queryIds)
      const existing = new Set(draft.authoring.assignments.map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
      const requested = targetKeys.length * queryIds.length
      let added = 0
      for (const targetKey of targetKeys) {
        for (const queryId of queryIds) {
          if (!existing.has(`${targetKey}\u0000${queryId}`)) added += 1
        }
      }
      const membershipCounts = new Map<string, number>()
      for (const group of draft.authoring.groups.filter(group => selectedGroups.has(group.stableKey))) {
        for (const targetKey of group.targetKeys) membershipCounts.set(targetKey, (membershipCounts.get(targetKey) ?? 0) + 1)
      }
      return {
        draftEtag: currentEtag()!,
        groups: draft.authoring.groups
          .filter(group => selectedGroups.has(group.stableKey))
          .map(group => ({ groupKey: group.stableKey, label: group.label, memberCount: group.targetKeys.length })),
        resolvedTargetKeys: targetKeys,
        overlapCount: [...membershipCounts.values()].filter(count => count > 1).length,
        assignments: { requested, added, alreadyPresent: requested - added },
        execution: {
          addedNodes: added,
          addedProviderCalls: added,
          fullRunNodes: draft.authoring.assignments.length + added,
          fullRunProviderCalls: draft.authoring.assignments.length + added,
        },
      }
    }),
    applyAssignments: vi.fn(async (_projectName, etag, input) => {
      const draft = requireDraft(etag)
      if (assignmentConflictStatus !== undefined) {
        const status = assignmentConflictStatus
        assignmentConflictStatus = undefined
        etagVersion += 1
        throw new ApiError('The setup changed in another session.', status)
      }
      const selectedGroups = new Set(input.groupKeys ?? [])
      const targetKeys = input.groupKeys
        ? unique(draft.authoring.groups
          .filter(group => selectedGroups.has(group.stableKey))
          .flatMap(group => group.targetKeys))
        : unique(input.targetKeys ?? [])
      const queryIds = unique(input.queryIds)
      const existing = new Set(draft.authoring.assignments.map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
      for (const targetKey of targetKeys) {
        for (const queryId of queryIds) {
          const key = `${targetKey}\u0000${queryId}`
          if (existing.has(key)) continue
          existing.add(key)
          draft.authoring.assignments.push({
            targetKey,
            queryId,
            queryClass: 'non-brand',
            classificationSource: 'rule',
          })
        }
      }
      return mutation(options.assignmentWarnings)
    }),
    replaceAssignments: vi.fn(async (_projectName, etag, input) => {
      const draft = requireDraft(etag)
      const targetKeys = unique(input.targetKeys ?? [])
      const queryIds = new Set(input.queryIds)
      const targets = new Set(targetKeys)
      draft.authoring.assignments = draft.authoring.assignments.filter(assignment => (
        !queryIds.has(assignment.queryId) || targets.has(assignment.targetKey)
      ))
      const existing = new Set(draft.authoring.assignments.map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
      for (const targetKey of targetKeys) {
        for (const queryId of queryIds) {
          if (existing.has(`${targetKey}\u0000${queryId}`)) continue
          draft.authoring.assignments.push({
            targetKey,
            queryId,
            queryClass: 'non-brand',
            classificationSource: 'rule',
          })
        }
      }
      return mutation(options.assignmentWarnings)
    }),
    applyPairedAssignments: vi.fn(async (_projectName, etag, pairs) => {
      await options.pairedAssignmentGate
      const draft = requireDraft(etag)
      if (options.pairedAssignmentError) throw options.pairedAssignmentError
      const existing = new Set(draft.authoring.assignments.map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
      for (const pair of pairs) {
        const key = `${pair.targetKey}\u0000${pair.queryId}`
        if (existing.has(key)) continue
        existing.add(key)
        draft.authoring.assignments.push({
          targetKey: pair.targetKey,
          queryId: pair.queryId,
          queryClass: 'non-brand',
          classificationSource: 'rule',
        })
      }
      return mutation(options.assignmentWarnings)
    }),
    removeAssignment: vi.fn(async (_projectName, etag, targetKeys, queryId) => {
      const draft = requireDraft(etag)
      const selected = new Set(targetKeys)
      draft.authoring.assignments = draft.authoring.assignments.filter(
        assignment => !(selected.has(assignment.targetKey) && assignment.queryId === queryId),
      )
      return mutation()
    }),
    excludeTarget: vi.fn(async (_projectName, etag, targetKey) => {
      const draft = requireDraft(etag)
      draft.authoring.targets = draft.authoring.targets.map(target => (
        target.stableKey === targetKey ? { ...target, status: 'excluded' } : target
      ))
      draft.authoring.assignments = draft.authoring.assignments.filter(assignment => assignment.targetKey !== targetKey)
      draft.authoring.groups = draft.authoring.groups.map(group => ({
        ...group,
        targetKeys: group.targetKeys.filter(key => key !== targetKey),
      }))
      return mutation()
    }),
    upsertTarget: vi.fn(async (_projectName, etag, target) => {
      const draft = requireDraft(etag)
      const index = draft.authoring.targets.findIndex(candidate => candidate.stableKey === target.stableKey)
      if (index === -1) draft.authoring.targets.push(clone(target))
      else draft.authoring.targets[index] = clone(target)
      return mutation()
    }),
    upsertGroup: vi.fn(async (_projectName, etag, group) => {
      const draft = requireDraft(etag)
      const index = draft.authoring.groups.findIndex(candidate => candidate.stableKey === group.stableKey)
      const next = {
        stableKey: group.stableKey,
        label: group.label,
        targetKeys: clone(group.targetKeys),
        competitors: group.competitors === undefined
          ? (index === -1 ? [] : draft.authoring.groups[index]!.competitors)
          : clone(group.competitors),
      }
      if (index === -1) draft.authoring.groups.push(next)
      else draft.authoring.groups[index] = next
      return mutation(options.groupWarnings)
    }),
    removeGroup: vi.fn(async (_projectName, etag, groupKey) => {
      const draft = requireDraft(etag)
      draft.authoring.groups = draft.authoring.groups.filter(group => group.stableKey !== groupKey)
      return mutation()
    }),
    upsertCompetitor: vi.fn(async (_projectName, etag, input) => {
      const draft = requireDraft(etag)
      const group = draft.authoring.groups.find(candidate => candidate.stableKey === input.groupKey)
      if (group) {
        const index = group.competitors.findIndex(candidate => candidate.stableKey === input.competitor.stableKey)
        if (index === -1) group.competitors.push(clone(input.competitor))
        else group.competitors[index] = clone(input.competitor)
      }
      return mutation()
    }),
    removeCompetitor: vi.fn(async (_projectName, etag, groupKey, competitorKey) => {
      const draft = requireDraft(etag)
      const group = draft.authoring.groups.find(candidate => candidate.stableKey === groupKey)
      if (group) group.competitors = group.competitors.filter(competitor => competitor.stableKey !== competitorKey)
      return mutation()
    }),
    previewGroupMembership: vi.fn(async () => options.groupMembershipPreview ?? ({
      draftEtag: currentEtag()!,
      sourceChecksum: 'c'.repeat(64),
      previewChecksum: 'd'.repeat(64),
      rows: [],
      groupChanges: [],
      counts: {
        dataRows: 0,
        matchedRows: 0,
        ambiguousRows: 0,
        unmatchedRows: 0,
        invalidRows: 0,
        duplicateRows: 0,
        proposedRows: 0,
        excludedRows: 0,
        needsAttention: 0,
        groupsReady: 0,
        groupsToCreate: 0,
        groupsToExtend: 0,
        membershipsReady: 0,
        addedMemberships: 0,
        unchangedMemberships: 0,
      },
    })),
    applyGroupMembership: vi.fn(async (_projectName, etag, input) => {
      requireDraft(etag)
      return {
        ...mutation(),
        appliedRows: input.acceptedRows.length,
        addedMemberships: input.acceptedRows.length,
        unchangedMemberships: 0,
      }
    }),
    compilePreview: vi.fn(async () => preview()),
    diffPreview: vi.fn(async () => {
      const activeRevision = options.diffActiveRevision === undefined
        ? currentDraft?.baseActiveRevision ?? null
        : options.diffActiveRevision
      const response: MeasurementDraftDiffPreviewResponse = {
        ...preview(),
        checks: options.diffChecks ?? options.compileChecks ?? [],
        diff: {
          activeRevision,
          targets: {
            added: currentDraft?.authoring.targets.map(target => target.stableKey) ?? [],
            removed: [],
            changed: [],
            unchanged: [],
          },
          groups: { added: [], removed: [], changed: [], unchanged: [] },
          assignments: { added: currentDraft?.authoring.assignments.length ?? 0, removed: 0, reclassified: 0 },
          execution: { addedNodeKeys: [], removedNodeKeys: [] },
        },
      }
      if (!movedDraftDuringDiff && options.latestBaseActiveRevision !== undefined && currentDraft) {
        movedDraftDuringDiff = true
        currentDraft.baseActiveRevision = options.latestBaseActiveRevision
        currentDraft.baseActiveVersionId = options.latestBaseActiveRevision === null
          ? null
          : `version-${options.latestBaseActiveRevision}`
        currentSetup = setupFixture(currentDraft)
        etagVersion += 1
      }
      return response
    }),
    publish: vi.fn(async (_projectName, etag, input) => {
      requireDraft(etag)
      if (options.publishConflictRevision !== undefined) {
        currentSetup = {
          ...currentSetup,
          state: 'setup_in_progress',
          mode: 'active-v2',
          activeRevision: options.publishConflictRevision,
          activeSchemaVersion: 2,
        }
        throw new ApiError('The published setup changed.', 409)
      }
      const revision = (input.expectedActiveRevision ?? 0) + 1
      const response: MeasurementPlanV2PublishResponse = {
        published: true,
        active: {
          revision,
          checksum: DOCUMENT_CHECKSUM,
          compiledChecksum: input.expectedCompiledChecksum,
          createdAt: NOW,
          plan: compiledPlan(input.expectedCompiledChecksum),
        },
      }
      currentDraft = null
      currentSetup = {
        state: 'awaiting_first_run',
        nextAction: 'run_measurement',
        mode: 'active-v2',
        answerVisibilityProviderReady: true,
        activeRevision: revision,
        activeSchemaVersion: 2,
        draft: null,
      }
      return response
    }),
    discard: vi.fn(async (_projectName, etag) => {
      requireDraft(etag)
      currentDraft = null
      currentSetup = setupFixture(null)
      if (options.discardConflictStatus) {
        throw new ApiError('Measurement plan draft was not found.', options.discardConflictStatus)
      }
      return { discarded: true }
    }),
  }

  return {
    service,
    getDraft: () => currentDraft ? clone(currentDraft) : null,
    getEtag: currentEtag,
  }
}

function renderSection(
  fake: ReturnType<typeof createFakeService>,
  overrides: Partial<React.ComponentProps<typeof AdvancedMeasurementSection>> = {},
) {
  return render(
    <AdvancedMeasurementSection
      projectName={PROJECT}
      queries={QUERIES}
      isQueryLoading={false}
      isQueryError={false}
      service={fake.service}
      {...overrides}
    />,
  )
}

async function reviewSyntheticSitemap() {
  await screen.findByRole('heading', { name: 'Import Properties' })
  fireEvent.change(screen.getByLabelText('Sitemap URL'), {
    target: { value: 'https://portfolio.example/sitemap.xml' },
  })
  fireEvent.change(screen.getByLabelText('Example Property page'), {
    target: { value: 'https://portfolio.example/properties/property-001' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review sitemap' }))
}

async function advanceExistingDraftToReview() {
  await screen.findByRole('heading', { name: 'Properties' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Groups' })
  fireEvent.click(screen.getByRole('button', { name: /^Continue(?: without groups)?$/ }))
  await screen.findByRole('heading', { name: 'Queries' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Review & publish' })
}

async function advanceGroupsToQuestions() {
  await screen.findByRole('heading', { name: 'Groups' })
  fireEvent.click(screen.getByRole('button', { name: /^Continue(?: without groups)?$/ }))
  await screen.findByRole('heading', { name: 'Queries' })
}

async function advancePropertiesToQuestions() {
  await screen.findByRole('heading', { name: 'Properties' })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await advanceGroupsToQuestions()
}

async function clickReadyAssignment(name: RegExp): Promise<void> {
  const button = screen.getByRole('button', { name })
  await waitFor(() => expect(button).not.toHaveProperty('disabled', true))
  fireEvent.click(button)
}

afterEach(cleanup)

test('keeps internal setup terminology out of customer-facing errors', () => {
  expect(setupErrorMessage(new ApiError('Measurement draft Target was not found', 404), 'Could not save this Property.'))
    .toBe('Could not save this Property.')
  expect(setupErrorMessage(new ApiError('Sitemap request timed out', 504), 'Could not review this sitemap.'))
    .toBe('Could not review this sitemap.')
  expect(setupErrorMessage(new ApiError('Target Stores could not be saved', 500), 'Could not save this group.'))
    .toBe('Could not save this group.')
  expect(setupErrorMessage(new Error('Target Stores needs a competitor domain'), 'Could not save this group.'))
    .toBe('Target Stores needs a competitor domain')
  expect(setupErrorMessage(new ApiError('Measurement plan draft no longer exists', 404), 'Could not discard these changes.'))
    .toBe('Could not discard these changes.')
  expect(setupErrorMessage(new ApiError('A draft already exists', 409), 'Could not open setup.'))
    .toBe('Could not open setup.')
  expect(assignmentPreviewErrorMessage(new ApiError(
    'Group "Dallas" has no Properties to assign.',
    400,
    'VALIDATION_ERROR',
    { displayToOperator: true },
  )))
    .toBe('Group "Dallas" has no Properties to assign.')
  const ceiling = 'This would create 5,100 assignments (3 questions across 1700 unique Properties), over the 5,000 limit for one action.'
  expect(assignmentPreviewErrorMessage(new ApiError(ceiling, 400, 'VALIDATION_ERROR', { displayToOperator: true })))
    .toBe(ceiling)
  expect(assignmentPreviewErrorMessage(new ApiError('Invalid "preview-assignments" payload', 400, 'VALIDATION_ERROR')))
    .toBe('Could not calculate assignment impact.')
})

test('turns simple path wildcards into deterministic sitemap exclusions', () => {
  const input = sitemapImportInput({
    sitemapUrl: 'https://portfolio.example/sitemap.xml',
    examplePropertyUrl: 'https://portfolio.example/properties/example-place',
    preferredHost: '',
    propertyPathPattern: '',
    additionalHost: '',
    additionalPathPattern: '',
    excludedPaths: 'archive\n*-directory\nformer-*\n*preview*',
  })

  expect(input.rule.excludedSlugPatterns).toEqual([
    { kind: 'exact', value: 'archive' },
    { kind: 'suffix', value: '-directory' },
    { kind: 'prefix', value: 'former-' },
    { kind: 'contains', value: 'preview' },
  ])
})

describe('AdvancedMeasurementSection server draft controller', () => {
  test('starts an Advanced draft from Simple with the active revision the setup read supplied', async () => {
    const fake = createFakeService()
    renderSection(fake)

    await screen.findByRole('heading', { name: 'Import Properties' })
    expect(fake.service.createDraft).toHaveBeenCalledTimes(1)
    expect(fake.service.createDraft).toHaveBeenCalledWith(PROJECT, null)
    expect(fake.service.loadSetup).toHaveBeenCalledTimes(2)
    expect(fake.service.loadDraft).toHaveBeenCalledTimes(2)
  })

  test('shows the server sitemap error instead of replacing it with a generic failure', async () => {
    const fake = createFakeService({
      importError: new Error('The sitemap contains no Property URLs matching this rule.'),
    })
    renderSection(fake)

    await reviewSyntheticSitemap()

    expect(await screen.findByText('The sitemap contains no Property URLs matching this rule.')).toBeTruthy()
    expect(screen.queryByText('We could not review this sitemap. Check the URL and try again.')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Import Properties' })).toBeTruthy()
  })

  test('requires an explicit restart when a draft is based on an older published setup', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], baseActiveRevision: 4 }),
      setupActiveRevision: 5,
    })
    renderSection(fake)

    expect(await screen.findByText('This draft is based on an older published setup.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull()
    expect(fake.service.discard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard draft and restart' }))

    await waitFor(() => expect(fake.service.discard).toHaveBeenCalledWith(PROJECT, '"mpd_7"'))
    await waitFor(() => expect(fake.service.createDraft).toHaveBeenCalledWith(PROJECT, 5))
    expect(await screen.findByRole('heading', { name: 'Import Properties' })).toBeTruthy()
  })

  test('confirms 213 synthetic sitemap proposals with one server selection action', async () => {
    const proposals = Array.from({ length: 213 }, (_, index) => property(index + 1, 'proposed'))
    const fake = createFakeService({ importedTargets: proposals })
    renderSection(fake)

    await reviewSyntheticSitemap()
    await screen.findByRole('heading', { name: 'Properties' })
    expect(screen.getByText('Showing 50 of 213 Properties')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })

    expect(fake.service.applySitemapSelection).toHaveBeenCalledTimes(1)
    const selections = vi.mocked(fake.service.applySitemapSelection).mock.calls[0]![2]
    expect(selections).toHaveLength(213)
    expect(selections.map(selection => selection.discoveryIdentity)).toEqual(
      proposals.map(proposal => proposal.discoveryIdentity),
    )
    expect(new Set(selections.map(selection => selection.action))).toEqual(new Set(['create']))
    expect(vi.mocked(fake.service.applySitemapSelection).mock.calls[0]![3]).toEqual(
      proposals.map(proposal => proposal.stableKey),
    )
  })

  test('renders real sitemap warning codes from paths without leaking warning prose or stable keys', async () => {
    const targetStores = {
      ...property(1, 'proposed'),
      stableKey: 'target-stores',
      label: 'Target Stores',
    }
    const originalStore = {
      ...property(2),
      stableKey: 'original-store',
      label: 'Original Store',
    }
    const movedStore = {
      ...property(3, 'proposed'),
      stableKey: 'moved-store',
      label: 'Moved Store',
    }
    const ambiguousStore = {
      ...property(4, 'proposed'),
      stableKey: 'ambiguous-store',
      label: 'Ambiguous Store',
    }
    const warnings: MeasurementDraftWarning[] = [
      {
        code: 'measurement.discovery.proposed_new_target',
        message: `'${targetStores.discoveredUrl}' matches no existing Target and is proposed as a new one.`,
        path: ['targets', targetStores.stableKey],
      },
      {
        code: 'measurement.discovery.proposed_rebind',
        message: `'${movedStore.discoveredUrl}' looks like Target '${originalStore.stableKey}' at a new URL.`,
        path: ['targets', movedStore.stableKey, 'rebind', originalStore.stableKey],
      },
      {
        code: 'measurement.discovery.rebind_ambiguous',
        message: `'${ambiguousStore.discoveredUrl}' matches several Targets, '${originalStore.stableKey}' among them.`,
        path: ['targets', ambiguousStore.stableKey, 'rebind', originalStore.stableKey],
      },
      {
        code: 'future-warning',
        message: 'Target node stable key leaked from a future warning.',
        path: ['targets', targetStores.stableKey],
      },
    ]
    const fake = createFakeService({
      importedTargets: [targetStores, originalStore, movedStore, ambiguousStore],
      importWarnings: warnings,
      assignmentWarnings: warnings,
    })
    renderSection(fake)

    await reviewSyntheticSitemap()
    await screen.findByRole('heading', { name: 'Properties' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await advanceGroupsToQuestions()
    fireEvent.click(screen.getByLabelText(`Select query ${QUERIES[0]!.query}`))
    await clickReadyAssignment(/Assign 1 query to all 4 Properties/)
    await waitFor(() => expect(fake.service.applyAssignments).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Review & publish' })

    expect(screen.getByText('Review a new Property')).toBeTruthy()
    expect(screen.getByText(`Review Target Stores — ${targetStores.discoveredUrl}. It did not match an existing Property.`)).toBeTruthy()
    expect(screen.getByText('Review a moved Property')).toBeTruthy()
    expect(screen.getByText(`Review Moved Store — ${movedStore.discoveredUrl}. It may be the same Property as Original Store.`)).toBeTruthy()
    expect(screen.getByText('Choose an existing Property')).toBeTruthy()
    expect(screen.getByText(`Review Ambiguous Store — ${ambiguousStore.discoveredUrl}. It may match Original Store; choose the correct Property.`)).toBeTruthy()
    expect(screen.getByText('Unexpected setup warning')).toBeTruthy()
    expect(screen.getByText('Review the latest setup change before publishing. If this warning remains, contact support.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('matches no existing Target')
    expect(document.body.textContent).not.toContain('original-store')
    expect(document.body.textContent).not.toContain('Target node stable key leaked')
  })

  test('disables Properties Continue with saving feedback while the server selection is pending', async () => {
    let releaseSelection: (() => void) | undefined
    const sitemapSelectionGate = new Promise<void>(resolve => { releaseSelection = resolve })
    const fake = createFakeService({
      importedTargets: [property(1, 'proposed'), property(2, 'proposed')],
      sitemapSelectionGate,
    })
    renderSection(fake)

    await reviewSyntheticSitemap()
    await screen.findByRole('heading', { name: 'Properties' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    const saving = await screen.findByRole('button', { name: 'Saving Properties…' })
    expect(saving).toHaveProperty('disabled', true)
    fireEvent.click(saving)
    expect(fake.service.applySitemapSelection).toHaveBeenCalledTimes(1)

    releaseSelection?.()
    expect(await screen.findByRole('heading', { name: 'Groups' })).toBeTruthy()
    expect(fake.service.applySitemapSelection).toHaveBeenCalledTimes(1)
  })

  test('applies every selected query to every selected Property in exactly one bulk call', async () => {
    const targets = [property(1), property(2), property(3)]
    const fake = createFakeService({ initialDraft: draftFixture({ targets }) })
    renderSection(fake)

    await advanceGroupsToQuestions()
    for (const query of QUERIES) fireEvent.click(screen.getByLabelText(`Select query ${query.query}`))
    await clickReadyAssignment(/Assign 2 queries to all 3 Properties/)

    await waitFor(() => expect(fake.service.applyAssignments).toHaveBeenCalledTimes(1))
    expect(fake.service.previewAssignments).toHaveBeenCalledTimes(1)
    expect(fake.service.applyAssignments).toHaveBeenCalledWith(
      PROJECT,
      '"mpd_7"',
      {
        targetKeys: targets.map(target => target.stableKey),
        queryIds: QUERIES.map(query => query.id),
      },
    )
    expect(fake.getDraft()?.authoring.assignments).toHaveLength(targets.length * QUERIES.length)
  })

  test('previews and applies a selected group through one server-resolved audience', async () => {
    const targets = [property(1), property(2), property(3)]
    const initialDraft = draftFixture({ targets })
    initialDraft.authoring.groups = [{
      stableKey: 'group-dallas',
      label: 'Dallas',
      targetKeys: ['property-001', 'property-003'],
      competitors: [],
    }]
    const fake = createFakeService({ initialDraft })
    renderSection(fake)

    await advanceGroupsToQuestions()
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'group:group-dallas' } })
    fireEvent.click(screen.getByLabelText(`Select query ${QUERIES[0]!.query}`))
    await clickReadyAssignment(/Assign 1 query to Dallas/)

    await waitFor(() => expect(fake.service.applyAssignments).toHaveBeenCalledTimes(1))
    expect(fake.service.previewAssignments).toHaveBeenLastCalledWith(PROJECT, {
      groupKeys: ['group-dallas'],
      queryIds: [QUERIES[0]!.id],
    })
    expect(fake.service.applyAssignments).toHaveBeenCalledWith(PROJECT, '"mpd_7"', {
      groupKeys: ['group-dallas'],
      queryIds: [QUERIES[0]!.id],
    })
  })

  test('applies Specific Properties in canonical order regardless of checkbox order', async () => {
    const targets = [property(1), property(2), property(3)]
    const fake = createFakeService({ initialDraft: draftFixture({ targets }) })
    renderSection(fake)

    await advanceGroupsToQuestions()
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'specific' } })
    fireEvent.click(screen.getByLabelText('Select Property 003'))
    fireEvent.click(screen.getByLabelText('Select Property 001'))
    fireEvent.click(screen.getByLabelText(`Select query ${QUERIES[0]!.query}`))
    await clickReadyAssignment(/Assign 1 query to 2 Properties/)

    await waitFor(() => expect(fake.service.applyAssignments).toHaveBeenCalledTimes(1))
    expect(fake.service.applyAssignments).toHaveBeenCalledWith(PROJECT, '"mpd_7"', {
      targetKeys: ['property-001', 'property-003'],
      queryIds: [QUERIES[0]!.id],
    })
    expect(screen.queryByText('Review the latest assignment impact before assigning queries.')).toBeNull()
  })

  test('resets the audience when its selected group is removed', async () => {
    const targets = [property(1), property(2)]
    const initialDraft = draftFixture({ targets })
    initialDraft.authoring.groups = [{
      stableKey: 'group-dallas',
      label: 'Dallas',
      targetKeys: ['property-001'],
      competitors: [],
    }]
    const fake = createFakeService({ initialDraft })
    renderSection(fake)

    await advanceGroupsToQuestions()
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'group:group-dallas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Dallas' }))
    await waitFor(() => expect(fake.service.removeGroup).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Continue without groups' }))
    await screen.findByRole('heading', { name: 'Queries' })

    expect((screen.getByLabelText('Apply to') as HTMLSelectElement).value).toBe('all')
    expect(screen.queryByText(/selected group is no longer available/i)).toBeNull()
  })

  test('keeps a generated pattern and gives a recoverable pairing error when assignment fails after creation', async () => {
    const targets = [property(1), property(2)]
    const fake = createFakeService({
      initialDraft: draftFixture({ targets }),
      pairedAssignmentError: new ApiError('The draft changed.', 412),
    })
    const onCreateQueries = vi.fn(async (texts: readonly string[]) => (
      texts.map((query, index) => ({ id: `created-${index + 1}`, query }))
    ))
    renderSection(fake, { onCreateQueries })

    await advanceGroupsToQuestions()
    const pattern = await screen.findByLabelText('Query pattern')
    fireEvent.change(pattern, { target: { value: 'events at {property}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 queries' }))

    expect(await screen.findByText(
      'The queries were added, but could not be assigned to their Properties. Try again to pair them.',
    )).toBeTruthy()
    expect((screen.getByLabelText('Query pattern') as HTMLInputElement).value).toBe('events at {property}')
    expect(onCreateQueries).toHaveBeenCalledWith(['events at Property 001', 'events at Property 002'])
    expect(fake.service.applyPairedAssignments).toHaveBeenCalledWith(PROJECT, '"mpd_7"', [
      { targetKey: 'property-001', queryId: 'created-1' },
      { targetKey: 'property-002', queryId: 'created-2' },
    ])
  })

  test('keeps generated pairing busy through assignment, refreshes once, and clears only after both stages', async () => {
    const targets = [property(1), property(2)]
    let releaseAssignment: (() => void) | undefined
    const pairedAssignmentGate = new Promise<void>(resolve => { releaseAssignment = resolve })
    const fake = createFakeService({ initialDraft: draftFixture({ targets }), pairedAssignmentGate })
    const onCreateQueries = vi.fn(async (texts: readonly string[]) => (
      texts.map((query, index) => ({ id: `created-${index + 1}`, query }))
    ))
    renderSection(fake, { onCreateQueries })

    await advanceGroupsToQuestions()
    const pattern = await screen.findByLabelText('Query pattern')
    fireEvent.change(pattern, { target: { value: 'events at {property}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 queries' }))
    await waitFor(() => expect(fake.service.applyPairedAssignments).toHaveBeenCalledTimes(1))

    const adding = screen.getAllByRole('button', { name: 'Adding…' })
    expect(adding).toHaveLength(2)
    for (const button of adding) expect(button).toHaveProperty('disabled', true)
    fireEvent.click(adding[1]!)
    expect(onCreateQueries).toHaveBeenCalledTimes(1)
    expect((pattern as HTMLInputElement).value).toBe('events at {property}')

    releaseAssignment?.()
    await waitFor(() => expect((pattern as HTMLInputElement).value).toBe(''))
    expect(fake.service.loadDraft).toHaveBeenCalledTimes(2)
    expect(fake.getDraft()?.authoring.assignments).toEqual([
      expect.objectContaining({ targetKey: 'property-001', queryId: 'created-1' }),
      expect.objectContaining({ targetKey: 'property-002', queryId: 'created-2' }),
    ])
  })

  test('clears one query from all assigned Properties in exactly one bulk call', async () => {
    const targets = [property(1), property(2), property(3), property(4)]
    const fake = createFakeService({
      initialDraft: draftFixture({ targets, assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
    })
    renderSection(fake)

    await advancePropertiesToQuestions()
    fireEvent.click(screen.getByRole('button', { name: `Clear query assignments for ${QUERIES[0]!.query}` }))

    await waitFor(() => expect(fake.service.removeAssignment).toHaveBeenCalledTimes(1))
    expect(fake.service.removeAssignment).toHaveBeenCalledWith(
      PROJECT,
      '"mpd_7"',
      targets.map(target => target.stableKey),
      'q-nearby',
    )
    expect(fake.getDraft()?.authoring.assignments).toEqual([])
  })

  test('saves the complete Property selection and cleanup in one atomic action', async () => {
    const targets = [property(1), property(2)]
    const initialDraft = draftFixture({ targets, assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 })
    initialDraft.authoring.groups = [{
      stableKey: 'group-synthetic',
      label: 'Synthetic group',
      targetKeys: targets.map(target => target.stableKey),
      competitors: [],
    }]
    const fake = createFakeService({ initialDraft })
    renderSection(fake)

    const firstProperty = await screen.findByLabelText('Select Property 001')
    fireEvent.click(firstProperty)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })

    expect(fake.service.applySitemapSelection).toHaveBeenCalledTimes(1)
    expect(fake.service.applySitemapSelection).toHaveBeenCalledWith(PROJECT, '"mpd_7"', [], ['property-002'])
    expect(fake.service.excludeTarget).not.toHaveBeenCalled()
    expect(fake.getDraft()?.authoring.assignments.map(assignment => assignment.targetKey)).toEqual(['property-002'])
    expect(fake.getDraft()?.authoring.groups[0]?.targetKeys).toEqual(['property-002'])
  })

  test('resets a narrowed audience after returning through Properties', async () => {
    const targets = Array.from({ length: 194 }, (_, index) => property(index + 1))
    const initialDraft = draftFixture({ targets, assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 })
    initialDraft.authoring.groups = [{
      stableKey: 'group-synthetic',
      label: 'Synthetic group',
      targetKeys: targets.map(target => target.stableKey),
      competitors: [],
    }]
    const fake = createFakeService({ initialDraft })
    renderSection(fake)

    await advancePropertiesToQuestions()
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'specific' } })
    expect(screen.getByText('Specific Properties')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Select Property 001'))
    fireEvent.click(screen.getByLabelText('Select Property 002'))

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('heading', { name: 'Properties' })
    expect(screen.getByText('194 of 194 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await advanceGroupsToQuestions()
    expect((screen.getByLabelText('Apply to') as HTMLSelectElement).value).toBe('all')
    expect(screen.queryByText('Specific Properties')).toBeNull()

    expect(fake.service.applySitemapSelection).not.toHaveBeenCalled()
    expect(fake.getDraft()?.authoring.targets.filter(target => target.status === 'included')).toHaveLength(194)
    expect(fake.getDraft()?.authoring.assignments).toHaveLength(194)
    expect(fake.getDraft()?.authoring.groups[0]?.targetKeys).toHaveLength(194)
  })

  test('saves a group and its complete competitor list atomically', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
    })
    renderSection(fake)
    await advanceExistingDraftToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('heading', { name: 'Groups' })

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Synthetic metro' } })
    fireEvent.click(screen.getByLabelText('Select Property 001'))
    fireEvent.change(screen.getByLabelText('Competitor domains'), { target: { value: 'rival.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }))

    await waitFor(() => expect(fake.service.upsertGroup).toHaveBeenCalledTimes(1))
    expect(fake.service.upsertGroup).toHaveBeenCalledWith(PROJECT, '"mpd_7"', {
      stableKey: 'group-synthetic-metro',
      label: 'Synthetic metro',
      targetKeys: ['property-001'],
      competitors: [{
        stableKey: 'competitor-rival.example',
        label: 'rival.example',
        domain: 'rival.example',
        aliases: [],
      }],
    })
    expect(fake.service.upsertCompetitor).not.toHaveBeenCalled()
    expect(fake.service.removeCompetitor).not.toHaveBeenCalled()
  })

  test('renders an action warning from its group path without filtering the operator label', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
      groupWarnings: [{
        code: 'group-unknown-target',
        message: 'Group "group-target-stores" names 1 Target the draft does not hold yet.',
        path: ['groups', 0, 'targetKeys'],
      }],
    })
    renderSection(fake)
    await advanceExistingDraftToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('heading', { name: 'Groups' })

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Target Stores' } })
    fireEvent.click(screen.getByLabelText('Select Property 001'))
    fireEvent.click(screen.getByRole('button', { name: 'Save group' }))
    await waitFor(() => expect(fake.service.upsertGroup).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Review & publish' })

    expect(screen.getByText('Fix group Properties')).toBeTruthy()
    expect(screen.getByText('This group includes a Property that is not in setup. Remove it or add the Property first. Affected: Target Stores.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('group-target-stores')
    expect(document.body.textContent).not.toContain('names 1 Target')
  })

  test('lets a viewer inspect the server draft without creating or mutating anything', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'] }),
    })
    renderSection(fake, { canEdit: false })

    await screen.findByRole('heading', { name: 'Review & publish' })
    expect(screen.getByText('Viewer access')).toBeTruthy()
    for (const action of [
      'Discard changes',
      'Review changes',
      'Publish setup',
      'Apply selected queries',
      'Continue',
    ]) expect(screen.queryByRole('button', { name: action })).toBeNull()
    for (const method of [
      fake.service.createDraft,
      fake.service.importSitemap,
      fake.service.applySitemapSelection,
      fake.service.applyAssignments,
      fake.service.removeAssignment,
      fake.service.publish,
      fake.service.discard,
    ]) expect(method).not.toHaveBeenCalled()
  })

  test('reloads the latest draft when compile and diff report a moved active revision', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
      diffActiveRevision: 5,
      latestBaseActiveRevision: 5,
    })
    renderSection(fake)
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    expect(await screen.findByText(
      'The published setup changed while you were reviewing. The latest draft is loaded; review it again.',
    )).toBeTruthy()
    expect(fake.service.compilePreview).toHaveBeenCalledTimes(1)
    expect(fake.service.diffPreview).toHaveBeenCalledTimes(1)
    expect(fake.getDraft()?.baseActiveRevision).toBe(5)
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeTruthy()
    expect(fake.service.publish).not.toHaveBeenCalled()
  })

  test.each([412, 409] as const)('reloads actionable state after a %s assignment conflict', async status => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)] }),
      assignmentConflictStatus: status,
    })
    renderSection(fake)
    await advanceGroupsToQuestions()
    fireEvent.click(screen.getByLabelText(`Select query ${QUERIES[0]!.query}`))
    await clickReadyAssignment(/Assign 1 query to all 1 Property/)

    expect(await screen.findByText(
      'This setup changed in another session. The latest draft is loaded; review your changes again.',
    )).toBeTruthy()
    expect(fake.service.applyAssignments).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('button', { name: /Assign 1 query to all 1 Property/ })).not.toHaveProperty('disabled', true))

    await clickReadyAssignment(/Assign 1 query to all 1 Property/)
    await waitFor(() => expect(fake.service.applyAssignments).toHaveBeenCalledTimes(2))
    expect(vi.mocked(fake.service.applyAssignments).mock.calls[1]![1]).toBe('"mpd_8"')
    expect(fake.getDraft()?.authoring.assignments).toHaveLength(1)
  })

  test('publishes only the reviewed ETag, base revision, and compiled checksum', async () => {
    const onPublished = vi.fn()
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
    })
    renderSection(fake, { onPublished })
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByRole('button', { name: 'Publish setup' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish setup' }))

    await waitFor(() => expect(fake.service.publish).toHaveBeenCalledTimes(1))
    expect(fake.service.publish).toHaveBeenCalledWith(PROJECT, '"mpd_7"', {
      expectedActiveRevision: 4,
      expectedCompiledChecksum: COMPILED_CHECKSUM,
    })
    expect(onPublished).toHaveBeenCalledTimes(1)
  })

  test('groups repeated review checks into concise Property actions while retaining distinct fixes', async () => {
    const targets = Array.from({ length: 194 }, (_, index) => property(index + 1))
    const repeatedChecks: MeasurementDraftCompilePreviewResponse['checks'] = [
      ...targets.map((_, index) => ({
        ruleId: 'execution-context-no-provider',
        severity: 'fail' as const,
        message: 'An execution context must name at least one provider.',
        path: ['assignments', index, 'contextOverride', 'providers'],
      })),
      ...targets.map((_, index) => ({
        ruleId: 'target-without-aliases',
        severity: 'warn' as const,
        message: `Target "Property ${String(index + 1).padStart(3, '0')}" has no aliases, so it can be cited but never mentioned.`,
        path: ['targets', index, 'aliases'],
      })),
      ...targets.map((_, index) => ({
        ruleId: 'target-without-assignments',
        severity: 'warn' as const,
        message: `Target "Property ${String(index + 1).padStart(3, '0')}" has no assigned questions, so nothing will be measured for it.`,
        path: ['targets', index],
      })),
      {
        ruleId: 'target-url-matcher-invalid',
        severity: 'warn' as const,
        message: 'Target URL matcher is not a URL, a "/*" path prefix, or a hostname.',
        path: ['targets', 0, 'urlMatchers', 0],
      },
      {
        ruleId: 'target-url-matcher-unowned',
        severity: 'warn' as const,
        message: 'Target URL matcher host must be a project-owned host or its subdomain.',
        path: ['targets', 1, 'urlMatchers', 0],
      },
    ]
    const fake = createFakeService({
      initialDraft: draftFixture({ targets, assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
      compileChecks: repeatedChecks,
    })
    renderSection(fake)
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    expect(await screen.findByText('Choose a provider')).toBeTruthy()
    expect(screen.getByText('Choose at least one provider before publishing. 194 query assignments need a provider. Affected: Property 001 — event venues nearby, Property 002 — event venues nearby, Property 003 — event venues nearby, and 191 more.')).toBeTruthy()
    expect(screen.getByText('Add Property aliases')).toBeTruthy()
    expect(screen.getByText('Add a name or alias to measure mentions. 194 Properties need aliases. Affected: Property 001, Property 002, Property 003, and 191 more.')).toBeTruthy()
    expect(screen.getByText('Assign queries')).toBeTruthy()
    expect(screen.getByText('Assign at least one query to measure a Property. 194 Properties need queries. Affected: Property 001, Property 002, Property 003, and 191 more.')).toBeTruthy()
    expect(screen.getByText('Fix a Property URL')).toBeTruthy()
    expect(screen.getByText('Use a project domain')).toBeTruthy()
    expect(screen.getByText('Showing 5 of 5')).toBeTruthy()
    expect(document.body.textContent).not.toContain('An execution context must name at least one provider.')
    expect(document.body.textContent).not.toContain('Target URL matcher')
    expect(document.body.textContent).not.toMatch(/\b(?:target|edge|node|manifest|revision|checksum|stableKey)\b/i)
  })

  test('renders structured compile guidance for limits and an operator-named group', async () => {
    const initialDraft = draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 })
    initialDraft.authoring.groups = [{
      stableKey: 'group-target-stores',
      label: 'Target Stores',
      targetKeys: ['property-001'],
      competitors: [
        { stableKey: 'competitor-rival', label: 'rival.com', domain: 'rival.com', aliases: [] },
        { stableKey: 'competitor-rival-www', label: 'www.rival.com', domain: 'www.rival.com', aliases: [] },
      ],
    }]
    const fake = createFakeService({
      initialDraft,
      compileChecks: [
        {
          ruleId: 'target-limit-exceeded',
          severity: 'fail',
          message: 'A draft holds at most 1000 Targets.',
          path: ['targets'],
        },
        {
          ruleId: 'competitor-duplicate',
          severity: 'fail',
          message: 'Competitor is listed twice in group group-target-stores: rival.com',
          path: ['groups', 0, 'competitors', 1],
        },
      ],
    })
    renderSection(fake)
    await screen.findByRole('heading', { name: 'Properties' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Groups' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Queries' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { name: 'Review & publish' })

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    expect(await screen.findByText('Reduce Properties')).toBeTruthy()
    expect(screen.getByText('This setup exceeds the Properties publishing limit. Remove some Properties, then review again.')).toBeTruthy()
    expect(screen.getByText('Remove a duplicate competitor')).toBeTruthy()
    expect(screen.getByText('List each competitor domain only once in a group. Affected: Target Stores — www.rival.com.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Return to the earlier setup steps and review the affected Property or query.')
    expect(document.body.textContent).not.toContain('A draft holds at most 1000 Targets.')
    expect(document.body.textContent).not.toContain('Competitor is listed twice in group group-target-stores: rival.com')
  })

  test('gives every measurement compiler rule an operator-facing action', async () => {
    const targets = [property(1), property(2, 'excluded')]
    const initialDraft = draftFixture({ targets, assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 })
    initialDraft.authoring.groups = [{
      stableKey: 'group-waterfront',
      label: 'Waterfront venues',
      targetKeys: ['property-001', 'property-002', 'missing-property'],
      competitors: [
        { stableKey: 'competitor-rival', label: 'rival.com', domain: 'rival.com', aliases: [] },
        { stableKey: 'competitor-rival-www', label: 'www.rival.com', domain: 'www.rival.com', aliases: [] },
      ],
    }]
    const compilerRules: Array<readonly [string, string, readonly (string | number)[], 'fail' | 'warn']> = [
      ['invalid-project-identity', 'Fix the project domain', ['identities', 'projectBrand', 'canonicalHost'], 'fail'],
      ['target-limit-exceeded', 'Reduce Properties', ['targets'], 'fail'],
      ['duplicate-target-key', 'Resolve duplicate Properties', ['targets', 0, 'stableKey'], 'fail'],
      ['no-included-targets', 'Include a Property', ['targets'], 'fail'],
      ['target-url-matcher-invalid', 'Fix a Property URL', ['targets', 0, 'urlMatchers', 0], 'fail'],
      ['target-url-matcher-unowned', 'Use a project domain', ['targets', 0, 'urlMatchers', 0], 'fail'],
      ['target-url-matcher-ambiguous', 'Separate Property URL coverage', ['targets', 0, 'urlMatchers', 0], 'fail'],
      ['target-alias-ambiguous', 'Use distinct Property names', ['targets', 0, 'aliases', 0], 'fail'],
      ['target-without-aliases', 'Add Property aliases', ['targets', 0, 'aliases'], 'warn'],
      ['duplicate-group-key', 'Resolve duplicate groups', ['groups', 0, 'stableKey'], 'fail'],
      ['group-unknown-target', 'Fix group Properties', ['groups', 0, 'targetKeys', 2], 'fail'],
      ['group-excluded-target', 'Include or remove a grouped Property', ['groups', 0, 'targetKeys', 1], 'fail'],
      ['competitor-invalid-domain', 'Fix a competitor domain', ['groups', 0, 'competitors', 0, 'domain'], 'fail'],
      ['competitor-matches-project', 'Remove a project domain', ['groups', 0, 'competitors', 0, 'domain'], 'fail'],
      ['competitor-duplicate', 'Remove a duplicate competitor', ['groups', 0, 'competitors', 1], 'fail'],
      ['execution-context-no-provider', 'Choose a provider', ['assignments', 0, 'contextOverride', 'providers'], 'fail'],
      ['invalid-provider-model', 'Fix provider settings', ['assignments', 0, 'contextOverride', 'models', 'gemini'], 'fail'],
      ['invalid-location', 'Fix a location', ['assignments', 0, 'contextOverride', 'locations', 0], 'fail'],
      ['duplicate-assignment', 'Remove a duplicate query', ['assignments', 0], 'fail'],
      ['assignment-unknown-target', 'Fix a query assignment', ['assignments', 0, 'targetKey'], 'fail'],
      ['assignment-excluded-target', 'Include or unassign a Property', ['assignments', 0, 'targetKey'], 'fail'],
      ['assignment-unknown-query', 'Remove an unavailable query', ['assignments', 0, 'queryId'], 'fail'],
      ['assignment-unclassified', 'Classify a query', ['assignments', 0, 'queryClass'], 'fail'],
      ['query-limit-exceeded', 'Reduce queries', ['assignments'], 'fail'],
      ['target-without-assignments', 'Assign queries', ['targets', 0], 'warn'],
      ['invalid-compiled-plan', 'Fix setup details', ['targets', 0, 'label'], 'fail'],
      ['compiled-plan-too-large', 'Reduce setup size', [], 'fail'],
    ]
    const fake = createFakeService({
      initialDraft,
      compileChecks: compilerRules.map(([ruleId, _title, path, severity]) => ({
        ruleId,
        severity,
        message: `Internal Target compiler message for ${ruleId}`,
        path: [...path],
      })),
    })
    renderSection(fake)
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    await screen.findByText('Fix the project domain')
    fireEvent.click(screen.getByRole('button', { name: 'Show next 50 exceptions' }))

    for (const [, title] of compilerRules) expect(screen.getByText(title)).toBeTruthy()
    expect(document.body.textContent).not.toContain('Internal Target compiler message')
    expect(document.body.textContent).not.toContain('Return to the earlier setup steps and review the affected Property or query.')
  })

  test('shows inherited model and location values for a partial assignment override', async () => {
    const initialDraft = draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 })
    initialDraft.authoring.defaultContext = {
      providers: ['gemini'],
      models: { openai: 'gpt-default' },
      locations: ['Target Stores'],
    }
    initialDraft.authoring.assignments[0]!.contextOverride = { providers: ['gemini'] }
    const fake = createFakeService({
      initialDraft,
      compileChecks: [
        {
          ruleId: 'invalid-provider-model',
          severity: 'fail',
          message: 'Internal model error.',
          path: ['assignments', 0, 'contextOverride', 'models', 'openai'],
        },
        {
          ruleId: 'invalid-location',
          severity: 'fail',
          message: 'Internal location error.',
          path: ['assignments', 0, 'contextOverride', 'locations', 0],
        },
      ],
    })
    renderSection(fake)
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    expect(await screen.findByText('Fix provider settings')).toBeTruthy()
    expect(screen.getByText('Choose the provider that runs this model, or remove the model setting. Affected: Property 001 — event venues nearby — gpt-default.')).toBeTruthy()
    expect(screen.getByText('Fix a location')).toBeTruthy()
    expect(screen.getByText('Choose a location configured for this project, or remove it from the query. Affected: Property 001 — event venues nearby — Target Stores.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Internal model error.')
    expect(document.body.textContent).not.toContain('Internal location error.')
  })

  test('makes an unknown compiler failure explicit and actionable', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
      compileChecks: [{
        ruleId: 'future-validation-check',
        severity: 'fail',
        message: 'Target compiler validation failed.',
        path: ['targets', 0],
      }],
    })
    renderSection(fake)
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    expect(await screen.findByText('An unexpected setup issue blocks publishing')).toBeTruthy()
    expect(screen.getByText('Review the affected item, make a correction, and review again. If it remains blocked, contact support. Affected: Property 001.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Target compiler validation failed.')
  })

  test('explains that existing results remain available when updating an older setup', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
      diffChecks: [{
        ruleId: 'active-revision-schema-v1',
        severity: 'warn',
        message: 'Active revision 4 is schema v1, which has no assignment model. Everything below reads as added.',
        path: [],
      }],
    })
    renderSection(fake)
    await advanceExistingDraftToReview()

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))

    expect(await screen.findByText('Historical results will be kept')).toBeTruthy()
    expect(screen.getByText('Existing results remain visible after you publish this setup.')).toBeTruthy()
    expect(screen.getByText('Historical results will be kept').closest('section')?.textContent).not.toContain('Needs attention')
    expect(document.body.textContent).not.toContain('Return to the earlier setup steps')
    expect(document.body.textContent).not.toMatch(/\b(?:target|edge|node|manifest|revision|checksum|stableKey)\b/i)
  })

  test('turns a publish revision conflict into an explicit restart path', async () => {
    const fake = createFakeService({
      initialDraft: draftFixture({ targets: [property(1)], assignedQueryIds: ['q-nearby'], baseActiveRevision: 4 }),
      publishConflictRevision: 5,
    })
    renderSection(fake)
    await advanceExistingDraftToReview()
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Publish setup' }))

    expect(await screen.findByText('This draft is based on an older published setup.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Discard draft and restart' })).toBeTruthy()
    expect(fake.service.publish).toHaveBeenCalledTimes(1)
  })

  test('discards the server draft only after explicit confirmation', async () => {
    const fake = createFakeService({ initialDraft: draftFixture() })
    renderSection(fake)
    await screen.findByRole('heading', { name: 'Import Properties' })

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(fake.service.discard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard unpublished changes' }))

    await waitFor(() => expect(fake.service.discard).toHaveBeenCalledTimes(1))
    expect(fake.service.discard).toHaveBeenCalledWith(PROJECT, '"mpd_7"')
    expect(fake.getDraft()).toBeNull()
  })

  test('recovers when another session already discarded the draft', async () => {
    const fake = createFakeService({ initialDraft: draftFixture(), discardConflictStatus: 404 })
    renderSection(fake)
    await screen.findByRole('heading', { name: 'Import Properties' })

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard unpublished changes' }))

    await waitFor(() => expect(fake.service.discard).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(fake.service.loadDraft).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Start setup from the project Overview.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Measurement plan draft')
  })
})

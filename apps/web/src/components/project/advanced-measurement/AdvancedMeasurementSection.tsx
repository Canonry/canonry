import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeQueryText } from '@ainyc/canonry-contracts'
import { extractErrorMessage } from '../../../lib/extract-error-message.js'
import type {
  MeasurementDraftAuthoring,
  MeasurementDraftCompileCheck,
  MeasurementDraftDiff,
  MeasurementDraftReplaceQueryResponse,
  MeasurementDraftResponse,
  MeasurementDraftWarning,
  MeasurementSetupResponse,
} from '@ainyc/canonry-contracts'
import type { QueryDto } from '@ainyc/canonry-api-client'
import type { MeasurementPlanResponse } from '@ainyc/canonry-api-client'

import { Button } from '../../ui/button.js'
import { AdvancedMeasurementSetup } from './AdvancedMeasurementSetup.js'
import type {
  AdvancedMeasurementImportDraft,
  AdvancedMeasurementProperty as ImportProperty,
  AdvancedMeasurementReviewState,
} from './SetupImportProperties.js'
import type {
  AdvancedMeasurementFlaggedException,
  AdvancedMeasurementAudience,
  AdvancedMeasurementAssignmentImpact,
  AdvancedMeasurementGroup,
  AdvancedMeasurementGroupDraft,
  AdvancedMeasurementProperty as SetupProperty,
  AdvancedMeasurementQuery,
} from './SetupQueriesGroupsReview.js'
import {
  advancedMeasurementService,
  assignmentPreviewErrorMessage,
  createMeasurementDraftIdempotencyKey,
  isDraftConflict,
  setupErrorMessage,
  type AdvancedMeasurementService,
  type GroupMembershipPreview,
  type MeasurementAudienceAssignmentInput,
  type MeasurementAudienceAssignmentPreview,
  type SitemapImportInput,
} from './service.js'

type SetupStep = 'import' | 'properties' | 'groups' | 'queries' | 'review'
type Draft = NonNullable<MeasurementDraftResponse['draft']>
type DraftTarget = MeasurementDraftAuthoring['targets'][number]
type PendingQueryReplacement = Pick<MeasurementDraftReplaceQueryResponse, 'previousQueryId' | 'replacementQuery'>

interface ReviewedSetup {
  etag: string
  baseActiveRevision: number | null
  compiledChecksum: string
  changes: { title: string; items: string[] }
  providerCalls: number
}

interface PendingQueryReplacementIntent {
  sourceQueryId: string
  queryText: string
  idempotencyKey: string
}

export interface AdvancedMeasurementSectionProps {
  projectName: string
  queries: readonly QueryDto[]
  isQueryLoading: boolean
  isQueryError: boolean
  onRetryQueries?: () => void
  publishedPlan?: MeasurementPlanResponse['active']
  canEdit?: boolean
  /** Explicit query-workspace handoff; never bypass Property confirmation. */
  initialStep?: 'queries'
  initialQueryId?: string
  /** Adds tracked queries to the project from inside setup. */
  /** Returns the project's queries AFTER the write, so a pairing can resolve text -> id. */
  onCreateQueries?: (texts: readonly string[]) => Promise<readonly { id: string; query: string }[]>
  onManageProjectQueries?: () => void
  onPublished?: () => void
  service?: AdvancedMeasurementService
}

const DEFAULT_IMPORT_DRAFT: AdvancedMeasurementImportDraft = {
  sitemapUrl: '',
  examplePropertyUrl: '',
  preferredHost: '',
  propertyPathPattern: '',
  additionalHost: '',
  additionalPathPattern: '',
  excludedPaths: '',
}
const DEFAULT_GROUP_DRAFT: AdvancedMeasurementGroupDraft = {
  name: '',
  propertyIds: [],
  competitorDomains: '',
}
const DEFAULT_VISIBLE_PROPERTIES = 50

function normalizedHost(value: string): string | null {
  const candidate = value.trim()
  if (!candidate) return null
  try {
    return new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname.toLocaleLowerCase()
  } catch {
    return null
  }
}

function normalizedSitemapUrl(value: string): string {
  const candidate = value.trim()
  if (!candidate) throw new Error('Add a sitemap URL.')
  let parsed: URL
  try {
    parsed = new URL(candidate.includes('://') ? candidate : `https://${candidate}`)
  } catch {
    throw new Error('Sitemap URL must be a valid web address.')
  }
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/sitemap.xml'
  return parsed.toString()
}

function pathTemplateFor(draft: AdvancedMeasurementImportDraft): string {
  const supplied = draft.propertyPathPattern.trim()
  if (supplied) {
    const value = supplied.startsWith('/') ? supplied : `/${supplied}`
    const segments = value.split('/').slice(1)
    const placeholders = segments.filter(segment => segment === '*' || segment === '{slug}')
    if (placeholders.length !== 1 || segments.some(segment => segment.includes('*') && segment !== '*')) {
      throw new Error('Property URL pattern must contain exactly one * or {slug} segment.')
    }
    return `/${segments.map(segment => segment === '*' ? '{slug}' : segment).join('/')}`
  }

  const example = draft.examplePropertyUrl.trim()
  if (!example) throw new Error('Add one example Property page so Canonry can identify the matching URLs.')
  try {
    const segments = new URL(example).pathname.split('/').filter(Boolean)
    if (segments.length === 0) throw new Error()
    segments[segments.length - 1] = '{slug}'
    return `/${segments.join('/')}`
  } catch {
    throw new Error('Example Property page must be a valid web address.')
  }
}

function excludedSlugPatterns(value: string): NonNullable<SitemapImportInput['rule']['excludedSlugPatterns']> {
  const patterns: NonNullable<SitemapImportInput['rule']['excludedSlugPatterns']> = []
  const seen = new Set<string>()
  for (const entry of value.split(/[\n,]+/)) {
    const trimmed = entry.trim().replace(/\/+$/, '')
    if (!trimmed) continue
    const pieces = trimmed.split('/').filter(Boolean)
    const candidate = pieces.at(-1) ?? trimmed
    const beginsWithWildcard = candidate.startsWith('*')
    const endsWithWildcard = candidate.endsWith('*')
    const patternValue = candidate.slice(beginsWithWildcard ? 1 : 0, endsWithWildcard ? -1 : undefined).trim()
    if (!patternValue) throw new Error('Ignored URL patterns must include text besides *.')
    const kind = beginsWithWildcard && endsWithWildcard
      ? 'contains' as const
      : beginsWithWildcard
        ? 'suffix' as const
        : endsWithWildcard
          ? 'prefix' as const
          : 'exact' as const
    const key = `${kind}:${patternValue}`
    if (seen.has(key)) continue
    seen.add(key)
    patterns.push({ kind, value: patternValue })
  }
  return patterns
}

export function sitemapImportInput(draft: AdvancedMeasurementImportDraft): SitemapImportInput {
  const sitemapUrl = normalizedSitemapUrl(draft.sitemapUrl)
  const exampleHost = draft.examplePropertyUrl.trim() ? normalizedHost(draft.examplePropertyUrl) : null
  const host = normalizedHost(draft.preferredHost) ?? exampleHost ?? normalizedHost(sitemapUrl)
  if (!host) throw new Error('Add a valid sitemap or Property page URL.')

  const additionalHost = normalizedHost(draft.additionalHost)
  const hasAdditionalHost = draft.additionalHost.trim().length > 0
  const hasAdditionalPath = draft.additionalPathPattern.trim().length > 0
  if (hasAdditionalHost !== hasAdditionalPath || (hasAdditionalHost && !additionalHost)) {
    throw new Error('Add both an additional domain and its Property URL pattern.')
  }

  const excluded = excludedSlugPatterns(draft.excludedPaths)
  return {
    sitemapUrl,
    rule: {
      primary: { host, pathTemplate: pathTemplateFor(draft) },
      ...(additionalHost ? {
        aliases: [{
          host: additionalHost,
          pathTemplate: pathTemplateFor({
            ...draft,
            examplePropertyUrl: '',
            propertyPathPattern: draft.additionalPathPattern,
          }),
        }],
      } : {}),
      ...(excluded.length > 0 ? { excludedSlugPatterns: excluded } : {}),
    },
  }
}

function initialStepFor(draft: Draft | null): SetupStep {
  if (!draft || draft.authoring.targets.length === 0) return 'import'
  if (draft.authoring.targets.some(target => target.status === 'proposed')) return 'properties'
  if (draft.authoring.assignments.length === 0) return 'groups'
  return draft.baseActiveRevision === null ? 'review' : 'properties'
}

function recoveredStepFor(draft: Draft | null, current: SetupStep): SetupStep {
  if (!draft || draft.authoring.targets.length === 0) return 'import'
  if (!draft.authoring.targets.some(target => target.status !== 'excluded')) return 'properties'
  if (draft.authoring.targets.some(target => target.status === 'proposed')) return 'properties'
  if (draft.authoring.assignments.length === 0 && current === 'review') return 'groups'
  return current
}

function propertyUrls(target: DraftTarget): string[] {
  return [...new Set([
    ...(target.discoveredUrl ? [target.discoveredUrl] : []),
    ...target.urlMatchers,
  ])]
}

function propertyState(status: DraftTarget['status']): ImportProperty['state'] {
  if (status === 'included') return 'confirmed'
  if (status === 'excluded') return 'excluded'
  return 'proposed'
}

function includedPropertyIdsFor(draft: Draft | null | undefined): string[] {
  return draft?.authoring.targets
    .filter(target => target.status !== 'excluded')
    .map(target => target.stableKey) ?? []
}

function stableKey(value: string, prefix: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${prefix}-${normalized || 'item'}`.slice(0, 128)
}

function normalizedDomain(value: string): string | null {
  return normalizedHost(value)
}

interface ReviewCheckMeaning {
  title: string
  detail: string
  tone: AdvancedMeasurementFlaggedException['tone']
  affected?: string
}

interface ReviewCheckContext {
  authoring: MeasurementDraftAuthoring | null | undefined
  queries: readonly QueryDto[]
}

function targetAtPath(authoring: MeasurementDraftAuthoring | null | undefined, path: readonly (string | number)[]): DraftTarget | undefined {
  if (path[0] !== 'targets') return undefined
  const reference = path[1]
  if (typeof reference === 'number') return authoring?.targets[reference]
  if (typeof reference === 'string') return authoring?.targets.find(target => target.stableKey === reference)
  return undefined
}

function groupAtPath(authoring: MeasurementDraftAuthoring | null | undefined, path: readonly (string | number)[]) {
  if (path[0] !== 'groups') return undefined
  const reference = path[1]
  if (typeof reference === 'number') return authoring?.groups[reference]
  if (typeof reference === 'string') return authoring?.groups.find(group => group.stableKey === reference)
  return undefined
}

function assignmentAtPath(authoring: MeasurementDraftAuthoring | null | undefined, path: readonly (string | number)[]) {
  return path[0] === 'assignments' && typeof path[1] === 'number' ? authoring?.assignments[path[1]] : undefined
}

function propertyLabel(authoring: MeasurementDraftAuthoring | null | undefined, propertyId: string | undefined): string {
  return authoring?.targets.find(property => property.stableKey === propertyId)?.label ?? 'a Property'
}

function targetLocation(context: ReviewCheckContext, check: MeasurementDraftCompileCheck): string | undefined {
  const property = targetAtPath(context.authoring, check.path)
  if (!property) return undefined
  const field = check.path[2]
  const index = check.path[3]
  if (field === 'urlMatchers' && typeof index === 'number') {
    const url = property.urlMatchers[index]
    return url ? `${property.label} — ${url}` : property.label
  }
  if (field === 'aliases' && typeof index === 'number') {
    const alias = property.aliases[index]
    return alias ? `${property.label} — ${alias}` : property.label
  }
  return property.label
}

function groupLocation(context: ReviewCheckContext, check: MeasurementDraftCompileCheck): string | undefined {
  const group = groupAtPath(context.authoring, check.path)
  if (!group) return undefined
  const field = check.path[2]
  const index = check.path[3]
  if (field === 'competitors' && typeof index === 'number') {
    const domain = group.competitors.at(index)?.domain
    return domain ? `${group.label} — ${domain}` : group.label
  }
  if (field === 'targetKeys' && typeof index === 'number') {
    const property = propertyLabel(context.authoring, group.targetKeys[index])
    return `${group.label} — ${property}`
  }
  return group.label
}

function assignmentLocation(context: ReviewCheckContext, check: MeasurementDraftCompileCheck): string | undefined {
  const assignment = assignmentAtPath(context.authoring, check.path)
  if (!assignment) return undefined
  const question = context.queries.find(candidate => candidate.id === assignment.queryId)?.query ?? 'an unavailable query'
  return `${propertyLabel(context.authoring, assignment.targetKey)} — ${question}`
}

function locationFromPath(context: ReviewCheckContext, check: MeasurementDraftCompileCheck): string | undefined {
  if (check.path[0] === 'identities') return 'Project domain'
  return targetLocation(context, check) ?? groupLocation(context, check) ?? assignmentLocation(context, check)
}

function contextValue(context: ReviewCheckContext, check: MeasurementDraftCompileCheck, field: 'models' | 'locations'): string | undefined {
  const assignment = assignmentAtPath(context.authoring, check.path)
  if (!assignment) return undefined
  const resolved = {
    ...context.authoring?.defaultContext,
    ...assignment.contextOverride,
  }
  const index = check.path.at(-1)
  if (field === 'models' && typeof index === 'string') return resolved.models?.[index]
  if (field === 'locations' && typeof index === 'number') return resolved.locations?.[index]
  return undefined
}

function reviewCheckMeaning(check: MeasurementDraftCompileCheck, context: ReviewCheckContext): ReviewCheckMeaning {
  const affected = locationFromPath(context, check)
  switch (check.ruleId) {
    case 'invalid-project-identity':
      return {
        title: 'Fix the project domain',
        detail: 'The project domain is not valid. Update it in project settings, then review again.',
        tone: 'negative',
        affected,
      }
    case 'target-limit-exceeded':
      return {
        title: 'Reduce Properties',
        detail: 'This setup exceeds the Properties publishing limit. Remove some Properties, then review again.',
        tone: 'negative',
      }
    case 'duplicate-target-key':
      return {
        title: 'Resolve duplicate Properties',
        detail: 'Two Properties use the same setup identifier. Rename or recreate one, then review again.',
        tone: 'negative',
        affected,
      }
    case 'no-included-targets':
      return {
        title: 'Include a Property',
        detail: 'Include at least one Property before publishing.',
        tone: 'negative',
      }
    case 'target-url-matcher-invalid':
      return {
        title: 'Fix a Property URL',
        detail: 'Use a valid web address, site-wide address, or URL pattern for this Property.',
        tone: 'negative',
        affected,
      }
    case 'target-url-matcher-unowned':
      return {
        title: 'Use a project domain',
        detail: 'This Property URL must use the project domain or one of its subdomains.',
        tone: 'negative',
        affected,
      }
    case 'target-url-matcher-ambiguous':
      return {
        title: 'Separate Property URL coverage',
        detail: 'This URL is assigned to more than one Property at the same specificity. Update one of the URLs.',
        tone: 'negative',
        affected,
      }
    case 'target-alias-ambiguous':
      return {
        title: 'Use distinct Property names',
        detail: 'This name or alias matches another Property. Make each Property name and alias distinct.',
        tone: 'negative',
        affected,
      }
    case 'execution-context-no-provider':
      return {
        title: 'Choose a provider',
        detail: 'Choose at least one provider before publishing.',
        tone: 'negative',
        affected,
      }
    case 'invalid-provider-model':
      return {
        title: 'Fix provider settings',
        detail: 'Choose the provider that runs this model, or remove the model setting.',
        tone: 'negative',
        affected: [affected, contextValue(context, check, 'models')].filter(Boolean).join(' — ') || undefined,
      }
    case 'invalid-location':
      return {
        title: 'Fix a location',
        detail: 'Choose a location configured for this project, or remove it from the query.',
        tone: 'negative',
        affected: [affected, contextValue(context, check, 'locations')].filter(Boolean).join(' — ') || undefined,
      }
    case 'target-without-aliases':
      return {
        title: 'Add Property aliases',
        detail: 'Add a name or alias to measure mentions.',
        tone: 'caution',
        affected,
      }
    case 'duplicate-group-key':
      return {
        title: 'Resolve duplicate groups',
        detail: 'Two groups use the same setup identifier. Rename one group, then review again.',
        tone: 'negative',
        affected,
      }
    case 'group-unknown-target':
      return {
        title: 'Fix group Properties',
        detail: 'This group contains a Property that is no longer in setup. Remove it or add the Property back.',
        tone: 'negative',
        affected,
      }
    case 'group-excluded-target':
      return {
        title: 'Include or remove a grouped Property',
        detail: 'This group contains an excluded Property. Include it or remove it from the group.',
        tone: 'negative',
        affected,
      }
    case 'competitor-invalid-domain':
      return {
        title: 'Fix a competitor domain',
        detail: 'Enter a valid competitor domain.',
        tone: 'negative',
        affected,
      }
    case 'competitor-matches-project':
      return {
        title: 'Remove a project domain',
        detail: 'A competitor cannot use the project domain.',
        tone: 'negative',
        affected,
      }
    case 'competitor-duplicate':
      return {
        title: 'Remove a duplicate competitor',
        detail: 'List each competitor domain only once in a group.',
        tone: 'negative',
        affected,
      }
    case 'duplicate-assignment':
      return {
        title: 'Remove a duplicate query',
        detail: 'Assign each query to a Property only once.',
        tone: 'negative',
        affected,
      }
    case 'assignment-unknown-target':
      return {
        title: 'Fix a query assignment',
        detail: 'This query is assigned to a Property that is no longer in setup. Remove the assignment or add the Property back.',
        tone: 'negative',
        affected,
      }
    case 'assignment-excluded-target':
      return {
        title: 'Include or unassign a Property',
        detail: 'This query is assigned to an excluded Property. Include it or remove the assignment.',
        tone: 'negative',
        affected,
      }
    case 'assignment-unknown-query':
      return {
        title: 'Remove an unavailable query',
        detail: 'This assignment refers to a tracked query that is no longer available. Remove it or add the query back to the project.',
        tone: 'negative',
        affected,
      }
    case 'assignment-unclassified':
      return {
        title: 'Classify a query',
        detail: 'Choose Branded or Non-brand for this query before publishing.',
        tone: 'negative',
        affected,
      }
    case 'query-limit-exceeded':
      return {
        title: 'Reduce queries',
        detail: 'This setup exceeds the distinct-query publishing limit. Remove some query assignments, then review again.',
        tone: 'negative',
      }
    case 'target-without-assignments':
      return {
        title: 'Assign queries',
        detail: 'Assign at least one query to measure a Property.',
        tone: 'caution',
        affected,
      }
    case 'invalid-compiled-plan':
      return {
        title: 'Fix setup details',
        detail: 'A setup value could not be validated. Review the affected item, then review again.',
        tone: 'negative',
        affected,
      }
    case 'compiled-plan-too-large':
      return {
        title: 'Reduce setup size',
        detail: 'This setup is too large to publish. Remove Properties, queries, or groups, then review again.',
        tone: 'negative',
      }
    case 'active-revision-schema-v1':
      return {
        title: 'Historical results will be kept',
        detail: 'Existing results remain visible after you publish this setup.',
        tone: 'neutral',
      }
  }
  return {
    title: check.severity === 'fail' ? 'An unexpected setup issue blocks publishing' : 'An unexpected setup issue needs review',
    detail: check.severity === 'fail'
      ? 'Review the affected item, make a correction, and review again. If it remains blocked, contact support.'
      : 'Review the affected item before publishing. If it remains, contact support.',
    tone: check.severity === 'fail' ? 'negative' : 'caution',
    affected,
  }
}

function pluralized(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function affectedItems(items: Iterable<string>): string {
  const uniqueItems = [...new Set(items)]
  if (uniqueItems.length === 0) return ''
  if (uniqueItems.length === 1) return ` Affected: ${uniqueItems[0]}.`
  if (uniqueItems.length <= 3) return ` Affected: ${uniqueItems.join(', ')}.`
  return ` Affected: ${uniqueItems.slice(0, 3).join(', ')}, and ${uniqueItems.length - 3} more.`
}

function reviewCheckDetail(ruleId: string, detail: string, count: number, affected: Iterable<string>): string {
  const detailWithCount = (() => {
  switch (ruleId) {
    case 'execution-context-no-provider':
      return `${detail} ${pluralized(count, 'query assignment')} need${count === 1 ? 's' : ''} a provider.`
    case 'target-without-aliases':
      return `${detail} ${pluralized(count, 'Property', 'Properties')} need${count === 1 ? 's' : ''} aliases.`
    case 'target-without-assignments':
      return `${detail} ${pluralized(count, 'Property', 'Properties')} need${count === 1 ? 's' : ''} queries.`
    default:
      return count > 1 ? `${detail} ${pluralized(count, 'item')} need review.` : detail
  }
  })()
  return `${detailWithCount}${affectedItems(affected)}`
}

function reviewCheckFlags(checks: readonly MeasurementDraftCompileCheck[], context: ReviewCheckContext): AdvancedMeasurementFlaggedException[] {
  const grouped = new Map<string, {
    ruleId: string
    severity: MeasurementDraftCompileCheck['severity']
    meaning: ReviewCheckMeaning
    paths: Set<string>
    affected: Set<string>
  }>()

  for (const check of checks) {
    const meaning = reviewCheckMeaning(check, context)
    const key = [check.ruleId, check.severity, meaning.title, meaning.detail].join('\u0000')
    const group = grouped.get(key) ?? {
      ruleId: check.ruleId,
      severity: check.severity,
      meaning,
      paths: new Set<string>(),
      affected: new Set<string>(),
    }
    group.paths.add(JSON.stringify(check.path))
    if (meaning.affected) group.affected.add(meaning.affected)
    grouped.set(key, group)
  }

  return [...grouped.values()].map((group, index) => ({
    id: `${group.ruleId}-${group.severity}-${index}`,
    title: group.meaning.title,
    detail: reviewCheckDetail(group.ruleId, group.meaning.detail, group.paths.size, group.affected),
    tone: group.meaning.tone,
  }))
}

function propertySummary(target: DraftTarget | undefined): string | undefined {
  if (!target) return undefined
  const url = target.discoveredUrl ?? target.urlMatchers[0]
  return url ? `${target.label} — ${url}` : target.label
}

function warningFlag(
  warning: MeasurementDraftWarning,
  index: number,
  authoring: MeasurementDraftAuthoring | null | undefined,
): AdvancedMeasurementFlaggedException {
  const target = targetAtPath(authoring, warning.path)
  const group = groupAtPath(authoring, warning.path)
  const linkedTargetKey = warning.path[2] === 'rebind' && typeof warning.path[3] === 'string' ? warning.path[3] : undefined
  const linkedTarget = linkedTargetKey
    ? authoring?.targets.find(candidate => candidate.stableKey === linkedTargetKey)
    : undefined
  const affected = target?.label ?? group?.label
  const suffix = affectedItems(affected ? [affected] : [])
  const base = { id: `${warning.code}-${index}`, tone: 'caution' as const }

  switch (warning.code) {
    case 'merge-targets-noop':
      return {
        ...base,
        title: 'Choose another Property to merge',
        detail: `Select at least one other Property before merging.${suffix}`,
      }
    case 'excluded-target-has-assignments':
      return {
        ...base,
        title: 'Review excluded Property queries',
        detail: `An excluded Property still has assigned queries. Include it or remove those queries before publishing.${suffix}`,
      }
    case 'group-unknown-target':
      return {
        ...base,
        title: 'Fix group Properties',
        detail: `This group includes a Property that is not in setup. Remove it or add the Property first.${suffix}`,
      }
    case 'measurement.discovery.proposed_new_target': {
      const subject = propertySummary(target) ?? 'the proposed Property'
      return {
        ...base,
        title: 'Review a new Property',
        detail: `Review ${subject}. It did not match an existing Property.`,
      }
    }
    case 'measurement.discovery.proposed_rebind': {
      const subject = propertySummary(target) ?? 'the proposed Property'
      const existing = linkedTarget?.label ?? 'an existing Property'
      return {
        ...base,
        title: 'Review a moved Property',
        detail: `Review ${subject}. It may be the same Property as ${existing}.`,
      }
    }
    case 'measurement.discovery.rebind_ambiguous': {
      const subject = propertySummary(target) ?? 'the proposed Property'
      const existing = linkedTarget?.label ?? 'an existing Property'
      return {
        ...base,
        title: 'Choose an existing Property',
        detail: `Review ${subject}. It may match ${existing}; choose the correct Property.`,
      }
    }
    default:
      return {
        ...base,
        title: 'Unexpected setup warning',
        detail: 'Review the latest setup change before publishing. If this warning remains, contact support.',
      }
  }
}

function reviewedChanges(diff: MeasurementDraftDiff, preservesHistoricalResults = false): ReviewedSetup['changes'] {
  const items: string[] = []
  const targetChanges = diff.targets.added.length + diff.targets.removed.length + diff.targets.changed.length
  const groupChanges = diff.groups.added.length + diff.groups.removed.length + diff.groups.changed.length
  const assignmentChanges = diff.assignments.added + diff.assignments.removed + diff.assignments.reclassified
  if (targetChanges > 0) items.push(`${targetChanges} Property ${targetChanges === 1 ? 'change' : 'changes'}`)
  if (assignmentChanges > 0) items.push(`${assignmentChanges} query assignment ${assignmentChanges === 1 ? 'change' : 'changes'}`)
  if (groupChanges > 0) items.push(`${groupChanges} group ${groupChanges === 1 ? 'change' : 'changes'}`)
  if (preservesHistoricalResults) items.unshift('Existing results remain visible after you publish this setup.')
  return {
    title: preservesHistoricalResults
      ? 'Historical results will be kept'
      : diff.activeRevision === null ? 'New setup ready' : 'Changes ready',
    items: items.length > 0 ? items : ['No changes from the published setup.'],
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function uniqueSorted(values: readonly string[]): string[] {
  return unique(values).sort()
}

function assignmentInputFor(
  audience: AdvancedMeasurementAudience,
  allTargetKeys: readonly string[],
  queryIds: readonly string[],
): MeasurementAudienceAssignmentInput {
  if (audience.kind === 'groups') {
    return { groupKeys: uniqueSorted(audience.groupIds), queryIds: uniqueSorted(queryIds) }
  }
  return {
    targetKeys: uniqueSorted(audience.kind === 'all' ? allTargetKeys : audience.propertyIds),
    queryIds: uniqueSorted(queryIds),
  }
}

function assignmentImpactFor(preview: MeasurementAudienceAssignmentPreview): AdvancedMeasurementAssignmentImpact {
  return {
    assignmentCount: preview.assignments.requested,
    addedAssignments: preview.assignments.added,
    alreadyPresentAssignments: preview.assignments.alreadyPresent,
    resolvedPropertyCount: preview.resolvedTargetKeys.length,
    overlapCount: preview.overlapCount,
    addedProviderCalls: preview.execution.addedProviderCalls,
    fullRunProviderCalls: preview.execution.fullRunProviderCalls,
  }
}

function matcherString(matcher: {
  kind: 'exact' | 'prefix' | 'host'
  url?: string
  host?: string
  pathPrefix?: string
}): string {
  if (matcher.kind === 'exact') return matcher.url ?? ''
  if (matcher.kind === 'prefix') return `https://${matcher.host ?? ''}${matcher.pathPrefix === '/' ? '' : matcher.pathPrefix ?? ''}/*`
  return matcher.host ?? ''
}

function publishedAuthoring(active: NonNullable<MeasurementPlanResponse['active']>): MeasurementDraftAuthoring {
  const plan = active.plan
  if (plan.schemaVersion === 2) {
    return {
      defaultContext: { providers: [], locations: [] },
      targets: plan.targets.map(target => ({
        stableKey: target.stableKey,
        label: target.label,
        status: 'included',
        aliases: [...target.aliases],
        urlMatchers: target.urlMatchers.map(matcherString).filter(Boolean),
        source: target.discoveryIdentity ? 'sitemap' : 'manual',
        ...(target.discoveryIdentity ? { discoveryIdentity: target.discoveryIdentity } : {}),
      })),
      assignments: plan.assignments.map(assignment => ({
        targetKey: assignment.targetKey,
        queryId: assignment.queryId,
        queryClass: assignment.queryClass,
        classificationSource: 'operator',
      })),
      groups: plan.groups.map(group => ({
        stableKey: group.stableKey,
        label: group.label,
        targetKeys: [...group.targetKeys],
        competitors: group.competitors.map(competitor => ({ ...competitor, aliases: [...competitor.aliases] })),
      })),
    }
  }

  const assignments = plan.targetQuerySelections.flatMap(selection => selection.queryIds.map(queryId => ({
    targetKey: selection.targetKey,
    queryId,
    queryClass: 'unclassified' as const,
    classificationSource: 'rule' as const,
  })))
  return {
    defaultContext: { providers: [], locations: [] },
    targets: plan.targets.map(target => ({
      stableKey: target.stableKey,
      label: target.label,
      status: 'included',
      aliases: [...target.aliases],
      urlMatchers: target.urls.map(matcherString).filter(Boolean),
      source: 'manual',
    })),
    assignments,
    groups: plan.groups.map(group => ({
      stableKey: group.stableKey,
      label: group.label,
      targetKeys: [...group.targetKeys],
      competitors: (group.competitors ?? []).map(domain => ({
        stableKey: stableKey(domain, 'competitor'),
        label: domain,
        domain,
        aliases: [],
      })),
    })),
  }
}

export function AdvancedMeasurementSection({
  projectName,
  queries,
  isQueryLoading,
  isQueryError,
  onRetryQueries,
  publishedPlan,
  canEdit = true,
  initialStep,
  initialQueryId,
  onCreateQueries,
  onManageProjectQueries,
  onPublished,
  service = advancedMeasurementService,
}: AdvancedMeasurementSectionProps) {
  const [setup, setSetup] = useState<MeasurementSetupResponse | null>(null)
  const [draftResponse, setDraftResponse] = useState<MeasurementDraftResponse | null>(null)
  const [step, setStep] = useState<SetupStep>('import')
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [serverFlags, setServerFlags] = useState<AdvancedMeasurementFlaggedException[]>([])
  const [importDraft, setImportDraft] = useState<AdvancedMeasurementImportDraft>({ ...DEFAULT_IMPORT_DRAFT })
  const [reviewState, setReviewState] = useState<AdvancedMeasurementReviewState>('idle')
  const [propertiesSearch, setPropertiesSearch] = useState('')
  const [maxVisibleProperties, setMaxVisibleProperties] = useState(DEFAULT_VISIBLE_PROPERTIES)
  const [includedPropertyIds, setIncludedPropertyIds] = useState<string[]>([])
  const [selectedQueryIds, setSelectedQueryIds] = useState<string[]>([])
  const [editingQueryId, setEditingQueryId] = useState<string | null>(initialQueryId ?? null)
  const [editingQueryText, setEditingQueryText] = useState<string | null>(null)
  const [pendingQueryReplacements, setPendingQueryReplacements] = useState<PendingQueryReplacement[]>([])
  const [audience, setAudience] = useState<AdvancedMeasurementAudience>({ kind: 'all' })
  const [assignmentPreview, setAssignmentPreview] = useState<MeasurementAudienceAssignmentPreview | null>(null)
  const [assignmentPreviewSelectionKey, setAssignmentPreviewSelectionKey] = useState<string | null>(null)
  const [isPreviewingAssignment, setIsPreviewingAssignment] = useState(false)
  const [assignmentPreviewError, setAssignmentPreviewError] = useState<string | null>(null)
  const [assignmentPreviewRetry, setAssignmentPreviewRetry] = useState(0)
  const [assignmentNotice, setAssignmentNotice] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState<AdvancedMeasurementGroupDraft>({ ...DEFAULT_GROUP_DRAFT })
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupMembershipCsv, setGroupMembershipCsv] = useState('')
  const [groupMembershipPreview, setGroupMembershipPreview] = useState<GroupMembershipPreview | null>(null)
  const [isReviewingGroupMembership, setIsReviewingGroupMembership] = useState(false)
  const [isApplyingGroupMembership, setIsApplyingGroupMembership] = useState(false)
  const [groupMembershipError, setGroupMembershipError] = useState<string | null>(null)
  const [groupMembershipNotice, setGroupMembershipNotice] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [createQueriesError, setCreateQueriesError] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<ReviewedSetup | null>(null)
  const requestVersionRef = useRef(0)
  const assignmentPreviewVersionRef = useRef(0)
  // State updates make the visible button disabled, while this ref closes the
  // same-render double-click window before React has committed that update.
  const queryReplacementInFlightRef = useRef(false)
  // A transport failure can happen after the server committed. Keep the same
  // key for exactly the same source/text intent so the receipt can replay even
  // though the browser's ETag is now stale.
  const pendingQueryReplacementIntentRef = useRef<PendingQueryReplacementIntent | null>(null)

  const draft = draftResponse?.draft ?? null
  const etag = draftResponse?.etag ?? null
  const publishedDraftView = useMemo(() => (
    !canEdit && publishedPlan
      ? { baseActiveRevision: publishedPlan.revision, authoring: publishedAuthoring(publishedPlan) }
      : null
  ), [canEdit, publishedPlan])
  const viewDraft = draft ?? publishedDraftView
  const catalogQueries = useMemo<QueryDto[]>(() => {
    const currentIds = new Set(queries.map(query => query.id))
    return [
      ...queries,
      ...pendingQueryReplacements
        .map(replacement => replacement.replacementQuery)
        .filter(query => !currentIds.has(query.id)),
    ]
  }, [pendingQueryReplacements, queries])

  async function loadCurrent(createIfMissing: boolean): Promise<void> {
    const requestVersion = ++requestVersionRef.current
    setIsLoading(true)
    setLoadError(null)
    try {
      let [nextSetup, nextDraft] = await Promise.all([
        service.loadSetup(projectName),
        service.loadDraft(projectName),
      ])
      if (!nextDraft.draft && createIfMissing && canEdit) {
        await service.createDraft(projectName, nextSetup.activeRevision)
        ;[nextSetup, nextDraft] = await Promise.all([
          service.loadSetup(projectName),
          service.loadDraft(projectName),
        ])
      }
      if (requestVersion !== requestVersionRef.current) return
      setSetup(nextSetup)
      setDraftResponse(nextDraft)
      const canOpenQueries = initialStep === 'queries'
        && nextDraft.draft?.authoring.targets.some(target => target.status === 'included')
        && !nextDraft.draft.authoring.targets.some(target => target.status === 'proposed')
      setStep(canOpenQueries ? 'queries' : initialStepFor(nextDraft.draft))
      if (canOpenQueries) {
        setAudience({
          kind: 'specific',
          propertyIds: [...new Set(nextDraft.draft!.authoring.assignments
            .filter(assignment => assignment.queryId === initialQueryId)
            .map(assignment => assignment.targetKey))],
        })
      }
      const included = includedPropertyIdsFor(nextDraft.draft)
      setIncludedPropertyIds(included)
    } catch (error) {
      if (requestVersion !== requestVersionRef.current) return
      setLoadError(setupErrorMessage(error, 'Could not load advanced measurement setup.'))
    } finally {
      if (requestVersion === requestVersionRef.current) setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadCurrent(true)
    return () => { requestVersionRef.current += 1 }
  }, [projectName, canEdit, service])

  useEffect(() => {
    if (!isLoading && !draft && publishedDraftView) setStep('properties')
  }, [draft, isLoading, publishedDraftView])

  const initialQuerySelectedRef = useRef(false)
  useEffect(() => {
    if (initialQuerySelectedRef.current || !initialQueryId || isLoading || isQueryLoading || isQueryError || step !== 'queries') return
    initialQuerySelectedRef.current = true
    const initialQuery = catalogQueries.find(query => query.id === initialQueryId)
    if (!initialQuery) return
    setSelectedQueryIds([initialQueryId])
    setEditingQueryId(initialQueryId)
    setEditingQueryText(initialQuery.query)
  }, [catalogQueries, initialQueryId, isLoading, isQueryLoading, isQueryError, step])

  async function refreshDraft(): Promise<MeasurementDraftResponse> {
    const next = await service.loadDraft(projectName)
    setDraftResponse(next)
    return next
  }

  async function recoverConflict(message: string): Promise<void> {
    setReviewed(null)
    setEditingQueryText(null)
    void onRetryQueries?.()
    try {
      const [nextSetup, nextDraft] = await Promise.all([
        service.loadSetup(projectName),
        service.loadDraft(projectName),
      ])
      setSetup(nextSetup)
      setDraftResponse(nextDraft)
      const included = includedPropertyIdsFor(nextDraft.draft)
      setIncludedPropertyIds(included)
      setStep(current => recoveredStepFor(nextDraft.draft, current))
      setActionError(message)
    } catch (error) {
      setActionError(setupErrorMessage(error, message))
    }
  }

  async function mutate(
    action: string,
    run: (currentEtag: string) => Promise<{ etag: string; warnings?: MeasurementDraftWarning[] }>,
    fallback: string,
    options: { preserveBusyAction?: boolean } = {},
  ): Promise<MeasurementDraftResponse | null> {
    const { preserveBusyAction = false } = options
    if (!canEdit || !etag || (busyAction && !preserveBusyAction)) return null
    if (!preserveBusyAction) setBusyAction(action)
    setActionError(null)
    setReviewed(null)
    try {
      const result = await run(etag)
      const next = await refreshDraft()
      setServerFlags((result.warnings ?? []).map((warning, index) => warningFlag(warning, index, next.draft?.authoring)))
      return next
    } catch (error) {
      if (isDraftConflict(error)) {
        await recoverConflict('This setup changed in another session. The latest draft is loaded; review your changes again.')
      } else {
        setActionError(setupErrorMessage(error, fallback))
      }
      return null
    } finally {
      if (!preserveBusyAction) setBusyAction(null)
    }
  }

  const importProperties = useMemo<ImportProperty[]>(() => (
    (viewDraft?.authoring.targets ?? []).map(target => {
      const urls = propertyUrls(target)
      return {
        id: target.stableKey,
        name: target.label,
        url: urls[0] ?? 'No URL',
        urls,
        state: propertyState(target.status),
      }
    })
  ), [viewDraft])

  const includedTargets = useMemo(() => (
    viewDraft?.authoring.targets.filter(target => target.status === 'included') ?? []
  ), [viewDraft])
  const confirmedProperties = useMemo<SetupProperty[]>(() => (
    includedTargets.map(target => ({ id: target.stableKey, label: target.label, urlCount: propertyUrls(target).length }))
  ), [includedTargets])
  const assignmentCount = viewDraft?.authoring.assignments.length ?? 0

  const setupQueries = useMemo<AdvancedMeasurementQuery[]>(() => {
    if (!viewDraft) return []
    const projectQueryIds = new Set(catalogQueries.map(query => query.id))
    const available = catalogQueries.map(query => ({
      id: query.id,
      text: query.query,
      source: 'saved-project-queries' as const,
      propertyIds: unique(viewDraft.authoring.assignments
        .filter(assignment => assignment.queryId === query.id)
        .map(assignment => assignment.targetKey)),
    }))
    const missing = unique(viewDraft.authoring.assignments
      .map(assignment => assignment.queryId)
      .filter(queryId => !projectQueryIds.has(queryId)))
      .map(queryId => ({
        id: queryId,
        source: 'unavailable-tracked-query' as const,
        state: 'missing' as const,
        propertyIds: unique(viewDraft.authoring.assignments
          .filter(assignment => assignment.queryId === queryId)
          .map(assignment => assignment.targetKey)),
      }))
    return [...available, ...missing]
  }, [catalogQueries, viewDraft])
  const editingQuery = useMemo(() => (
    editingQueryId === null
      ? null
      : setupQueries.find(query => query.id === editingQueryId && query.text?.trim() && (query.propertyIds?.length ?? 0) > 0) ?? null
  ), [editingQueryId, setupQueries])
  const editingQueryPropertyLabels = useMemo(() => (
    (editingQuery?.propertyIds ?? []).map(propertyId => (
      confirmedProperties.find(property => property.id === propertyId)?.label ?? propertyId
    ))
  ), [confirmedProperties, editingQuery])

  const setupGroups = useMemo<AdvancedMeasurementGroup[]>(() => (
    (viewDraft?.authoring.groups ?? []).map(group => ({
      id: group.stableKey,
      name: group.label,
      propertyIds: group.targetKeys,
      competitors: group.competitors.map(competitor => competitor.domain),
    }))
  ), [viewDraft])

  const assignmentPreviewInput = useMemo<MeasurementAudienceAssignmentInput | null>(() => {
    if (selectedQueryIds.length === 0) return null
    const input = assignmentInputFor(audience, confirmedProperties.map(property => property.id), selectedQueryIds)
    const targetCount = input.groupKeys?.length ?? input.targetKeys?.length ?? 0
    return targetCount > 0 ? input : null
  }, [audience, confirmedProperties, selectedQueryIds])
  const assignmentPreviewKey = assignmentPreviewInput ? JSON.stringify(assignmentPreviewInput) : ''

  useEffect(() => {
    const request = assignmentPreviewInput
    const requestVersion = ++assignmentPreviewVersionRef.current
    if (!canEdit || !draft || !etag || !request) {
      setAssignmentPreview(null)
      setAssignmentPreviewSelectionKey(null)
      setAssignmentPreviewError(null)
      setIsPreviewingAssignment(false)
      return
    }

    setAssignmentPreview(null)
    setAssignmentPreviewSelectionKey(null)
    setAssignmentPreviewError(null)
    setIsPreviewingAssignment(true)
    const timer = window.setTimeout(() => {
      void service.previewAssignments(projectName, request)
        .then(preview => {
          if (requestVersion !== assignmentPreviewVersionRef.current) return
          if (preview.draftEtag !== etag) {
            setAssignmentPreview(null)
            setAssignmentPreviewSelectionKey(null)
            setAssignmentPreviewError('The setup changed while calculating assignment impact. Refresh the draft and try again.')
            return
          }
          setAssignmentPreview(preview)
          setAssignmentPreviewSelectionKey(assignmentPreviewKey)
        })
        .catch(error => {
          if (requestVersion !== assignmentPreviewVersionRef.current) return
          setAssignmentPreview(null)
          setAssignmentPreviewSelectionKey(null)
          setAssignmentPreviewError(assignmentPreviewErrorMessage(error))
        })
        .finally(() => {
          if (requestVersion === assignmentPreviewVersionRef.current) setIsPreviewingAssignment(false)
        })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      assignmentPreviewVersionRef.current += 1
    }
  }, [assignmentPreviewInput, assignmentPreviewKey, assignmentPreviewRetry, canEdit, draft, etag, projectName, service])

  const reviewFlags = useMemo<AdvancedMeasurementFlaggedException[]>(() => [
    ...(assignmentCount === 0 ? [{
      id: 'no-query-assignments',
      title: 'Assign at least one query',
      detail: 'Apply a tracked query to at least one Property before publishing.',
      tone: 'negative' as const,
    }] : []),
    ...((viewDraft?.authoring.assignments.some(assignment => assignment.queryClass === 'unclassified')
      && !(publishedDraftView && publishedPlan?.plan.schemaVersion === 1)) ? [{
      id: 'unclassified-query-assignments',
      title: 'Remove an unavailable query',
      detail: 'One or more saved assignments no longer have a tracked query. Clear them before publishing.',
      tone: 'negative' as const,
    }] : []),
    ...serverFlags,
  ], [assignmentCount, publishedDraftView, publishedPlan, serverFlags, viewDraft])

  const queryAvailability = isQueryLoading
    ? { status: 'unavailable' as const, message: 'Tracked queries are loading.' }
    : isQueryError
      ? { status: 'unavailable' as const, message: 'Tracked queries could not be loaded. Retry before assigning Properties.' }
      : { status: 'available' as const }

  async function reviewSitemap(nextImportDraft: AdvancedMeasurementImportDraft): Promise<void> {
    let input: SitemapImportInput
    try {
      input = sitemapImportInput(nextImportDraft)
    } catch (error) {
      setActionError(setupErrorMessage(error, 'Check the sitemap details and try again.'))
      return
    }
    setImportDraft(nextImportDraft)
    setReviewState('reviewing')
    const next = await mutate('import', currentEtag => service.importSitemap(projectName, currentEtag, input), 'Could not review this sitemap.')
    if (next?.draft) {
      const proposed = next.draft.authoring.targets.filter(target => target.status === 'proposed').map(target => target.stableKey)
      const alreadyIncluded = next.draft.authoring.targets.filter(target => target.status === 'included').map(target => target.stableKey)
      setIncludedPropertyIds([...alreadyIncluded, ...proposed])
      setPropertiesSearch('')
      setMaxVisibleProperties(DEFAULT_VISIBLE_PROPERTIES)
      setStep('properties')
      setReviewState('idle')
    } else {
      setReviewState('error')
    }
  }

  async function addProjectQueries(texts: readonly string[]): Promise<readonly { id: string; query: string }[]> {
    if (!onCreateQueries || texts.length === 0 || busyAction) return []
    setBusyAction('create-queries')
    setCreateQueriesError(null)
    try {
      return await onCreateQueries(texts)
    } catch (error) {
      // The server says which query was rejected and why. Replacing that with
      // a house string is what sent an operator round in circles on the sitemap.
      setCreateQueriesError(extractErrorMessage(error))
      // Rethrow so the step keeps what the operator typed. Resolving here would
      // report failure and clear the box in the same breath, and they would have
      // to retype every query to try again.
      throw error
    } finally {
      setBusyAction(null)
    }
  }

  async function continueProperties(selectedIds: readonly string[]): Promise<void> {
    if (!draft || !etag || busyAction) return
    const selected = new Set(selectedIds)
    const proposed = draft.authoring.targets.filter(target => target.status === 'proposed' && target.discoveryIdentity)
    const selections = proposed.map(target => ({
      discoveryIdentity: target.discoveryIdentity!,
      action: selected.has(target.stableKey) ? 'create' as const : 'ignore' as const,
    }))
    const selectionChanged = selections.length > 0 || draft.authoring.targets.some(target =>
      target.status !== 'proposed' && (target.status === 'included') !== selected.has(target.stableKey))

    setBusyAction('properties')
    setActionError(null)
    setReviewed(null)
    try {
      if (!selectionChanged) {
        setIncludedPropertyIds([...selected])
        setAudience({ kind: 'all' })
        setStep('groups')
        return
      }
      await service.applySitemapSelection(projectName, etag, selections, [...selected])
      const next = await refreshDraft()
      const included = includedPropertyIdsFor(next.draft)
      setIncludedPropertyIds(included)
      setAudience({ kind: 'all' })
      setStep('groups')
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('This setup changed in another session. The latest Properties are loaded.')
      else setActionError(setupErrorMessage(error, 'Could not save the selected Properties.'))
    } finally {
      setBusyAction(null)
    }
  }

  async function applySelectedQueries(selection: { queryIds: readonly string[]; propertyIds: readonly string[]; groupIds?: readonly string[] }): Promise<void> {
    const input: MeasurementAudienceAssignmentInput = selection.groupIds && selection.groupIds.length > 0
      ? { groupKeys: uniqueSorted(selection.groupIds), queryIds: uniqueSorted(selection.queryIds) }
      : { targetKeys: uniqueSorted(selection.propertyIds), queryIds: uniqueSorted(selection.queryIds) }
    if (!assignmentPreview || assignmentPreviewSelectionKey !== JSON.stringify(input)
      || !etag || assignmentPreview.draftEtag !== etag) {
      setActionError('Review the latest assignment impact before assigning queries.')
      return
    }
    const next = await mutate(
      'assignments',
      currentEtag => service.applyAssignments(projectName, currentEtag, input),
      'Could not apply these queries.',
    )
    if (next) {
      setSelectedQueryIds([])
      setAssignmentNotice(`${assignmentPreview.assignments.added} new assignment${assignmentPreview.assignments.added === 1 ? '' : 's'} added. Existing assignments were kept.`)
    }
  }

  async function replaceQueryAssignments(selection: { queryId: string; propertyIds: readonly string[] }): Promise<void> {
    if (selection.propertyIds.length === 0) return
    const next = await mutate(
      'replace-assignments',
      currentEtag => service.replaceAssignments(projectName, currentEtag, {
        targetKeys: unique(selection.propertyIds),
        queryIds: [selection.queryId],
      }),
      'Could not replace this query assignment.',
    )
    if (next) {
      setSelectedQueryIds(current => current.filter(queryId => queryId !== selection.queryId))
      setAssignmentNotice('Query assignments replaced.')
    }
  }

  function editQuery(queryId: string): void {
    if (!canEdit || isQueryLoading || isQueryError || busyAction) return
    const query = setupQueries.find(candidate => candidate.id === queryId)
    if (!query?.text?.trim()) return
    setEditingQueryId(queryId)
    setEditingQueryText(query.text)
    setActionError(null)
    setSelectedQueryIds(current => current.includes(queryId) ? current : [...current, queryId])
  }

  async function saveQueryText(): Promise<void> {
    const sourceQuery = editingQuery
    const sourceText = sourceQuery?.text?.trim()
    const queryText = (editingQueryText ?? sourceQuery?.text ?? '').trim()
    if (!canEdit || isQueryLoading || isQueryError || !sourceQuery || !sourceText || !queryText || normalizeQueryText(queryText) === normalizeQueryText(sourceText) || busyAction || queryReplacementInFlightRef.current) return

    const previousIntent = pendingQueryReplacementIntentRef.current
    const intent = previousIntent?.sourceQueryId === sourceQuery.id && previousIntent.queryText === queryText
      ? previousIntent
      : {
          sourceQueryId: sourceQuery.id,
          queryText,
          idempotencyKey: createMeasurementDraftIdempotencyKey(),
        }
    pendingQueryReplacementIntentRef.current = intent
    queryReplacementInFlightRef.current = true

    try {
      const replacementResult: { current: MeasurementDraftReplaceQueryResponse | null } = { current: null }
      const next = await mutate(
        'replace-query',
        async currentEtag => {
          const result = await service.replaceQuery(
            projectName,
            currentEtag,
            { queryId: sourceQuery.id, queryText },
            intent.idempotencyKey,
          )
          replacementResult.current = result
          return result
        },
        'Could not save this query.',
      )
      const replacement = replacementResult.current
      if (!next || !replacement) return

      setPendingQueryReplacements(current => current.some(item => item.replacementQuery.id === replacement.replacementQuery.id)
        ? current
        : [...current, replacement])
      setSelectedQueryIds(current => {
        const replaced = current.map(queryId => queryId === replacement.previousQueryId ? replacement.replacementQuery.id : queryId)
        return replaced.includes(replacement.replacementQuery.id) ? replaced : [...replaced, replacement.replacementQuery.id]
      })
      setEditingQueryId(replacement.replacementQuery.id)
      setEditingQueryText(replacement.replacementQuery.query)
      if (pendingQueryReplacementIntentRef.current.idempotencyKey === intent.idempotencyKey) {
        pendingQueryReplacementIntentRef.current = null
      }
      void onRetryQueries?.()
    } finally {
      queryReplacementInFlightRef.current = false
    }
  }

  /**
   * One question written for one Property, assigned to that Property alone.
   *
   * The pattern box generates a question per Property, but the only assignment
   * action used to be a cross product, so applying the generated set put every
   * question on every Property: 213 questions over 213 Properties is 45,369
   * assignments, and coverage is matched/assignments, so each Property's
   * denominator became the whole portfolio.
   */
  async function applyPairedQuestions(
    pairs: readonly { targetKey: string; queryId: string }[],
    preserveBusyAction = false,
  ): Promise<void> {
    if (pairs.length === 0) return
    const next = await mutate(
      'paired-assignments',
      currentEtag => service.applyPairedAssignments(projectName, currentEtag, [...pairs]),
      'Could not assign these queries.',
      { preserveBusyAction },
    )
    // mutate reports failure by returning null, not by throwing. Swallowing that
    // let a failed assignment read as success: the questions were created, none
    // were assigned, and the authored pattern was cleared as if it had worked.
    if (!next) throw new Error('Could not assign these queries.')
  }

  /**
   * Writes one question per Property and assigns each to the Property it names.
   *
   * Creating the questions and assigning them used to be two unrelated steps,
   * and the only assignment action was a cross product, so the generated set
   * landed on every Property. The pairing has to survive from generation to
   * assignment, which means one operation owns both halves.
   */
  async function createAndPairQuestions(
    pairs: readonly { propertyId: string; text: string }[],
  ): Promise<void> {
    if (!canEdit || !onCreateQueries || pairs.length === 0 || busyAction) return
    // The ids only exist after the write, and the pairing is by text.
    setBusyAction('create-and-pair-questions')
    setCreateQueriesError(null)
    try {
      let refreshed: readonly { id: string; query: string }[]
      try {
        refreshed = await onCreateQueries(unique(pairs.map(pair => pair.text)))
      } catch (error) {
        setCreateQueriesError(extractErrorMessage(error))
        throw error
      }
      const idByText = new Map(refreshed.map(query => [query.query, query.id]))
      const assignmentPairs = pairs
        .map(pair => ({ targetKey: pair.propertyId, queryId: idByText.get(pair.text) }))
        .filter((pair): pair is { targetKey: string; queryId: string } => pair.queryId !== undefined)
      if (assignmentPairs.length !== pairs.length) {
        const error = new Error('The created queries could not be matched to their Properties.')
        setCreateQueriesError('The queries were added, but could not be paired with every Property. Try again to pair them.')
        throw error
      }
      try {
        await applyPairedQuestions(assignmentPairs, true)
      } catch (error) {
        setCreateQueriesError('The queries were added, but could not be assigned to their Properties. Try again to pair them.')
        throw error
      }
    } finally {
      setBusyAction(null)
    }
  }

  async function clearQueryAssignments(queryId: string): Promise<void> {
    if (!draft) return
    const targetKeys = unique(draft.authoring.assignments
      .filter(assignment => assignment.queryId === queryId)
      .map(assignment => assignment.targetKey))
    if (targetKeys.length === 0) return
    const next = await mutate(
      `remove-${queryId}`,
      currentEtag => service.removeAssignment(projectName, currentEtag, targetKeys, queryId),
      'Could not clear this query assignment.',
    )
    if (next) setSelectedQueryIds(current => current.filter(id => id !== queryId))
  }

  async function saveGroup(nextGroupDraft: AdvancedMeasurementGroupDraft): Promise<void> {
    if (!draft || !etag || busyAction) return
    const label = nextGroupDraft.name.trim()
    if (!label) return
    const groupKey = editingGroupId ?? stableKey(label, 'group')
    const existing = draft.authoring.groups.find(group => group.stableKey === groupKey)
    if (existing && editingGroupId === null) {
      setActionError(`A group named "${existing.label}" already exists. Edit it or choose a different name.`)
      return
    }
    const domainEntries = nextGroupDraft.competitorDomains.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)
    const invalidDomain = domainEntries.find(value => normalizedDomain(value) === null)
    if (invalidDomain) {
      setActionError(`"${invalidDomain}" is not a valid competitor domain.`)
      return
    }
    const domains = unique(domainEntries.map(value => normalizedDomain(value)!))

    setBusyAction('group')
    setActionError(null)
    setReviewed(null)
    try {
      const result = await service.upsertGroup(projectName, etag, {
        stableKey: groupKey,
        label,
        targetKeys: unique(nextGroupDraft.propertyIds),
        competitors: domains.map(domain => existing?.competitors.find(competitor => competitor.domain === domain) ?? {
          stableKey: stableKey(domain, 'competitor'),
          label: domain,
          domain,
          aliases: [],
        }),
      })
      const next = await refreshDraft()
      setServerFlags(result.warnings.map((warning, index) => warningFlag(warning, index, next.draft?.authoring)))
      setGroupDraft({ ...DEFAULT_GROUP_DRAFT })
      setEditingGroupId(null)
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('This setup changed in another session. The latest groups are loaded.')
      else setActionError(setupErrorMessage(error, 'Could not save this group.'))
    } finally {
      setBusyAction(null)
    }
  }

  function editGroup(groupId: string): void {
    const group = draft?.authoring.groups.find(item => item.stableKey === groupId)
    if (!group) return
    setEditingGroupId(groupId)
    setGroupDraft({
      name: group.label,
      propertyIds: [...group.targetKeys],
      competitorDomains: group.competitors.map(competitor => competitor.domain).join(', '),
    })
  }

  async function removeGroup(groupId: string): Promise<void> {
    const next = await mutate('remove-group', currentEtag => service.removeGroup(projectName, currentEtag, groupId), 'Could not remove this group.')
    if (next) {
      setAudience(current => current.kind === 'groups' && current.groupIds.includes(groupId)
        ? { kind: 'all' }
        : current)
      if (editingGroupId === groupId) {
        setEditingGroupId(null)
        setGroupDraft({ ...DEFAULT_GROUP_DRAFT })
      }
    }
  }

  function changeGroupMembershipCsv(csv: string): void {
    setGroupMembershipCsv(csv)
    setGroupMembershipPreview(null)
    setGroupMembershipError(null)
    setGroupMembershipNotice(null)
  }

  async function reviewGroupMembership(): Promise<void> {
    if (!canEdit || !groupMembershipCsv.trim() || isReviewingGroupMembership || isApplyingGroupMembership) return
    setIsReviewingGroupMembership(true)
    setGroupMembershipError(null)
    setGroupMembershipNotice(null)
    try {
      setGroupMembershipPreview(await service.previewGroupMembership(projectName, { csv: groupMembershipCsv }))
    } catch (error) {
      setGroupMembershipPreview(null)
      setGroupMembershipError(setupErrorMessage(error, 'Could not review this CSV.'))
    } finally {
      setIsReviewingGroupMembership(false)
    }
  }

  async function applyGroupMembership(acceptedRows: readonly number[]): Promise<void> {
    if (!canEdit || !etag || !groupMembershipPreview || acceptedRows.length === 0 || busyAction) return
    if (groupMembershipPreview.draftEtag !== etag) {
      setGroupMembershipError('The setup changed while this CSV was open. Review the latest CSV before applying it.')
      return
    }
    setIsApplyingGroupMembership(true)
    setBusyAction('group-import')
    setGroupMembershipError(null)
    setGroupMembershipNotice(null)
    setReviewed(null)
    try {
      const result = await service.applyGroupMembership(projectName, etag, {
        csv: groupMembershipCsv,
        sourceChecksum: groupMembershipPreview.sourceChecksum,
        previewChecksum: groupMembershipPreview.previewChecksum,
        acceptedRows: unique(acceptedRows.map(String)).map(Number),
      })
      const next = await refreshDraft()
      setServerFlags(result.warnings.map((warning, index) => warningFlag(warning, index, next.draft?.authoring)))
      setGroupMembershipCsv('')
      setGroupMembershipPreview(null)
      setGroupMembershipNotice(`${result.addedMemberships} membership${result.addedMemberships === 1 ? '' : 's'} added${result.unchangedMemberships > 0 ? `; ${result.unchangedMemberships} already present` : ''}.`)
    } catch (error) {
      if (isDraftConflict(error)) {
        await recoverConflict('This setup changed in another session. The latest draft is loaded; review the CSV again.')
        setGroupMembershipError('The setup changed while this CSV was open. Review the latest CSV before applying it.')
      } else {
        setGroupMembershipError(setupErrorMessage(error, 'Could not apply this CSV.'))
      }
    } finally {
      setBusyAction(null)
      setIsApplyingGroupMembership(false)
    }
  }

  async function reviewSetupChanges(): Promise<void> {
    if (!draft || !etag || busyAction || assignmentCount === 0) return
    setBusyAction('review')
    setActionError(null)
    setReviewed(null)
    try {
      const [compile, diff] = await Promise.all([
        service.compilePreview(projectName),
        service.diffPreview(projectName),
      ])
      const checks = [...compile.checks, ...diff.checks]
      const preservesHistoricalResults = checks.some(check => check.ruleId === 'active-revision-schema-v1')
      setServerFlags(reviewCheckFlags(
        checks.filter(check => check.ruleId !== 'active-revision-schema-v1'),
        { authoring: viewDraft?.authoring, queries },
      ))
      if (!compile.ok || !diff.ok) return
      if (diff.diff.activeRevision !== draft.baseActiveRevision) {
        await recoverConflict('The published setup changed while you were reviewing. The latest draft is loaded; review it again.')
        return
      }
      if (compile.compiledChecksum !== diff.compiledChecksum) {
        setActionError('The setup changed while it was being reviewed. Review the latest changes again.')
        return
      }
      setReviewed({
        etag,
        baseActiveRevision: draft.baseActiveRevision,
        compiledChecksum: compile.compiledChecksum,
        changes: reviewedChanges(diff.diff, preservesHistoricalResults),
        providerCalls: compile.plan.executionNodes.reduce((total, node) => total + node.expectedSnapshots, 0),
      })
    } catch (error) {
      setActionError(setupErrorMessage(error, 'Could not review this setup.'))
    } finally {
      setBusyAction(null)
    }
  }

  async function publishSetup(): Promise<void> {
    if (!draft || !etag || !reviewed || busyAction) return
    if (etag !== reviewed.etag || draft.baseActiveRevision !== reviewed.baseActiveRevision) {
      setReviewed(null)
      setActionError('The setup changed after review. Review the latest changes before publishing.')
      return
    }
    setBusyAction('publish')
    setActionError(null)
    try {
      await service.publish(projectName, etag, {
        expectedActiveRevision: reviewed.baseActiveRevision,
        expectedCompiledChecksum: reviewed.compiledChecksum,
      })
      setDraftResponse({ draft: null, etag: null })
      setReviewed(null)
      onPublished?.()
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('The setup changed before it could be published. Review the latest draft and publish again.')
      else setActionError(setupErrorMessage(error, 'Could not publish this setup.'))
    } finally {
      setBusyAction(null)
    }
  }

  async function discardDraft(): Promise<void> {
    if (!etag || busyAction) return
    setBusyAction('discard')
    setActionError(null)
    try {
      await service.discard(projectName, etag)
      setDraftResponse({ draft: null, etag: null })
      setReviewed(null)
      onPublished?.()
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('This setup changed in another session. The latest draft is loaded.')
      else setActionError(setupErrorMessage(error, 'Could not discard these changes.'))
    } finally {
      setBusyAction(null)
    }
  }

  async function restartStaleDraft(): Promise<void> {
    if (!draft || !etag || !setup || busyAction) return
    setBusyAction('restart')
    setActionError(null)
    setReviewed(null)
    try {
      await service.discard(projectName, etag)
      await service.createDraft(projectName, setup.activeRevision)
      setImportDraft({ ...DEFAULT_IMPORT_DRAFT })
      setPropertiesSearch('')
      setIncludedPropertyIds([])
      setSelectedQueryIds([])
      setAudience({ kind: 'all' })
      setAssignmentPreview(null)
      setAssignmentPreviewError(null)
      setAssignmentNotice(null)
      setGroupDraft({ ...DEFAULT_GROUP_DRAFT })
      setEditingGroupId(null)
      setGroupMembershipCsv('')
      setGroupMembershipPreview(null)
      setGroupMembershipError(null)
      setGroupMembershipNotice(null)
      await loadCurrent(false)
    } catch (error) {
      if (isDraftConflict(error)) await recoverConflict('The setup changed again. Reloaded the latest draft and published setup.')
      else setActionError(setupErrorMessage(error, 'Could not restart this setup.'))
    } finally {
      setBusyAction(null)
    }
  }

  if (isLoading) {
    return (
      <section aria-labelledby="advanced-measurement-loading-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-loading-title">Advanced measurement setup</h2></div>
        <div className="h-28 animate-pulse rounded-md bg-surface-subtle" aria-label="Loading advanced measurement setup" />
      </section>
    )
  }

  if (loadError) {
    return (
      <section aria-labelledby="advanced-measurement-error-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-error-title">Advanced measurement setup</h2></div>
        <div role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-4 text-sm text-negative">
          <p>{loadError}</p>
          <Button className="mt-3 min-h-11" type="button" size="sm" variant="outline" onClick={() => { void loadCurrent(true) }}>Try again</Button>
        </div>
      </section>
    )
  }

  if (!viewDraft || (canEdit && !etag)) {
    return (
      <section aria-labelledby="advanced-measurement-empty-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-empty-title">Advanced measurement setup</h2></div>
        <p className="text-sm text-secondary">{canEdit ? 'Start setup from the project Overview.' : 'No advanced setup is available to review.'}</p>
      </section>
    )
  }

  if (canEdit && draft && setup && draft.baseActiveRevision !== setup.activeRevision) {
    return (
      <section aria-labelledby="advanced-measurement-stale-draft-title" className="space-y-4">
        <div className="section-head"><h2 id="advanced-measurement-stale-draft-title">Advanced measurement setup</h2></div>
        <div role="alert" className="border-y border-caution-800/40 bg-caution-950/20 py-4">
          <p className="text-sm font-medium text-heading">This draft is based on an older published setup.</p>
          <p className="mt-1 text-sm text-secondary">Restart from the latest setup before making more changes.</p>
          <Button
            className="mt-3 min-h-11"
            type="button"
            size="sm"
            variant="outline"
            disabled={busyAction === 'restart'}
            onClick={() => { void restartStaleDraft() }}
          >
            {busyAction === 'restart' ? 'Restarting…' : 'Discard draft and restart'}
          </Button>
        </div>
        {actionError ? <p role="alert" className="text-sm text-negative">{actionError}</p> : null}
      </section>
    )
  }

  const retryQueries = isQueryError && onRetryQueries ? (
    <div className="flex justify-end"><Button type="button" size="sm" variant="outline" className="min-h-11" onClick={onRetryQueries}>Retry queries</Button></div>
  ) : null

  return (
    <div className="space-y-4">
      {setup?.mode === 'active-v1' ? (
        <p role="status" className="border-y border-caution-800/40 bg-caution-950/20 py-3 text-sm text-secondary">
          Review and publish this setup to enable class-filtered reporting.
        </p>
      ) : null}
      {actionError ? <p role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-3 text-sm text-negative">{actionError}</p> : null}
      {retryQueries}
      {step === 'import' || step === 'properties' ? (
        <AdvancedMeasurementSetup
          currentStep={step}
          hasDraft={draft !== null}
          canEdit={canEdit}
          onStepChange={!canEdit ? setStep : undefined}
          onDiscard={() => { void discardDraft() }}
          importProperties={{
            importDraft,
            onImportDraftChange: next => {
              setImportDraft(next)
              setReviewState('idle')
              setActionError(null)
            },
            onReviewSitemap: next => { void reviewSitemap(next) },
            reviewState,
            properties: importProperties,
            propertiesState: 'ready',
            propertiesSearch,
            onPropertiesSearchChange: setPropertiesSearch,
            maxVisibleProperties,
            onShowAllProperties: () => setMaxVisibleProperties(importProperties.length),
            selectedPropertyIds: includedPropertyIds,
            onSelectedPropertyIdsChange: ids => setIncludedPropertyIds([...ids]),
            onContinue: ids => { void continueProperties(ids) },
            isContinuing: busyAction === 'properties',
            onRetryProperties: () => { void refreshDraft() },
            onReturnToImport: () => setStep('import'),
          }}
        />
      ) : step === 'queries' ? (
        <AdvancedMeasurementSetup
          currentStep="queries"
          hasDraft={draft !== null}
          canEdit={canEdit}
          onStepChange={!canEdit ? setStep : undefined}
          onDiscard={() => { void discardDraft() }}
          onManageProjectQueries={onManageProjectQueries}
          queries={{
            onCreateQueries: onCreateQueries
              ? texts => addProjectQueries(texts)
              : undefined,
            isCreatingQueries: busyAction === 'create-queries' || busyAction === 'create-and-pair-questions',
            isBusy: busyAction !== null,
            createQueriesError: createQueriesError,
            availability: queryAvailability,
            properties: confirmedProperties,
            queries: setupQueries,
            selectedQueryIds,
            isApplying: busyAction === 'assignments' || busyAction === 'paired-assignments',
            onSelectedQueryIdsChange: ids => setSelectedQueryIds([...ids]),
            onApplySelectedQueries: selection => applySelectedQueries(selection),
            groups: setupGroups,
            audience,
            onAudienceChange: nextAudience => {
              setAudience(nextAudience)
              setAssignmentNotice(null)
            },
            assignmentImpact: assignmentPreview && assignmentPreviewSelectionKey === assignmentPreviewKey
              ? assignmentImpactFor(assignmentPreview)
              : null,
            isPreviewingAssignmentImpact: isPreviewingAssignment,
            assignmentImpactError: assignmentPreviewError,
            onRetryAssignmentImpact: () => setAssignmentPreviewRetry(value => value + 1),
            assignmentNotice,
            queryEditor: canEdit && editingQuery?.text ? {
              originalValue: editingQuery.text,
              value: editingQueryText ?? editingQuery.text,
              assignedPropertyLabels: editingQueryPropertyLabels,
              isSaving: busyAction === 'replace-query',
              isDisabled: isQueryLoading || isQueryError,
              onValueChange: setEditingQueryText,
              onSave: saveQueryText,
            } : undefined,
            onEditQuery: canEdit && !isQueryLoading && !isQueryError ? editQuery : undefined,
            onReplaceAssignments: replaceQueryAssignments,
            isReplacingAssignments: busyAction === 'replace-assignments',
            onCreateAndPairQuestions: canEdit && onCreateQueries ? createAndPairQuestions : undefined,
            onClearQueryAssignments: clearQueryAssignments,
            onRemoveQuery: clearQueryAssignments,
            canContinue: assignmentCount > 0,
            onBack: () => setStep('groups'),
            onContinue: () => setStep('review'),
          }}
        />
      ) : step === 'groups' ? (
        <AdvancedMeasurementSetup
          currentStep="groups"
          hasDraft={draft !== null}
          canEdit={canEdit}
          onStepChange={!canEdit ? setStep : undefined}
          onDiscard={() => { void discardDraft() }}
          groups={{
            properties: confirmedProperties,
            groups: setupGroups,
            groupDraft,
            isSaving: busyAction === 'group',
            onGroupDraftChange: setGroupDraft,
            onSaveGroup: saveGroup,
            onEditGroup: group => editGroup(group.id),
            onRemoveGroup: removeGroup,
            onClearGroupDraft: () => {
              setEditingGroupId(null)
              setGroupDraft({ ...DEFAULT_GROUP_DRAFT })
            },
            membershipImport: {
              csv: groupMembershipCsv,
              preview: groupMembershipPreview,
              isReviewing: isReviewingGroupMembership,
              isApplying: isApplyingGroupMembership,
              error: groupMembershipError,
              notice: groupMembershipNotice,
              onCsvChange: changeGroupMembershipCsv,
              onReview: reviewGroupMembership,
              onApply: applyGroupMembership,
            },
            onBack: () => {
              setStep('properties')
            },
            onContinue: () => setStep('queries'),
          }}
        />
      ) : (
        <AdvancedMeasurementSetup
          currentStep="review"
          hasDraft={draft !== null}
          canEdit={canEdit}
          onStepChange={!canEdit ? setStep : undefined}
          onDiscard={() => { void discardDraft() }}
          review={{
            counts: {
              properties: includedTargets.length,
              queries: new Set(viewDraft.authoring.assignments.map(assignment => assignment.queryId)).size,
              groups: viewDraft.authoring.groups.length,
              assignments: viewDraft.authoring.assignments.length,
              providerCalls: reviewed?.providerCalls,
            },
            flaggedExceptions: reviewFlags,
            reviewedChanges: reviewed?.changes,
            isReviewing: busyAction === 'review',
            canReviewChanges: assignmentCount > 0 && !busyAction,
            onReviewChanges: reviewSetupChanges,
            onBack: () => setStep('queries'),
            canPublish: reviewed !== null && !busyAction,
            isPublishing: busyAction === 'publish',
            onPublish: publishSetup,
          }}
        />
      )}
    </div>
  )
}

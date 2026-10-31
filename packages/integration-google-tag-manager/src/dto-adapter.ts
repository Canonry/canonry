import type {
  GtmAccountDto,
  GtmConfigurationGraphDto,
  GtmContainerDto,
  GtmContainerVersionDto,
  GtmDraftWorkspaceGraphDto,
  GtmGoogleAdsTagAssessmentDto,
  GtmGoogleAdsTagFieldMappingDto,
  GtmGoogleAdsTagReviewReason,
  GtmGoogleAdsTagTriggerStrategy,
  GtmGoogleAdsTriggerPredicateDto,
  GtmLiveContainerGraphDto,
  GtmTagDto,
  GtmTriggerDto,
  GtmVariableDto,
  GtmWorkspaceDto,
} from '@canonry/canonry-contracts'
import {
  gtmGoogleAdsConversionIdMappingDtoSchema,
  gtmGoogleAdsConversionLabelMappingDtoSchema,
  gtmGoogleAdsConversionValueMappingDtoSchema,
  gtmGoogleAdsCurrencyMappingDtoSchema,
  gtmGoogleAdsTransactionIdMappingDtoSchema,
} from '@canonry/canonry-contracts'
import { recognizeGoogleAdsConversionTag } from './recognizer.js'
import { GtmApiError } from './types.js'
import type {
  GtmAccount,
  GtmCondition,
  GtmContainer,
  GtmContainerSnapshot,
  GtmContainerVersion,
  GtmDtoAdapterOptions,
  GtmGoogleAdsConversionAssessment,
  GtmGoogleAdsFieldMapping,
  GtmParameter,
  GtmTag,
  GtmTrigger,
  GtmVariable,
  GtmWorkspace,
} from './types.js'

function required(value: string | null | undefined, label: string): string {
  if (!value) {
    throw new GtmApiError(`Tag Manager response is missing ${label}`, 502, {
      reason: 'INVALID_PROVIDER_RESPONSE',
    })
  }
  return value
}

function finalPathSegment(path: string | undefined): string | undefined {
  return path?.split('/').filter(Boolean).at(-1)
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))].sort()
}

function parameterKeys(parameters: GtmParameter[] | undefined): string[] {
  return uniqueStrings((parameters ?? []).map((parameter) => parameter.key))
}

function parameterValues(parameters: GtmParameter[] | undefined): string[] {
  return (parameters ?? []).flatMap((parameter) => [
    ...(typeof parameter.value === 'string' ? [parameter.value] : []),
    ...parameterValues(parameter.list),
    ...parameterValues(parameter.map),
  ])
}

function referencedVariableIds(
  tag: GtmTag,
  variableIdsByName: ReadonlyMap<string, readonly string[]>,
): string[] {
  const ids: string[] = []
  for (const value of parameterValues(tag.parameter)) {
    for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const name = match[1].trim()
      if (name) ids.push(...(variableIdsByName.get(name) ?? []))
    }
  }
  return uniqueStrings(ids)
}

function conditionParameter(condition: GtmCondition, key: string): string | null {
  const parameter = condition.parameter?.find((candidate) => candidate.key === key)
  return typeof parameter?.value === 'string' ? parameter.value : null
}

function normalizedVariableName(value: string): string {
  const trimmed = value.trim()
  const unwrapped = trimmed.startsWith('{{') && trimmed.endsWith('}}')
    ? trimmed.slice(2, -2)
    : trimmed
  return unwrapped.trim().toLowerCase()
}

function safeCustomEventNames(trigger: GtmTrigger): string[] {
  const names: string[] = []
  for (const condition of trigger.customEventFilter ?? []) {
    const left = conditionParameter(condition, 'arg0')
    const right = conditionParameter(condition, 'arg1')
    if (left && right) {
      const variableName = normalizedVariableName(left)
      if (variableName === '_event' || variableName === 'event' || variableName === 'event name') {
        names.push(right)
      }
    }
  }
  return uniqueStrings(names)
}

function conditionKeys(conditions: GtmCondition[] | undefined): string[] {
  return uniqueStrings((conditions ?? []).flatMap((condition) =>
    (condition.parameter ?? []).map((parameter) => parameter.key)))
}

function triggerConditions(trigger: GtmTrigger): GtmCondition[] {
  return [
    ...(trigger.customEventFilter ?? []),
    ...(trigger.filter ?? []),
    ...(trigger.autoEventFilter ?? []),
  ]
}

function triggerPredicate(trigger: GtmTrigger): GtmGoogleAdsTriggerPredicateDto | null {
  if (!trigger.triggerId) return null
  const eventPredicates: GtmGoogleAdsTriggerPredicateDto['eventPredicates'] = []
  const hostnamePredicates: GtmGoogleAdsTriggerPredicateDto['hostnamePredicates'] = []
  let unsupportedConditionCount = 0

  for (const condition of triggerConditions(trigger)) {
    const left = conditionParameter(condition, 'arg0')
    const right = conditionParameter(condition, 'arg1')
    const operator = condition.type?.trim() ?? ''
    if (!left || right === null || !operator || operator.length > 64 || right.length > 2_048) {
      unsupportedConditionCount += 1
      continue
    }
    const predicate = {
      operator,
      value: right,
      negated: conditionParameter(condition, 'negate')?.toLowerCase() === 'true',
      ignoreCase: (conditionParameter(condition, 'ignore_case')
        ?? conditionParameter(condition, 'ignoreCase'))?.toLowerCase() === 'true',
    }
    const variableName = normalizedVariableName(left)
    if (variableName === '_event' || variableName === 'event' || variableName === 'event name') {
      eventPredicates.push(predicate)
    } else if (variableName === 'page hostname' || variableName === '_hostname') {
      hostnamePredicates.push(predicate)
    } else {
      unsupportedConditionCount += 1
    }
  }

  return {
    triggerId: trigger.triggerId,
    triggerType: trigger.type ?? '',
    eventPredicates,
    hostnamePredicates,
    unsupportedConditionCount,
  }
}

export function toGtmAccountDto(account: GtmAccount): GtmAccountDto {
  return {
    id: required(account.accountId ?? finalPathSegment(account.path), 'account id'),
    path: account.path ?? '',
    name: account.name ?? '',
    shareData: typeof account.shareData === 'boolean' ? account.shareData : null,
  }
}

export function toGtmContainerDto(container: GtmContainer): GtmContainerDto {
  return {
    accountId: required(container.accountId, 'container account id'),
    id: required(container.containerId ?? finalPathSegment(container.path), 'container id'),
    path: container.path ?? '',
    name: container.name ?? '',
    publicId: container.publicId ?? null,
    domainName: container.domainName?.join(', ') ?? null,
    usageContexts: [...(container.usageContext ?? [])],
  }
}

export function toGtmWorkspaceDto(workspace: GtmWorkspace): GtmWorkspaceDto {
  return {
    accountId: required(workspace.accountId, 'workspace account id'),
    containerId: required(workspace.containerId, 'workspace container id'),
    id: required(workspace.workspaceId ?? finalPathSegment(workspace.path), 'workspace id'),
    path: workspace.path ?? '',
    name: workspace.name ?? '',
    description: workspace.description ?? null,
    fingerprint: workspace.fingerprint ?? null,
  }
}

export function toGtmContainerVersionDto(version: GtmContainerVersion): GtmContainerVersionDto {
  return {
    accountId: required(version.accountId, 'container version account id'),
    containerId: required(version.containerId, 'container version container id'),
    id: required(version.containerVersionId ?? finalPathSegment(version.path), 'container version id'),
    path: version.path ?? '',
    name: version.name ?? '',
    description: version.description ?? null,
    fingerprint: version.fingerprint ?? null,
    deleted: version.deleted ?? false,
  }
}

function toGtmTagDto(
  tag: GtmTag,
  fallbackId: string,
  variableIdsByName: ReadonlyMap<string, readonly string[]>,
): GtmTagDto {
  return {
    id: required(tag.tagId ?? fallbackId, 'tag id'),
    name: tag.name ?? '',
    type: tag.type ?? '',
    paused: tag.paused ?? false,
    firingTriggerIds: uniqueStrings(tag.firingTriggerId ?? []),
    blockingTriggerIds: uniqueStrings(tag.blockingTriggerId ?? []),
    referencedVariableIds: referencedVariableIds(tag, variableIdsByName),
    parameterKeys: parameterKeys(tag.parameter),
    fingerprint: tag.fingerprint ?? null,
  }
}

function toGtmTriggerDto(trigger: GtmTrigger, fallbackId: string): GtmTriggerDto {
  return {
    id: required(trigger.triggerId ?? fallbackId, 'trigger id'),
    name: trigger.name ?? '',
    type: trigger.type ?? '',
    customEventNames: safeCustomEventNames(trigger),
    filterKeys: uniqueStrings([
      ...conditionKeys(trigger.customEventFilter),
      ...conditionKeys(trigger.filter),
    ]),
    autoEventFilterKeys: conditionKeys(trigger.autoEventFilter),
    fingerprint: trigger.fingerprint ?? null,
  }
}

function dataLayerVariableName(variable: GtmVariable): string | null {
  if (variable.type !== 'v') return null
  const name = variable.parameter?.find((parameter) => parameter.key === 'name')?.value
  return typeof name === 'string' && name.trim() ? name : null
}

function toGtmVariableDto(variable: GtmVariable, fallbackId: string): GtmVariableDto {
  return {
    id: required(variable.variableId ?? fallbackId, 'variable id'),
    name: variable.name ?? '',
    type: variable.type ?? '',
    dataLayerVariableName: dataLayerVariableName(variable),
    parameterKeys: parameterKeys(variable.parameter),
    fingerprint: variable.fingerprint ?? null,
  }
}

function absentMapping(): GtmGoogleAdsTagFieldMappingDto {
  return { source: 'absent', literal: null, variableRef: null }
}

function unknownMapping(): GtmGoogleAdsTagFieldMappingDto {
  return { source: 'unknown', literal: null, variableRef: null }
}

type GtmGoogleAdsPersistedField =
  | 'conversionId'
  | 'conversionLabel'
  | 'value'
  | 'transactionId'
  | 'currency'

function normalizedVariableReference(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{{') || !trimmed.endsWith('}}')) return null
  const inner = trimmed.slice(2, -2)
  const normalized = inner.trim()
  if (
    !normalized
    || normalized.length > 128
    || inner.includes('{{')
    || inner.includes('}}')
    || !/^\w[\w ./-]*$/.test(normalized)
  ) return null
  return `{{${normalized}}}`
}

function normalizedLiteral(
  field: GtmGoogleAdsPersistedField,
  value: string,
): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (field === 'conversionId') {
    const match = /^(?:AW-)?(\d{1,20})$/i.exec(trimmed)
    return match ? `AW-${match[1]}` : null
  }
  if (field === 'conversionLabel') {
    return /^[\w-]{1,128}$/.test(trimmed) ? trimmed : null
  }
  if (field === 'value') {
    if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(trimmed)) return null
    const [whole, fractional = ''] = trimmed.split('.')
    const normalizedFractional = fractional.replace(/0+$/, '')
    return normalizedFractional ? `${whole}.${normalizedFractional}` : whole
  }
  if (field === 'currency') {
    return /^[a-z]{3}$/i.test(trimmed) ? trimmed.toUpperCase() : null
  }

  // An order ID is evaluated transaction data. Never persist a literal even
  // when it looks harmless; only an explicit GTM variable reference is safe.
  return null
}

function fieldMapping(
  field: GtmGoogleAdsPersistedField,
  value: string,
  source: GtmGoogleAdsFieldMapping['source'],
): GtmGoogleAdsTagFieldMappingDto {
  if (source === 'variable') {
    const variableRef = normalizedVariableReference(value)
    return variableRef
      ? { source: 'variable-ref', literal: null, variableRef }
      : unknownMapping()
  }
  if (source !== 'literal') return unknownMapping()

  const literal = normalizedLiteral(field, value)
  return literal
    ? { source: 'literal', literal, variableRef: null }
    : unknownMapping()
}

function toFieldMapping(
  mapping: GtmGoogleAdsFieldMapping | null,
  field: GtmGoogleAdsPersistedField,
): GtmGoogleAdsTagFieldMappingDto {
  return mapping ? fieldMapping(field, mapping.value, mapping.source) : absentMapping()
}

function safeTagFieldMapping(
  tag: GtmTag,
  key: string,
  field: GtmGoogleAdsPersistedField,
): GtmGoogleAdsTagFieldMappingDto {
  const parameters = (tag.parameter ?? []).filter((parameter) => parameter.key === key)
  if (parameters.length === 0) return absentMapping()
  if (parameters.length !== 1) return unknownMapping()
  const value = parameters[0]?.value
  if (typeof value !== 'string' || parameters[0]?.list || parameters[0]?.map) return unknownMapping()
  const variableRef = normalizedVariableReference(value)
  if (variableRef) return { source: 'variable-ref', literal: null, variableRef }
  if (value.includes('{{') || value.includes('}}') || !value.trim()) return unknownMapping()
  return fieldMapping(field, value, 'literal')
}

function triggerStrategy(
  assessment: GtmGoogleAdsConversionAssessment,
  triggers: readonly GtmTrigger[],
): GtmGoogleAdsTagTriggerStrategy {
  if (assessment.trigger.unresolvedTriggerIds.length > 0) return 'unknown'
  if (assessment.trigger.strategy === 'custom-event') return 'custom-event'
  if (assessment.trigger.strategy !== 'url-based') return 'unknown'

  const firingIds = new Set(assessment.trigger.firingTriggerIds)
  const resolved = triggers.filter((trigger) => trigger.triggerId && firingIds.has(trigger.triggerId))
  const hasFilters = resolved.some((trigger) =>
    (trigger.customEventFilter?.length ?? 0) > 0 ||
    (trigger.filter?.length ?? 0) > 0 ||
    (trigger.autoEventFilter?.length ?? 0) > 0)
  return hasFilters ? 'filtered' : 'all-pages'
}

function mapReviewReasons(
  assessment: GtmGoogleAdsConversionAssessment,
  tag: GtmTag,
  fields: {
    conversionId: GtmGoogleAdsTagFieldMappingDto
    conversionLabel: GtmGoogleAdsTagFieldMappingDto
    value: GtmGoogleAdsTagFieldMappingDto
    transactionId: GtmGoogleAdsTagFieldMappingDto
    currency: GtmGoogleAdsTagFieldMappingDto
  },
): GtmGoogleAdsTagReviewReason[] {
  const reasons = new Set<GtmGoogleAdsTagReviewReason>()

  if (assessment.recognition.status === 'unknown') {
    if (assessment.recognition.reason === 'custom-html') reasons.add('custom-html-opaque')
    else if (assessment.recognition.reason === 'custom-template') reasons.add('unsupported-tag-type')
    else if (assessment.recognition.reason === 'unsupported-tag-type') reasons.add('not-google-ads-tag')
    else {
      reasons.add('conversion-id-unresolved')
      reasons.add('conversion-label-unresolved')
    }
  }

  for (const reason of assessment.review.reasons) {
    if (
      reason === 'no-firing-trigger' ||
      reason === 'unresolved-firing-trigger' ||
      reason === 'url-based-trigger' ||
      reason === 'mixed-trigger-strategies' ||
      reason === 'missing-custom-event-name' ||
      reason === 'unexpected-custom-event-name'
    ) reasons.add('trigger-unresolved')
    if (reason === 'missing-hostname-filter' || reason === 'unexpected-hostname-filter') {
      reasons.add('hostname-filter-unresolved')
    }
    if (reason === 'missing-conversion-value') reasons.add('value-mapping-missing')
    if (reason === 'missing-transaction-id') reasons.add('transaction-id-mapping-missing')
  }

  if (tag.type === 'awct') {
    if (fields.conversionId.source === 'absent' || fields.conversionId.source === 'unknown') {
      reasons.add('conversion-id-unresolved')
    }
    if (fields.conversionLabel.source === 'absent' || fields.conversionLabel.source === 'unknown') {
      reasons.add('conversion-label-unresolved')
    }
    if (fields.value.source === 'absent' || fields.value.source === 'unknown') {
      reasons.add('value-mapping-missing')
    }
    if (fields.transactionId.source === 'absent' || fields.transactionId.source === 'unknown') {
      reasons.add('transaction-id-mapping-missing')
    }
    if (fields.currency.source === 'absent' || fields.currency.source === 'unknown') {
      reasons.add('currency-mapping-missing')
    }
  }

  return [...reasons]
}

export function toGtmGoogleAdsTagAssessmentDto(
  tag: GtmTag,
  triggers: readonly GtmTrigger[],
  options: GtmDtoAdapterOptions = {},
  fallbackTagId?: string,
): GtmGoogleAdsTagAssessmentDto {
  const assessment = recognizeGoogleAdsConversionTag(tag, triggers, options)
  const knownConversion = assessment.conversion
  const knownTag = tag.type === 'awct'
  const fields = {
    conversionId: gtmGoogleAdsConversionIdMappingDtoSchema.parse(knownConversion
      ? toFieldMapping(knownConversion.id, 'conversionId')
      : knownTag ? safeTagFieldMapping(tag, 'conversionId', 'conversionId') : unknownMapping()),
    conversionLabel: gtmGoogleAdsConversionLabelMappingDtoSchema.parse(knownConversion
      ? toFieldMapping(knownConversion.label, 'conversionLabel')
      : knownTag ? safeTagFieldMapping(tag, 'conversionLabel', 'conversionLabel') : unknownMapping()),
    value: gtmGoogleAdsConversionValueMappingDtoSchema.parse(knownConversion
      ? toFieldMapping(knownConversion.value, 'value')
      : knownTag ? safeTagFieldMapping(tag, 'conversionValue', 'value') : unknownMapping()),
    transactionId: gtmGoogleAdsTransactionIdMappingDtoSchema.parse(knownConversion
      ? toFieldMapping(knownConversion.transactionId, 'transactionId')
      : knownTag ? safeTagFieldMapping(tag, 'orderId', 'transactionId') : unknownMapping()),
    currency: gtmGoogleAdsCurrencyMappingDtoSchema.parse(knownConversion
      ? toFieldMapping(knownConversion.currency, 'currency')
      : knownTag ? safeTagFieldMapping(tag, 'currencyCode', 'currency') : unknownMapping()),
  }

  return {
    tagId: required(tag.tagId ?? fallbackTagId, 'Google Ads assessment tag id'),
    tagType: tag.type ?? '',
    recognition: assessment.recognition.status,
    recognitionReason: assessment.recognition.status === 'unknown' ? assessment.recognition.reason : null,
    ...fields,
    triggerStrategy: triggerStrategy(assessment, triggers),
    triggerIds: uniqueStrings(assessment.trigger.firingTriggerIds),
    triggerPredicates: triggers
      .filter(trigger => trigger.triggerId && assessment.trigger.firingTriggerIds.includes(trigger.triggerId))
      .map(triggerPredicate)
      .filter((predicate): predicate is GtmGoogleAdsTriggerPredicateDto => predicate !== null)
      .sort((left, right) => left.triggerId.localeCompare(right.triggerId)),
    reviewReasons: mapReviewReasons(assessment, tag, fields),
  }
}

export function toGtmConfigurationGraphDto(
  snapshot: GtmContainerSnapshot,
  options: GtmDtoAdapterOptions = {},
): GtmConfigurationGraphDto {
  const accountId = required(snapshot.identity.accountId, 'snapshot account id')
  const containerId = required(snapshot.identity.containerId, 'snapshot container id')
  const triggers = snapshot.entities.triggers.map((entity) => entity.raw)
  const variableIdsByName = new Map<string, string[]>()
  for (const entity of snapshot.entities.variables) {
    const name = entity.raw.name?.trim()
    if (!name) continue
    const id = required(entity.raw.variableId ?? entity.id, 'variable id')
    variableIdsByName.set(name, [...(variableIdsByName.get(name) ?? []), id])
  }

  return {
    accountId,
    containerId,
    workspaceId: snapshot.source === 'workspace'
      ? required(snapshot.identity.workspaceId, 'snapshot workspace id')
      : null,
    tags: snapshot.entities.tags.map((entity) =>
      toGtmTagDto(entity.raw, entity.id, variableIdsByName)),
    triggers: snapshot.entities.triggers.map((entity) => toGtmTriggerDto(entity.raw, entity.id)),
    variables: snapshot.entities.variables.map((entity) => toGtmVariableDto(entity.raw, entity.id)),
    googleAdsTagAssessments: snapshot.entities.tags.map((entity) =>
      toGtmGoogleAdsTagAssessmentDto(entity.raw, triggers, options, entity.id)),
  }
}

function fetchedAt(options: GtmDtoAdapterOptions): string {
  return options.fetchedAt ?? new Date().toISOString()
}

export function toGtmLiveContainerGraphDto(
  snapshot: GtmContainerSnapshot,
  options: GtmDtoAdapterOptions = {},
): GtmLiveContainerGraphDto {
  if (snapshot.source !== 'live') {
    throw new GtmApiError('Live graph adapter requires a live snapshot', 400, {
      reason: 'INVALID_SNAPSHOT_SOURCE',
    })
  }
  const version = snapshot.raw.containerVersion
  if (!version) {
    throw new GtmApiError('Live snapshot is missing its container version', 502, {
      reason: 'INVALID_PROVIDER_RESPONSE',
    })
  }
  return {
    source: 'live',
    version: toGtmContainerVersionDto(version),
    graph: toGtmConfigurationGraphDto(snapshot, options),
    fetchedAt: fetchedAt(options),
  }
}

export function toGtmDraftWorkspaceGraphDto(
  snapshot: GtmContainerSnapshot,
  options: GtmDtoAdapterOptions = {},
): GtmDraftWorkspaceGraphDto {
  if (snapshot.source !== 'workspace') {
    throw new GtmApiError('Draft graph adapter requires a workspace snapshot', 400, {
      reason: 'INVALID_SNAPSHOT_SOURCE',
    })
  }
  const workspace = snapshot.raw.workspace
  if (!workspace) {
    throw new GtmApiError('Workspace snapshot is missing its workspace', 502, {
      reason: 'INVALID_PROVIDER_RESPONSE',
    })
  }
  return {
    source: 'draft',
    workspace: toGtmWorkspaceDto(workspace),
    graph: toGtmConfigurationGraphDto(snapshot, options),
    conflictCount: snapshot.raw.workspaceStatus?.mergeConflict?.length ?? 0,
    fetchedAt: fetchedAt(options),
  }
}

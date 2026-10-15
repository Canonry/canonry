import {
  ConversionTrackingFindingCodes,
  ConversionTrackingFindingOutcomes,
  ConversionTrackingRuntimeObservations,
  ConversionTrackingStaticCheckStates,
  GoogleAdsGoalConfigurationLevels,
  deriveConversionTrackingIntegrityStatus,
  deriveGoogleAdsEffectiveGoalGraph,
  type ConversionTrackingContract,
  type ConversionTrackingFindingCode,
  type ConversionTrackingFindingOutcome,
  type ConversionTrackingIntegrityAssessmentDto,
  type ConversionTrackingIntegrityFindingDto,
  type ConversionTrackingRuntimeObservation,
  type GoogleAdsInventoryDto,
  type GtmGoogleAdsConditionPredicateDto,
  type GtmGoogleAdsTriggerPredicateDto,
  type GtmGoogleAdsTagFieldMappingDto,
  type GtmLiveContainerGraphDto,
  type GtmTagDto,
  type GtmVariableDto,
} from '@canonry/canonry-contracts'

export interface ConversionTrackingIntegrityInput {
  contract: ConversionTrackingContract
  googleAdsInventory?: GoogleAdsInventoryDto | null
  googleAdsEvidenceId?: string
  gtmLiveGraph?: GtmLiveContainerGraphDto | null
  gtmEvidenceId?: string
  runtimeObservation?: ConversionTrackingRuntimeObservation
  evaluatedAt: string
}

interface PendingFinding {
  code: ConversionTrackingFindingCode
  subject: string
  outcome: ConversionTrackingFindingOutcome
  evidenceIds: string[]
}

function finding(
  code: ConversionTrackingFindingCode,
  subject: string,
  outcome: ConversionTrackingFindingOutcome,
  evidenceId?: string,
): PendingFinding {
  return {
    code,
    subject,
    outcome,
    evidenceIds: evidenceId ? [evidenceId] : [],
  }
}

function resolvedVariableReference(
  mapping: GtmGoogleAdsTagFieldMappingDto,
  tag: GtmTagDto | undefined,
  variables: readonly GtmVariableDto[],
): boolean {
  if (mapping.source !== 'variable-ref' || !mapping.variableRef || !tag) return false
  const match = /^\{\{(.+)\}\}$/.exec(mapping.variableRef.trim())
  const name = match?.[1]?.trim()
  if (!name) return false
  return tag.referencedVariableIds.some(variableId =>
    variables.some(variable => variable.id === variableId && variable.name.trim() === name))
}

function mappingOutcome(
  mapping: GtmGoogleAdsTagFieldMappingDto,
  tag: GtmTagDto | undefined,
  variables: readonly GtmVariableDto[],
): ConversionTrackingFindingOutcome {
  if (mapping.source === 'literal') {
    return ConversionTrackingFindingOutcomes.pass
  }
  if (mapping.source === 'variable-ref') {
    // GTM built-ins are not necessarily returned in the user-variable list.
    // An unresolved reference is therefore unproven, never a static pass.
    return resolvedVariableReference(mapping, tag, variables)
      ? ConversionTrackingFindingOutcomes.pass
      : ConversionTrackingFindingOutcomes.unknown
  }
  return mapping.source === 'absent'
    ? ConversionTrackingFindingOutcomes.fail
    : ConversionTrackingFindingOutcomes.unknown
}

function expectedMappingOutcome(
  mapping: GtmGoogleAdsTagFieldMappingDto,
  expected: string,
): ConversionTrackingFindingOutcome {
  if (mapping.source === 'literal') {
    return mapping.literal === expected
      ? ConversionTrackingFindingOutcomes.pass
      : ConversionTrackingFindingOutcomes.fail
  }
  // A variable reference may resolve correctly at runtime, but a static API
  // graph does not expose that runtime value. Never infer it as a match.
  return mapping.source === 'absent'
    ? ConversionTrackingFindingOutcomes.fail
    : ConversionTrackingFindingOutcomes.unknown
}

function logicalAnd(
  outcomes: ConversionTrackingFindingOutcome[],
): ConversionTrackingFindingOutcome {
  if (outcomes.includes(ConversionTrackingFindingOutcomes.fail)) {
    return ConversionTrackingFindingOutcomes.fail
  }
  if (outcomes.includes(ConversionTrackingFindingOutcomes.unknown)) {
    return ConversionTrackingFindingOutcomes.unknown
  }
  return ConversionTrackingFindingOutcomes.pass
}

function logicalOr(
  outcomes: ConversionTrackingFindingOutcome[],
): ConversionTrackingFindingOutcome {
  if (outcomes.includes(ConversionTrackingFindingOutcomes.pass)) {
    return ConversionTrackingFindingOutcomes.pass
  }
  if (outcomes.includes(ConversionTrackingFindingOutcomes.unknown)) {
    return ConversionTrackingFindingOutcomes.unknown
  }
  return ConversionTrackingFindingOutcomes.fail
}

function hostnameOf(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return parsed.hostname.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

function predicateOutcome(
  predicate: GtmGoogleAdsConditionPredicateDto,
  candidate: string,
  kind: 'event' | 'hostname',
): ConversionTrackingFindingOutcome {
  const caseInsensitive = kind === 'hostname' || predicate.ignoreCase
  const left = caseInsensitive ? candidate.toLowerCase() : candidate
  const right = caseInsensitive ? predicate.value.toLowerCase() : predicate.value

  let matched: boolean
  switch (predicate.operator) {
    case 'equals': matched = left === right; break
    case 'contains': matched = left.includes(right); break
    case 'startsWith': matched = left.startsWith(right); break
    case 'endsWith': matched = left.endsWith(right); break
    case 'matchRegex':
    case 'urlMatches':
      try {
        matched = new RegExp(predicate.value, caseInsensitive ? 'i' : undefined).test(candidate)
      } catch {
        return ConversionTrackingFindingOutcomes.unknown
      }
      break
    default:
      return ConversionTrackingFindingOutcomes.unknown
  }
  const result = predicate.negated ? !matched : matched
  return result ? ConversionTrackingFindingOutcomes.pass : ConversionTrackingFindingOutcomes.fail
}

function triggerPredicateOutcome(
  predicates: GtmGoogleAdsConditionPredicateDto[],
  candidate: string,
  kind: 'event' | 'hostname',
  unsupportedConditionCount: number,
): ConversionTrackingFindingOutcome {
  if (predicates.length === 0) return ConversionTrackingFindingOutcomes.fail
  const outcomes = predicates.map(predicate => predicateOutcome(predicate, candidate, kind))
  if (unsupportedConditionCount > 0) outcomes.push(ConversionTrackingFindingOutcomes.unknown)
  return logicalAnd(outcomes)
}

function firingEventOutcome(
  predicate: GtmGoogleAdsTriggerPredicateDto | undefined,
  eventName: string,
): ConversionTrackingFindingOutcome {
  if (!predicate || predicate.triggerType !== 'customEvent') {
    return ConversionTrackingFindingOutcomes.unknown
  }
  return triggerPredicateOutcome(
    predicate.eventPredicates,
    eventName,
    'event',
    predicate.unsupportedConditionCount,
  )
}

function firingHostOutcome(
  predicate: GtmGoogleAdsTriggerPredicateDto | undefined,
  eventName: string,
  hostname: string,
): ConversionTrackingFindingOutcome {
  return logicalAnd([
    firingEventOutcome(predicate, eventName),
    predicate
      ? triggerPredicateOutcome(
          predicate.hostnamePredicates,
          hostname,
          'hostname',
          predicate.unsupportedConditionCount,
        )
      : ConversionTrackingFindingOutcomes.unknown,
  ])
}

function adsFindings(input: ConversionTrackingIntegrityInput): PendingFinding[] {
  const { contract, googleAdsInventory: inventory, googleAdsEvidenceId } = input
  const findings: PendingFinding[] = []
  if (!inventory || inventory.customerId !== contract.googleAds.customerId) {
    return [finding(
      ConversionTrackingFindingCodes['ads-connection-missing'],
      `customer:${contract.googleAds.customerId}`,
      ConversionTrackingFindingOutcomes.fail,
      googleAdsEvidenceId,
    )]
  }

  const action = inventory.conversionActions.find(
    candidate => candidate.id === contract.googleAds.conversionActionId
      && candidate.status === 'enabled',
  )
  findings.push(finding(
    ConversionTrackingFindingCodes['ads-conversion-action-missing'],
    `conversion-action:${contract.googleAds.conversionActionId}`,
    action ? ConversionTrackingFindingOutcomes.pass : ConversionTrackingFindingOutcomes.fail,
    googleAdsEvidenceId,
  ))

  if (contract.googleAds.requirePrimaryAction) {
    findings.push(finding(
      ConversionTrackingFindingCodes['ads-action-not-primary'],
      `conversion-action:${contract.googleAds.conversionActionId}`,
      !action
        ? ConversionTrackingFindingOutcomes.unknown
        : action.primaryForGoal
          ? ConversionTrackingFindingOutcomes.pass
          : ConversionTrackingFindingOutcomes.fail,
      googleAdsEvidenceId,
    ))
  }

  if (contract.googleAds.campaignIds.length === 0) return findings

  const graph = deriveGoogleAdsEffectiveGoalGraph(inventory)
  for (const campaignId of contract.googleAds.campaignIds) {
    const campaign = graph.campaigns.find(candidate => candidate.campaignId === campaignId)
    const matchingGoals = campaign?.goals.filter(goal =>
      goal.conversionActionIds.includes(contract.googleAds.conversionActionId),
    ) ?? []
    const campaignGoalsIncomplete = campaign?.goalConfigLevel
      === GoogleAdsGoalConfigurationLevels.campaign
      && inventory.campaignConversionGoalsComplete !== true
    findings.push(finding(
      ConversionTrackingFindingCodes['ads-goal-missing'],
      `campaign:${campaignId}/conversion-action:${contract.googleAds.conversionActionId}`,
      matchingGoals.length > 0
        ? ConversionTrackingFindingOutcomes.pass
        : campaignGoalsIncomplete
          ? ConversionTrackingFindingOutcomes.unknown
          : ConversionTrackingFindingOutcomes.fail,
      googleAdsEvidenceId,
    ))

    if (contract.googleAds.requireBiddableGoal) {
      const biddable = matchingGoals.some(goal => goal.biddable === true)
      const providerDidNotExposeBiddability = matchingGoals.length > 0
        && matchingGoals.every(goal => goal.biddable === null)
      findings.push(finding(
        ConversionTrackingFindingCodes['ads-goal-not-biddable'],
        `campaign:${campaignId}/conversion-action:${contract.googleAds.conversionActionId}`,
        matchingGoals.length === 0 || providerDidNotExposeBiddability
          ? ConversionTrackingFindingOutcomes.unknown
          : biddable
            ? ConversionTrackingFindingOutcomes.pass
            : ConversionTrackingFindingOutcomes.fail,
        googleAdsEvidenceId,
      ))
    }
  }
  return findings
}

function gtmFindings(input: ConversionTrackingIntegrityInput): PendingFinding[] {
  const { contract, gtmLiveGraph: live, gtmEvidenceId } = input
  if (!live) {
    return [
      finding(
        ConversionTrackingFindingCodes['gtm-connection-missing'],
        `container:${contract.gtm.containerId}`,
        ConversionTrackingFindingOutcomes.fail,
        gtmEvidenceId,
      ),
      finding(
        ConversionTrackingFindingCodes['gtm-live-graph-missing'],
        `container:${contract.gtm.containerId}`,
        ConversionTrackingFindingOutcomes.fail,
        gtmEvidenceId,
      ),
    ]
  }

  const graphMatches = live.graph.accountId === contract.gtm.accountId
    && live.graph.containerId === contract.gtm.containerId
  if (!graphMatches) {
    return [finding(
      ConversionTrackingFindingCodes['gtm-live-graph-missing'],
      `container:${contract.gtm.containerId}`,
      ConversionTrackingFindingOutcomes.fail,
      gtmEvidenceId,
    )]
  }

  const findings: PendingFinding[] = []
  const tag = live.graph.tags.find(candidate => candidate.id === contract.gtm.tagId)
  findings.push(finding(
    ConversionTrackingFindingCodes['gtm-tag-missing'],
    `tag:${contract.gtm.tagId}`,
    tag ? ConversionTrackingFindingOutcomes.pass : ConversionTrackingFindingOutcomes.fail,
    gtmEvidenceId,
  ))
  if (tag) {
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-tag-paused'],
      `tag:${tag.id}`,
      tag.paused ? ConversionTrackingFindingOutcomes.fail : ConversionTrackingFindingOutcomes.pass,
      gtmEvidenceId,
    ))
  }

  for (const triggerId of contract.gtm.triggerIds) {
    const linked = tag?.firingTriggerIds.includes(triggerId) === true
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-trigger-missing'],
      `trigger:${triggerId}`,
      linked && live.graph.triggers.some(candidate => candidate.id === triggerId)
        ? ConversionTrackingFindingOutcomes.pass
        : ConversionTrackingFindingOutcomes.fail,
      gtmEvidenceId,
    ))
  }
  for (const variableId of contract.gtm.variableIds) {
    const linked = tag?.referencedVariableIds.includes(variableId) === true
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-variable-missing'],
      `variable:${variableId}`,
      linked && live.graph.variables.some(candidate => candidate.id === variableId)
        ? ConversionTrackingFindingOutcomes.pass
        : ConversionTrackingFindingOutcomes.fail,
      gtmEvidenceId,
    ))
  }

  const assessment = live.graph.googleAdsTagAssessments.find(
    candidate => candidate.tagId === contract.gtm.tagId,
  )
  findings.push(finding(
    ConversionTrackingFindingCodes['gtm-tag-unrecognized'],
    `tag:${contract.gtm.tagId}`,
    !assessment || assessment.recognition === 'unknown'
      ? ConversionTrackingFindingOutcomes.unknown
      : ConversionTrackingFindingOutcomes.pass,
    gtmEvidenceId,
  ))
  if (!assessment || assessment.recognition === 'unknown') return findings

  const firingTriggerIds = new Set(tag?.firingTriggerIds ?? [])
  const triggerPredicateById = new Map(
    assessment.triggerPredicates.map(predicate => [predicate.triggerId, predicate]),
  )
  const triggerPredicates = [...firingTriggerIds].map(id => triggerPredicateById.get(id))
  const eventOutcomes = triggerPredicates.map(predicate =>
    firingEventOutcome(predicate, contract.eventName))
  let eventOutcome = eventOutcomes.length > 0
    ? logicalAnd(eventOutcomes)
    : ConversionTrackingFindingOutcomes.fail
  if (tag?.blockingTriggerIds.length && eventOutcome === ConversionTrackingFindingOutcomes.pass) {
    eventOutcome = ConversionTrackingFindingOutcomes.unknown
  }
  findings.push(finding(
    ConversionTrackingFindingCodes['gtm-event-mismatch'],
    `tag:${contract.gtm.tagId}/event:${contract.eventName}`,
    eventOutcome,
    gtmEvidenceId,
  ))

  if (contract.runtime.productionHosts.length > 0) {
    const hostOutcomes = contract.runtime.productionHosts.map((host) => {
      const hostname = hostnameOf(host)
      if (!hostname) return ConversionTrackingFindingOutcomes.unknown
      const outcomes = triggerPredicates.map(predicate =>
        firingHostOutcome(predicate, contract.eventName, hostname))
      let outcome = logicalOr(outcomes)
      if (tag?.blockingTriggerIds.length && outcome === ConversionTrackingFindingOutcomes.pass) {
        outcome = ConversionTrackingFindingOutcomes.unknown
      }
      return outcome
    })
    const firingPathOutcomes = triggerPredicates.map((predicate) => {
      const outcomes = contract.runtime.productionHosts.map((host) => {
        const hostname = hostnameOf(host)
        return hostname
          ? firingHostOutcome(predicate, contract.eventName, hostname)
          : ConversionTrackingFindingOutcomes.unknown
      })
      return logicalOr(outcomes)
    })
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-hostname-mismatch'],
      `tag:${contract.gtm.tagId}/production-hosts`,
      logicalAnd([...hostOutcomes, ...firingPathOutcomes]),
      gtmEvidenceId,
    ))
  }

  if (contract.runtime.requireValue) {
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-value-mapping-missing'],
      `tag:${contract.gtm.tagId}/value`,
      mappingOutcome(assessment.value, tag, live.graph.variables),
      gtmEvidenceId,
    ))
  }
  if (contract.runtime.requireTransactionId) {
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-transaction-id-mapping-missing'],
      `tag:${contract.gtm.tagId}/transaction-id`,
      mappingOutcome(assessment.transactionId, tag, live.graph.variables),
      gtmEvidenceId,
    ))
  }
  if (contract.runtime.requireCurrency) {
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-currency-mapping-missing'],
      `tag:${contract.gtm.tagId}/currency`,
      mappingOutcome(assessment.currency, tag, live.graph.variables),
      gtmEvidenceId,
    ))
  }
  if (contract.googleAds.conversionId) {
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-conversion-id-mismatch'],
      `tag:${contract.gtm.tagId}/conversion-id`,
      expectedMappingOutcome(assessment.conversionId, contract.googleAds.conversionId),
      gtmEvidenceId,
    ))
  }
  if (contract.googleAds.conversionLabel) {
    findings.push(finding(
      ConversionTrackingFindingCodes['gtm-conversion-label-mismatch'],
      `tag:${contract.gtm.tagId}/conversion-label`,
      expectedMappingOutcome(assessment.conversionLabel, contract.googleAds.conversionLabel),
      gtmEvidenceId,
    ))
  }
  return findings
}

/**
 * Deterministically evaluates a declared conversion against stored provider
 * evidence. This function never performs I/O and never upgrades static API
 * evidence to runtime observation.
 */
export function assessConversionTrackingIntegrity(
  input: ConversionTrackingIntegrityInput,
): ConversionTrackingIntegrityAssessmentDto {
  const staticFindings = [...adsFindings(input), ...gtmFindings(input)]
  const staticCheck = staticFindings.length > 0
    && staticFindings.every(item => item.outcome === ConversionTrackingFindingOutcomes.pass)
    ? ConversionTrackingStaticCheckStates.consistent
    : ConversionTrackingStaticCheckStates.inconsistent
  const runtimeObservation = input.runtimeObservation
    ?? ConversionTrackingRuntimeObservations['not-run']
  const status = deriveConversionTrackingIntegrityStatus({
    staticCheck,
    runtimeVerificationRequired: input.contract.runtime.verificationRequired,
    runtimeObservation,
  })

  const runtimeFindings: PendingFinding[] = input.contract.runtime.verificationRequired
    ? [
        finding(
          ConversionTrackingFindingCodes['runtime-event-not-observed'],
          `event:${input.contract.eventName}`,
          runtimeObservation === ConversionTrackingRuntimeObservations.observed
            ? ConversionTrackingFindingOutcomes.pass
            : ConversionTrackingFindingOutcomes.unknown,
        ),
        finding(
          ConversionTrackingFindingCodes['runtime-gtm-not-observed'],
          `tag:${input.contract.gtm.tagId}`,
          runtimeObservation === ConversionTrackingRuntimeObservations.observed
            ? ConversionTrackingFindingOutcomes.pass
            : ConversionTrackingFindingOutcomes.unknown,
        ),
        finding(
          ConversionTrackingFindingCodes['runtime-ads-not-observed'],
          `conversion-action:${input.contract.googleAds.conversionActionId}`,
          runtimeObservation === ConversionTrackingRuntimeObservations.observed
            ? ConversionTrackingFindingOutcomes.pass
            : ConversionTrackingFindingOutcomes.unknown,
        ),
      ]
    : []

  const findings: ConversionTrackingIntegrityFindingDto[] = [
    ...staticFindings,
    ...runtimeFindings,
  ].map(item => ({ ...item, status }))

  return {
    contract: input.contract,
    status,
    findings,
    evaluatedAt: input.evaluatedAt,
  }
}

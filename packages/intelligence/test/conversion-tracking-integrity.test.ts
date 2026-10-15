import { describe, expect, test } from 'vitest'
import {
  ConversionTrackingIntegrityStatuses,
  type ConversionTrackingContract,
  type GoogleAdsInventoryDto,
  type GtmLiveContainerGraphDto,
} from '@canonry/canonry-contracts'
import { assessConversionTrackingIntegrity } from '../src/conversion-tracking-integrity.js'

const contract: ConversionTrackingContract = {
  id: 'contract-1',
  projectId: 'project-1',
  name: 'Booking purchase',
  eventName: 'purchase',
  googleAds: {
    customerId: '1234567890',
    conversionActionId: '42',
    conversionId: 'AW-123',
    conversionLabel: 'booking',
    campaignIds: ['7'],
    requireBiddableGoal: true,
    requirePrimaryAction: true,
  },
  gtm: {
    accountId: '1',
    containerId: '2',
    tagId: '3',
    triggerIds: ['4'],
    variableIds: ['5'],
  },
  runtime: {
    verificationRequired: true,
    requireTransactionId: true,
    requireValue: true,
    requireCurrency: true,
    productionHosts: ['example.com'],
  },
  createdAt: '2026-08-14T12:00:00.000Z',
  updatedAt: '2026-08-14T12:00:00.000Z',
}

const ads: GoogleAdsInventoryDto = {
  customerId: '1234567890',
  fetchedAt: '2026-08-14T12:01:00.000Z',
  campaigns: [{ id: '7', resourceName: 'customers/1234567890/campaigns/7', name: 'Hotel', status: 'enabled' }],
  conversionActions: [{
    id: '42',
    resourceName: 'customers/1234567890/conversionActions/42',
    name: 'Booking',
    status: 'enabled',
    category: 'PURCHASE',
    origin: 'WEBSITE',
    primaryForGoal: true,
    includeInConversionsMetric: true,
  }],
  customerConversionGoals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: true }],
  campaignConversionGoals: [],
  customConversionGoals: [],
  campaignGoalConfigurations: [{ campaignId: '7', goalConfigLevel: 'customer', customGoalId: null }],
}

const gtm: GtmLiveContainerGraphDto = {
  source: 'live',
  version: {
    accountId: '1',
    containerId: '2',
    id: '6',
    path: 'accounts/1/containers/2/versions/6',
    name: 'Version 6',
    description: null,
    fingerprint: 'fp',
    deleted: false,
  },
  graph: {
    accountId: '1',
    containerId: '2',
    workspaceId: null,
    tags: [{
      id: '3',
      name: 'Booking conversion',
      type: 'awct',
      paused: false,
      firingTriggerIds: ['4'],
      blockingTriggerIds: [],
      referencedVariableIds: ['5', '6', '7'],
      parameterKeys: ['conversionId', 'conversionLabel', 'conversionValue', 'orderId', 'currencyCode'],
      fingerprint: 'tag-fp',
    }],
    triggers: [{
      id: '4',
      name: 'purchase',
      type: 'customEvent',
      customEventNames: ['purchase'],
      filterKeys: ['event'],
      autoEventFilterKeys: [],
      fingerprint: 'trigger-fp',
    }],
    variables: [{
      id: '5',
      name: 'value',
      type: 'v',
      dataLayerVariableName: 'value',
      parameterKeys: [],
      fingerprint: 'variable-fp',
    }, {
      id: '6',
      name: 'transaction_id',
      type: 'v',
      dataLayerVariableName: 'transaction_id',
      parameterKeys: [],
      fingerprint: 'transaction-id-variable-fp',
    }, {
      id: '7',
      name: 'currency',
      type: 'v',
      dataLayerVariableName: 'currency',
      parameterKeys: [],
      fingerprint: 'currency-variable-fp',
    }],
    googleAdsTagAssessments: [{
      tagId: '3',
      tagType: 'awct',
      recognition: 'recognized',
      recognitionReason: null,
      conversionId: { source: 'literal', literal: 'AW-123', variableRef: null },
      conversionLabel: { source: 'literal', literal: 'booking', variableRef: null },
      value: { source: 'variable-ref', literal: null, variableRef: '{{value}}' },
      transactionId: { source: 'variable-ref', literal: null, variableRef: '{{transaction_id}}' },
      currency: { source: 'variable-ref', literal: null, variableRef: '{{currency}}' },
      triggerStrategy: 'custom-event',
      triggerIds: ['4'],
      triggerPredicates: [{
        triggerId: '4',
        triggerType: 'customEvent',
        eventPredicates: [{ operator: 'equals', value: 'purchase', negated: false, ignoreCase: false }],
        hostnamePredicates: [{ operator: 'equals', value: 'example.com', negated: false, ignoreCase: false }],
        unsupportedConditionCount: 0,
      }],
      reviewReasons: [],
    }],
  },
  fetchedAt: '2026-08-14T12:02:00.000Z',
}

describe('assessConversionTrackingIntegrity', () => {
  test('keeps a statically consistent graph runtime-unverified without runtime evidence', () => {
    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: ads,
      googleAdsEvidenceId: 'ads-snapshot',
      gtmLiveGraph: gtm,
      gtmEvidenceId: 'gtm-snapshot',
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.status).toBe(ConversionTrackingIntegrityStatuses['runtime-unverified'])
    expect(result.findings.filter(item => item.outcome !== 'pass')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'runtime-event-not-observed', outcome: 'unknown' }),
    ]))
  })

  test('does not infer an opaque GTM tag as consistent', () => {
    const opaque = structuredClone(gtm)
    opaque.graph.googleAdsTagAssessments[0] = {
      ...opaque.graph.googleAdsTagAssessments[0]!,
      recognition: 'unknown',
      recognitionReason: 'custom-html-opaque',
    }
    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: ads,
      gtmLiveGraph: opaque,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'gtm-tag-unrecognized',
      outcome: 'unknown',
    }))
  })

  test('requires contract triggers and variables to be linked to the selected tag', () => {
    const unlinked = structuredClone(gtm)
    unlinked.graph.tags[0]!.firingTriggerIds = []
    unlinked.graph.tags[0]!.referencedVariableIds = []
    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: ads,
      gtmLiveGraph: unlinked,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gtm-trigger-missing', outcome: 'fail' }),
      expect.objectContaining({ code: 'gtm-variable-missing', outcome: 'fail' }),
    ]))
  })

  test('does not pass required mappings with dangling GTM variable references', () => {
    const dangling = structuredClone(gtm)
    const assessment = dangling.graph.googleAdsTagAssessments[0]!
    assessment.value = { source: 'variable-ref', literal: null, variableRef: '{{missing_value}}' }
    assessment.transactionId = {
      source: 'variable-ref', literal: null, variableRef: '{{missing_transaction_id}}',
    }
    assessment.currency = { source: 'variable-ref', literal: null, variableRef: '{{missing_currency}}' }

    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: ads,
      gtmLiveGraph: dangling,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gtm-value-mapping-missing', outcome: 'unknown' }),
      expect.objectContaining({ code: 'gtm-transaction-id-mapping-missing', outcome: 'unknown' }),
      expect.objectContaining({ code: 'gtm-currency-mapping-missing', outcome: 'unknown' }),
    ]))
  })

  test('keeps a missing campaign goal unknown when its bounded inventory is incomplete', () => {
    const incompleteGoals = structuredClone(ads)
    incompleteGoals.campaignGoalConfigurations = [{
      campaignId: '7',
      goalConfigLevel: 'campaign',
      customGoalId: null,
    }]
    incompleteGoals.campaignConversionGoals = []
    incompleteGoals.campaignConversionGoalsComplete = false

    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: incompleteGoals,
      gtmLiveGraph: gtm,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'ads-goal-missing',
      outcome: 'unknown',
    }))
  })

  test('normalizes URL-form production hosts without dropping www', () => {
    const urlContract = structuredClone(contract)
    urlContract.runtime.productionHosts = ['https://www.example.com/booking']
    const wwwGraph = structuredClone(gtm)
    wwwGraph.graph.googleAdsTagAssessments[0]!.triggerPredicates[0]!
      .hostnamePredicates[0]!.value = 'www.example.com'
    const result = assessConversionTrackingIntegrity({
      contract: urlContract,
      googleAdsInventory: ads,
      gtmLiveGraph: wwwGraph,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'gtm-hostname-mismatch',
      outcome: 'pass',
    }))
  })

  test.each([
    ['eventPredicates', 'gtm-event-mismatch'],
    ['hostnamePredicates', 'gtm-hostname-mismatch'],
  ] as const)('honors negation for %s', (field, findingCode) => {
    const negated = structuredClone(gtm)
    negated.graph.googleAdsTagAssessments[0]!.triggerPredicates[0]![field][0]!.negated = true
    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: ads,
      gtmLiveGraph: negated,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: findingCode,
      outcome: 'fail',
    }))
  })

  test('does not combine event and hostname predicates from different firing triggers', () => {
    const anyTriggerContract = structuredClone(contract)
    anyTriggerContract.gtm.triggerIds = []
    const split = structuredClone(gtm)
    split.graph.tags[0]!.firingTriggerIds.push('9')
    split.graph.googleAdsTagAssessments[0]!.triggerIds.push('9')
    split.graph.googleAdsTagAssessments[0]!.triggerPredicates[0]!
      .hostnamePredicates[0]!.value = 'staging.example.com'
    split.graph.googleAdsTagAssessments[0]!.triggerPredicates.push({
      triggerId: '9',
      triggerType: 'customEvent',
      eventPredicates: [{ operator: 'equals', value: 'other-event', negated: false, ignoreCase: false }],
      hostnamePredicates: [{ operator: 'equals', value: 'example.com', negated: false, ignoreCase: false }],
      unsupportedConditionCount: 0,
    })

    const result = assessConversionTrackingIntegrity({
      contract: anyTriggerContract,
      googleAdsInventory: ads,
      gtmLiveGraph: split,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'gtm-hostname-mismatch',
      outcome: 'fail',
    }))
  })

  test('does not ignore an additional all-pages firing path', () => {
    const mixed = structuredClone(gtm)
    mixed.graph.tags[0]!.firingTriggerIds.push('9')
    mixed.graph.triggers.push({
      id: '9',
      name: 'All pages',
      type: 'pageview',
      customEventNames: [],
      filterKeys: [],
      autoEventFilterKeys: [],
      fingerprint: 'all-pages-fp',
    })
    mixed.graph.googleAdsTagAssessments[0]!.triggerIds.push('9')
    mixed.graph.googleAdsTagAssessments[0]!.triggerPredicates.push({
      triggerId: '9',
      triggerType: 'pageview',
      eventPredicates: [],
      hostnamePredicates: [],
      unsupportedConditionCount: 0,
    })
    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: ads,
      gtmLiveGraph: mixed,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'gtm-event-mismatch',
      outcome: 'unknown',
    }))
  })

  test('does not rewrite a GTM hostname predicate URL into a matching hostname', () => {
    const providerLiteral = structuredClone(gtm)
    providerLiteral.graph.googleAdsTagAssessments[0]!.triggerPredicates[0]!
      .hostnamePredicates[0]!.value = 'https://example.com/booking'
    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: ads,
      gtmLiveGraph: providerLiteral,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'gtm-hostname-mismatch',
      outcome: 'fail',
    }))
  })

  test.each(['blocking trigger', 'unsupported condition'] as const)(
    'does not call the graph statically consistent with a %s',
    (reason) => {
      const uncertain = structuredClone(gtm)
      if (reason === 'blocking trigger') {
        uncertain.graph.tags[0]!.blockingTriggerIds = ['block-1']
      } else {
        uncertain.graph.googleAdsTagAssessments[0]!.triggerPredicates[0]!
          .unsupportedConditionCount = 1
      }
      const result = assessConversionTrackingIntegrity({
        contract,
        googleAdsInventory: ads,
        gtmLiveGraph: uncertain,
        evaluatedAt: '2026-08-14T12:03:00.000Z',
      })

      expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
      expect(result.findings.some(item => item.outcome === 'unknown')).toBe(true)
    },
  )

  test('requires the conversion action to be biddable in each asserted campaign', () => {
    const nonBiddable = structuredClone(ads)
    nonBiddable.customerConversionGoals[0]!.biddable = false
    const result = assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: nonBiddable,
      gtmLiveGraph: gtm,
      evaluatedAt: '2026-08-14T12:03:00.000Z',
    })

    expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'ads-goal-not-biddable',
      outcome: 'fail',
    }))
  })

  test.each(['hidden', 'removed', 'unknown'] as const)(
    'does not treat a %s conversion action as recordable',
    (status) => {
      const unavailable = structuredClone(ads)
      unavailable.conversionActions[0]!.status = status
      const result = assessConversionTrackingIntegrity({
        contract,
        googleAdsInventory: unavailable,
        gtmLiveGraph: gtm,
        evaluatedAt: '2026-08-14T12:03:00.000Z',
      })

      expect(result.status).toBe(ConversionTrackingIntegrityStatuses.configured)
      expect(result.findings).toContainEqual(expect.objectContaining({
        code: 'ads-conversion-action-missing',
        outcome: 'fail',
      }))
    },
  )
})

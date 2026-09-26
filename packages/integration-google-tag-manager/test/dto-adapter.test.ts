import {
  gtmDraftWorkspaceGraphDtoSchema,
  gtmGoogleAdsTagAssessmentDtoSchema,
  gtmLiveContainerGraphDtoSchema,
} from '@ainyc/canonry-contracts'
import { describe, expect, it } from 'vitest'
import {
  buildLiveSnapshot,
  buildWorkspaceSnapshot,
  toGtmDraftWorkspaceGraphDto,
  toGtmGoogleAdsTagAssessmentDto,
  toGtmLiveContainerGraphDto,
} from '../src/index.js'
import type { GtmCondition, GtmTag, GtmTrigger } from '../src/index.js'

function condition(type: string, left: string, right: string): GtmCondition {
  return {
    type,
    parameter: [
      { key: 'arg0', type: 'template', value: left },
      { key: 'arg1', type: 'template', value: right },
    ],
  }
}

const trigger: GtmTrigger = {
  triggerId: 'trigger_purchase',
  name: 'Purchase - production only',
  type: 'customEvent',
  customEventFilter: [condition('equals', '{{_event}}', 'purchase')],
  filter: [condition('equals', '{{Page Hostname}}', 'example.com')],
  fingerprint: 'trigger-fingerprint',
}

const conversionTag: GtmTag = {
  tagId: 'tag_purchase',
  name: 'Google Ads - Purchase',
  type: 'awct',
  paused: true,
  firingTriggerId: ['trigger_purchase'],
  parameter: [
    { key: 'conversionId', type: 'template', value: 'AW-12345678901' },
    { key: 'conversionLabel', type: 'template', value: 'purchase_label' },
    { key: 'conversionValue', type: 'template', value: '{{DLV - ecommerce.value}}' },
    { key: 'orderId', type: 'template', value: '{{DLV - ecommerce.transaction_id}}' },
    { key: 'currencyCode', type: 'template', value: '{{DLV - ecommerce.currency}}' },
  ],
  fingerprint: 'tag-fingerprint',
}

describe('contract DTO adapters', () => {
  it('maps recognized semantics to the strict assessment contract without casts', () => {
    const dto = toGtmGoogleAdsTagAssessmentDto(conversionTag, [trigger], {
      expectedEventName: 'purchase',
      expectedHostname: 'example.com',
    })

    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse(dto).success).toBe(true)
    expect(dto).toMatchObject({
      tagId: 'tag_purchase',
      recognition: 'recognized',
      recognitionReason: null,
      value: { source: 'variable-ref', variableRef: '{{DLV - ecommerce.value}}' },
      transactionId: { source: 'variable-ref', variableRef: '{{DLV - ecommerce.transaction_id}}' },
      currency: { source: 'variable-ref', variableRef: '{{DLV - ecommerce.currency}}' },
      triggerStrategy: 'custom-event',
      triggerPredicates: [{
        triggerId: 'trigger_purchase',
        triggerType: 'customEvent',
        eventPredicates: [{ operator: 'equals', value: 'purchase', negated: false, ignoreCase: false }],
        hostnamePredicates: [{ operator: 'equals', value: 'example.com', negated: false, ignoreCase: false }],
        unsupportedConditionCount: 0,
      }],
    })
    expect(dto.reviewReasons).toEqual([])
  })

  it('preserves paused state but strips parameter values and opaque custom HTML from the graph DTO', () => {
    const opaqueTag: GtmTag = {
      tagId: 'tag_opaque',
      name: 'Legacy custom HTML',
      type: 'html',
      firingTriggerId: ['trigger_purchase'],
      parameter: [{ key: 'html', type: 'template', value: '<script>private-template-body</script>' }],
    }
    const snapshot = buildLiveSnapshot({
      accountId: 'account_1',
      containerId: 'container_1',
      containerVersionId: 'version_7',
      path: 'accounts/account_1/containers/container_1/versions/version_7',
      name: 'Live',
      deleted: false,
      tag: [conversionTag, opaqueTag],
      trigger: [trigger],
      variable: [{
        variableId: 'variable_value',
        name: 'DLV - ecommerce.value',
        type: 'v',
        parameter: [{ key: 'name', type: 'template', value: 'ecommerce.value' }],
      }],
    })

    const dto = toGtmLiveContainerGraphDto(snapshot, {
      fetchedAt: '2026-08-14T16:00:00.000Z',
      expectedEventName: 'purchase',
      expectedHostname: 'example.com',
    })

    expect(gtmLiveContainerGraphDtoSchema.safeParse(dto).success).toBe(true)
    expect(dto.graph.tags.find((tag) => tag.id === 'tag_purchase')?.paused).toBe(true)
    expect(dto.graph.tags.find((tag) => tag.id === 'tag_opaque')?.parameterKeys).toEqual(['html'])
    expect(dto.graph.googleAdsTagAssessments.find((tag) => tag.tagId === 'tag_opaque')).toMatchObject({
      recognition: 'unknown',
      recognitionReason: 'custom-html',
      triggerStrategy: 'custom-event',
      triggerPredicates: [{
        triggerId: 'trigger_purchase',
        triggerType: 'customEvent',
        eventPredicates: [{ operator: 'equals', value: 'purchase', negated: false, ignoreCase: false }],
        hostnamePredicates: [{ operator: 'equals', value: 'example.com', negated: false, ignoreCase: false }],
        unsupportedConditionCount: 0,
      }],
      reviewReasons: ['custom-html-opaque'],
    })
    expect(JSON.stringify(dto)).not.toContain('private-template-body')
    expect(JSON.stringify(dto)).not.toContain('<script>')
  })

  it('preserves condition semantics and resolves nested tag variable references to graph IDs', () => {
    const semanticTrigger: GtmTrigger = {
      ...trigger,
      filter: [{
        ...condition('equals', '{{Page Hostname}}', 'example.com'),
        parameter: [
          ...condition('equals', '{{Page Hostname}}', 'example.com').parameter!,
          { key: 'negate', type: 'boolean', value: 'true' },
          { key: 'ignore_case', type: 'boolean', value: 'true' },
        ],
      }],
    }
    const nestedTag: GtmTag = {
      ...conversionTag,
      parameter: [
        ...(conversionTag.parameter ?? []),
        {
          key: 'metadata',
          type: 'list',
          list: [{ key: 'nested', type: 'template', value: 'prefix {{Nested variable}} suffix' }],
        },
      ],
    }
    const snapshot = buildLiveSnapshot({
      accountId: 'account_1',
      containerId: 'container_1',
      containerVersionId: 'version_semantics',
      tag: [nestedTag],
      trigger: [semanticTrigger],
      variable: [{ variableId: 'variable_nested', name: 'Nested variable', type: 'v' }],
    })

    const dto = toGtmLiveContainerGraphDto(snapshot)
    expect(dto.graph.tags[0]?.referencedVariableIds).toEqual(['variable_nested'])
    expect(dto.graph.googleAdsTagAssessments[0]?.triggerPredicates).toEqual([{
      triggerId: 'trigger_purchase',
      triggerType: 'customEvent',
      eventPredicates: [{ operator: 'equals', value: 'purchase', negated: false, ignoreCase: false }],
      hostnamePredicates: [{ operator: 'equals', value: 'example.com', negated: true, ignoreCase: true }],
      unsupportedConditionCount: 0,
    }])
    expect(gtmLiveContainerGraphDtoSchema.safeParse(dto).success).toBe(true)
  })

  it('maps URL filters and missing mappings to contract vocabulary', () => {
    const urlTrigger: GtmTrigger = {
      triggerId: 'trigger_url',
      type: 'init',
      filter: [condition('contains', '{{Page Path}}', '/booking')],
    }
    const bareTag: GtmTag = {
      tagId: 'tag_bare',
      type: 'awct',
      firingTriggerId: ['trigger_url'],
      parameter: [
        { key: 'conversionId', type: 'template', value: 'AW-12345678901' },
        { key: 'conversionLabel', type: 'template', value: 'booking_label' },
      ],
    }
    const dto = toGtmGoogleAdsTagAssessmentDto(bareTag, [urlTrigger])

    expect(dto.triggerStrategy).toBe('filtered')
    expect(dto.reviewReasons).toEqual(expect.arrayContaining([
      'trigger-unresolved',
      'hostname-filter-unresolved',
      'value-mapping-missing',
      'transaction-id-mapping-missing',
      'currency-mapping-missing',
    ]))
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse(dto).success).toBe(true)
  })

  it('normalizes only safe Google Ads literals and retains explicit GTM references', () => {
    const tag: GtmTag = {
      ...conversionTag,
      parameter: [
        { key: 'conversionId', type: 'template', value: 'aw-12345678901' },
        { key: 'conversionLabel', type: 'template', value: 'purchase_label' },
        { key: 'conversionValue', type: 'template', value: '125.5000' },
        { key: 'orderId', type: 'template', value: ' {{ DLV - ecommerce.transaction_id }} ' },
        { key: 'currencyCode', type: 'template', value: 'usd' },
      ],
    }

    const dto = toGtmGoogleAdsTagAssessmentDto(tag, [trigger])

    expect(dto).toMatchObject({
      conversionId: { source: 'literal', literal: 'AW-12345678901', variableRef: null },
      conversionLabel: { source: 'literal', literal: 'purchase_label', variableRef: null },
      value: { source: 'literal', literal: '125.5', variableRef: null },
      transactionId: {
        source: 'variable-ref',
        literal: null,
        variableRef: '{{DLV - ecommerce.transaction_id}}',
      },
      currency: { source: 'literal', literal: 'USD', variableRef: null },
    })
    expect(gtmGoogleAdsTagAssessmentDtoSchema.safeParse(dto).success).toBe(true)
  })

  it('redacts unsafe GTM literals before a graph snapshot can be persisted', () => {
    const secret = 'sk_live_never_persist_123456'
    const email = 'guest@example.test'
    const unsafeTag: GtmTag = {
      ...conversionTag,
      tagId: 'tag_unsafe_literals',
      name: 'Google Ads - unsafe test',
      parameter: [
        { key: 'conversionId', type: 'template', value: `AW-12345678901-${secret}` },
        { key: 'conversionLabel', type: 'template', value: `purchase_${email}` },
        { key: 'conversionValue', type: 'template', value: `125.50 ${secret}` },
        { key: 'orderId', type: 'template', value: email },
        { key: 'currencyCode', type: 'template', value: 'USD-secret' },
      ],
    }
    const snapshot = buildLiveSnapshot({
      accountId: 'account_1',
      containerId: 'container_1',
      containerVersionId: 'version_8',
      path: 'accounts/account_1/containers/container_1/versions/version_8',
      name: 'Live',
      deleted: false,
      tag: [unsafeTag],
      trigger: [trigger],
      variable: [],
    })

    const dto = toGtmLiveContainerGraphDto(snapshot, {
      fetchedAt: '2026-08-14T16:00:00.000Z',
      expectedEventName: 'purchase',
      expectedHostname: 'example.com',
    })
    const assessment = dto.graph.googleAdsTagAssessments[0]!
    const persisted = JSON.stringify(dto)

    expect(assessment.conversionId).toEqual({ source: 'unknown', literal: null, variableRef: null })
    expect(assessment.conversionLabel).toEqual({ source: 'unknown', literal: null, variableRef: null })
    expect(assessment.value).toEqual({ source: 'unknown', literal: null, variableRef: null })
    expect(assessment.transactionId).toEqual({ source: 'unknown', literal: null, variableRef: null })
    expect(assessment.currency).toEqual({ source: 'unknown', literal: null, variableRef: null })
    expect(assessment.reviewReasons).toEqual(expect.arrayContaining([
      'conversion-id-unresolved',
      'conversion-label-unresolved',
      'value-mapping-missing',
      'transaction-id-mapping-missing',
      'currency-mapping-missing',
    ]))
    expect(gtmLiveContainerGraphDtoSchema.safeParse(dto).success).toBe(true)
    expect(persisted).not.toContain(secret)
    expect(persisted).not.toContain(email)
    expect(persisted).not.toContain('125.50')
  })

  it('maps workspace identity and conflicts to the draft graph contract', () => {
    const snapshot = buildWorkspaceSnapshot({
      accountId: 'account_1',
      containerId: 'container_1',
      workspaceId: 'workspace_1',
      path: 'accounts/account_1/containers/container_1/workspaces/workspace_1',
      name: 'Default Workspace',
    }, {
      mergeConflict: [{ entityInWorkspace: { changeStatus: 'updated', tag: conversionTag } }],
    }, {
      tags: [conversionTag],
      triggers: [trigger],
      variables: [],
      folders: [],
      builtInVariables: [],
    })

    const dto = toGtmDraftWorkspaceGraphDto(snapshot, {
      fetchedAt: '2026-08-14T16:00:00.000Z',
    })

    expect(dto).toMatchObject({ source: 'draft', conflictCount: 1 })
    expect(dto.graph.workspaceId).toBe('workspace_1')
    expect(gtmDraftWorkspaceGraphDtoSchema.safeParse(dto).success).toBe(true)
  })
})

/** Stored, credential-free Google marketing evidence for the public demo. */
import {
  googleAdsConnections,
  googleAdsRawSnapshots,
  googleConnections,
  gtmConnections,
  gtmRawSnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { DemoSeedContext, DemoSeedProject } from './types.js'

const checksum = 'd'.repeat(64)

function dateAt(now: Date, offset: number): string {
  const result = new Date(now)
  result.setUTCDate(result.getUTCDate() + offset)
  return result.toISOString().slice(0, 10)
}

export function seedDemoMarketing(db: DatabaseClient, context: DemoSeedContext): void {
  for (const project of [context.simple, context.portfolio]) seedProjectMarketing(db, project, context.now)
}

function seedProjectMarketing(db: DatabaseClient, project: DemoSeedProject, now: Date): void {
  const capturedAt = now.toISOString()
  const prefix = `demo-marketing-${project.id}`
  const campaignId = `demo-signals-${project.id}-campaign`
  const adsConnectionId = `${prefix}-google-ads`
  const gtmConnectionId = `${prefix}-gtm`
  const adsRunId = `${prefix}-google-ads-run`
  const gtmRunId = `${prefix}-gtm-run`
  const customerSnapshotId = `${prefix}-customers`
  const inventorySnapshotId = `${prefix}-inventory`
  const metricsSnapshotId = `${prefix}-metrics`
  const gtmSnapshotId = `${prefix}-gtm-live`

  // GBP visibility is controlled by the demo's read-only Google connection
  // store. This DB metadata gives that store a safe, selected connection.
  db.insert(googleConnections).values({
    id: `${prefix}-gbp`, domain: project.domain, connectionType: 'gbp',
    propertyId: `accounts/sample-${project.id}`, scopes: [], createdByProjectId: project.id,
    createdAt: capturedAt, updatedAt: capturedAt,
  }).run()
  db.insert(runs).values([
    { id: adsRunId, projectId: project.id, kind: 'google-ads-sync', status: 'completed', trigger: 'manual', createdAt: capturedAt, finishedAt: capturedAt },
    { id: gtmRunId, projectId: project.id, kind: 'gtm-sync', status: 'completed', trigger: 'manual', createdAt: capturedAt, finishedAt: capturedAt },
  ]).run()
  db.insert(googleAdsConnections).values({
    id: adsConnectionId, projectId: project.id, selectedCustomerId: 'demo-customer',
    selectedCustomerName: 'Sample Google Ads account', selectedCustomerCurrencyCode: 'USD',
    selectedCustomerTimeZone: 'UTC', selectedCustomerStatus: 'enabled', scopes: [],
    lastValidatedAt: capturedAt, lastCustomerSnapshotId: customerSnapshotId,
    lastInventorySnapshotAt: capturedAt, lastInventorySnapshotId: inventorySnapshotId,
    lastMetricsSnapshotAt: capturedAt, lastMetricsSnapshotId: metricsSnapshotId,
    createdAt: capturedAt, updatedAt: capturedAt,
  }).run()
  db.insert(gtmConnections).values({
    id: gtmConnectionId, projectId: project.id, selectedAccountId: 'demo-account', selectedAccountName: 'Sample account',
    selectedContainerId: 'demo-container', selectedContainerName: 'Sample web container', selectedContainerPublicId: 'GTM-SAMPLE',
    selectedWorkspaceId: 'demo-workspace', selectedWorkspaceName: 'Sample workspace', scopes: [],
    lastValidatedAt: capturedAt, lastSnapshotAt: capturedAt, lastSnapshotId: gtmSnapshotId,
    createdAt: capturedAt, updatedAt: capturedAt,
  }).run()

  db.insert(googleAdsRawSnapshots).values([
    {
      id: customerSnapshotId, projectId: project.id, connectionId: adsConnectionId, runId: adsRunId,
      kind: 'accessible-customers', customerId: 'demo-customer', payloadChecksum: checksum, rawPayloadSha256: null,
      rawPayloadBytes: null, redactedFieldCount: 0, capturedAt, createdAt: capturedAt,
      payload: {
        kind: 'accessible-customers', data: {
          customers: [{
            resourceName: 'customers/demo-customer', customerId: 'demo-customer', parentCustomerId: null,
            descriptiveName: 'Sample Google Ads account', currencyCode: 'USD', timeZone: 'UTC',
            manager: false, hidden: false, testAccount: true, level: 0, status: 'enabled',
          }],
          totalAccessible: 1, truncated: false,
          selection: { loginCustomerId: null, customerId: 'demo-customer', selectedAt: capturedAt },
          fetchedAt: capturedAt,
        },
      },
    },
    {
      id: inventorySnapshotId, projectId: project.id, connectionId: adsConnectionId, runId: adsRunId,
      kind: 'inventory', customerId: 'demo-customer', payloadChecksum: checksum, rawPayloadSha256: null,
      rawPayloadBytes: null, redactedFieldCount: 0, capturedAt, createdAt: capturedAt,
      payload: {
        kind: 'inventory', data: {
          customerId: 'demo-customer', fetchedAt: capturedAt,
          campaigns: [{ id: campaignId, resourceName: `customers/demo-customer/campaigns/${campaignId}`, name: 'Sample search campaign', status: 'enabled', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MAXIMIZE_CONVERSIONS' }],
          conversionActions: [{ id: 'demo-action', resourceName: 'customers/demo-customer/conversionActions/demo-action', name: 'Sample lead', status: 'enabled', category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', primaryForGoal: true, includeInConversionsMetric: true }],
          customerConversionGoals: [{ category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true }],
          campaignConversionGoals: [], customConversionGoals: [],
          campaignGoalConfigurations: [{ campaignId, goalConfigLevel: 'customer', customGoalId: null }],
        },
      },
    },
    {
      id: metricsSnapshotId, projectId: project.id, connectionId: adsConnectionId, runId: adsRunId,
      kind: 'campaign-metrics', customerId: 'demo-customer', payloadChecksum: checksum, rawPayloadSha256: null,
      rawPayloadBytes: null, redactedFieldCount: 0, capturedAt, createdAt: capturedAt,
      payload: {
        kind: 'campaign-metrics', data: {
          query: { campaignIds: [campaignId], startDate: dateAt(now, -30), endDate: dateAt(now, 0) },
          rows: Array.from({ length: 14 }, (_, index) => ({ campaignId, date: dateAt(now, -14 + index), impressions: 260 + index * 17, clicks: 14 + index, costMicros: 1_500_000 + index * 75_000, conversions: 1 + (index % 3) / 2, conversionValueMicros: 7_500_000 + index * 300_000 })),
          truncated: false, fetchedAt: capturedAt,
        },
      },
    },
  ]).run()
  db.insert(gtmRawSnapshots).values({
    id: gtmSnapshotId, projectId: project.id, connectionId: gtmConnectionId, runId: gtmRunId,
    kind: 'container', accountId: 'demo-account', containerId: 'demo-container', workspaceId: 'demo-workspace',
    payloadChecksum: checksum, rawPayloadSha256: null, rawPayloadBytes: null, redactedFieldCount: 0,
    capturedAt, createdAt: capturedAt,
    payload: {
      kind: 'container', data: {
        account: { id: 'demo-account', path: 'accounts/demo-account', name: 'Sample account', shareData: null },
        container: { accountId: 'demo-account', id: 'demo-container', path: 'accounts/demo-account/containers/demo-container', name: 'Sample web container', publicId: 'GTM-SAMPLE', domainName: project.domain, usageContexts: ['web'] },
        workspaces: [], draft: null, fetchedAt: capturedAt,
        live: {
          source: 'live', version: { accountId: 'demo-account', containerId: 'demo-container', id: 'demo-version', path: 'accounts/demo-account/containers/demo-container/versions/demo-version', name: 'Sample published version', description: null, fingerprint: 'sample-version', deleted: false },
          graph: {
            accountId: 'demo-account', containerId: 'demo-container', workspaceId: null,
            tags: [{ id: 'demo-tag', name: 'Sample lead conversion', type: 'awct', paused: false, firingTriggerIds: ['demo-trigger'], blockingTriggerIds: [], referencedVariableIds: ['demo-value', 'demo-transaction', 'demo-currency'], parameterKeys: ['conversionId', 'conversionLabel', 'conversionValue', 'orderId', 'currencyCode'], fingerprint: 'sample-tag' }],
            triggers: [{ id: 'demo-trigger', name: 'generate_lead', type: 'customEvent', customEventNames: ['generate_lead'], filterKeys: ['event'], autoEventFilterKeys: [], fingerprint: 'sample-trigger' }],
            variables: [
              { id: 'demo-value', name: 'value', type: 'v', dataLayerVariableName: 'value', parameterKeys: [], fingerprint: 'sample-value' },
              { id: 'demo-transaction', name: 'transaction_id', type: 'v', dataLayerVariableName: 'transaction_id', parameterKeys: [], fingerprint: 'sample-transaction' },
              { id: 'demo-currency', name: 'currency', type: 'v', dataLayerVariableName: 'currency', parameterKeys: [], fingerprint: 'sample-currency' },
            ],
            googleAdsTagAssessments: [{ tagId: 'demo-tag', tagType: 'awct', recognition: 'recognized', recognitionReason: null, conversionId: { source: 'literal', literal: 'AW-123456', variableRef: null }, conversionLabel: { source: 'literal', literal: 'demo-label', variableRef: null }, value: { source: 'variable-ref', literal: null, variableRef: '{{value}}' }, transactionId: { source: 'variable-ref', literal: null, variableRef: '{{transaction_id}}' }, currency: { source: 'variable-ref', literal: null, variableRef: '{{currency}}' }, triggerStrategy: 'custom-event', triggerIds: ['demo-trigger'], triggerPredicates: [{ triggerId: 'demo-trigger', triggerType: 'customEvent', eventPredicates: [{ operator: 'equals', value: 'generate_lead', negated: false, ignoreCase: false }], hostnamePredicates: [{ operator: 'equals', value: project.domain, negated: false, ignoreCase: false }], unsupportedConditionCount: 0 }], reviewReasons: [] }],
          }, fetchedAt: capturedAt,
        },
      },
    },
  }).run()
}

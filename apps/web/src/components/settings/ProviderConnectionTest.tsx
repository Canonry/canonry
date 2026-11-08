import { ProviderConnectionTestStatuses } from '@canonry/canonry-contracts'

import type { MetricTone } from '../../view-models.js'
import { isConnectedRecord, isFailedRecord, type ProviderConnectionTestRecord } from '../../queries/provider-connection-tests.js'

export const PROVIDER_CONNECTION_TEST_COPY = {
  connected: 'Connected',
  savedNotVerified: 'Saved, not verified',
  testOne: 'Test connection',
  testMany: 'Test connections',
  testing: 'Testing…',
  saveFirst: 'Save your changes, then test the connection.',
  results: 'Connection test results',
  connectedLine: 'Connected.',
  failed: (message: string) => `Test failed: ${message}`,
  notRun: (message: string) => `Could not run the test: ${message}`,
} as const

/** One status for one or more connections: Connected only when every one passed its latest test. */
export function providerConnectionStatus(records: readonly (ProviderConnectionTestRecord | undefined)[]): { label: string; tone: MetricTone } {
  if (records.length > 0 && records.every(isConnectedRecord)) return { label: PROVIDER_CONNECTION_TEST_COPY.connected, tone: 'positive' }
  return { label: PROVIDER_CONNECTION_TEST_COPY.savedNotVerified, tone: records.some(isFailedRecord) ? 'caution' : 'neutral' }
}

/** What one test showed, as a sentence. The provider's own words explain a failure or an unverifiable key. */
export function providerConnectionTestSummary(record: ProviderConnectionTestRecord): string {
  if (record.kind === 'error') return PROVIDER_CONNECTION_TEST_COPY.notRun(record.message)
  switch (record.result.status) {
    case ProviderConnectionTestStatuses.connected: return PROVIDER_CONNECTION_TEST_COPY.connectedLine
    case ProviderConnectionTestStatuses.failed: return PROVIDER_CONNECTION_TEST_COPY.failed(record.result.message)
    case ProviderConnectionTestStatuses['not-verified']: return record.result.message
  }
}

export function ProviderConnectionTestLine({ record, label }: { record: ProviderConnectionTestRecord; label?: string }) {
  const tone = isConnectedRecord(record) ? 'text-positive-400' : isFailedRecord(record) ? 'text-negative-400' : 'text-secondary'
  return (
    <p className={`break-words text-copy-14 ${tone}`}>
      {label ? <span className="text-heading">{label}: </span> : null}
      {providerConnectionTestSummary(record)}
    </p>
  )
}

import { ProviderConnectionTestStatuses } from '@canonry/canonry-contracts'

import type { MetricTone } from '../../view-models.js'
import { formatSweepInstant } from '../../lib/format-helpers.js'
import { isConnectedRecord, isFailedRecord, type ProviderConnectionTestRecord } from '../../queries/provider-connection-tests.js'
import { joinWithAnd } from '../../lib/visibility-trend-helpers.js'

/** A provider's own message as a sentence, so a following sentence reads cleanly. */
function asSentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

export const PROVIDER_CONNECTION_TEST_COPY = {
  connected: 'Connected',
  savedNotVerified: 'Saved, not verified',
  testOne: 'Test connection',
  testMany: 'Test connections',
  testing: 'Testing…',
  saveFirst: 'Save your changes, then test the connection.',
  /** What one click sends, said before it is sent: each test is a live request on the operator's account. */
  sends: (labels: readonly string[]) => labels.length === 1
    ? `Sends one short request to ${labels[0]}, using your provider account.`
    : `Sends one short request each to ${joinWithAnd(labels)}, using your provider accounts.`,
  results: 'Connection test results',
  connectedLine: 'Connected.',
  failed: (message: string) => `Test failed: ${asSentence(message)}`,
  notRun: (message: string) => `Could not run the test: ${asSentence(message)}`,
  /** When a result was checked, in the viewer's zone: the time alone today, the day too before that. */
  checkedAt: (checkedAt: string, now: Date = new Date()) => `Checked ${formatSweepInstant(checkedAt, now.toISOString(), now)}.`,
} as const

/** One status for one or more connections: Connected only when every one's latest test passed. */
export function providerConnectionStatus(results: readonly (ProviderConnectionTestRecord | undefined)[]): { label: string; tone: MetricTone } {
  if (results.length > 0 && results.every(isConnectedRecord)) return { label: PROVIDER_CONNECTION_TEST_COPY.connected, tone: 'positive' }
  return { label: PROVIDER_CONNECTION_TEST_COPY.savedNotVerified, tone: results.some(isFailedRecord) ? 'caution' : 'neutral' }
}

/** What one test showed, as a sentence. The provider's own words explain a failure or an unverifiable key. */
export function providerConnectionTestSummary(record: ProviderConnectionTestRecord): string {
  if (record.kind === 'error') return PROVIDER_CONNECTION_TEST_COPY.notRun(record.message)
  switch (record.result.status) {
    case ProviderConnectionTestStatuses.connected: return PROVIDER_CONNECTION_TEST_COPY.connectedLine
    case ProviderConnectionTestStatuses.failed: return PROVIDER_CONNECTION_TEST_COPY.failed(record.result.message)
    case ProviderConnectionTestStatuses['not-verified']: return asSentence(record.result.message)
  }
}

export function ProviderConnectionTestLine({ record, label }: { record: ProviderConnectionTestRecord; label?: string }) {
  const tone = isConnectedRecord(record) ? 'text-positive-400' : isFailedRecord(record) ? 'text-negative-400' : 'text-secondary'
  return (
    <p className={`break-words text-copy-14 ${tone}`}>
      {label ? <span className="text-heading">{label}: </span> : null}
      {providerConnectionTestSummary(record)}
      {record.kind === 'result' ? <span className="text-secondary"> {PROVIDER_CONNECTION_TEST_COPY.checkedAt(record.result.checkedAt)}</span> : null}
    </p>
  )
}

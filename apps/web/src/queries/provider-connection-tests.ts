import { queryOptions, skipToken, useMutation, useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { describeError, ProviderConnectionTestStatuses, type ProviderConnectionLastTestDto } from '@canonry/canonry-contracts'

import { testProviderConnection } from '../api.js'

/**
 * A test this tab just ran lives in the tab's query cache, one entry per
 * connection, so setup and Settings show it at once. The server keeps the
 * latest result too (`lastTest` on the connection), which is what a reload or
 * another tab reads. Only a test writes a cache entry, and a settings change
 * forgets it.
 */
const PROVIDER_CONNECTION_TEST_KEY = 'provider-connection-test'

export type ProviderConnectionTestRecord =
  | { kind: 'result'; result: ProviderConnectionLastTestDto; revision: string | null }
  /** The test request itself was refused (no permission, unsupported host, network). */
  | { kind: 'error'; message: string; at: string; revision: string | null }

export type ProviderConnectionTestResultRecord = Extract<ProviderConnectionTestRecord, { kind: 'result' }>

export interface ProviderConnectionTestTarget {
  name: string
  /**
   * The saved connection revision on screen, when known. Only a record of this
   * revision is shown; one from another revision, or one recorded without a
   * revision, may describe settings changed since (from the CLI or another tab).
   */
  revision?: string
  /** The server's latest test of the connection's active settings, when the page has it. */
  lastTest?: ProviderConnectionLastTestDto | null
}

function recordOptions(name: string) {
  return queryOptions<ProviderConnectionTestRecord>({
    queryKey: [PROVIDER_CONNECTION_TEST_KEY, name],
    queryFn: skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

function recordTime(record: ProviderConnectionTestRecord): string {
  return record.kind === 'result' ? record.result.checkedAt : record.at
}

export function isConnectedRecord(record: ProviderConnectionTestRecord | undefined): boolean {
  return record?.kind === 'result' && record.result.status === ProviderConnectionTestStatuses.connected
}

/** A test ran and did not pass: the provider refused, or the request to test was refused. */
export function isFailedRecord(record: ProviderConnectionTestRecord | undefined): boolean {
  return record?.kind === 'error' || (record?.kind === 'result' && record.result.status === ProviderConnectionTestStatuses.failed)
}

/**
 * For each target: `results` holds the latest test result of its current
 * settings, this tab's or the server's, whichever is newer; `records` holds
 * what to show beside it, which is that result unless this tab's last attempt
 * to test was refused after it. A refused attempt says nothing about the
 * connection, so it never replaces a result.
 */
export function useProviderConnectionTestRecords(targets: readonly ProviderConnectionTestTarget[]) {
  const stored = useQueries({ queries: targets.map(target => recordOptions(target.name)) })
  const results: (ProviderConnectionTestResultRecord | undefined)[] = []
  const records: (ProviderConnectionTestRecord | undefined)[] = []
  targets.forEach((target, index) => {
    const cached = stored[index]?.data
    // A test of other saved settings, or of settings it cannot name, says nothing about these.
    const tab = cached && (target.revision === undefined || cached.revision === target.revision) ? cached : undefined
    const server: ProviderConnectionTestResultRecord | undefined = target.lastTest
      ? { kind: 'result', result: target.lastTest, revision: target.revision ?? null }
      : undefined
    const tabResult = tab?.kind === 'result' ? tab : undefined
    const result = !tabResult ? server : !server ? tabResult : recordTime(tabResult) >= recordTime(server) ? tabResult : server
    results.push(result)
    records.push(tab?.kind === 'error' && (!result || recordTime(tab) >= recordTime(result)) ? tab : result)
  })
  return { results, records }
}

/** The latest test of each target, and one action that tests them all. */
export function useProviderConnectionTests(targets: readonly ProviderConnectionTestTarget[]) {
  const queryClient = useQueryClient()
  const { results, records } = useProviderConnectionTestRecords(targets)
  const mutation = useMutation({
    mutationFn: async (selected: readonly ProviderConnectionTestTarget[]) => {
      await Promise.all(selected.map(async target => {
        const revision = target.revision ?? null
        let record: ProviderConnectionTestRecord
        try {
          record = { kind: 'result', result: await testProviderConnection(target.name), revision }
        } catch (error) {
          record = { kind: 'error', message: describeError(error), at: new Date().toISOString(), revision }
        }
        queryClient.setQueryData(recordOptions(target.name).queryKey, record)
      }))
    },
  })
  return {
    results,
    records,
    testing: mutation.isPending,
    test: () => mutation.mutate(targets),
    allConnected: targets.length > 0 && results.every(isConnectedRecord),
  }
}

/** Forget this tab's results once saved settings change: one connection's, or every one's. */
export function forgetProviderConnectionTests(queryClient: Pick<QueryClient, 'removeQueries'>, name?: string): void {
  queryClient.removeQueries({ queryKey: name === undefined ? [PROVIDER_CONNECTION_TEST_KEY] : recordOptions(name).queryKey })
}

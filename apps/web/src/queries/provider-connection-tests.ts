import { queryOptions, skipToken, useMutation, useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { describeError, ProviderConnectionTestStatuses, type ProviderConnectionTestResultDto } from '@canonry/canonry-contracts'

import { testProviderConnection } from '../api.js'

/**
 * Connection test results live in this tab's query cache, one entry per
 * connection, so setup and Settings show the same state. Nothing fetches
 * them: only a test writes one, and a settings change forgets it.
 */
const PROVIDER_CONNECTION_TEST_KEY = 'provider-connection-test'

export type ProviderConnectionTestRecord =
  | { kind: 'result'; result: ProviderConnectionTestResultDto; revision: string | null }
  /** The test request itself was refused (no permission, unsupported host, network). */
  | { kind: 'error'; message: string; revision: string | null }

export interface ProviderConnectionTestTarget {
  name: string
  /**
   * The saved connection revision on screen, when known. Only a record of this
   * revision is shown; one from another revision, or one recorded without a
   * revision, may describe settings changed since (from the CLI or another tab).
   */
  revision?: string
}

function recordOptions(name: string) {
  return queryOptions<ProviderConnectionTestRecord>({
    queryKey: [PROVIDER_CONNECTION_TEST_KEY, name],
    queryFn: skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
  })
}

export function isConnectedRecord(record: ProviderConnectionTestRecord | undefined): boolean {
  return record?.kind === 'result' && record.result.status === ProviderConnectionTestStatuses.connected
}

/** A test ran and did not pass: the provider refused, or the request to test was refused. */
export function isFailedRecord(record: ProviderConnectionTestRecord | undefined): boolean {
  return record?.kind === 'error' || (record?.kind === 'result' && record.result.status === ProviderConnectionTestStatuses.failed)
}

/** The latest test of each target that still describes its saved settings. */
export function useProviderConnectionTestRecords(targets: readonly ProviderConnectionTestTarget[]): (ProviderConnectionTestRecord | undefined)[] {
  const stored = useQueries({ queries: targets.map(target => recordOptions(target.name)) })
  return targets.map((target, index) => {
    const record = stored[index]?.data
    if (!record) return undefined
    // A test of other saved settings, or of settings it cannot name, says nothing about these.
    if (target.revision !== undefined && record.revision !== target.revision) return undefined
    return record
  })
}

/** The latest test of each target, and one action that tests them all. */
export function useProviderConnectionTests(targets: readonly ProviderConnectionTestTarget[]) {
  const queryClient = useQueryClient()
  const records = useProviderConnectionTestRecords(targets)
  const mutation = useMutation({
    mutationFn: async (selected: readonly ProviderConnectionTestTarget[]) => {
      await Promise.all(selected.map(async target => {
        const revision = target.revision ?? null
        let record: ProviderConnectionTestRecord
        try {
          record = { kind: 'result', result: await testProviderConnection(target.name), revision }
        } catch (error) {
          record = { kind: 'error', message: describeError(error), revision }
        }
        queryClient.setQueryData(recordOptions(target.name).queryKey, record)
      }))
    },
  })
  return {
    records,
    testing: mutation.isPending,
    test: () => mutation.mutate(targets),
    allConnected: targets.length > 0 && records.every(isConnectedRecord),
    anyFailed: records.some(isFailedRecord),
  }
}

/** Forget test results once saved settings change: one connection's, or every one's. */
export function forgetProviderConnectionTests(queryClient: Pick<QueryClient, 'removeQueries'>, name?: string): void {
  queryClient.removeQueries({ queryKey: name === undefined ? [PROVIDER_CONNECTION_TEST_KEY] : recordOptions(name).queryKey })
}

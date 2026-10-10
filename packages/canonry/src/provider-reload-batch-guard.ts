import { isDeepStrictEqual } from 'node:util'
import { and, inArray } from 'drizzle-orm'
import { providerBatches, type DatabaseClient } from '@ainyc/canonry-db'
import { operationInProgress, ProviderBatchStatuses, type ProviderConfig } from '@ainyc/canonry-contracts'
import { resolveRegistration, type RegisteredProvider } from './provider-registry.js'

function pendingBatchIdentity(provider: RegisteredProvider): Omit<ProviderConfig, 'quotaPolicy'> {
  const { quotaPolicy: _quotaPolicy, ...identity } = resolveRegistration(provider.adapter, provider.config).config
  return identity
}

/** Queued batch dispatch, polling, ingestion and cancellation need the original registration. */
export function assertProviderReloadKeepsPendingBatches(
  db: DatabaseClient,
  previous: readonly RegisteredProvider[],
  next: readonly RegisteredProvider[],
  executing: readonly { runId: string; registration: RegisteredProvider }[] = [],
): void {
  const nextByName = new Map(next.map(provider => [provider.adapter.name, provider]))
  const changedRegistration = (provider: RegisteredProvider): boolean => {
    const replacement = nextByName.get(provider.adapter.name)
    return !replacement || !isDeepStrictEqual(pendingBatchIdentity(provider), pendingBatchIdentity(replacement))
  }
  const changed = previous.filter(changedRegistration).map(provider => provider.adapter.name)
  const active = executing.filter(snapshot => changedRegistration(snapshot.registration))
  if (changed.length === 0 && active.length === 0) return
  const pending = changed.length === 0 ? [] : db.select({ id: providerBatches.id, provider: providerBatches.provider, runId: providerBatches.runId })
    .from(providerBatches)
    .where(and(
      inArray(providerBatches.provider, changed),
      inArray(providerBatches.status, [ProviderBatchStatuses.submitting, ProviderBatchStatuses.submitted, ProviderBatchStatuses.ended]),
    ))
    .all()
  if (pending.length === 0 && active.length === 0) return
  throw operationInProgress('Changes to provider credentials or execution settings must wait for outstanding batch work to settle.', {
    providers: [...new Set([...pending.map(batch => batch.provider), ...active.map(snapshot => snapshot.registration.adapter.name)])].sort(),
    batchIds: pending.map(batch => batch.id).sort(),
    runIds: [...new Set([...pending.map(batch => batch.runId), ...active.map(snapshot => snapshot.runId)])].sort(),
  })
}

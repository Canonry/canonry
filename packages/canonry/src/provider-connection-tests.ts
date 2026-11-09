import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { providerConnectionTests, type DatabaseClient } from '@canonry/canonry-db'
import {
  providerConnectionLastTestDtoSchema,
  ProviderConnectionTestStatuses,
  type ProviderConfig,
  type ProviderConnectionLastTestDto,
  type ProviderConnectionTestResultDto,
} from '@canonry/canonry-contracts'

/**
 * The settings a connection test exercises. Request limits, batch and pricing
 * change nothing about reaching the provider, so editing them keeps a result.
 */
function testedSettings(config: ProviderConfig) {
  return {
    provider: config.provider,
    apiKey: config.apiKey ?? null,
    baseUrl: config.baseUrl ?? null,
    model: config.model ?? null,
    cdpEndpoint: config.cdpEndpoint ?? null,
    vertexProject: config.vertexProject ?? null,
    vertexRegion: config.vertexRegion ?? null,
    vertexCredentials: config.vertexCredentials ?? null,
  }
}

export type ProviderConnectionTestStore = ReturnType<typeof createProviderConnectionTestStore>

/**
 * The latest test of each provider connection, kept in the database with a
 * keyed fingerprint of the registration it checked. A result outlives a reload
 * or a restart, but never describes settings it did not test: once the key,
 * endpoint, model or Vertex settings change, `read` returns null.
 */
export function createProviderConnectionTestStore(db: DatabaseClient, fingerprintKey: string) {
  function fingerprint(config: ProviderConfig): string {
    return crypto.createHmac('sha256', fingerprintKey).update(JSON.stringify(testedSettings(config))).digest('hex')
  }

  return {
    fingerprint,

    /** Keep a result for the registration whose fingerprint was taken when the test started. */
    record(name: string, testedFingerprint: string, result: ProviderConnectionTestResultDto): void {
      const values = {
        fingerprint: testedFingerprint,
        status: result.status,
        message: result.message,
        model: result.model,
        checkedAt: result.checkedAt,
        durationMs: result.durationMs,
      }
      db.insert(providerConnectionTests)
        .values({ provider: name, ...values })
        .onConflictDoUpdate({ target: providerConnectionTests.provider, set: values })
        .run()
    },

    /** The latest test of these exact settings, or null when there is none or they changed since. */
    read(name: string, config: ProviderConfig | undefined): ProviderConnectionLastTestDto | null {
      if (!config) return null
      const row = db.select().from(providerConnectionTests).where(eq(providerConnectionTests.provider, name)).get()
      if (!row || row.fingerprint !== fingerprint(config)) return null
      // A status this build does not know reads as no test rather than a guess.
      const parsed = providerConnectionLastTestDtoSchema.safeParse({
        status: row.status,
        ok: row.status !== ProviderConnectionTestStatuses.failed,
        message: row.message,
        model: row.model,
        checkedAt: row.checkedAt,
        durationMs: row.durationMs,
      })
      return parsed.success ? parsed.data : null
    },

    forget(name: string): void {
      db.delete(providerConnectionTests).where(eq(providerConnectionTests.provider, name)).run()
    },
  }
}

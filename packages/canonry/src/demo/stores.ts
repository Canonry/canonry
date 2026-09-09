import { and, eq } from 'drizzle-orm'
import { assessConversionTrackingIntegrity } from '@ainyc/canonry-intelligence'
import { bingConnections, googleConnections, type DatabaseClient } from '@ainyc/canonry-db'
import type { ApiRoutesOptions } from '@ainyc/canonry-api-routes'
import type { DemoSeedContext } from './types.js'

function refuseMutation(): never { throw new Error('The public demo stores are view only.') }

/** Synthetic connection metadata, with no usable provider credential. */
export function demoReadOptions(db: DatabaseClient, context: DemoSeedContext): Pick<ApiRoutesOptions,
  'googleConnectionStore' | 'googleStateSecret' | 'bingConnectionStore' | 'ga4CredentialStore' | 'getBacklinksStatus' | 'listCachedReleases' | 'assessConversionTrackingIntegrity'> {
  const mapGoogle = (row: typeof googleConnections.$inferSelect) => ({
    domain: row.domain, connectionType: row.connectionType as 'gsc' | 'ga4' | 'gbp',
    propertyId: row.propertyId, createdByProjectId: row.createdByProjectId,
    createdAt: row.createdAt, updatedAt: row.updatedAt, scopes: [],
  })
  return {
    // Required to register stored Google readers. No OAuth callbacks are
    // allowed, and no Google client id, secret, token, or transport is wired.
    googleStateSecret: 'public-demo-no-oauth-callbacks',
    googleConnectionStore: {
      listConnections: domain => db.select().from(googleConnections).where(eq(googleConnections.domain, domain)).all().map(mapGoogle),
      getConnection: (domain, type) => {
        const row = db.select().from(googleConnections).where(and(eq(googleConnections.domain, domain), eq(googleConnections.connectionType, type))).get()
        return row ? mapGoogle(row) : undefined
      },
      upsertConnection: refuseMutation, updateConnection: refuseMutation, deleteConnection: refuseMutation,
    },
    bingConnectionStore: {
      getConnection: domain => {
        const row = db.select().from(bingConnections).where(eq(bingConnections.domain, domain)).get()
        return row ? { domain, siteUrl: row.siteUrl, apiKey: '', createdAt: row.createdAt, updatedAt: row.updatedAt } : undefined
      },
      upsertConnection: refuseMutation, updateConnection: refuseMutation, deleteConnection: refuseMutation,
    },
    ga4CredentialStore: {
      getConnection: projectName => {
        const project = [context.simple, context.portfolio].find(item => item.name === projectName)
        return project ? { projectName, propertyId: 'demo-property', clientEmail: 'sample@analytics.example', privateKey: '', createdAt: context.now.toISOString(), updatedAt: context.now.toISOString() } : undefined
      },
      upsertConnection: refuseMutation, deleteConnection: refuseMutation,
    },
    assessConversionTrackingIntegrity: ({ contract, googleAdsSnapshot, gtmSnapshot }) => assessConversionTrackingIntegrity({
      contract,
      googleAdsInventory: googleAdsSnapshot?.payload.kind === 'inventory' ? googleAdsSnapshot.payload.data : null,
      googleAdsEvidenceId: googleAdsSnapshot?.metadata.id,
      gtmLiveGraph: gtmSnapshot?.payload.kind === 'container' ? gtmSnapshot.payload.data.live : gtmSnapshot?.payload.kind === 'live' ? gtmSnapshot.payload.data : null,
      gtmEvidenceId: gtmSnapshot?.metadata.id,
      evaluatedAt: context.now.toISOString(),
    }),
    getBacklinksStatus: () => ({ duckdbInstalled: false, duckdbSpec: 'Demo uses stored sample backlinks', pluginDir: '' }),
    listCachedReleases: () => [{ release: 'DEMO-2026-09', syncStatus: 'ready', bytes: 0, lastUsedAt: context.now.toISOString() }],
  }
}

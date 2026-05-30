import type { FastifyInstance } from 'fastify'
import { cloudBootstrapRoutes } from './bootstrap.js'
import type { CloudBootstrapRoutesOptions } from './bootstrap.js'
import { cloudGoogleTokensRoutes } from './google-tokens.js'
import type { CloudGoogleTokensRoutesOptions } from './google-tokens.js'
import { cloudBingKeyRoutes } from './bing-key.js'
import type { CloudBingKeyRoutesOptions } from './bing-key.js'

export interface CloudRoutesOptions
  extends CloudBootstrapRoutesOptions {
  /** Inject the Google connection store — same singleton `googleRoutes` uses. */
  googleConnectionStore?: CloudGoogleTokensRoutesOptions['googleConnectionStore']
  /** Inject the Bing connection store — same singleton `bingRoutes` uses. */
  bingConnectionStore?: CloudBingKeyRoutesOptions['bingConnectionStore']
}

/**
 * Track 3 (Canonry Hosted) cloud-bridge routes. Always registered, but the
 * inner routes gate themselves on the `CANONRY_ENABLE_CLOUD_BOOTSTRAP=1`
 * env flag + `X-Admin-Scope: 1` header via `requireCloudBootstrap`. OSS
 * deployments leave the flag unset and these routes return 404.
 *
 * The Google and Bing import routes are only registered when their
 * respective connection stores are wired — same posture as `googleRoutes`
 * / `bingRoutes`. Without the store, calls would have nowhere to write.
 */
export async function cloudRoutes(app: FastifyInstance, opts: CloudRoutesOptions = {}) {
  await app.register(cloudBootstrapRoutes, {
    canonryVersion: opts.canonryVersion,
    allowLoopbackWebhooks: opts.allowLoopbackWebhooks,
    allowPrivateNetworkWebhooks: opts.allowPrivateNetworkWebhooks,
  })

  if (opts.googleConnectionStore) {
    await app.register(cloudGoogleTokensRoutes, {
      googleConnectionStore: opts.googleConnectionStore,
    })
  }

  if (opts.bingConnectionStore) {
    await app.register(cloudBingKeyRoutes, {
      bingConnectionStore: opts.bingConnectionStore,
    })
  }
}

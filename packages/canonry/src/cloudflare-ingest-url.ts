import type { CanonryConfig } from './config.js'

/**
 * Build the ingest-URL template baked into generated Cloudflare Worker
 * scripts. The `{name}` placeholder is substituted with the project name at
 * connect time (see `traffic.ts`).
 *
 * `basePath` is deliberately NOT applied here: `loadConfig()` already folds
 * it into `apiUrl`, and `publicUrl` is configured base-path-inclusive (the
 * Google OAuth redirect builder relies on the same convention). Appending
 * `basePath` a second time double-prefixes the URL (`…/canonry/canonry/…`),
 * so every Worker ingest POST 404s on sub-path deployments.
 */
export function buildCloudflareIngestUrlTemplate(
  config: Pick<CanonryConfig, 'publicUrl' | 'apiUrl'>,
): string {
  const base = (config.publicUrl ?? config.apiUrl).replace(/\/$/, '')
  return `${base}/api/v1/projects/{name}/traffic/cloudflare/ingest`
}

/**
 * Public barrel — re-exports every generated service + type plus a tiny
 * `createClient` factory that applies Bearer auth and the canonry base URL.
 *
 * The factory is the only non-generated runtime in this package; everything
 * else flows through the bundled hey-api fetch client in `generated/client/`.
 */
import {
  createClient as createFetchClient,
  type Client,
  type Config,
} from './generated/client/index.js'

export * from './generated/index.js'
export type { Client, Config } from './generated/client/index.js'

export interface CanonryClientOptions {
  /** Base URL for the API, including any sub-path (e.g. `https://example.com/canonry`). */
  baseUrl: string
  /** Optional Bearer token. Applied to every request as `Authorization: Bearer ${apiKey}`. */
  apiKey?: string
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Default request headers merged into every operation. */
  headers?: Record<string, string>
}

/**
 * Build a hey-api Client preconfigured for the canonry API.
 *
 * Pass the returned client to any generated operation via `{ client }`:
 *
 *   const client = createClient({ baseUrl, apiKey })
 *   const { data } = await getApiV1Projects({ client })
 */
export function createClient(opts: CanonryClientOptions): Client {
  const config: Config = {
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    headers: {
      ...(opts.headers ?? {}),
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    },
  }
  return createFetchClient(config)
}

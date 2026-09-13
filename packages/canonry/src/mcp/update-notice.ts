import { updateCheckEnvOptOut } from '@ainyc/canonry-contracts'
import type { ApiClient, ServerUpdateAvailable } from '../client.js'

// Function-typed properties, not methods: both are closures with no `this`,
// and `get` is handed around unbound as the MCP server's `updateAvailable`.
export interface UpdateNoticeSource {
  /** Fetch now (deduplicated with any refresh already running). Never rejects. */
  refresh: () => Promise<void>
  /** Last known notice. Starts a background refresh when the value is older than the TTL. */
  get: () => ServerUpdateAvailable | null
}

/**
 * The stdio adapter's view of the connected server's update notice.
 *
 * Hosts such as Claude Desktop and Codex keep a stdio server alive for days,
 * so a value read once at launch would never announce a release published
 * mid-session. `get()` stays synchronous (the MCP server reads it while
 * building instructions and on every `canonry_help`) and refreshes in the
 * background at most once per TTL.
 *
 * The update-check environment opt-outs are honoured here, in the adapter's
 * own environment: an MCP client config is where an operator would set
 * `CANONRY_DISABLE_UPDATE_CHECK=1`, and that server may not share it.
 */
export function createUpdateNoticeSource(
  client: Pick<ApiClient, 'getServerUpdateAvailable'>,
  opts: { env?: NodeJS.ProcessEnv; ttlMs?: number; now?: () => number } = {},
): UpdateNoticeSource {
  const disabled = updateCheckEnvOptOut(opts.env ?? process.env) !== null
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000
  const now = opts.now ?? Date.now
  let value: ServerUpdateAvailable | null = null
  let fetchedAt = Number.NEGATIVE_INFINITY
  let inFlight: Promise<void> | null = null

  const refresh = (): Promise<void> => {
    if (disabled) return Promise.resolve()
    inFlight ??= client.getServerUpdateAvailable()
      // null also covers "server unreachable": clearing is the safe side,
      // since a stale notice could survive the operator's upgrade.
      .then((next) => { value = next }, () => { value = null })
      .finally(() => {
        fetchedAt = now()
        inFlight = null
      })
    return inFlight
  }

  return {
    refresh,
    get: () => {
      if (!disabled && !inFlight && now() - fetchedAt >= ttlMs) void refresh()
      return value
    },
  }
}

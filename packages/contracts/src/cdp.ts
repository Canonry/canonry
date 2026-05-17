import { z } from 'zod'

/**
 * Per-target browser-page tracker entry returned by `GET /cdp/status`.
 * `lastUsed` is null when the target has never been driven by a snapshot
 * job; `alive` is true while the underlying CDP session is open.
 */
export const cdpTargetStatusDtoSchema = z.object({
  name: z.string(),
  alive: z.boolean(),
  lastUsed: z.string().nullable(),
})
export type CdpTargetStatusDto = z.infer<typeof cdpTargetStatusDtoSchema>

/**
 * Response shape for `GET /cdp/status` — Chrome DevTools Protocol
 * connection health plus per-target liveness. `version` /
 * `browserVersion` mirror the `Browser.getVersion` reply; both are
 * absent until the very first CDP request succeeds.
 */
export const cdpStatusDtoSchema = z.object({
  connected: z.boolean(),
  endpoint: z.string(),
  version: z.string().optional(),
  browserVersion: z.string().optional(),
  targets: z.array(cdpTargetStatusDtoSchema).default([]),
})
export type CdpStatusDto = z.infer<typeof cdpStatusDtoSchema>

import { z } from 'zod'

export const mcpTransportStatusSchema = z.enum(['available', 'unavailable', 'not-supported'])
export const McpTransportStatuses = mcpTransportStatusSchema.enum
export type McpTransportStatus = z.infer<typeof mcpTransportStatusSchema>

export const hostedMcpStatusSchema = z.enum(['ready', 'unavailable'])
export const HostedMcpStatuses = hostedMcpStatusSchema.enum
export type HostedMcpStatus = z.infer<typeof hostedMcpStatusSchema>

export const hostedMcpUnavailableReasonSchema = z.enum([
  'public-url-required',
  'https-required',
  'public-host-required',
  'public-path-mismatch',
  'oauth-unavailable',
  'account-required',
  'transport-unavailable',
])
export const HostedMcpUnavailableReasons = hostedMcpUnavailableReasonSchema.enum
export type HostedMcpUnavailableReason = z.infer<typeof hostedMcpUnavailableReasonSchema>

/** Server prerequisites only; the client must still authorize and verify a stored read. */
export const hostedMcpHealthSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal(HostedMcpStatuses.ready), url: z.string().url() }),
  z.object({ status: z.literal(HostedMcpStatuses.unavailable), reason: hostedMcpUnavailableReasonSchema }),
])
export type HostedMcpHealth = z.infer<typeof hostedMcpHealthSchema>

/** Transport availability, not an end-to-end MCP client connection check. */
export const mcpHealthSchema = z.object({
  status: mcpTransportStatusSchema,
  hosted: hostedMcpHealthSchema.optional(),
})
export type McpHealth = z.infer<typeof mcpHealthSchema>

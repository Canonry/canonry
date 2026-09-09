import { z } from 'zod'

/** Transport availability, not an end-to-end MCP client connection check. */
export const mcpHealthSchema = z.object({
  status: z.enum(['available', 'unavailable', 'not-supported']),
})
export type McpHealth = z.infer<typeof mcpHealthSchema>

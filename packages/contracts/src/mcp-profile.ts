import { z } from 'zod'
import { READ_ONLY_SCOPE } from './scopes.js'

/** A connection identifies a person inside one configured MCP resource. */
export const mcpProfileDtoSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
  instance: z.object({
    issuer: z.url(),
    resource: z.url(),
  }),
  scopes: z.array(z.literal(READ_ONLY_SCOPE)).length(1),
})

export type McpProfileDto = z.infer<typeof mcpProfileDtoSchema>

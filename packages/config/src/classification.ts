import { agentProviderIdSchema } from '@canonry/canonry-contracts'
import { z } from 'zod'

/** Independent role selection. It never changes which engines a sweep measures. */
export const classificationConfigSchema = z.object({
  provider: agentProviderIdSchema,
  model: z.string().trim().min(1).optional(),
}).strict()
export type ClassificationConfig = z.infer<typeof classificationConfigSchema>

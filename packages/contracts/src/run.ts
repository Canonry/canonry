import { z } from 'zod'

export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed'])
export type RunStatus = z.infer<typeof runStatusSchema>

export const runDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(['answer-visibility', 'site-audit']),
  status: runStatusSchema,
  createdAt: z.string(),
})

export type RunDto = z.infer<typeof runDtoSchema>

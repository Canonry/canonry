import { z } from 'zod'

export const projectDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  canonicalDomain: z.string(),
  country: z.string().length(2),
  language: z.string().min(2),
  tags: z.array(z.string()).default([]),
})

export type ProjectDto = z.infer<typeof projectDtoSchema>

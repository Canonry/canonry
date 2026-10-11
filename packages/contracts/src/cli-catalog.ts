import { z } from 'zod'

export const cliCatalogOptionSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'boolean']),
  multiple: z.boolean(),
})
export const cliCatalogCommandSchema = z.object({
  id: z.string(),
  path: z.array(z.string()).min(1),
  usage: z.string(),
  supportsDryRun: z.boolean(),
  windows: z.array(z.string()).optional(),
  options: z.array(cliCatalogOptionSchema),
})
export const cliCatalogSchema = z.object({
  version: z.string(),
  globalOptions: z.array(cliCatalogOptionSchema),
  groups: z.array(z.object({
    root: z.string(), section: z.string(), summary: z.string(),
    commands: z.array(cliCatalogCommandSchema),
  })),
})
export type CliCatalogDto = z.infer<typeof cliCatalogSchema>

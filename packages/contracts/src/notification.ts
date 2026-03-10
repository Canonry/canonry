import { z } from 'zod'

export const notificationEventSchema = z.enum([
  'citation.lost',
  'citation.gained',
  'run.completed',
  'run.failed',
])
export type NotificationEvent = z.infer<typeof notificationEventSchema>

export const notificationDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  channel: z.literal('webhook'),
  url: z.string().url(),
  events: z.array(notificationEventSchema),
  enabled: z.boolean().default(true),
  webhookSecret: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type NotificationDto = z.infer<typeof notificationDtoSchema>

export interface WebhookPayload {
  source: 'canonry'
  event: NotificationEvent
  project: { name: string; canonicalDomain: string }
  run: { id: string; status: string; finishedAt: string | null }
  transitions: Array<{
    keyword: string
    from: string
    to: string
    provider: string
  }>
  dashboardUrl: string
}

import type { NotificationEvent } from '@canonry/canonry-contracts'

/**
 * Events the agent webhook subscribes to. Consumed by `canonry agent attach`
 * and the `canonry_agent_webhook_attach` MCP tool. A gain on either signal is
 * news for the agent: a mention and a citation move independently.
 */
export const AGENT_WEBHOOK_EVENTS = [
  'run.completed',
  'insight.critical',
  'insight.high',
  'citation.gained',
  'mention.gained',
] as const satisfies readonly NotificationEvent[]

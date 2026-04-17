/** Events the agent webhook subscribes to. Consumed by `canonry agent attach`. */
export const AGENT_WEBHOOK_EVENTS = ['run.completed', 'insight.critical', 'insight.high', 'citation.gained'] as const

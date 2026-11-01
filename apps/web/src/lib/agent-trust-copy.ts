import { AgentTrustLevels, AgentTrustReasons, type AgentTrustReason, type StoredAgentTrust } from '@canonry/canonry-contracts'

/** Agent trust wording shared by Journeys, Activity and the traffic source page. */
export const TRUST_LABELS: Record<StoredAgentTrust, string> = {
  [AgentTrustLevels.verified]: 'Verified',
  [AgentTrustLevels.likely_real]: 'Likely real',
  [AgentTrustLevels.unknown]: 'Unknown',
}

/** Plain words for each trust reason; `operator` is the agent's company. */
export function trustReasonLabel(reason: AgentTrustReason, operator: string): string {
  switch (reason) {
    case AgentTrustReasons['ip-in-published-list']: return `IP on ${operator}'s published list`
    case AgentTrustReasons['ip-outside-published-list']: return `IP not on ${operator}'s published list`
    case AgentTrustReasons['no-ip']: return 'Source gives no IP to check'
    case AgentTrustReasons['no-published-list']: return `${operator} publishes no IP list`
    case AgentTrustReasons['documented-user-agent']: return `User agent matches ${operator}'s published one`
    case AgentTrustReasons['unusual-user-agent']: return `User agent differs from ${operator}'s published one`
    case AgentTrustReasons['scanner-path']: return 'Asked for a secret or admin file'
    case AgentTrustReasons['scanner-burst']: return 'Same IP asked for secret files'
  }
}

export const LIKELY_FAKE_HELP = 'These requests claimed to be an AI agent but look fake: they asked for secret or admin files, or used a user agent unlike the one the company publishes. They are counted, never listed, and never added to AI agent hits.'

/** Tooltip sentence for an AI agent hit count that leaves likely fake requests out. */
export function likelyFakeAgentHitsNote(likelyFake: number): string {
  if (likelyFake === 0) return 'No likely fake agent requests in this period.'
  return `Excludes ${likelyFake.toLocaleString('en-US')} likely fake ${likelyFake === 1 ? 'request' : 'requests'}. ${LIKELY_FAKE_HELP.replace('These requests', 'They')}`
}

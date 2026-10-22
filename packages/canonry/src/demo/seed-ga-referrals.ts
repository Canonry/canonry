import { AI_ENGINE_DOMAINS, classifyAiReferralTrafficClass } from '@canonry/canonry-contracts'
import { gaAiReferrals, gaSocialReferrals, type DatabaseClient } from '@canonry/canonry-db'

/**
 * GA4 AI and social referral rows for a demo project, shaped the way real
 * properties report them: one platform split across several source and medium
 * spellings, paid and organic rows side by side, and AI visits under GA4's
 * `AI Assistant` channel, including one source that names no engine.
 */

interface ReferralSeed {
  source: string
  medium: string
  channelGroup: string
  /** Sessions on a full day; small rows appear only on some days. */
  daily: number
  /** Show the row on every `every`-th day only. */
  every?: number
}

const SOCIAL_ROWS: readonly ReferralSeed[] = [
  { source: 'ig', medium: 'social', channelGroup: 'Organic Social', daily: 3 },
  { source: 'Pinterest', medium: 'PaidSocial', channelGroup: 'Paid Social', daily: 2 },
  { source: 'facebook', medium: 'paid', channelGroup: 'Paid Social', daily: 1 },
  { source: 'l.instagram.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1 },
  { source: 'pinterest.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 2 },
  { source: 'Pinterest', medium: 'organic', channelGroup: 'Organic Social', daily: 1, every: 3 },
  { source: 'FB_Ads', medium: 'social', channelGroup: 'Organic Social', daily: 1, every: 3 },
  { source: 'ig', medium: 'paidsocial', channelGroup: 'Paid Social', daily: 1, every: 4 },
  { source: 'instagram.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 4 },
  { source: 'm.facebook.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 4 },
  { source: 'facebook.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 5 },
  { source: 'Instagram+Story', medium: 'social', channelGroup: 'Organic Social', daily: 1, every: 5 },
  { source: 'linkedin.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 5 },
  { source: 'lnkd.in', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 7 },
  { source: 'reddit.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 6 },
  { source: 'youtube.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 6 },
  { source: 't.co', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 7 },
  { source: 'l.facebook.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 7 },
  { source: 'nextdoor.com', medium: 'referral', channelGroup: 'Organic Social', daily: 1, every: 7 },
]

const AI_ROWS: readonly ReferralSeed[] = [
  { source: AI_ENGINE_DOMAINS.chatgpt, medium: 'ai-assistant', channelGroup: 'AI Assistant', daily: 3 },
  { source: AI_ENGINE_DOMAINS.perplexity, medium: 'ai-assistant', channelGroup: 'AI Assistant', daily: 1 },
  { source: AI_ENGINE_DOMAINS.gemini, medium: 'ai-assistant', channelGroup: 'AI Assistant', daily: 1, every: 2 },
  { source: AI_ENGINE_DOMAINS.claude, medium: 'ai-assistant', channelGroup: 'AI Assistant', daily: 1, every: 2 },
  { source: AI_ENGINE_DOMAINS.copilotMicrosoft, medium: 'ai-assistant', channelGroup: 'AI Assistant', daily: 1, every: 3 },
  { source: AI_ENGINE_DOMAINS.grok, medium: 'ai-assistant', channelGroup: 'AI Assistant', daily: 1, every: 4 },
  { source: `chat.${AI_ENGINE_DOMAINS.deepseek}`, medium: 'ai-assistant', channelGroup: 'AI Assistant', daily: 1, every: 5 },
  // GA4 put it in the AI channel, and no engine matches it: AI traffic, unattributed.
  { source: 'demo-answer-engine.example', medium: 'ai-assistant', channelGroup: 'AI Assistant', daily: 1, every: 3 },
  { source: AI_ENGINE_DOMAINS.metaAi, medium: 'referral', channelGroup: 'Referral', daily: 1, every: 6 },
  { source: 'chatgpt', medium: 'cpc', channelGroup: 'Paid Other', daily: 1, every: 2 },
]

const AI_LANDING_PAGES = ['/', '/services/', '/guides/'] as const

export function seedGaReferrals(
  db: DatabaseClient,
  input: { projectId: string; prefix: string; syncRunId: string; nowIso: string; dates: readonly string[] },
): void {
  const { projectId, prefix, syncRunId, nowIso, dates } = input
  for (const [day, date] of dates.entries()) {
    for (const [index, row] of SOCIAL_ROWS.entries()) {
      if (day % (row.every ?? 1) !== 0) continue
      db.insert(gaSocialReferrals).values({
        id: `${prefix}-ga-social-${day}-${index}`,
        projectId,
        date,
        source: row.source,
        medium: row.medium,
        channelGroup: row.channelGroup,
        sessions: row.daily + (day % 3 === 0 ? 1 : 0),
        users: row.daily,
        syncedAt: nowIso,
        syncRunId,
      }).run()
    }
    for (const [index, row] of AI_ROWS.entries()) {
      if (day % (row.every ?? 1) !== 0) continue
      const landingPage = row.medium === 'cpc'
        ? '/?utm_source=chatgpt&utm_medium=cpc'
        : AI_LANDING_PAGES[(day + index) % AI_LANDING_PAGES.length]!
      const sessions = row.daily + (day % 4 === 0 ? 1 : 0)
      db.insert(gaAiReferrals).values({
        id: `${prefix}-ga-ai-${day}-${index}`,
        projectId,
        date,
        source: row.source,
        medium: row.medium,
        trafficClass: classifyAiReferralTrafficClass({ source: row.source, medium: row.medium, channelGroup: row.channelGroup, landingPage }),
        sourceDimension: 'session',
        channelGroup: row.channelGroup,
        landingPage,
        landingPageNormalized: landingPage.split('?')[0]!,
        sessions,
        users: sessions,
        syncedAt: nowIso,
        syncRunId,
      }).run()
    }
  }
}

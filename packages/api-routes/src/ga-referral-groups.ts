import {
  AiReferralTrafficClasses,
  aiEngineForReferralSource,
  aiReferralEngineLabel,
  breakdownShares,
  buildStackedDailySeries,
  shareOf,
  socialPlatformForReferralSource,
  socialPlatformLabel,
} from '@canonry/canonry-contracts'
import type {
  AiReferralEngine,
  AiReferralTrafficClass,
  SocialPlatform,
  StackedDailySeries,
} from '@canonry/canonry-contracts'

interface SocialRow { source: string; channelGroup: string; sessions: number }
interface AiRow { source: string; trafficClass: AiReferralTrafficClass; sessions: number }

/** A group of rows: the shape of `GA4SocialPlatformDto` and `GA4AiEngineReferralDto`. */
interface RowGroup<Row> {
  label: string
  sessions: number
  organicSessions: number
  paidSessions: number
  share: number
  sources: Row[]
}

/**
 * Engine and platform groups over rows `/ga/traffic` already returns.
 *
 * Every row lands in exactly one group, so a group's sessions are the sum of
 * its rows and the groups add up to the rows' total. A source no engine or
 * platform matches is never dropped: AI rows go to the unattributed group,
 * social rows keep their own source as the group.
 */

/** Charted groups before the rest fold into `other`. */
const CHART_SERIES_LIMIT = 5

export const UNATTRIBUTED_AI_LABEL = 'Unattributed AI'
const UNATTRIBUTED_AI_KEY = 'unattributed'

const PAID_SOCIAL_CHANNEL_GROUP = 'Paid Social'

function bySessionsThenLabel<T extends { sessions: number; label: string }>(a: T, b: T): number {
  return b.sessions - a.sessions || a.label.localeCompare(b.label)
}

function socialGroupKey(source: string, platform: SocialPlatform | null): string {
  return platform ?? `source:${source}`
}

export function isPaidSocialChannel(channelGroup: string): boolean {
  return channelGroup === PAID_SOCIAL_CHANNEL_GROUP
}

export function groupSocialPlatforms<Row extends SocialRow>(
  rows: readonly Row[],
): Array<RowGroup<Row> & { platform: SocialPlatform | null }> {
  const groups = new Map<string, Omit<RowGroup<Row>, 'share'> & { platform: SocialPlatform | null }>()
  for (const row of rows) {
    const platform = socialPlatformForReferralSource(row.source)
    const key = socialGroupKey(row.source, platform)
    let group = groups.get(key)
    if (!group) {
      group = {
        platform,
        label: platform ? socialPlatformLabel(platform) : row.source,
        sessions: 0,
        organicSessions: 0,
        paidSessions: 0,
        sources: [],
      }
      groups.set(key, group)
    }
    group.sessions += row.sessions
    if (isPaidSocialChannel(row.channelGroup)) group.paidSessions += row.sessions
    else group.organicSessions += row.sessions
    group.sources.push(row)
  }
  const sorted = [...groups.values()].sort(bySessionsThenLabel)
  const shares = breakdownShares(sorted.map(group => group.sessions))
  return sorted.map((group, index) => ({
    ...group,
    share: shares[index] ?? 0,
    sources: [...group.sources].sort((a, b) => b.sessions - a.sessions || a.source.localeCompare(b.source)),
  }))
}

export function socialPlatformDailySeries(
  rows: Iterable<{ date: string; source: string; sessions: number }>,
): StackedDailySeries {
  return buildStackedDailySeries(
    [...rows].map(row => {
      const platform = socialPlatformForReferralSource(row.source)
      return {
        date: row.date,
        key: socialGroupKey(row.source, platform),
        label: platform ? socialPlatformLabel(platform) : row.source,
        sessions: row.sessions,
      }
    }),
    { limit: CHART_SERIES_LIMIT, otherLabel: 'Other' },
  )
}

/** Paid social sessions and their 0..1 share of all social sessions. */
export function paidSocialSummary(rows: readonly SocialRow[]): { paidSocialSessions: number; paidSocialShare: number } {
  const total = rows.reduce((sum, row) => sum + row.sessions, 0)
  const paidSocialSessions = rows
    .filter(row => isPaidSocialChannel(row.channelGroup))
    .reduce((sum, row) => sum + row.sessions, 0)
  return { paidSocialSessions, paidSocialShare: shareOf(paidSocialSessions, total) ?? 0 }
}

function aiEngineGroup(source: string): { engine: AiReferralEngine | null; key: string; label: string } {
  const engine = aiEngineForReferralSource(source)
  return engine
    ? { engine, key: engine, label: aiReferralEngineLabel(engine) }
    : { engine: null, key: UNATTRIBUTED_AI_KEY, label: UNATTRIBUTED_AI_LABEL }
}

export function groupAiEngines<Row extends AiRow>(
  rows: readonly Row[],
): Array<RowGroup<Row> & { engine: AiReferralEngine | null }> {
  const groups = new Map<string, Omit<RowGroup<Row>, 'share'> & { engine: AiReferralEngine | null }>()
  for (const row of rows) {
    const { engine, key, label } = aiEngineGroup(row.source)
    let group = groups.get(key)
    if (!group) {
      group = { engine, label, sessions: 0, organicSessions: 0, paidSessions: 0, sources: [] }
      groups.set(key, group)
    }
    group.sessions += row.sessions
    if (row.trafficClass === AiReferralTrafficClasses.paid) group.paidSessions += row.sessions
    else group.organicSessions += row.sessions
    group.sources.push(row)
  }
  // Named engines first; the unattributed group closes the list at any size.
  const sorted = [...groups.values()].sort((a, b) => (
    Number(a.engine === null) - Number(b.engine === null) || bySessionsThenLabel(a, b)
  ))
  const shares = breakdownShares(sorted.map(group => group.sessions))
  return sorted.map((group, index) => ({
    ...group,
    share: shares[index] ?? 0,
    sources: [...group.sources].sort((a, b) => b.sessions - a.sessions || a.source.localeCompare(b.source)),
  }))
}

export function aiEngineDailySeries(
  winners: Iterable<{ date: string; source: string; sessions: number }>,
): StackedDailySeries {
  return buildStackedDailySeries(
    [...winners].map(winner => {
      const { key, label } = aiEngineGroup(winner.source)
      return { date: winner.date, key, label, sessions: winner.sessions }
    }),
    { limit: CHART_SERIES_LIMIT, otherLabel: 'Other' },
  )
}

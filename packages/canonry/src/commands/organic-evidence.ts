import type { OrganicEvidenceDto, OrganicEvidencePeriodDays } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'

export interface OrganicEvidenceOptions {
  period?: OrganicEvidencePeriodDays
  format?: string
}

/** Read the reconciled organic-search and AI-attention evidence ladder. */
export async function showOrganicEvidence(project: string, opts: OrganicEvidenceOptions): Promise<void> {
  const data = await createApiClient().getOrganicEvidence(project, opts.period)
  // This is a composite document, not a primary collection. Keep jsonl as the
  // complete JSON document so agents never lose its coverage and caveats.
  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  printOrganicEvidence(project, data)
}

function formatCounts(clicks: number, impressions: number): string {
  return `${clicks} clicks / ${impressions} impressions`
}

function printOrganicEvidence(project: string, data: OrganicEvidenceDto): void {
  const asOf = data.asOfDate ? ` through ${data.asOfDate}` : ''
  console.log(`Organic evidence: ${project}  (${data.periodDays} days${asOf})`)
  console.log(`Coverage: GSC ${data.coverage.gsc ? 'yes' : 'no'} · GA4 ${data.coverage.ga4 ? 'yes' : 'no'} · server ${data.coverage.server ? 'yes' : 'no'} · AI visibility ${data.coverage.visibility ? 'yes' : 'no'}`)

  if (data.gsc) {
    console.log(`Google Search: ${formatCounts(data.gsc.propertyTotals.clicks, data.gsc.propertyTotals.impressions)} (named non-brand: ${formatCounts(data.gsc.namedNonBrand.clicks, data.gsc.namedNonBrand.impressions)})`)
  }
  if (data.ga4) console.log(`GA4 organic: ${data.ga4.organicSessions} sessions (${data.ga4.blogOrganicSessions} blog)`)
  if (data.gaAiReferrals) console.log(`GA4 AI referrals: ${data.gaAiReferrals.organicSessions} organic, ${data.gaAiReferrals.paidSessions} paid sessions`)
  if (data.server) {
    const s = data.server
    const fetchTotal = s.userFetchHits.verified + s.userFetchHits.claimedUnverified + s.userFetchHits.unknownAiLike
    console.log(`Server AI: ${s.crawlerHits.verified} verified + ${s.crawlerHits.claimedUnverified} claimed + ${s.crawlerHits.unknownAiLike} heuristic crawls; ${fetchTotal} user-agent fetches (${s.userFetchHits.verified} verified, ${s.userFetchHits.claimedUnverified} claimed, ${s.userFetchHits.unknownAiLike} heuristic); ${s.referralSessions.organic} organic referrals, ${s.referralSessions.paid} paid, ${s.referralSessions.unknown} unclassified`)
  }
  if (data.visibility) {
    const v = data.visibility
    console.log(`Latest AI visibility: ${v.mentionedPairs}/${v.answerPairs} mentioned, ${v.citedPairs}/${v.answerPairs} cited (${Math.floor(v.ageDays)}d old)`)
  }

  if (data.findings.length > 0) {
    console.log('\nFindings:')
    for (const finding of data.findings) console.log(`- ${finding.title}: ${finding.detail}`)
  }
  if (data.limitations.length > 0) {
    console.log('\nLimitations:')
    for (const limitation of data.limitations) console.log(`- ${limitation.detail}`)
  }
}

/**
 * Weekly answer-visibility history for the simple demo project.
 *
 * Every value is fixed by a table indexed by sweep, engine and query, so each
 * restart stores the same sample. The mention and citation plans are separate
 * tables: an answer can name Summit Roofing without citing its site, or cite a
 * page without naming the business. The stored flags come from the same
 * detectors the run writer uses, applied to the answer and sources built here.
 */
import {
  determineAnswerMentioned,
  effectiveBrandNames,
  effectiveDomains,
  type NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import { computeCompetitorOverlap, determineCitationState, extractRecommendedCompetitors } from '../citation-utils.js'

export const SUMMIT_SWEEP_COUNT = 6
export const SUMMIT_ENGINES = ['openai', 'gemini', 'claude'] as const
export type SummitEngine = (typeof SUMMIT_ENGINES)[number]

const RIVALS = {
  roofcraft: { name: 'RoofCraft', domain: 'roofcraft.example', path: '/roof-replacement/', blurb: 'A replacement contractor known for metal and shingle installs.' },
  everlast: { name: 'Everlast Roofing', domain: 'everlast-roofing.example', path: '/services/', blurb: 'A repair and gutter company with a large emergency crew.' },
} as const
type RivalKey = keyof typeof RIVALS

export const SUMMIT_COMPETITORS = Object.values(RIVALS).map(rival => ({ domain: rival.domain, label: rival.name }))

interface SummitQueryPlan {
  key: string
  text: string
  /** Pages on summit-roofing.example an engine can cite for this query. */
  pages: readonly string[]
  rivals: readonly RivalKey[]
  /** A third-party source every answer to this query draws on. */
  source: string
  lead: string
  blurb: string
}

/** Query order is the stored id order: demo-summit-query-1 onward. */
export const SUMMIT_QUERIES: readonly SummitQueryPlan[] = [
  { key: 'reviews', text: 'Summit Roofing reviews', pages: ['/reviews/'], rivals: [], source: 'https://home-services-reviews.example/roofers/', lead: 'Recent homeowner reviews are mostly positive.', blurb: 'Reviewers mention clear estimates, tidy crews and quick follow-up on warranty visits.' },
  { key: 'near-me', text: 'roof repair contractor near me', pages: ['/services/roof-repair/', '/service-areas/'], rivals: ['everlast', 'roofcraft'], source: 'https://local-contractor-directory.example/roofing/', lead: 'Several roofers in the area handle repair work.', blurb: 'A local roofer covering leak repairs, storm damage and inspections across two dozen towns.' },
  { key: 'emergency-leak', text: 'emergency roof leak repair', pages: ['/services/roof-repair/leak-repair/', '/services/roof-repair/emergency-tarping/'], rivals: ['everlast'], source: 'https://homeowner-guides.example/roof-leaks/', lead: 'For an active leak, look for a crew that can tarp the roof the same day.', blurb: 'Offers emergency tarping and leak repair, with same-day visits in its service area.' },
  { key: 'metal-installer', text: 'best metal roof installer', pages: ['/services/roof-replacement/metal-roofing/', '/guides/metal-vs-asphalt-shingles/'], rivals: ['roofcraft'], source: 'https://metal-roofing-council.example/find-an-installer/', lead: 'Metal roofs need an installer with standing-seam experience.', blurb: 'Installs standing-seam and metal shingle roofs and publishes a metal versus asphalt comparison.' },
  { key: 'warranty', text: 'Summit Roofing warranty', pages: ['/about/warranty/'], rivals: [], source: 'https://homeowner-guides.example/roof-warranties/', lead: 'Roofing warranties usually combine manufacturer and workmanship coverage.', blurb: 'Backs replacements with a written workmanship warranty on top of the manufacturer coverage.' },
  { key: 'replacement-cost', text: 'how much does a roof replacement cost', pages: ['/guides/how-much-does-a-roof-replacement-cost/', '/financing/'], rivals: ['roofcraft'], source: 'https://home-cost-report.example/roof-replacement/', lead: 'Most full replacements land between 9,000 and 18,000 dollars, depending on size and material.', blurb: 'Publishes a cost guide with typical price ranges and offers financing on full replacements.' },
  { key: 'storm-claims', text: 'storm damage roof repair and insurance claims', pages: ['/services/roof-repair/storm-damage/', '/guides/filing-a-roof-insurance-claim/'], rivals: ['everlast'], source: 'https://homeowner-guides.example/storm-claims/', lead: 'Photograph the damage before any repair and call your insurer early.', blurb: 'Documents storm damage for insurance claims and joins the adjuster visit.' },
  { key: 'asphalt-shingles', text: 'asphalt shingle roof replacement', pages: ['/services/roof-replacement/asphalt-shingles/'], rivals: ['roofcraft'], source: 'https://home-cost-report.example/asphalt-shingles/', lead: 'Architectural shingles are the most common replacement choice.', blurb: 'Replaces asphalt shingle roofs with a choice of architectural shingle lines.' },
  { key: 'seamless-gutters', text: 'seamless gutter installation', pages: ['/services/gutters/seamless-gutters/'], rivals: ['everlast'], source: 'https://homeowner-guides.example/gutters/', lead: 'Seamless gutters are formed on site, so they leak less at the joints.', blurb: 'Installs seamless gutters and gutter guards, often alongside a roof replacement.' },
  { key: 'pre-purchase-inspection', text: 'roof inspection before buying a house', pages: ['/services/roof-inspection/real-estate-inspection/', '/guides/real-estate-roof-inspections/'], rivals: ['roofcraft', 'everlast'], source: 'https://home-buyer-checklist.example/roof-inspection/', lead: 'A roof inspection before closing can surface repairs to negotiate.', blurb: 'Runs pre-purchase roof inspections with photo reports for buyers and agents.' },
]

const SUMMIT_BRANDED_QUERY_KEYS = ['reviews', 'warranty'] as const
type BrandedKey = (typeof SUMMIT_BRANDED_QUERY_KEYS)[number]

interface EnginePlan {
  /** Non-brand answers naming Summit Roofing, per sweep, oldest first. */
  mentioned: readonly number[]
  /** Non-brand queries in the order this engine starts naming Summit Roofing for them. */
  mentionOrder: readonly string[]
  /** Non-brand answers citing summit-roofing.example, per sweep, oldest first. */
  cited: readonly number[]
  /** Non-brand queries in the order this engine starts citing the site for them. */
  citationOrder: readonly string[]
}

/**
 * Three engines with different shapes over the six sweeps, counted out of the
 * eight non-brand queries. The engines share most of their query order, so the
 * number of queries any engine covers grows as the climbing engine reaches
 * further, while each engine's own rate keeps its shape.
 */
export const SUMMIT_ENGINE_PLANS: Record<SummitEngine, EnginePlan> = {
  // Climbs steadily.
  openai: {
    mentioned: [2, 3, 3, 4, 5, 6],
    mentionOrder: ['emergency-leak', 'replacement-cost', 'near-me', 'storm-claims', 'pre-purchase-inspection', 'seamless-gutters', 'asphalt-shingles', 'metal-installer'],
    cited: [1, 2, 2, 3, 4, 5],
    citationOrder: ['replacement-cost', 'storm-claims', 'pre-purchase-inspection', 'emergency-leak', 'asphalt-shingles', 'metal-installer', 'seamless-gutters', 'near-me'],
  },
  // Steady, then a dip and a recovery.
  gemini: {
    mentioned: [4, 4, 4, 2, 3, 5],
    mentionOrder: ['near-me', 'emergency-leak', 'replacement-cost', 'storm-claims', 'seamless-gutters', 'pre-purchase-inspection', 'metal-installer', 'asphalt-shingles'],
    cited: [3, 3, 3, 1, 2, 3],
    citationOrder: ['replacement-cost', 'pre-purchase-inspection', 'storm-claims', 'metal-installer', 'emergency-leak', 'asphalt-shingles', 'seamless-gutters', 'near-me'],
  },
  // Swings from week to week.
  claude: {
    mentioned: [3, 1, 4, 2, 4, 3],
    mentionOrder: ['emergency-leak', 'replacement-cost', 'storm-claims', 'near-me', 'pre-purchase-inspection', 'asphalt-shingles', 'seamless-gutters', 'metal-installer'],
    cited: [2, 1, 2, 1, 3, 2],
    citationOrder: ['pre-purchase-inspection', 'replacement-cost', 'storm-claims', 'emergency-leak', 'asphalt-shingles', 'near-me', 'metal-installer', 'seamless-gutters'],
  },
}

/** Branded answers name the business in all but one answer; citations vary by engine. */
const BRANDED_PLAN: Record<BrandedKey, Record<SummitEngine, { mentioned: readonly boolean[]; cited: readonly boolean[] }>> = {
  reviews: {
    openai: { mentioned: [true, true, true, true, true, true], cited: [true, true, true, true, true, true] },
    gemini: { mentioned: [true, true, true, true, true, true], cited: [true, true, true, true, true, true] },
    claude: { mentioned: [true, true, true, true, true, true], cited: [false, false, false, false, false, false] },
  },
  warranty: {
    openai: { mentioned: [true, true, true, true, true, true], cited: [true, true, true, true, true, true] },
    gemini: { mentioned: [true, true, true, false, true, true], cited: [true, true, true, false, true, true] },
    claude: { mentioned: [true, true, true, true, true, true], cited: [false, false, true, false, true, true] },
  },
}

function isBranded(key: string): key is BrandedKey {
  return (SUMMIT_BRANDED_QUERY_KEYS as readonly string[]).includes(key)
}

/** The planned signals for one answer, before any text is written. */
export function summitAnswerPlan(sweep: number, engine: SummitEngine, queryKey: string): { mentioned: boolean; cited: boolean } {
  if (isBranded(queryKey)) {
    const plan = BRANDED_PLAN[queryKey][engine]
    return { mentioned: plan.mentioned[sweep]!, cited: plan.cited[sweep]! }
  }
  const plan = SUMMIT_ENGINE_PLANS[engine]
  return {
    mentioned: plan.mentionOrder.slice(0, plan.mentioned[sweep]!).includes(queryKey),
    cited: plan.citationOrder.slice(0, plan.cited[sweep]!).includes(queryKey),
  }
}

export interface SummitAnswer {
  answerText: string
  answerMentioned: boolean
  citationState: 'cited' | 'not-cited'
  citedDomains: string[]
  citedUrls: string[]
  competitorOverlap: string[]
  recommendedCompetitors: string[]
}

/** Builds one stored answer and derives its flags with the run writer's detectors. */
export function summitAnswer(input: { sweep: number; engine: SummitEngine; queryIndex: number; displayName: string; domain: string }): SummitAnswer {
  const { sweep, engine, queryIndex, displayName, domain } = input
  const query = SUMMIT_QUERIES[queryIndex]!
  const engineIndex = SUMMIT_ENGINES.indexOf(engine)
  const plan = summitAnswerPlan(sweep, engine, query.key)
  // When Summit Roofing is named, a rival shares the answer on alternating
  // engines and weeks. When it is not, the query's rivals take its place.
  const rivals = plan.mentioned
    ? ((sweep + engineIndex + queryIndex) % 2 === 0 ? query.rivals.slice(0, 1) : [])
    : query.rivals
  const entries = [
    ...(plan.mentioned ? [{ name: displayName, blurb: query.blurb }] : []),
    ...rivals.map(key => ({ name: RIVALS[key].name, blurb: RIVALS[key].blurb })),
  ]
  const answerText = isBranded(query.key) && !plan.mentioned
    ? `Fictional answer.\n\nI could not find published details for that company. ${query.lead} Most residential roofers offer 5 to 10 years of workmanship coverage.`
    : [
      'Fictional answer.',
      query.lead,
      entries.map((entry, index) => `${index + 1}. **${entry.name}**: ${entry.blurb}`).join('\n'),
      'Get two or three written estimates before you commit.',
    ].join('\n\n')

  const citedRivals = rivals.filter((_, index) => (sweep + engineIndex + queryIndex + index) % 3 !== 0)
  const citedUrls = [
    ...(plan.cited ? [`https://${domain}${query.pages[(sweep + engineIndex) % query.pages.length]}`] : []),
    ...citedRivals.map(key => `https://${RIVALS[key].domain}${RIVALS[key].path}`),
    query.source,
  ]
  const citedDomains = citedUrls.map(url => new URL(url).hostname)

  const normalized: NormalizedQueryResult = {
    provider: engine, answerText, citedDomains,
    groundingSources: citedUrls.map(uri => ({ uri, title: '' })),
    searchQueries: [query.text], retrievalStatus: 'used',
  }
  const domains = effectiveDomains({ canonicalDomain: domain, ownedDomains: [domain] })
  const brandNames = effectiveBrandNames({ displayName, canonicalDomain: domain, ownedDomains: [domain] })
  const competitorDomains = SUMMIT_COMPETITORS.map(competitor => competitor.domain)
  return {
    answerText,
    answerMentioned: determineAnswerMentioned(answerText, brandNames, domains),
    citationState: determineCitationState(normalized, domains),
    citedDomains,
    citedUrls,
    competitorOverlap: computeCompetitorOverlap(normalized, competitorDomains),
    recommendedCompetitors: extractRecommendedCompetitors(answerText, domains, citedDomains, competitorDomains, brandNames),
  }
}

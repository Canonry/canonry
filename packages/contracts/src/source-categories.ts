import { z } from 'zod'

export const sourceCategorySchema = z.enum([
  'competitor',
  'directory',
  'social',
  'forum',
  'news',
  'reference',
  'blog',
  'ecommerce',
  'video',
  'academic',
  'other',
])
export type SourceCategory = z.infer<typeof sourceCategorySchema>
export const SourceCategories = sourceCategorySchema.enum

export interface SourceCategoryRule {
  pattern: string
  category: SourceCategory
  label: string
}

export const SOURCE_CATEGORY_RULES: SourceCategoryRule[] = [
  // Directories, marketplaces & review platforms — generic across industries.
  // Industry-specific directories (NRCA, GAF, etc.) intentionally omitted;
  // they would slip past for the next vertical and create maintenance churn.
  { pattern: 'yelp.com', category: 'directory', label: 'Yelp' },
  { pattern: 'angi.com', category: 'directory', label: 'Angi' },
  { pattern: 'angieslist.com', category: 'directory', label: 'Angi' },
  { pattern: 'homeadvisor.com', category: 'directory', label: 'HomeAdvisor' },
  { pattern: 'bbb.org', category: 'directory', label: 'Better Business Bureau' },
  { pattern: 'trustpilot.com', category: 'directory', label: 'Trustpilot' },
  { pattern: 'houzz.com', category: 'directory', label: 'Houzz' },
  { pattern: 'thumbtack.com', category: 'directory', label: 'Thumbtack' },
  { pattern: 'nextdoor.com', category: 'directory', label: 'Nextdoor' },
  { pattern: 'yellowpages.com', category: 'directory', label: 'Yellow Pages' },
  { pattern: 'manta.com', category: 'directory', label: 'Manta' },
  { pattern: 'foursquare.com', category: 'directory', label: 'Foursquare' },
  { pattern: 'g2.com', category: 'directory', label: 'G2' },
  { pattern: 'capterra.com', category: 'directory', label: 'Capterra' },
  { pattern: 'getapp.com', category: 'directory', label: 'GetApp' },
  { pattern: 'softwareadvice.com', category: 'directory', label: 'Software Advice' },
  { pattern: 'trustradius.com', category: 'directory', label: 'TrustRadius' },
  { pattern: 'producthunt.com', category: 'directory', label: 'Product Hunt' },
  { pattern: 'glassdoor.com', category: 'directory', label: 'Glassdoor' },
  { pattern: 'indeed.com', category: 'directory', label: 'Indeed' },
  // Major GLOBAL travel / lodging / dining aggregators (OTAs). Included
  // because — unlike niche per-vertical directories (NRCA, GAF) which are
  // deliberately omitted — these are top-tier cross-business marketplaces in
  // the same class as Yelp/Angi, and AEO for hospitality routinely competes
  // against them. They classify as `ota-aggregator` surfaces (see #675).
  { pattern: 'tripadvisor.com', category: 'directory', label: 'Tripadvisor' },
  { pattern: 'booking.com', category: 'directory', label: 'Booking.com' },
  { pattern: 'expedia.com', category: 'directory', label: 'Expedia' },
  { pattern: 'hotels.com', category: 'directory', label: 'Hotels.com' },
  { pattern: 'agoda.com', category: 'directory', label: 'Agoda' },
  { pattern: 'kayak.com', category: 'directory', label: 'Kayak' },
  { pattern: 'trivago.com', category: 'directory', label: 'Trivago' },
  { pattern: 'airbnb.com', category: 'directory', label: 'Airbnb' },
  { pattern: 'vrbo.com', category: 'directory', label: 'Vrbo' },
  { pattern: 'opentable.com', category: 'directory', label: 'OpenTable' },

  // Forums
  { pattern: 'reddit.com', category: 'forum', label: 'Reddit' },
  { pattern: 'quora.com', category: 'forum', label: 'Quora' },
  { pattern: 'stackexchange.com', category: 'forum', label: 'Stack Exchange' },
  { pattern: 'stackoverflow.com', category: 'forum', label: 'Stack Overflow' },
  { pattern: 'discourse.org', category: 'forum', label: 'Discourse' },

  // Social
  { pattern: 'linkedin.com', category: 'social', label: 'LinkedIn' },
  { pattern: 'twitter.com', category: 'social', label: 'X (Twitter)' },
  { pattern: 'x.com', category: 'social', label: 'X (Twitter)' },
  { pattern: 'facebook.com', category: 'social', label: 'Facebook' },
  { pattern: 'instagram.com', category: 'social', label: 'Instagram' },
  { pattern: 'threads.net', category: 'social', label: 'Threads' },
  { pattern: 'pinterest.com', category: 'social', label: 'Pinterest' },
  { pattern: 'tiktok.com', category: 'social', label: 'TikTok' },

  // Video
  { pattern: 'youtube.com', category: 'video', label: 'YouTube' },
  { pattern: 'youtu.be', category: 'video', label: 'YouTube' },
  { pattern: 'vimeo.com', category: 'video', label: 'Vimeo' },

  // News
  { pattern: 'nytimes.com', category: 'news', label: 'NY Times' },
  { pattern: 'bbc.com', category: 'news', label: 'BBC' },
  { pattern: 'bbc.co.uk', category: 'news', label: 'BBC' },
  { pattern: 'cnn.com', category: 'news', label: 'CNN' },
  { pattern: 'reuters.com', category: 'news', label: 'Reuters' },
  { pattern: 'apnews.com', category: 'news', label: 'AP News' },
  { pattern: 'theguardian.com', category: 'news', label: 'The Guardian' },
  { pattern: 'washingtonpost.com', category: 'news', label: 'Washington Post' },
  { pattern: 'wsj.com', category: 'news', label: 'WSJ' },
  { pattern: 'forbes.com', category: 'news', label: 'Forbes' },
  { pattern: 'techcrunch.com', category: 'news', label: 'TechCrunch' },
  { pattern: 'theverge.com', category: 'news', label: 'The Verge' },
  { pattern: 'wired.com', category: 'news', label: 'Wired' },
  { pattern: 'arstechnica.com', category: 'news', label: 'Ars Technica' },

  // Reference
  { pattern: 'wikipedia.org', category: 'reference', label: 'Wikipedia' },
  { pattern: 'wikimedia.org', category: 'reference', label: 'Wikimedia' },
  { pattern: 'britannica.com', category: 'reference', label: 'Britannica' },
  { pattern: 'merriam-webster.com', category: 'reference', label: 'Merriam-Webster' },

  // Blog / Content platforms
  { pattern: 'medium.com', category: 'blog', label: 'Medium' },
  { pattern: 'substack.com', category: 'blog', label: 'Substack' },
  { pattern: 'dev.to', category: 'blog', label: 'DEV Community' },
  { pattern: 'hashnode.dev', category: 'blog', label: 'Hashnode' },
  { pattern: 'wordpress.com', category: 'blog', label: 'WordPress' },
  { pattern: 'blogger.com', category: 'blog', label: 'Blogger' },
  { pattern: 'hubspot.com', category: 'blog', label: 'HubSpot' },

  // E-commerce
  { pattern: 'amazon.com', category: 'ecommerce', label: 'Amazon' },
  { pattern: 'amazon.co.uk', category: 'ecommerce', label: 'Amazon UK' },
  { pattern: 'shopify.com', category: 'ecommerce', label: 'Shopify' },
  { pattern: 'ebay.com', category: 'ecommerce', label: 'eBay' },

  // Academic
  { pattern: 'scholar.google.com', category: 'academic', label: 'Google Scholar' },
  { pattern: 'arxiv.org', category: 'academic', label: 'arXiv' },
  { pattern: 'pubmed.ncbi.nlm.nih.gov', category: 'academic', label: 'PubMed' },
  { pattern: 'researchgate.net', category: 'academic', label: 'ResearchGate' },
  { pattern: '.edu', category: 'academic', label: 'Academic (.edu)' },
]

const CATEGORY_LABELS: Record<SourceCategory, string> = {
  competitor: 'Tracked competitors',
  directory: 'Directories & review sites',
  social: 'Social Media',
  forum: 'Forums & Q&A',
  news: 'News & Media',
  reference: 'Reference',
  blog: 'Blogs & Content',
  ecommerce: 'E-commerce',
  video: 'Video',
  academic: 'Academic',
  other: 'Independent sites',
}

export function categorizeSource(uri: string): { category: SourceCategory; label: string; domain: string } {
  let domain: string
  try {
    const url = new URL(uri.startsWith('http') ? uri : `https://${uri}`)
    domain = url.hostname.replace(/^www\./, '')
  } catch {
    domain = uri.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? uri
  }

  const domainLower = domain.toLowerCase()

  for (const rule of SOURCE_CATEGORY_RULES) {
    if (
      domainLower === rule.pattern ||
      domainLower.endsWith(`.${rule.pattern}`) ||
      (rule.pattern.startsWith('.') && domainLower.endsWith(rule.pattern))
    ) {
      return { category: rule.category, label: rule.label, domain }
    }
  }

  return { category: 'other', label: CATEGORY_LABELS.other, domain }
}

/**
 * Tracked competitors are categorized BEFORE rule matching — a tracked
 * competitor that happens to also match a rule (e.g. a competitor whose
 * domain ends in `.com` and happens to be on a directory) should still be
 * counted as `competitor` so users see how often AI engines route them to
 * the tracked rivals.
 */
export function categorizeSourceWithCompetitors(
  uri: string,
  competitorDomains: readonly string[],
  isCompetitorMatch: (domain: string, competitors: readonly string[]) => boolean,
): { category: SourceCategory; label: string; domain: string } {
  const base = categorizeSource(uri)
  if (isCompetitorMatch(base.domain, competitorDomains)) {
    return { category: 'competitor', label: CATEGORY_LABELS.competitor, domain: base.domain }
  }
  return base
}

export function categoryLabel(category: SourceCategory): string {
  return CATEGORY_LABELS[category]
}

export type SourceCategory =
  | 'social'
  | 'forum'
  | 'news'
  | 'reference'
  | 'blog'
  | 'ecommerce'
  | 'video'
  | 'academic'
  | 'other'

export interface SourceCategoryRule {
  pattern: string
  category: SourceCategory
  label: string
}

export const SOURCE_CATEGORY_RULES: SourceCategoryRule[] = [
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
  social: 'Social Media',
  forum: 'Forums & Q&A',
  news: 'News & Media',
  reference: 'Reference',
  blog: 'Blogs & Content',
  ecommerce: 'E-commerce',
  video: 'Video',
  academic: 'Academic',
  other: 'Other',
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

export function categoryLabel(category: SourceCategory): string {
  return CATEGORY_LABELS[category]
}

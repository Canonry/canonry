// What the browser lets through during a check. Nothing that writes leaves the browser:
// a write to the site under test gets a local success reply, so a form shows its real
// confirmation without creating a lead, and every other write is dropped. Trackers are
// dropped so a check never records analytics or ad conversions. A page on another site
// is replaced by a local "blocked" page so the agent stays on the site under test.

import { isAgentBrowserSiteHost } from '@canonry/canonry-contracts'

export type FenceDecision =
  | { action: 'continue' }
  | { action: 'answer-write' }
  | { action: 'drop'; reason: 'tracker' | 'offsite-write' }
  | { action: 'block-page' }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const TRACKER_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'doubleclick.net',
  'googleadservices.com',
  'facebook.com',
  'facebook.net',
  'clarity.ms',
  'hotjar.com',
  'hotjar.io',
  'segment.io',
  'segment.com',
  'posthog.com',
  'plausible.io',
  'vercel-insights.com',
  'licdn.com',
  'redditstatic.com',
  'bat.bing.com',
  'bzr.openai.com',
]

function hostOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

function matchesHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export function isTrackerHost(host: string): boolean {
  return TRACKER_HOSTS.some((domain) => matchesHost(host, domain))
}


export interface FenceRequest {
  url: string
  method: string
  /** True for a document the main frame is about to show. */
  isMainFrameDocument: boolean
}

export function decideFence(request: FenceRequest, siteHosts: readonly string[]): FenceDecision {
  const host = hostOfUrl(request.url)
  if (host === null) return { action: 'continue' }
  const sameSite = isAgentBrowserSiteHost(host, siteHosts)
  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    return sameSite ? { action: 'answer-write' } : { action: 'drop', reason: 'offsite-write' }
  }
  if (isTrackerHost(host)) return { action: 'drop', reason: 'tracker' }
  if (request.isMainFrameDocument && !sameSite) return { action: 'block-page' }
  return { action: 'continue' }
}

/**
 * The origin (`scheme://host[:port]`, without credentials, path or query) whose addresses the
 * host's egress policy must accept before a request leaves the browser. Null for a request
 * that dials nothing, such as a data: or blob: URL.
 */
export function egressOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

export function blockedPageHtml(url: string, why = 'This check stays on the site being tested.'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Blocked by the check</title></head><body style="font:18px system-ui,sans-serif;padding:48px"><h1>Blocked by the check</h1><p>${escapeHtml(why)} The page tried to open ${escapeHtml(url)}</p></body></html>`
}

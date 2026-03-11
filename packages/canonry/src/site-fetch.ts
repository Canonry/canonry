import { resolveWebhookTarget } from '@ainyc/canonry-api-routes'

const FETCH_TIMEOUT_MS = 10_000
const MAX_TEXT_LENGTH = 4000
const USER_AGENT = 'Canonry/1.0 (site-analysis)'

/**
 * Extract a bare hostname from a domain that may be stored as a full URL.
 * Handles "https://www.example.com", "www.example.com", "example.com", etc.
 */
function extractHostname(domain: string): string {
  let hostname = domain
  try {
    if (hostname.includes('://')) {
      hostname = new URL(hostname).hostname
    }
  } catch {
    // not a URL, use as-is
  }
  return hostname.replace(/^www\./, '')
}

/**
 * Fetch a domain's homepage and extract plain text content.
 * Returns empty string on any failure (network, timeout, non-HTML, SSRF block).
 */
export async function fetchSiteText(domain: string): Promise<string> {
  const hostname = extractHostname(domain)
  const url = `https://${hostname}`

  // SSRF check: resolve DNS and reject private/loopback addresses
  const targetCheck = await resolveWebhookTarget(url)
  if (!targetCheck.ok) return ''

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual', // don't follow redirects — they could point to private IPs
    })

    // For redirects, validate the target before following
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return ''
      const redirectCheck = await resolveWebhookTarget(new URL(location, url).href)
      if (!redirectCheck.ok) return ''

      const redirectResponse = await fetch(redirectCheck.target.url.href, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
      })
      if (!redirectResponse.ok) return ''
      const ct = redirectResponse.headers.get('content-type') ?? ''
      if (!ct.includes('text/html')) return ''
      const html = await redirectResponse.text()
      return stripHtml(html)
    }

    if (!response.ok) return ''

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) return ''

    const html = await response.text()
    return stripHtml(html)
  } catch {
    return ''
  }
}

function stripHtml(html: string): string {
  // Remove script and style blocks entirely
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ')
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#39;/g, "'")
  text = text.replace(/&nbsp;/g, ' ')
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim()
  // Truncate
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH)
  }
  return text
}

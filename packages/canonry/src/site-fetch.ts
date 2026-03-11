const FETCH_TIMEOUT_MS = 10_000
const MAX_TEXT_LENGTH = 4000
const USER_AGENT = 'Canonry/1.0 (site-analysis)'

/**
 * Fetch a domain's homepage and extract plain text content.
 * Returns empty string on any failure (network, timeout, non-HTML).
 */
export async function fetchSiteText(domain: string): Promise<string> {
  const url = `https://${domain}`
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })

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

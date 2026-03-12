import https from 'node:https'
import { resolveWebhookTarget } from '@ainyc/canonry-api-routes'
import type { SafeWebhookTarget } from '@ainyc/canonry-api-routes'

const FETCH_TIMEOUT_MS = 10_000
const MAX_TEXT_LENGTH = 4000
const MAX_BODY_BYTES = 512_000 // 512 KB max download
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
 * Fetch HTML using the pinned resolved address to prevent DNS rebinding.
 * Connects directly to the validated IP, sets Host/SNI to the original hostname.
 */
function fetchWithPinnedAddress(target: SafeWebhookTarget): Promise<string> {
  return new Promise((resolve) => {
    const port = target.url.port ? Number(target.url.port) : 443
    const path = target.url.pathname + target.url.search

    const req = https.request(
      {
        hostname: target.address,
        family: target.family,
        port,
        path,
        method: 'GET',
        timeout: FETCH_TIMEOUT_MS,
        servername: target.url.hostname, // SNI for TLS
        headers: {
          Host: target.url.host,
          'User-Agent': USER_AGENT,
          Accept: 'text/html',
        },
      },
      (res) => {
        // Don't follow redirects automatically — we handle them in the caller
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          // For redirects, return the location header prefixed with a marker
          if (res.statusCode >= 300 && res.statusCode < 400) {
            const location = res.headers.location ?? ''
            res.resume()
            resolve(`REDIRECT:${location}`)
            return
          }
          res.resume()
          resolve('')
          return
        }

        const contentType = res.headers['content-type'] ?? ''
        if (!contentType.includes('text/html')) {
          res.resume()
          resolve('')
          return
        }

        const chunks: Buffer[] = []
        let totalBytes = 0
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (totalBytes <= MAX_BODY_BYTES) {
            chunks.push(chunk)
          }
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        res.on('error', () => resolve(''))
      },
    )

    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(''))
    req.end()
  })
}

/**
 * Fetch a domain's homepage and extract plain text content.
 * Returns empty string on any failure (network, timeout, non-HTML, SSRF block).
 *
 * Uses pinned DNS resolution to prevent SSRF via DNS rebinding.
 */
export async function fetchSiteText(domain: string): Promise<string> {
  const hostname = extractHostname(domain)
  const url = `https://${hostname}`

  // SSRF check: resolve DNS and reject private/loopback addresses
  const targetCheck = await resolveWebhookTarget(url)
  if (!targetCheck.ok) return ''

  try {
    const result = await fetchWithPinnedAddress(targetCheck.target)

    // Handle one level of redirect with re-validation
    if (result.startsWith('REDIRECT:')) {
      const location = result.slice('REDIRECT:'.length)
      if (!location) return ''
      const redirectUrl = new URL(location, url).href
      const redirectCheck = await resolveWebhookTarget(redirectUrl)
      if (!redirectCheck.ok) return ''
      const redirectResult = await fetchWithPinnedAddress(redirectCheck.target)
      if (redirectResult.startsWith('REDIRECT:')) return '' // don't follow chains
      return stripHtml(redirectResult)
    }

    return stripHtml(result)
  } catch {
    return ''
  }
}

function stripHtml(html: string): string {
  if (!html) return ''
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

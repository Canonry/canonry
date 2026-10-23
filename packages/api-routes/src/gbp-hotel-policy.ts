/** Conservative hotel policy preflight, including the complete linked HTML and links. */
import { decodeHTML } from 'entities'
import { hostOf } from '@canonry/canonry-contracts'
import { createGuardedFetch, type GuardedFetch } from './guarded-fetch.js'

export function hotelEditorialText(value: string): boolean {
  const text = decodeHTML(value).normalize('NFKC').toLowerCase()
  return (
    text.trim().length > 0 &&
    !/\b(?:offers?|deals?|promotions?|discounts?|coupons?|promo\s*codes?|special\s+rates?|book\s+now|save\s+\d+)\b|\d+\s*%\s*off/iu.test(
      text,
    )
  )
}
export async function hotelEditorialDestination(
  domain: string,
  summary: string,
  articleUrl: string,
  fetchImpl: GuardedFetch = createGuardedFetch(),
): Promise<boolean> {
  try {
    const host = hostOf(domain)
    const target = new URL(articleUrl)
    if (
      !host ||
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port ||
      target.hash ||
      target.search ||
      ![host, `www.${host}`].includes(target.hostname) ||
      !hotelEditorialText(summary + ' ' + decodeURIComponent(target.pathname))
    )
      return false
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(20_000),
    })
    if (
      response.status !== 200 ||
      !response.headers
        .get('content-type')
        ?.toLowerCase()
        .startsWith('text/html') ||
      new URL(response.url || target.href).origin !== target.origin ||
      !response.body
    )
      return false
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 512 * 1024) {
        await reader.cancel()
        return false
      }
      chunks.push(part.value)
    }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    )
    // Scan markup as well as visible copy: a linked /offers page is disallowed
    // even when its anchor says something innocuous. Encoded paths are decoded.
    return (
      hotelEditorialText(html) &&
      hotelEditorialText(
        html.replace(/(?:%[0-9a-f]{2})+/giu, (part) =>
          decodeURIComponent(part),
        ),
      )
    )
  } catch {
    return false
  }
}

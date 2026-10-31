const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

function decode(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]!)
}

/**
 * Where the page after Allow or Deny sends the browser. Canonry answers the
 * consent form with a new document and a meta refresh, not a 302, because
 * Chrome drops redirects that follow the form (sendHandoffPage in
 * packages/api-routes/src/oauth.ts). Its fallback link must agree.
 */
export function handoffTarget(html: string): URL {
  const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html)?.[1]
  if (!refresh) throw new Error(`The page after consent has no handoff: ${html.slice(0, 120)}`)
  const target = new URL(decode(refresh))
  const link = /<a href="([^"]+)" rel="noreferrer">/.exec(html)?.[1]
  if (!link || decode(link) !== target.toString()) throw new Error('The handoff link disagrees with its refresh')
  return target
}

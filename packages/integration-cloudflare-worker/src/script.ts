import type { CloudflareWorkerBotList, GenerateWorkerScriptOptions } from './types.js'

/**
 * Generic edge-side filter list. Intentionally broad — the strict
 * bot/referer classification happens server-side in
 * `packages/integration-traffic`. Bump `version` whenever this set
 * structurally changes so the `cloudflare.worker.version-stale`
 * doctor check can flag stale deployments.
 */
export const DEFAULT_BOT_LIST: CloudflareWorkerBotList = {
  version: '2026-05-27',
  uaKeywords: [
    'bot',
    'crawler',
    'spider',
    'agent',
    'gpt',
    'claude',
    'ai',
    'perplexity',
    'chatgpt',
    'openai',
    'anthropic',
  ],
  refererHostSuffixes: [
    '.openai.com',
    '.anthropic.com',
    '.perplexity.ai',
    '.you.com',
    '.phind.com',
  ],
  refererHostKeywords: ['gpt', 'claude', 'chat', 'perplexity', 'copilot'],
}

const DEFAULT_BOT_SCORE_MAX_FORWARD = 30
const WORKER_COMPATIBILITY_DATE = '2026-05-01'

function jsString(value: string): string {
  return JSON.stringify(value)
}

function jsArray(values: readonly string[]): string {
  return `[${values.map((v) => jsString(v)).join(', ')}]`
}

/**
 * Render the JavaScript source the operator drops into a Cloudflare zone.
 * The script runs on every request, applies a broad edge-side filter, and
 * `fetch()`-es each match to the configured canonry ingest URL via
 * `event.waitUntil` so the forward never blocks the response.
 *
 * Auth: each forward carries a bearer token plus an HMAC-SHA256 signature
 * over `timestamp + "." + body`. Both secrets are embedded at generation
 * time — the operator never sees them in cleartext after the connect
 * response is consumed.
 */
export function generateWorkerScript(opts: GenerateWorkerScriptOptions): string {
  const botScoreMax = opts.botScoreMaxForward ?? DEFAULT_BOT_SCORE_MAX_FORWARD

  return `// canonry traffic Worker — generated; do not edit by hand
// source: ${opts.sourceId}
// worker version: ${opts.workerVersion}
// bot-list version: ${opts.botList.version}

const CANONRY_SOURCE_ID = ${jsString(opts.sourceId)}
const CANONRY_INGEST_URL = ${jsString(opts.ingestUrl)}
const CANONRY_BEARER_TOKEN = ${jsString(opts.bearerToken)}
const CANONRY_HMAC_SECRET = ${jsString(opts.hmacSecret)}
const CANONRY_WORKER_VERSION = ${jsString(opts.workerVersion)}
const CANONRY_BOT_LIST_VERSION = ${jsString(opts.botList.version)}
const UA_KEYWORDS = ${jsArray(opts.botList.uaKeywords)}
const REFERER_HOST_SUFFIXES = ${jsArray(opts.botList.refererHostSuffixes)}
const REFERER_HOST_KEYWORDS = ${jsArray(opts.botList.refererHostKeywords)}
const BOT_SCORE_MAX_FORWARD = ${String(botScoreMax)}

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : ''
}

function uaMatches(ua) {
  const lc = lower(ua)
  if (!lc) return false
  for (const kw of UA_KEYWORDS) {
    if (lc.indexOf(kw) !== -1) return true
  }
  return false
}

function refererMatches(referer) {
  if (!referer) return false
  let host = ''
  try {
    host = new URL(referer).hostname.toLowerCase()
  } catch (_) {
    return false
  }
  for (const suffix of REFERER_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return true
  }
  for (const kw of REFERER_HOST_KEYWORDS) {
    if (host.indexOf(kw) !== -1) return true
  }
  return false
}

function botSignals(cf) {
  if (!cf) return false
  const bm = cf.botManagement
  if (bm) {
    if (bm.verifiedBot === true) return true
    if (typeof bm.score === 'number' && bm.score < BOT_SCORE_MAX_FORWARD) return true
  }
  if (typeof cf.botScore === 'number' && cf.botScore < BOT_SCORE_MAX_FORWARD) return true
  return false
}

function shouldForward(request) {
  const ua = request.headers.get('user-agent') || ''
  if (uaMatches(ua)) return true
  const referer = request.headers.get('referer') || ''
  if (refererMatches(referer)) return true
  return botSignals(request.cf)
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

async function signBody(timestamp, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CANONRY_HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(timestamp + '.' + body),
  )
  return toHex(sig)
}

function pickCf(cf) {
  if (!cf) return null
  const bm = cf.botManagement || {}
  return {
    verifiedBot: typeof bm.verifiedBot === 'boolean' ? bm.verifiedBot : null,
    botScore: typeof bm.score === 'number' ? bm.score : (typeof cf.botScore === 'number' ? cf.botScore : null),
    country: typeof cf.country === 'string' ? cf.country : null,
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    asOrganization: typeof cf.asOrganization === 'string' ? cf.asOrganization : null,
  }
}

function buildEvent(request, observedAt) {
  const url = new URL(request.url)
  return {
    eventId: request.headers.get('cf-ray') || crypto.randomUUID(),
    observedAt: observedAt,
    method: request.method || null,
    host: url.hostname || null,
    path: url.pathname || '/',
    queryString: url.search ? url.search.slice(1) : null,
    status: null,
    userAgent: request.headers.get('user-agent') || null,
    remoteIp: request.headers.get('cf-connecting-ip') || null,
    referer: request.headers.get('referer') || null,
    cf: pickCf(request.cf),
  }
}

async function forward(request, status, observedAt) {
  try {
    const payload = buildEvent(request, observedAt)
    payload.status = typeof status === 'number' ? status : payload.status
    const body = JSON.stringify({
      schemaVersion: 1,
      workerVersion: CANONRY_WORKER_VERSION,
      events: [payload],
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = await signBody(timestamp, body)
    await fetch(CANONRY_INGEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': 'Bearer ' + CANONRY_BEARER_TOKEN,
        'X-Canonry-Timestamp': timestamp,
        'X-Canonry-Signature': signature,
        'X-Canonry-Worker-Version': CANONRY_WORKER_VERSION,
        'X-Canonry-Source-Id': CANONRY_SOURCE_ID,
      },
      body,
    })
  } catch (_err) {
    // Swallow — AI traffic is statistical, not transactional. Dropped
    // events are acceptable; surfacing the error would mask the customer
    // response. Cloudflare's own Worker logs capture the failure.
  }
}

addEventListener('fetch', (event) => {
  const request = event.request
  const observedAt = new Date().toISOString()
  const shouldLog = shouldForward(request)
  const responsePromise = fetch(request)
  event.respondWith(
    responsePromise.then((response) => {
      if (shouldLog) {
        event.waitUntil(forward(request, response.status, observedAt))
      }
      return response
    }).catch((err) => {
      if (shouldLog) {
        event.waitUntil(forward(request, null, observedAt))
      }
      throw err
    }),
  )
})
`
}

export interface GenerateWranglerTomlOptions {
  sourceId: string
}

/**
 * Companion `wrangler.toml` for operators who prefer `wrangler deploy`
 * over pasting into the Cloudflare dashboard.
 */
export function generateWranglerToml(opts: GenerateWranglerTomlOptions): string {
  return `name = "canonry-traffic-${opts.sourceId}"
main = "worker.js"
compatibility_date = "${WORKER_COMPATIBILITY_DATE}"

# Edit and deploy this Worker via:
#   wrangler deploy
# After deploy, route it at:
#   *your-domain.com/*
# in the Cloudflare dashboard or via:
#   wrangler route add "*your-domain.com/*"
`
}

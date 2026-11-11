/**
 * The wire protocol for Sign in with ChatGPT: OpenID discovery, the
 * authorization URL, code exchange, refresh, revocation, ID-token
 * verification, and the plan's model list.
 *
 * Nothing here touches the database or decides who may sign in; that is
 * `chatgpt-accounts.ts`. Every function takes its `fetch` so tests run against
 * recorded responses, and every network call carries a timeout: a slow
 * provider must not hold a sign-in request open indefinitely.
 *
 * ID tokens are verified with Node's own crypto (RS256 against the issuer's
 * published keys) rather than a JWT library: the checks are few, fixed, and
 * listed in one place below.
 */
import crypto from 'node:crypto'
import {
  CHATGPT_DISCOVERY_URL,
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  isRetryableHttpError,
  withRetry,
} from '@canonry/canonry-contracts'

const HTTP_TIMEOUT_MS = 10_000
/** Clock skew tolerated on `exp` and `iat`. */
const CLOCK_SKEW_MS = 60_000
/** How long discovery metadata and signing keys are reused before a refetch. */
const METADATA_TTL_MS = 60 * 60 * 1000
/** An unknown `kid` refetches the key set, but never more often than this. */
const JWKS_REFETCH_MIN_INTERVAL_MS = 60_000
const MAX_TOKEN_LENGTH = 32_768

export type FetchLike = typeof globalThis.fetch

export interface ChatGptMetadata {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  revocationEndpoint: string | null
}

export interface ChatGptClientCredentials {
  clientId: string
  /** Present only for a confidential client. OpenAI never falls back to public-client auth for one. */
  clientSecret?: string
}

export interface ChatGptTokenResponse {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  expiresInSeconds: number
  /** Granted scopes. Null when the response omitted `scope`. */
  scopes: string[] | null
}

export interface ChatGptIdentityClaims {
  subject: string
  email: string | null
  emailVerified: boolean
  name: string | null
}

/** A failure talking to OpenAI. `oauthError` is the RFC 6749 error code when the server sent one. */
export class ChatGptProtocolError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly oauthError: string | null = null,
  ) {
    super(message)
    this.name = 'ChatGptProtocolError'
  }
}

/**
 * Back off and retry only the idempotent reads (discovery, signing keys, the
 * plan's model list), and only for a network failure, 429 or 5xx. The token
 * endpoint is never retried: an authorization code is single use and OpenAI
 * rotates refresh tokens, so a blind retry after a lost response can present a
 * spent token and get the whole grant revoked. A response that arrived but
 * failed validation (status null here) is not retried either.
 */
const READ_RETRY = {
  maxRetries: 1,
  isRetryable: (error: unknown) => error instanceof ChatGptProtocolError
    ? error.status !== null && isRetryableHttpError(error)
    : true,
}

function httpsUrl(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ChatGptProtocolError(`Discovery is missing ${field}.`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ChatGptProtocolError(`Discovery ${field} is not a URL.`)
  }
  if (parsed.protocol !== 'https:') throw new ChatGptProtocolError(`Discovery ${field} is not HTTPS.`)
  return parsed.toString()
}

async function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  return { status: response.status, body }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Read and validate the issuer's discovery document. The issuer must be exactly OpenAI's. */
export async function fetchChatGptMetadata(fetchImpl: FetchLike): Promise<ChatGptMetadata> {
  const doc = await withRetry(async () => {
    const { status, body } = await fetchJson(fetchImpl, CHATGPT_DISCOVERY_URL)
    const parsed = asObject(body)
    if (status !== 200 || !parsed) throw new ChatGptProtocolError('ChatGPT sign-in discovery failed.', status)
    return parsed
  }, READ_RETRY)
  if (doc.issuer !== CHATGPT_ISSUER) throw new ChatGptProtocolError('ChatGPT discovery named an unexpected issuer.')
  const methods = doc.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new ChatGptProtocolError('ChatGPT discovery does not offer S256 PKCE.')
  }
  return {
    issuer: CHATGPT_ISSUER,
    authorizationEndpoint: httpsUrl(doc.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: httpsUrl(doc.token_endpoint, 'token_endpoint'),
    jwksUri: httpsUrl(doc.jwks_uri, 'jwks_uri'),
    revocationEndpoint: doc.revocation_endpoint === undefined ? null : httpsUrl(doc.revocation_endpoint, 'revocation_endpoint'),
  }
}

/** S256 PKCE pair. The verifier is 43 base64url characters of randomness. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export interface AuthorizeUrlInput {
  clientId: string
  redirectUri: string
  scopes: readonly string[]
  state: string
  nonce: string
  codeChallenge: string
  /** Plan scopes are issued for this resource; identity-only sign-in sends none. */
  resource: string | null
  /** Ask OpenAI to show consent again, e.g. after a person earlier declined plan usage. */
  forceConsent: boolean
}

export function buildAuthorizeUrl(metadata: ChatGptMetadata, input: AuthorizeUrlInput): string {
  const url = new URL(metadata.authorizationEndpoint)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(' '),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  })
  if (input.resource) params.set('resource', input.resource)
  if (input.forceConsent) params.set('prompt', 'consent')
  url.search = params.toString()
  return url.toString()
}

function clientAuth(credentials: ChatGptClientCredentials, body: URLSearchParams): Record<string, string> {
  if (!credentials.clientSecret) {
    body.set('client_id', credentials.clientId)
    return {}
  }
  // RFC 6749 2.3.1: both halves are form-encoded before Basic encoding.
  const user = encodeURIComponent(credentials.clientId)
  const pass = encodeURIComponent(credentials.clientSecret)
  return { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` }
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH ? value : null
}

function parseTokenResponse(body: unknown): ChatGptTokenResponse {
  const doc = asObject(body)
  if (!doc) throw new ChatGptProtocolError('ChatGPT returned an unreadable token response.')
  const accessToken = boundedString(doc.access_token)
  if (!accessToken) throw new ChatGptProtocolError('ChatGPT returned no access token.')
  if (typeof doc.token_type !== 'string' || doc.token_type.toLowerCase() !== 'bearer') {
    throw new ChatGptProtocolError('ChatGPT returned an unexpected token type.')
  }
  const expiresIn = doc.expires_in
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new ChatGptProtocolError('ChatGPT returned no token lifetime.')
  }
  return {
    accessToken,
    refreshToken: boundedString(doc.refresh_token),
    idToken: boundedString(doc.id_token),
    expiresInSeconds: expiresIn,
    scopes: typeof doc.scope === 'string' ? [...new Set(doc.scope.split(/\s+/).filter(Boolean))] : null,
  }
}

async function tokenRequest(
  fetchImpl: FetchLike,
  metadata: ChatGptMetadata,
  credentials: ChatGptClientCredentials,
  body: URLSearchParams,
): Promise<ChatGptTokenResponse> {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    ...clientAuth(credentials, body),
  }
  const { status, body: response } = await fetchJson(fetchImpl, metadata.tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  })
  if (status !== 200) {
    // The error code is safe to keep; the description can echo request
    // material, so it is dropped.
    const error = asObject(response)?.error
    throw new ChatGptProtocolError('ChatGPT refused the token request.', status, typeof error === 'string' ? error : null)
  }
  return parseTokenResponse(response)
}

export function exchangeChatGptCode(
  fetchImpl: FetchLike,
  metadata: ChatGptMetadata,
  credentials: ChatGptClientCredentials,
  input: { code: string; codeVerifier: string; redirectUri: string; resource: string | null },
): Promise<ChatGptTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
  })
  if (input.resource) body.set('resource', input.resource)
  return tokenRequest(fetchImpl, metadata, credentials, body)
}

/**
 * Refresh a plan grant. `scope` is deliberately omitted so the refresh keeps
 * exactly the grant the person consented to.
 */
export function refreshChatGptTokens(
  fetchImpl: FetchLike,
  metadata: ChatGptMetadata,
  credentials: ChatGptClientCredentials,
  refreshToken: string,
): Promise<ChatGptTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    resource: CHATGPT_RESOURCE,
  })
  return tokenRequest(fetchImpl, metadata, credentials, body)
}

/** Best-effort revocation. Resolves true only when OpenAI confirmed it. */
export async function revokeChatGptToken(
  fetchImpl: FetchLike,
  metadata: ChatGptMetadata,
  credentials: ChatGptClientCredentials,
  token: string,
  hint: 'refresh_token' | 'access_token',
): Promise<boolean> {
  if (!metadata.revocationEndpoint) return false
  const body = new URLSearchParams({ token, token_type_hint: hint })
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    ...clientAuth(credentials, body),
  }
  try {
    const response = await fetchImpl(metadata.revocationEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    // RFC 7009: 200 for a revoked or already-invalid token alike.
    return response.status === 200
  } catch {
    return false
  }
}

/** Signing keys, cached per process and refetched on an unknown `kid`. */
export class ChatGptJwks {
  private keys = new Map<string, crypto.KeyObject>()
  private fetchedAt = 0
  private lastRefetchAt = 0

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  async keyFor(jwksUri: string, kid: string): Promise<crypto.KeyObject | null> {
    const stale = this.now() - this.fetchedAt > METADATA_TTL_MS
    if (stale || (!this.keys.has(kid) && this.now() - this.lastRefetchAt >= JWKS_REFETCH_MIN_INTERVAL_MS)) {
      await this.refetch(jwksUri)
    }
    return this.keys.get(kid) ?? null
  }

  private async refetch(jwksUri: string): Promise<void> {
    this.lastRefetchAt = this.now()
    const keys = await withRetry(async () => {
      const { status, body } = await fetchJson(this.fetchImpl, jwksUri)
      const list = asObject(body)?.keys
      if (status !== 200 || !Array.isArray(list)) throw new ChatGptProtocolError('ChatGPT signing keys could not be read.', status)
      return list as unknown[]
    }, READ_RETRY)
    const next = new Map<string, crypto.KeyObject>()
    for (const candidate of keys) {
      const jwk = asObject(candidate)
      if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue
      if (jwk.use !== undefined && jwk.use !== 'sig') continue
      if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue
      if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }))
      } catch {
        // A malformed key is skipped; a token signed by it then fails to verify.
      }
    }
    this.keys = next
    this.fetchedAt = this.now()
  }
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

/**
 * Verify an ID token and return the identity it carries. Every check that
 * makes the token trustworthy is here, and any failure throws:
 *
 *   1. RS256 only, with a `kid` the issuer currently publishes.
 *   2. The signature verifies against that key.
 *   3. `iss` is exactly OpenAI's issuer.
 *   4. `aud` names this client; with several audiences, `azp` must too.
 *   5. `exp` is in the future and `iat` is not, within a minute of skew.
 *   6. `nonce` matches the one this sign-in sent, so a token minted for a
 *      different sign-in cannot be replayed into this one.
 *   7. `sub` is present.
 */
export async function verifyChatGptIdToken(
  idToken: string,
  input: { metadata: ChatGptMetadata; jwks: ChatGptJwks; clientId: string; nonce: string; now: number },
): Promise<ChatGptIdentityClaims> {
  const parts = idToken.split('.')
  if (parts.length !== 3 || parts.some(part => !part)) throw new ChatGptProtocolError('ChatGPT returned a malformed ID token.')
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string]
  const header = decodeSegment(headerSegment)
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new ChatGptProtocolError('ChatGPT returned an ID token with an unexpected signature type.')
  }
  const key = await input.jwks.keyFor(input.metadata.jwksUri, header.kid)
  if (!key) throw new ChatGptProtocolError('ChatGPT signed the ID token with an unknown key.')
  const signed = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerSegment}.${payloadSegment}`),
    key,
    Buffer.from(signatureSegment, 'base64url'),
  )
  if (!signed) throw new ChatGptProtocolError('The ChatGPT ID token signature did not verify.')

  const claims = decodeSegment(payloadSegment)
  if (!claims) throw new ChatGptProtocolError('ChatGPT returned an unreadable ID token.')
  if (claims.iss !== CHATGPT_ISSUER) throw new ChatGptProtocolError('The ChatGPT ID token came from an unexpected issuer.')
  const audience = claims.aud
  const audiences = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : []
  if (!audiences.includes(input.clientId)) throw new ChatGptProtocolError('The ChatGPT ID token was issued to a different client.')
  if (audiences.length > 1 && claims.azp !== input.clientId) {
    throw new ChatGptProtocolError('The ChatGPT ID token was issued to a different client.')
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= input.now - CLOCK_SKEW_MS) {
    throw new ChatGptProtocolError('The ChatGPT ID token has expired.')
  }
  if (typeof claims.iat === 'number' && claims.iat * 1000 > input.now + CLOCK_SKEW_MS) {
    throw new ChatGptProtocolError('The ChatGPT ID token was issued in the future.')
  }
  if (typeof claims.nonce !== 'string' || !sameString(claims.nonce, input.nonce)) {
    throw new ChatGptProtocolError('The ChatGPT ID token belongs to a different sign-in.')
  }
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) {
    throw new ChatGptProtocolError('The ChatGPT ID token has no subject.')
  }
  const email = typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : null
  return {
    subject: claims.sub,
    email,
    emailVerified: email !== null && claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : null,
  }
}

export interface ChatGptPlanModel {
  id: string
  name: string
}

/**
 * The models a person's plan can use, in OpenAI's order. Only entries OpenAI
 * marks `visibility: "list"` are offered. Tolerates the standard `data[]`
 * shape as well as the plan endpoint's `models[]`.
 */
export async function listChatGptPlanModels(fetchImpl: FetchLike, accessToken: string): Promise<ChatGptPlanModel[]> {
  const body = await withRetry(async () => {
    const response = await fetchJson(fetchImpl, `${CHATGPT_RESOURCE}/models`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
    if (response.status !== 200) throw new ChatGptProtocolError('ChatGPT did not return the plan\'s models.', response.status)
    return response.body
  }, READ_RETRY)
  const doc = asObject(body)
  const models: ChatGptPlanModel[] = []
  const seen = new Set<string>()
  const push = (id: unknown, name: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 200 || seen.has(id)) return
    seen.add(id)
    models.push({ id, name: typeof name === 'string' && name ? name.slice(0, 200) : id })
  }
  if (Array.isArray(doc?.models)) {
    for (const entry of doc.models) {
      const model = asObject(entry)
      if (!model || model.visibility !== 'list') continue
      push(model.slug ?? model.id, model.display_name ?? model.name)
    }
  } else if (Array.isArray(doc?.data)) {
    for (const entry of doc.data) {
      const model = asObject(entry)
      if (!model) continue
      if (model.visibility !== undefined && model.visibility !== 'list') continue
      push(model.id ?? model.slug, model.display_name ?? model.name)
    }
  }
  return models
}

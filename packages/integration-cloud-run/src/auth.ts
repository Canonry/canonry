import crypto from 'node:crypto'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_OAUTH_REFRESH_URL = 'https://oauth2.googleapis.com/token'
export const CLOUD_LOGGING_READ_SCOPE = 'https://www.googleapis.com/auth/logging.read'
const TOKEN_REQUEST_TIMEOUT_MS = 30_000

export class CloudRunAuthError extends Error {
  constructor(message: string, public readonly httpStatus?: number, public readonly body?: string) {
    super(message)
    this.name = 'CloudRunAuthError'
  }
}

function createServiceAccountJwt(clientEmail: string, privateKey: string, scope: string): string {
  if (!clientEmail) throw new CloudRunAuthError('clientEmail is required')
  if (!privateKey) throw new CloudRunAuthError('privateKey is required')
  if (!scope) throw new CloudRunAuthError('scope is required')

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: clientEmail,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }
  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const headerB64 = encode(header)
  const payloadB64 = encode(payload)
  const signingInput = `${headerB64}.${payloadB64}`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(signingInput)
  const signature = sign.sign(privateKey, 'base64url')
  return `${signingInput}.${signature}`
}

/**
 * Exchange a service-account key for a Cloud Logging access token. The token
 * scope is `logging.read`, which is the minimum needed for `entries.list`.
 */
export async function getCloudLoggingAccessToken(
  clientEmail: string,
  privateKey: string,
): Promise<string> {
  const jwt = createServiceAccountJwt(clientEmail, privateKey, CLOUD_LOGGING_READ_SCOPE)
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CloudRunAuthError(
      `Service-account token exchange failed (HTTP ${res.status})`,
      res.status,
      body.slice(0, 500),
    )
  }
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) {
    throw new CloudRunAuthError('Service-account token response missing access_token', res.status)
  }
  return data.access_token
}

/**
 * Refresh a long-lived OAuth access token using the user's refresh token. The
 * caller supplies the OAuth client_id/client_secret (typically the same Google
 * OAuth app used by GSC).
 */
export async function refreshCloudLoggingAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(GOOGLE_OAUTH_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CloudRunAuthError(
      `OAuth refresh failed (HTTP ${res.status})`,
      res.status,
      body.slice(0, 500),
    )
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) {
    throw new CloudRunAuthError('OAuth refresh response missing access_token', res.status)
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 3600 }
}

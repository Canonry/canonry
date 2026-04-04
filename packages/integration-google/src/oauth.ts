import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_REQUEST_TIMEOUT_MS } from './constants.js'
import type { GoogleTokenResponse } from './types.js'
import { GoogleAuthError } from './types.js'

function validateClientId(clientId: string): void {
  if (!clientId || typeof clientId !== 'string' || clientId.trim().length === 0) {
    throw new GoogleAuthError('Client ID is required and must be a non-empty string')
  }
}

function validateClientSecret(clientSecret: string): void {
  if (!clientSecret || typeof clientSecret !== 'string' || clientSecret.trim().length === 0) {
    throw new GoogleAuthError('Client secret is required and must be a non-empty string')
  }
}

function validateRedirectUri(redirectUri: string): void {
  if (!redirectUri || typeof redirectUri !== 'string' || redirectUri.trim().length === 0) {
    throw new GoogleAuthError('Redirect URI is required and must be a non-empty string')
  }
  try {
    const url = new URL(redirectUri)
    if (!url.protocol.startsWith('http')) {
      throw new GoogleAuthError('Redirect URI must be an HTTP or HTTPS URL')
    }
  } catch {
    throw new GoogleAuthError('Redirect URI must be a valid URL')
  }
}

function validateCode(code: string): void {
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    throw new GoogleAuthError('Authorization code is required and must be a non-empty string')
  }
}

function validateScopes(scopes: string[]): void {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new GoogleAuthError('At least one scope is required')
  }
  for (const scope of scopes) {
    if (!scope || typeof scope !== 'string' || scope.trim().length === 0) {
      throw new GoogleAuthError('Scope must be a non-empty string')
    }
  }
}

function validateRefreshToken(refreshToken: string): void {
  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    throw new GoogleAuthError('Refresh token is required and must be a non-empty string')
  }
}

export function getAuthUrl(
  clientId: string,
  redirectUri: string,
  scopes: string[],
  state?: string,
): string {
  validateClientId(clientId)
  validateRedirectUri(redirectUri)
  validateScopes(scopes)
  if (state && (typeof state !== 'string' || state.trim().length === 0)) {
    throw new GoogleAuthError('State must be a non-empty string if provided')
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  })
  if (state) params.set('state', state)
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  validateClientId(clientId)
  validateClientSecret(clientSecret)
  validateCode(code)
  validateRedirectUri(redirectUri)
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new GoogleAuthError(`Token exchange failed (${res.status}): ${body}`)
  }

  return (await res.json()) as GoogleTokenResponse
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  currentRefreshToken: string,
): Promise<GoogleTokenResponse> {
  validateClientId(clientId)
  validateClientSecret(clientSecret)
  validateRefreshToken(currentRefreshToken)
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: currentRefreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new GoogleAuthError(`Token refresh failed (${res.status}): ${body}`)
  }

  return (await res.json()) as GoogleTokenResponse
}

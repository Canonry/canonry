import * as oidc from 'openid-client'
import * as oauth from 'oauth4webapi'
import { authInvalid } from '@ainyc/canonry-contracts'

export const GOOGLE_ISSUER = 'https://accounts.google.com'

export interface GoogleIdentity {
  issuer: string
  subject: string
  email: string | null
  emailVerified: boolean
  hostedDomain: string | null
  name: string | null
}

export interface GoogleLoginChecks {
  state: string
  nonce: string
  codeVerifier: string
}

export interface GoogleOidcClient {
  authorizationUrl(input: GoogleLoginChecks & { redirectUri: string }): Promise<string>
  authenticate(input: GoogleLoginChecks & { callbackUrl: URL }): Promise<GoogleIdentity>
}

/**
 * Fixed Google endpoints prevent instance configuration from becoming an SSRF
 * surface. Transport injection is for offline protocol tests, never config.
 */
export function createGoogleOidcClient(
  credentials: { clientId: string; clientSecret: string },
  transport?: oidc.CustomFetch,
): GoogleOidcClient {
  const server: oauth.AuthorizationServer = {
    issuer: GOOGLE_ISSUER,
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    id_token_signing_alg_values_supported: ['RS256'],
  }
  const legacyServer = { ...server, issuer: 'accounts.google.com' }
  const client: oauth.Client = { client_id: credentials.clientId, id_token_signed_response_alg: 'RS256' }
  const clientAuth = oauth.ClientSecretPost(credentials.clientSecret)
  const config = new oidc.Configuration(server, credentials.clientId, credentials.clientSecret)

  return {
    async authorizationUrl(input) {
      const codeChallenge = await oidc.calculatePKCECodeChallenge(input.codeVerifier)
      return oidc.buildAuthorizationUrl(config, {
        response_type: 'code',
        redirect_uri: input.redirectUri,
        scope: 'openid email profile',
        state: input.state,
        nonce: input.nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).href
    },
    async authenticate(input) {
      const parameters = oauth.validateAuthResponse(server, client, input.callbackUrl, input.state)
      const redirectUri = new URL(input.callbackUrl)
      redirectUri.search = ''
      redirectUri.hash = ''
      const requestOptions = {
        [oauth.customFetch]: transport,
        signal: AbortSignal.timeout(10_000),
      }
      // Exchange the one-time code exactly once. Google documents two issuer
      // forms; revalidate only the saved response against the second fixed issuer.
      const response = await oauth.authorizationCodeGrantRequest(
        server, client, clientAuth, parameters, redirectUri.href, input.codeVerifier, requestOptions,
      )
      const savedResponse = response.clone()
      const checks = { expectedNonce: input.nonce, requireIdToken: true }
      let verifiedServer = server
      let verifiedResponse = response
      let tokens: oauth.TokenEndpointResponse
      try {
        tokens = await oauth.processAuthorizationCodeResponse(server, client, response, checks)
      } catch (error) {
        if (!(error instanceof oauth.OperationProcessingError)
          || error.code !== oauth.JWT_CLAIM_COMPARISON
          || (error.cause as { claim?: unknown } | undefined)?.claim !== 'iss') throw error
        verifiedServer = legacyServer
        verifiedResponse = savedResponse
        tokens = await oauth.processAuthorizationCodeResponse(legacyServer, client, savedResponse, checks)
      }
      // Claim checks alone are insufficient: verify the original token signature
      // with Google's fixed JWKS endpoint before returning any identity.
      await oauth.validateApplicationLevelSignature(verifiedServer, verifiedResponse, requestOptions)
      const claims = oauth.getValidatedIdTokenClaims(tokens)
      if (!claims?.sub || (claims.iss !== GOOGLE_ISSUER && claims.iss !== legacyServer.issuer)) throw authInvalid()
      return {
        issuer: GOOGLE_ISSUER,
        subject: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : null,
        emailVerified: claims.email_verified === true,
        hostedDomain: typeof claims.hd === 'string' && claims.hd.length > 0 ? claims.hd : null,
        name: typeof claims.name === 'string' ? claims.name : null,
      }
    },
  }
}

/** Google is not authoritative for every external mailbox used by an account. */
export function hasAuthoritativeGoogleEmail(identity: GoogleIdentity): boolean {
  return identity.emailVerified && identity.email !== null
    && (identity.email.toLowerCase().endsWith('@gmail.com') || identity.hostedDomain !== null)
}

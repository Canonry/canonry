import * as oidc from 'openid-client'
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
  const config = new oidc.Configuration({
    issuer: GOOGLE_ISSUER,
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    id_token_signing_alg_values_supported: ['RS256'],
  }, credentials.clientId, credentials.clientSecret)
  config.timeout = 10
  if (transport) config[oidc.customFetch] = transport
  // Code exchange over TLS alone is not our signature-verification boundary.
  oidc.enableNonRepudiationChecks(config)

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
      // Never blindly retry a one-time authorization code exchange.
      const tokens = await oidc.authorizationCodeGrant(config, input.callbackUrl, {
        expectedState: input.state,
        expectedNonce: input.nonce,
        pkceCodeVerifier: input.codeVerifier,
        idTokenExpected: true,
      })
      const claims = tokens.claims()
      if (!claims?.sub || claims.iss !== GOOGLE_ISSUER) throw authInvalid()
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

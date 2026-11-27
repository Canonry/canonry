/**
 * Resolve config.yaml's `chatgpt` block into what the sign-in service needs.
 *
 * Read on every call rather than once at boot, so switching ChatGPT sign-in or
 * plan usage on or off in config.yaml takes effect on the next request once
 * the server reloads its config, with no stale copy left in a closure.
 */
import { parseChatGptTokenKey, type ChatGptSignInSettings } from '@canonry/canonry-api-routes'
import type { CanonryConfig } from './config.js'

const CALLBACK_SUFFIX = '/api/v1/auth/chatgpt/callback'

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}

/**
 * The callback OpenAI redirects to: `publicUrl` plus the API path, mirroring
 * the Google callback. HTTPS only, except a loopback host for local testing.
 * Null when there is no usable public URL, which leaves ChatGPT off.
 */
export function chatGptRedirectUri(publicUrl: string | undefined): string | null {
  const configured = publicUrl?.trim()
  if (!configured) return null
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) return null
  return `${url.origin}${url.pathname.replace(/\/$/, '')}${CALLBACK_SUFFIX}`
}

/** Null when ChatGPT is not configured, switched off, or the install has no usable public URL. */
export function resolveChatGptSettings(
  config: Pick<CanonryConfig, 'chatgpt' | 'publicUrl'>,
  env: NodeJS.ProcessEnv = process.env,
): ChatGptSignInSettings | null {
  const entry = config.chatgpt
  const clientId = entry?.clientId?.trim()
  if (!entry || !clientId || (entry.signIn !== true && entry.planUsage !== true)) return null
  const redirectUri = chatGptRedirectUri(config.publicUrl)
  if (!redirectUri) return null
  const clientSecret = entry.clientSecret?.trim()
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    signIn: entry.signIn === true,
    planUsage: entry.planUsage === true,
    requirePlan: entry.requirePlan === true,
    tokenKey: parseChatGptTokenKey(env.CANONRY_CHATGPT_TOKEN_KEY ?? entry.tokenKey),
    redirectUri,
  }
}

import crypto from 'node:crypto'
import { z } from 'zod'
import { authInvalid, validationError } from '@ainyc/canonry-contracts'

const loginStateSchema = z.object({
  state: z.string().min(16).max(128),
  nonce: z.string().min(16).max(128),
  codeVerifier: z.string().min(43).max(128),
  // v1 cookies carried this. New attempts keep it on the single-use database
  // transaction, but accepting it here lets an in-flight old cookie finish.
  returnTo: z.string().max(4096).optional(),
  expiresAt: z.number().finite(),
  invitationHash: z.string().length(64).optional(),
  linkUserId: z.string().max(128).optional(),
  linkAuthVersion: z.number().int().nonnegative().optional(),
})
export type GoogleLoginState = z.infer<typeof loginStateSchema>

export interface GoogleLoginUrls {
  baseUrl: string
  basePath: string
  callbackUrl: string
}

function normalizedPath(path: string): string {
  const normalized = '/' + path.replace(/^\/+|\/+$/g, '') + '/'
  const value = normalized === '//' ? '/' : normalized
  if ((value.includes('\\') || /[?#%]/.test(value)) || /(?:^|\/)\.\.?(?:\/|$)/.test(value)) {
    throw validationError('Google sign-in needs a valid instance base path.')
  }
  return value
}

/** Use only an explicitly configured public URL, never request Host headers. */
export function googleLoginUrls(publicUrl: string | undefined, basePath?: string): GoogleLoginUrls {
  if (!publicUrl) throw validationError('Set the public URL before enabling Google sign-in.')
  let url: URL
  try { url = new URL(publicUrl) } catch { throw validationError('The public URL is invalid.') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.search || url.hash) {
    throw validationError('Google sign-in requires an HTTPS public URL, or localhost for development.')
  }
  const publicPath = normalizedPath(url.pathname)
  const path = basePath === undefined ? publicPath : normalizedPath(basePath)
  if (publicPath !== '/' && publicPath !== path) {
    throw validationError('The public URL and instance base path must agree.')
  }
  url.pathname = path
  return { baseUrl: url.href, basePath: path, callbackUrl: new URL('api/v1/auth/google/callback', url).href }
}

export function safeAuthReturnPath(value: string | undefined, urls: GoogleLoginUrls): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return urls.basePath
  const path = value.split('?')[0]!.split('#')[0]!
  if (path.includes('\\') || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /%2f|%5c/i.test(path)) return urls.basePath
  let resolved: URL
  try { resolved = new URL(value, urls.baseUrl) } catch { return urls.basePath }
  if (resolved.origin !== new URL(urls.baseUrl).origin || !resolved.pathname.startsWith(urls.basePath)) {
    return urls.basePath
  }
  return resolved.pathname + resolved.search
}

function stateKey(secret: string): Buffer {
  return crypto.createHash('sha256').update('canonry-google-login-state-v1\0').update(secret).digest()
}

/** Encryption keeps the recoverable PKCE verifier out of storage and readable cookies. */
export function sealGoogleLoginState(value: GoogleLoginState, secret: string, callbackUrl: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', stateKey(secret), iv)
  cipher.setAAD(Buffer.from(callbackUrl))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [iv, encrypted, cipher.getAuthTag()].map(part => part.toString('base64url')).join('.')
}

export function openGoogleLoginState(value: string, secret: string, callbackUrl: string, now = Date.now()): GoogleLoginState {
  try {
    if (value.length > 8192) throw authInvalid()
    const parts = value.split('.')
    if (parts.length !== 3) throw authInvalid()
    const [iv, encrypted, tag] = parts.map(part => Buffer.from(part, 'base64url'))
    if (iv!.length !== 12 || tag!.length !== 16) throw authInvalid()
    const decipher = crypto.createDecipheriv('aes-256-gcm', stateKey(secret), iv!)
    decipher.setAAD(Buffer.from(callbackUrl))
    decipher.setAuthTag(tag!)
    const plain = Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8')
    const parsed = loginStateSchema.parse(JSON.parse(plain))
    if (parsed.expiresAt <= now) throw authInvalid()
    return parsed
  } catch {
    throw authInvalid()
  }
}

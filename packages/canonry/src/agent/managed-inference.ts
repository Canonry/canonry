import crypto from 'node:crypto'
import { z } from 'zod'
import { authInvalid, forbidden } from '@ainyc/canonry-contracts'

/** Host-to-host grant; this supplements, and never replaces, the API credential. */
export const MANAGED_INFERENCE_HEADER = 'x-canonry-managed-inference'
export const MANAGED_INFERENCE_MAX_TTL_MS = 10 * 60 * 1000

const identity = z.string().min(1).max(256).refine(value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
const shared = {
  v: z.literal(1),
  grantId: z.string().uuid(),
  actorId: identity,
  connectionId: identity,
  projectName: identity,
  modelId: z.string().min(1).max(200).regex(/^[a-z\d][\w.:/-]*$/i),
  expiresAt: z.number().int().positive(),
}
const grantSchema = z.discriminatedUnion('purpose', [
  z.object({ ...shared, purpose: z.literal('turn'), accessToken: z.string().min(1).max(32_768) }).strict(),
  z.object({ ...shared, purpose: z.literal('read'), modelId: shared.modelId.or(z.literal('')) }).strict(),
])

export type ManagedInferenceGrant = z.infer<typeof grantSchema>
export type ManagedInferenceTurnGrant = Extract<ManagedInferenceGrant, { purpose: 'turn' }>

export function openManagedInferenceGrant(
  header: string | string[] | undefined,
  key: string | undefined,
  projectName: string,
  purpose: ManagedInferenceGrant['purpose'],
  now = Date.now(),
): ManagedInferenceGrant | undefined {
  if (header === undefined) return undefined
  if (!key) throw forbidden('Personal Aero inference is not enabled on this instance.')
  try {
    if (!/^[\da-f]{64}$/i.test(key) || typeof header !== 'string' || header.length > 70_000) throw authInvalid()
    const parts = header.split('.')
    if (parts.length !== 3) throw authInvalid()
    const [iv, tag, ciphertext] = parts as [string, string, string]
    if (!/^[\da-f]{24}$/i.test(iv) || !/^[\da-f]{32}$/i.test(tag)
      || !/^(?:[\da-f]{2})+$/i.test(ciphertext)) throw authInvalid()
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'))
    decipher.setAuthTag(Buffer.from(tag, 'hex'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()])
    const grant = grantSchema.parse(JSON.parse(plaintext.toString('utf8')))
    if (grant.projectName !== projectName || grant.purpose !== purpose
      || grant.expiresAt <= now || grant.expiresAt > now + MANAGED_INFERENCE_MAX_TTL_MS) throw authInvalid()
    return grant
  } catch {
    // Cryptographic errors, malformed claims, and plaintext never reach logs or responses.
    throw authInvalid()
  }
}

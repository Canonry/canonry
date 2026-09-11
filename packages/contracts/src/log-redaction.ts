const REDACTED = '[REDACTED]'
const TRUNCATED = '[TRUNCATED]'
const CIRCULAR = '[CIRCULAR]'
const UNREADABLE = '[UNREADABLE]'
const OMITTED = '[OMITTED]'
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 50
const MAX_OBJECT_KEYS = 100
const MAX_STRING_LENGTH = 4_096

const secretKey = /api[-_]?key|authorization|auth(?:entication)?|cookie|password|secret|token|credential/i
const unsafeGraphKey = /^(?:req|res|request|reply|raw|socket|headers?|body|responsebody|apiresponse|rawresponse|provider(?:body|response)?)$/i

/**
 * Redacts and bounds untrusted diagnostic values before they reach a runtime
 * log sink. This deliberately returns plain data only and never reads getters.
 */
export function redactLogValue(value: unknown): unknown {
  try {
    return redactValue(value, 0, new WeakSet<object>())
  } catch {
    return UNREADABLE
  }
}

/** Redacts credentials embedded in a human-readable diagnostic string. */
export function redactLogString(value: string): string {
  try {
    const clipped = value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`
      : value
    return redactEmbeddedUrls(clipped)
      .replace(
        /(["']?[\w-]*(?:api[-_]?key|auth|cookie|password|secret|token|credential)[\w-]*["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$))/gi,
        `$1${REDACTED}`,
      )
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, (_match, scheme: string) => `${scheme} ${REDACTED}`)
      .replace(
        /(api[-_]?key|authorization|auth(?:entication)?|cookie|password|secret|token|credential)\s*([=:])\s*[^\s&,'")\]}]+/gi,
        `$1$2${REDACTED}`,
      ).slice(0, MAX_STRING_LENGTH)
  } catch {
    return UNREADABLE
  }
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>, key?: string): unknown {
  // These fields contain database identifiers, never authentication material.
  if (key && diagnosticIdentity(key, value) !== undefined) return value
  if (key && secretKey.test(key)) return REDACTED
  if (key && unsafeGraphKey.test(key)) return OMITTED
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return redactLogString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return undefined
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}]`
  if (depth >= MAX_DEPTH) return TRUNCATED
  if (typeof value !== 'object') return UNREADABLE
  if (seen.has(value)) return CIRCULAR
  seen.add(value)
  try {
    if (value instanceof Error) return redactError(value, depth, seen)
    if (Array.isArray(value)) {
      const output: unknown[] = []
      const length = safeArrayLength(value)
      for (let index = 0; index < Math.min(length, MAX_ARRAY_ITEMS); index++) {
        output.push(redactValue(safeProperty(value, String(index)), depth + 1, seen))
      }
      if (length > MAX_ARRAY_ITEMS) output.push(TRUNCATED)
      return output
    }
    const output: Record<string, unknown> = {}
    const keys = safeKeys(value)
    for (const nestedKey of keys.slice(0, MAX_OBJECT_KEYS)) {
      output[nestedKey] = redactValue(safeProperty(value, nestedKey), depth + 1, seen, nestedKey)
    }
    if (keys.length > MAX_OBJECT_KEYS) output.__truncated = true
    return output
  } catch {
    return UNREADABLE
  } finally {
    seen.delete(value)
  }
}

/** Preserve typed principal/credential IDs without exempting free-text secrets. */
export function diagnosticIdentity(key: string, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (key === 'actor' && /^(?:api-key|user):[\w.-]{1,256}$/.test(value)) return value
  if (key === 'credentialId' && /^[\w.-]{1,256}$/.test(value)) return value
  return undefined
}

function redactError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: redactLogString(safeErrorString(error, 'name')),
    message: redactLogString(safeErrorString(error, 'message')),
  }
  const stack = safeErrorString(error, 'stack')
  if (stack) output.stack = redactLogString(stack)
  for (const key of safeKeys(error).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = redactValue(safeProperty(error, key), depth + 1, seen, key)
  }
  return output
}

function safeKeys(value: object): string[] {
  try { return Object.keys(value) } catch { return [] }
}

function safeArrayLength(value: unknown[]): number {
  try { return Number.isSafeInteger(value.length) && value.length >= 0 ? value.length : 0 } catch { return 0 }
}

function safeProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) return UNREADABLE
    return descriptor.value
  } catch {
    return UNREADABLE
  }
}

function safeErrorString(error: Error, key: 'name' | 'message' | 'stack'): string {
  try {
    const value = error[key]
    return typeof value === 'string' ? value : ''
  } catch {
    return UNREADABLE
  }
}

function redactEmbeddedUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, candidate => {
    // Clipping can hide the '@' that distinguishes userinfo from a hostname.
    if (candidate.includes(TRUNCATED)) return '[TRUNCATED_URL]'
    const suffix = candidate.match(/[),.;!?\]}]+$/)?.[0] ?? ''
    const rawUrl = suffix ? candidate.slice(0, -suffix.length) : candidate
    try {
      const url = new URL(rawUrl)
      if (url.username || url.password) {
        url.username = REDACTED
        url.password = REDACTED
      }
      for (const key of [...url.searchParams.keys()]) {
        if (secretKey.test(key)) url.searchParams.set(key, REDACTED)
      }
      return `${url.toString()}${suffix}`
    } catch {
      return `[REDACTED_URL]${suffix}`
    }
  })
}

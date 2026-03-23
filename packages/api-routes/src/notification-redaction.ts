export interface RedactedNotificationUrl {
  url: string
  urlDisplay: string
  urlHost: string
}

const REDACTED_URL: RedactedNotificationUrl = {
  url: 'https://redacted.invalid/redacted',
  urlDisplay: 'invalid-url/redacted',
  urlHost: 'invalid-url',
}

export function redactNotificationUrl(rawUrl: string): RedactedNotificationUrl {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.host || parsed.hostname
    return {
      url: `${parsed.protocol}//${host}/redacted`,
      urlDisplay: `${host}/redacted`,
      urlHost: host,
    }
  } catch {
    return REDACTED_URL
  }
}

export function redactNotificationDiff(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactNotificationDiff)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'url' && typeof entry === 'string') {
      const redacted = redactNotificationUrl(entry)
      output.url = redacted.url
      output.urlDisplay = redacted.urlDisplay
      output.urlHost = redacted.urlHost
      continue
    }

    output[key] = redactNotificationDiff(entry)
  }

  return output
}

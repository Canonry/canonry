import type { CloudRunLogFilterOptions } from './types.js'

function assertNonEmpty(name: string, value: string): void {
  if (!value.trim()) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function quoteLogFilterValue(value: string): string {
  return JSON.stringify(value)
}

function normalizeTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`)
  }
  return date.toISOString()
}

export function buildCloudRunLogFilter(options: CloudRunLogFilterOptions = {}): string {
  const clauses = ['resource.type="cloud_run_revision"']

  if (options.serviceName !== undefined) {
    assertNonEmpty('serviceName', options.serviceName)
    clauses.push(`resource.labels.service_name=${quoteLogFilterValue(options.serviceName)}`)
  }

  if (options.location !== undefined) {
    assertNonEmpty('location', options.location)
    clauses.push(`resource.labels.location=${quoteLogFilterValue(options.location)}`)
  }

  if (options.startTime !== undefined) {
    clauses.push(`timestamp >= ${quoteLogFilterValue(normalizeTimestamp(options.startTime))}`)
  }

  if (options.endTime !== undefined) {
    clauses.push(`timestamp < ${quoteLogFilterValue(normalizeTimestamp(options.endTime))}`)
  }

  const userAgentSubstrings = (options.userAgentSubstrings ?? [])
    .map((pattern) => pattern.trim())
    .filter(Boolean)

  if (userAgentSubstrings.length > 0) {
    const uaClauses = userAgentSubstrings.map((pattern) => (
      `httpRequest.userAgent:${quoteLogFilterValue(pattern)}`
    ))
    clauses.push(`(${uaClauses.join(' OR ')})`)
  }

  return clauses.join(' AND ')
}

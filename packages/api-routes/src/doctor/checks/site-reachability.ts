import { CheckCategories, CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import { probeSiteReachability } from '../../site-reachability.js'
import type { CheckDefinition, CheckOutput } from '../types.js'

/** Check id the site-liveness loop runs on its own, every few minutes. */
export const SITE_REACHABILITY_CHECK_ID = 'site.reachability'

/**
 * The stored domain, as a hostname we can probe.
 *
 * `canonicalDomain` is written raw by the project upsert and by apply, so it can
 * arrive with a scheme, a path, or as a bare project name. `hostOf` is not used
 * here: it strips `www.`, and a www-only site would then have its apex probed
 * and paged as down.
 */
export function probeHostFromDomain(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  let hostname: string
  try {
    hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return null
  }
  hostname = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  // A name with no dot is a project slug or an intranet label, not a site this
  // instance can reach. Probing it would page an outage that is not one.
  if (!hostname || !hostname.includes('.') || hostname.endsWith('.localhost')) return null
  return hostname
}

const skipped = (code: string, summary: string): CheckOutput => ({ status: CheckStatuses.skipped, code, summary, remediation: null })

const siteReachabilityCheck: CheckDefinition = {
  id: SITE_REACHABILITY_CHECK_ID,
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Website reachable',
  // Reaches the network, and one bad answer is not an outage: the liveness loop
  // names it explicitly and applies the two-pass debounce. An unfiltered
  // `canonry doctor --project` must not exit 1 on a single dropped packet.
  optIn: true,
  run: async (ctx) => {
    if (!ctx.project) return skipped('site.reachability.no-project', 'Project context required.')
    const host = probeHostFromDomain(ctx.project.canonicalDomain)
    if (!host) {
      return skipped('site.reachability.no-domain', `Project domain "${(ctx.project.canonicalDomain ?? '').trim()}" is not a probeable hostname.`)
    }
    const url = `https://${host}/`

    const probe = ctx.probeSiteReachability ?? probeSiteReachability
    const result = await probe(url)
    if (result.state === 'unavailable') {
      // Our resolver or network, not their site. Reporting this as down would
      // page every project on the instance for one local outage.
      return skipped('site.reachability.probe-unavailable', `Could not probe ${url} from this host: ${result.reason}.`)
    }
    if (result.state === 'up') {
      return {
        status: CheckStatuses.ok,
        code: 'site.reachability.up',
        summary: `${url} answered HTTP ${result.httpStatus} in ${result.durationMs} ms.`,
        remediation: null,
        details: {
          url, finalUrl: result.finalUrl, httpStatus: result.httpStatus, attempts: result.attempts, durationMs: result.durationMs,
          ...(result.lenient ? { tlsOrParserWarning: result.lenient } : {}),
        },
      }
    }
    if (result.state === 'unreachable') {
      // The name resolves only to addresses this instance refuses to dial (a
      // sinkholed or suspended domain). Visitors cannot reach it either.
      return {
        status: CheckStatuses.fail,
        code: 'site.reachability.refused-address',
        summary: `${url} resolves only to addresses that cannot serve visitors: ${result.reason}.`,
        remediation: 'Check the domain registration and its DNS records. A suspended or parked domain resolves this way.',
        details: { url, finalUrl: result.finalUrl, reason: result.reason, attempts: result.attempts, durationMs: result.durationMs },
      }
    }
    return {
      status: CheckStatuses.fail,
      code: 'site.reachability.down',
      summary: `${url} is not responding: ${result.reason}.`,
      remediation: 'Open the site in a browser and check with the host. Canonry keeps checking and sends health.recovered when it answers again.',
      details: { url, finalUrl: result.finalUrl, httpStatus: result.httpStatus, reason: result.reason, attempts: result.attempts, durationMs: result.durationMs },
    }
  },
}

export const SITE_REACHABILITY_CHECKS: readonly CheckDefinition[] = [siteReachabilityCheck]

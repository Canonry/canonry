import { CheckCategories, CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import { probeSiteReachability } from '../../site-reachability.js'
import type { CheckDefinition } from '../types.js'

/** Check id the site-liveness schedule runs on its own, every few minutes. */
export const SITE_REACHABILITY_CHECK_ID = 'site.reachability'

const siteReachabilityCheck: CheckDefinition = {
  id: SITE_REACHABILITY_CHECK_ID,
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Website reachable',
  run: async (ctx) => {
    if (!ctx.project) {
      return { status: CheckStatuses.skipped, code: 'site.reachability.no-project', summary: 'Project context required.', remediation: null }
    }
    const domain = ctx.project.canonicalDomain?.trim()
    let url: string
    try {
      url = new URL(`https://${domain}/`).toString()
    } catch {
      return {
        status: CheckStatuses.skipped,
        code: 'site.reachability.no-domain',
        summary: `Project domain "${domain ?? ''}" is not a probeable hostname.`,
        remediation: null,
      }
    }
    if (!domain) {
      return { status: CheckStatuses.skipped, code: 'site.reachability.no-domain', summary: 'Project has no domain to probe.', remediation: null }
    }

    const probe = ctx.probeSiteReachability ?? probeSiteReachability
    const result = await probe(url)
    if (result.state === 'blocked') {
      return {
        status: CheckStatuses.skipped,
        code: 'site.reachability.blocked-address',
        summary: `Not probing ${url}: ${result.reason}.`,
        remediation: null,
        details: { url },
      }
    }
    if (result.state === 'up') {
      return {
        status: CheckStatuses.ok,
        code: 'site.reachability.up',
        summary: `${url} answered HTTP ${result.httpStatus} in ${result.durationMs} ms.`,
        remediation: null,
        details: { url, finalUrl: result.finalUrl, httpStatus: result.httpStatus, attempts: result.attempts, durationMs: result.durationMs },
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

import { eq } from 'drizzle-orm'
import { CheckCategories, CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import { adsConnections } from '@ainyc/canonry-db'
import { probeApiHost } from '../../api-host-probe.js'
import type { CheckDefinition, CheckOutput, DoctorContext, ProjectInfo } from '../types.js'
import { gaConnection, gbpConnection, googleMarketingConnection, gscConnection, type Connection } from './integration-sync.js'

export const API_HOST_TABLE = {
  gsc: ['www.googleapis.com', 'searchconsole.googleapis.com', 'oauth2.googleapis.com'],
  ga: ['analyticsdata.googleapis.com', 'analyticsadmin.googleapis.com', 'oauth2.googleapis.com'],
  gbp: ['mybusinessaccountmanagement.googleapis.com', 'mybusinessbusinessinformation.googleapis.com', 'businessprofileperformance.googleapis.com', 'mybusiness.googleapis.com', 'mybusinesslodging.googleapis.com', 'oauth2.googleapis.com'],
  'google-ads': ['googleads.googleapis.com', 'oauth2.googleapis.com'],
  gtm: ['tagmanager.googleapis.com', 'oauth2.googleapis.com'],
  bing: ['ssl.bing.com'],
  ads: ['api.ads.openai.com'],
} as const

type ApiHostPrefix = keyof typeof API_HOST_TABLE

function skipped(code: string, summary: string): CheckOutput {
  return { status: CheckStatuses.skipped, code, summary, remediation: null }
}

function connectionFor(prefix: ApiHostPrefix, ctx: DoctorContext, project: ProjectInfo): Connection {
  if (prefix === 'gsc') return gscConnection(ctx, project)
  if (prefix === 'ga') return gaConnection(ctx, project)
  if (prefix === 'gbp') return gbpConnection(ctx, project)
  if (prefix === 'google-ads') return googleMarketingConnection('googleAds')(ctx)
  if (prefix === 'gtm') return googleMarketingConnection('gtm')(ctx)
  if (prefix === 'bing') return ctx.bingConnectionStore?.getConnection(project.canonicalDomain) ? { state: 'connected', since: null } : { state: 'not-connected' }
  return ctx.db.select({ id: adsConnections.id }).from(adsConnections).where(eq(adsConnections.projectId, project.id)).limit(1).get() ? { state: 'connected', since: null } : { state: 'not-connected' }
}

async function grade(prefix: ApiHostPrefix, ctx: DoctorContext): Promise<CheckOutput> {
  const id = `${prefix}.api`
  if (!ctx.project) return skipped(`${id}.no-project`, 'Project context required.')
  const connection = connectionFor(prefix, ctx, ctx.project)
  if (connection.state !== 'connected') return skipped(`${id}.not-connected`, `${prefix} is not connected for this project.`)
  const probe = ctx.probeApiHost ?? probeApiHost
  const results = await Promise.all(API_HOST_TABLE[prefix].map(host => probe(host)))
  const details = { hosts: results }
  const dnsBlocked = results.find(result => result.kind === 'null-routed' || result.kind === 'no-address')
  if (dnsBlocked) {
    return {
      status: CheckStatuses.fail,
      code: `${id}.dns-blocked`,
      summary: `${dnsBlocked.host} resolved to ${dnsBlocked.addresses.join(', ') || 'no address'}; every ${prefix} sync fails before connecting.`,
      remediation: `Allow ${dnsBlocked.host} in this server's DNS filter or remove its hosts-file entry, then re-run \`canonry doctor --project ${ctx.project.name} --check ${id}\` and the integration sync.`,
      details,
    }
  }
  const privateAddress = results.find(result => result.kind === 'private-address')
  if (privateAddress) return { status: CheckStatuses.warn, code: `${id}.private-address`, summary: `${privateAddress.host} resolved to a private address.`, remediation: 'Check split-horizon DNS and the provider host configuration.', details }
  const tlsFailure = results.find(result => result.kind === 'tls-failed')
  if (tlsFailure) return { status: CheckStatuses.warn, code: `${id}.tls-failed`, summary: `TLS handshake failed for ${tlsFailure.host}.`, remediation: `Check outbound TLS access to ${tlsFailure.host}.`, details }
  const connectFailure = results.find(result => result.kind === 'connect-failed')
  if (connectFailure) return { status: CheckStatuses.warn, code: `${id}.connect-failed`, summary: `Connection failed for ${connectFailure.host}.`, remediation: `Check outbound network access to ${connectFailure.host}.`, details }
  if (results.every(result => result.kind === 'resolver-unavailable')) return { status: CheckStatuses.skipped, code: `${id}.probe-unavailable`, summary: 'The server resolver was unavailable; provider reachability was not graded.', remediation: null, details }
  return { status: CheckStatuses.ok, code: `${id}.ok`, summary: `Provider hosts for ${prefix} resolved and completed TLS handshakes.`, remediation: null, details }
}

function definition(prefix: ApiHostPrefix): CheckDefinition {
  return { id: `${prefix}.api.reachable`, category: CheckCategories.integrations, scope: CheckScopes.project, title: `${prefix} API host reachability`, run: ctx => grade(prefix, ctx) }
}

export const API_HOST_CHECKS: readonly CheckDefinition[] = (Object.keys(API_HOST_TABLE) as ApiHostPrefix[]).map(definition)

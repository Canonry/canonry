import type { OperationAccess } from '@ainyc/canonry-contracts'
import type { CliCommandSpec } from './cli-dispatch.js'

const LIVE_COMMANDS = new Set([
  'ads.account', 'ads.live-delivery', 'ads.geo-search', 'ads.conversion-pixels',
  'google.properties', 'google.list-sitemaps', 'google.discover-sitemaps',
  'ga.properties', 'ga.acquisition', 'gbp.accounts', 'gbp.locations',
  'bing.sites', 'google-ads.customers', 'gtm.accounts', 'gtm.containers', 'gtm.workspaces',
  'doctor', 'get', 'search', 'measurement-plan.discover', 'measurement-plan.discovery',
  'wordpress.posts', 'wordpress.pages', 'wordpress.media',
])

const WRITE_COMMANDS = new Set([
  'competitor.add', 'competitor.remove', 'competitor.delete', 'competitor.aliases',
  'project.create', 'project.update', 'project.delete', 'query.add', 'query.replace', 'query.remove',
  'query.import', 'query.generate', 'run', 'snapshot', 'apply', 'google.connect', 'google.disconnect',
  'google.set-property', 'google.set-sitemap', 'google.submit-sitemap', 'google.sync',
  'ga.connect', 'ga.disconnect', 'ga.sync', 'gbp.connect', 'gbp.disconnect', 'gbp.sync',
  'bing.connect', 'bing.disconnect', 'bing.sync', 'gtm.sync', 'google-ads.sync',
])

export function resolveCliAccess(spec: CliCommandSpec): OperationAccess {
  if (spec.access) return spec.access
  const id = spec.path.join('.')
  if (WRITE_COMMANDS.has(id)) return 'write'
  if (LIVE_COMMANDS.has(id)) return 'live'
  if (id.startsWith('doctor.') || id.startsWith('search.') || id.startsWith('get.')) return 'live'
  return 'stored'
}

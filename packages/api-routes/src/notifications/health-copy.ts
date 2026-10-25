import type { HealthAlertCopy, HealthWebhookPayload } from '@canonry/canonry-contracts'

/**
 * Plain names for every doctor check, used when a check result carries no
 * wording of its own. An alert is read at a glance by someone who does not
 * know check ids or integration jargon, so these name the problem, not the
 * check. `health-copy.test.ts` keeps this in step with the registry.
 */
export const HEALTH_CHECK_LABELS: Readonly<Record<string, string>> = {
  'db.file.present': 'Database missing',
  'config.file.present': 'Config file missing',
  'canonry.version.current': 'Canonry update available',
  'google.auth.connection': 'Search Console sign-in',
  'google.auth.property-access': 'Search Console access',
  'google.auth.redirect-uri': 'Google sign-in setup',
  'google.auth.scopes': 'Search Console permissions',
  'gbp.auth.connection': 'Business Profile sign-in',
  'gbp.auth.scopes': 'Business Profile permissions',
  'gbp.account.access': 'Business Profile access',
  'gbp.data.recent-sync': 'Business Profile sync stalled',
  'gbp.places.api-key': 'Places API key',
  'gbp.reviews.access': 'Review alerts limited',
  'gbp.reviews.delivery': 'Review alert not delivered',
  'bing.auth.connection': 'Bing sign-in',
  'bing.auth.site-access': 'Bing site access',
  'wordpress.publish.connection': 'WordPress publishing',
  'ga.auth.connection': 'GA4 sign-in',
  'ga.data.recent-data': 'GA4 data stopped',
  'gsc.data.recent-data': 'Search Console data stopped',
  'report.sweeps': 'Monthly report sweeps',
  'report.models': 'Monthly report models',
  'report.daily-data': 'Monthly report data gaps',
  'report.ai-referral-bursts': 'AI referral spikes',
  'ads.auth.connection': 'OpenAI ads sign-in',
  'ads.data.recent-sync': 'OpenAI ads sync stalled',
  'google-ads.auth.connection': 'Google Ads sign-in',
  'google-ads.auth.scopes': 'Google Ads permissions',
  'google-ads.account.context': 'Google Ads account',
  'google-ads.data.recent-snapshot': 'Google Ads data stale',
  'gtm.auth.connection': 'Tag Manager sign-in',
  'gtm.auth.scopes': 'Tag Manager permissions',
  'gtm.container.context': 'Tag Manager container',
  'gtm.data.recent-snapshot': 'Tag Manager data stale',
  'gtm.runtime.firing': 'Tags not firing',
  'google-ads.sync.recent-failures': 'Google Ads sync failing',
  'gtm.sync.recent-failures': 'Tag Manager sync failing',
  'gbp.sync.recent-failures': 'Business Profile sync failing',
  'ga.sync.recent-failures': 'GA4 sync failing',
  'gsc.sync.recent-failures': 'Search Console sync failing',
  'config.providers': 'AI provider keys',
  'config.agent-providers': 'Agent provider keys',
  'traffic.source.connected': 'Traffic sync failing',
  'traffic.source.recent-data': 'Traffic data stopped',
  'traffic.source.sync-lag': 'Traffic sync behind',
  'traffic.source.queue-backlog': 'Traffic backlog',
  'traffic.source.worker-version': 'Cloudflare worker out of date',
  'traffic.source.credentials': 'Traffic source sign-in',
  'traffic.source.scopes': 'Traffic source permissions',
  'traffic.source.cache-blindspot': 'Traffic hidden by cache',
  'backlinks.source.connected': 'Backlinks source',
  'content.winnability.coverage': 'Content analysis incomplete',
  'agent.skills.installed': 'Agent skills missing',
  'agent.skills.current': 'Agent skills outdated',
  'agent.skills.trigger-surface': 'Agent skill setup',
  'gsc.api.reachable': "Can't reach Search Console",
  'ga.api.reachable': "Can't reach GA4",
  'gbp.api.reachable': "Can't reach Business Profile",
  'google-ads.api.reachable': "Can't reach Google Ads",
  'gtm.api.reachable': "Can't reach Tag Manager",
  'bing.api.reachable': "Can't reach Bing",
  'ads.api.reachable': "Can't reach OpenAI ads",
  'site.reachability': 'Website down',
}

/**
 * What a recovery says for a problem that cleared, by result code. A cleared
 * problem is known only by its code, so a code without a line here is counted
 * rather than named.
 */
export const HEALTH_FIXED_LINES: Readonly<Record<string, string>> = {
  'google.auth.refresh-unreachable': 'Google is reachable again.',
  'ga.auth.refresh-unreachable': 'Google is reachable again.',
  'gbp.auth.refresh-unreachable': 'Google is reachable again.',
  'traffic.sync-lag.unrecovered-skip': 'The traffic gap is closed.',
  'traffic.source.all-errored-recently': 'Traffic syncs are working again.',
  'traffic.queue-backlog.remaining': 'The traffic backlog is cleared.',
  'traffic.worker-version.stale': 'The Cloudflare worker is up to date.',
  'gbp.auth.no-connection': 'Business Profile is connected.',
}

/** The first sentence of a check's prose, so a fallback line stays one line. */
export function firstSentence(text: string | null | undefined, max = 180): string | null {
  if (!text) return null
  const end = text.search(/[.!?](?:\s|$)/u)
  const sentence = (end === -1 ? text : text.slice(0, end + 1)).trim()
  if (!sentence) return null
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`
}

type FailingCheck = HealthWebhookPayload['health']['failing'][number]

/** The code a pass reports when no check produced a result (see the notifier). */
const HEALTH_NO_SIGNAL_CODE = 'health.no-signal'

/**
 * The words an alert shows for one failing check: its own wording when it has
 * some, otherwise its plain label and the first sentence of its summary and
 * remediation. Never a check id or code, which only belong behind the link.
 */
export function plainHealthCopy(check: FailingCheck, remediation: string | null): HealthAlertCopy {
  if (check.alert) return check.alert
  // No check could grade the project, so there is no check to name.
  if (check.code === HEALTH_NO_SIGNAL_CODE) {
    return { label: 'Health unknown', line: 'No health check produced a result, so health is unknown, not confirmed.', next: null }
  }
  return {
    label: HEALTH_CHECK_LABELS[check.id] ?? 'Health check failing',
    line: firstSentence(check.summary) ?? check.summary,
    next: firstSentence(remediation),
  }
}

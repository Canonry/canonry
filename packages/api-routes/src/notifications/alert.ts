import { HEALTH_NO_LONGER_URGENT, googleBusinessReviewUrl } from '@canonry/canonry-contracts'
import { z } from 'zod'
import { HEALTH_FIXED_LINES, firstSentence, plainHealthCopy } from './health-copy.js'
import type {
  HealthWebhookPayload,
  InsightWebhookPayload,
  NotificationEvent,
  RatingWebhookPayload,
  ReviewWebhookPayload,
  WebhookPayload,
} from '@canonry/canonry-contracts'

/**
 * The destination-neutral view of a notification.
 *
 * Every chat destination wants the same six things — a headline, a severity, a
 * body, some labelled facts, a link, and a timestamp — and differs only in the
 * envelope it will accept. Building this once and rendering per destination
 * keeps the *content* decision (what an operator needs to see) in one place and
 * leaves each renderer responsible only for shape.
 *
 * Without this, every new destination re-derives what to say from the raw
 * payload, and the answer drifts between them.
 */

export const alertSeveritySchema = z.enum(['critical', 'warning', 'success', 'info'])
export type AlertSeverity = z.infer<typeof alertSeveritySchema>
export const AlertSeverities = alertSeveritySchema.enum

/** Labels are declared once so no renderer invents its own wording. */
export const AlertFieldLabels = {
  remediation: 'What to do',
  next: 'Next',
  alsoOpen: 'Also open',
  fixed: 'Fixed',
  event: 'Event',
  run: 'Run',
  changes: 'Changes',
  insights: 'Insights',
  location: 'Location',
  rating: 'Rating',
  reviewer: 'Reviewer',
  replied: 'Replied',
  source: 'Source',
} as const
export type AlertFieldLabel = (typeof AlertFieldLabels)[keyof typeof AlertFieldLabels]

export interface AlertField {
  label: string
  value: string
  /** Renderers that support side-by-side facts may place this inline. */
  compact?: boolean
}

/**
 * Every engine alert names where it came from. The same channel also carries
 * server and Brain alerts, and the category is what tells them apart at a
 * glance.
 */
export const CANONRY_ALERT_CATEGORY = '📈 Canonry'

export interface AlertView {
  severity: AlertSeverity
  /** Which part of the system is speaking, shown above the title. */
  category?: string
  title: string
  /** Longer prose body. Renderers clamp to their own limits. */
  body?: string
  fields: AlertField[]
  /** Where to go to act on this. */
  url: string
  /** Small trailing context, typically the project's domain. */
  footer?: string
  timestamp?: string
}

/** Every payload shape a notification can carry. */
export type AnyNotificationPayload =
  | WebhookPayload
  | InsightWebhookPayload
  | HealthWebhookPayload
  | ReviewWebhookPayload
  | RatingWebhookPayload

const HEALTH_EVENTS: ReadonlySet<NotificationEvent> = new Set([
  'health.degraded', 'health.recovered', 'health.urgent', 'health.urgent-resolved',
])

function isHealth(payload: AnyNotificationPayload): payload is HealthWebhookPayload {
  return HEALTH_EVENTS.has(payload.event as NotificationEvent)
}

/** Cap a list so one noisy notification cannot blow every destination's limit. */
const MAX_LIST_ITEMS = 10

function bulletList(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_LIST_ITEMS)
  const omitted = lines.length - shown.length
  const body = shown.map(line => `• ${line}`).join('\n')
  return omitted > 0 ? `${body}\n• …and ${omitted} more` : body
}

/** How many other problems an alert names before it just counts the rest. */
const MAX_ALSO_OPEN = 3

/**
 * What cleared, in plain words. A cleared problem is known only by its code, so
 * the ones with a plain line are named and the rest are counted, never shown
 * as codes.
 */
function fixedLines(cleared: readonly string[]): string[] {
  const named = [...new Set(cleared.map(code => HEALTH_FIXED_LINES[code]).filter((line): line is string => line !== undefined))]
  const unnamed = cleared.filter(code => HEALTH_FIXED_LINES[code] === undefined).length
  if (unnamed === 0) return named
  return [...named, `${unnamed} ${named.length > 0 ? 'other ' : ''}problem${unnamed === 1 ? '' : 's'} fixed.`]
}

/** Labels for a list, each once with a count when repeated, capped with the rest counted. */
function labelList(labels: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  const entries = [...counts].map(([label, count]) => (count > 1 ? `${label} (${count})` : label))
  const shown = entries.slice(0, MAX_ALSO_OPEN)
  const more = entries.length - shown.length
  return [...shown.map(entry => `• ${entry}`), ...(more > 0 ? [`• and ${more} more`] : [])].join('\n')
}

function healthView(payload: HealthWebhookPayload): AlertView {
  const { health, project } = payload
  const urgentEvent = payload.event === 'health.urgent' || payload.event === 'health.urgent-resolved'
  const recovered = payload.event === 'health.recovered' || payload.event === 'health.urgent-resolved'
  // A website outage and a degraded measurement are different news, and the
  // liveness loop sends both through this payload, so it keeps its own words.
  const website = health.code.startsWith('site.reachability.')
  const base = {
    category: CANONRY_ALERT_CATEGORY,
    url: payload.dashboardUrl,
    footer: project.canonicalDomain,
    timestamp: health.checkedAt,
  }

  if (recovered) {
    const fixed = fixedLines(health.cleared ?? [])
    if (website) {
      return { ...base, severity: AlertSeverities.success, title: `${project.name}: Website is back up`, body: 'The website answers again.', fields: [] }
    }
    if (urgentEvent) {
      // Only the urgent problems resolved; others may still be open, so this
      // is never titled as the whole project being back to normal. "Fixed" is
      // said only for one problem that cleared: a check that eased back to a
      // warning is still open, and a count of several may include one. The
      // body already names what resolved, so no "Fixed" list repeats it.
      const eased = health.summary.startsWith(HEALTH_NO_LONGER_URGENT)
      const several = (health.cleared?.length ?? 0) > 1
      return {
        ...base,
        severity: AlertSeverities.success,
        title: `${project.name}: ${eased || several ? 'No longer urgent' : 'Urgent problem fixed'}`,
        body: firstSentence(eased ? health.summary.slice(HEALTH_NO_LONGER_URGENT.length) : health.summary) ?? 'The urgent problem is resolved.',
        fields: [],
      }
    }
    return {
      ...base,
      severity: AlertSeverities.success,
      title: `${project.name}: Back to normal`,
      body: fixed.length > 0 ? fixed.join(' ') : 'Every check passes again.',
      fields: [],
    }
  }

  // Lead with the news: the first problem that is new or worse. Everything
  // else stays listed, the other new problems first and marked as new.
  const failing = health.failing
  const added = health.added ?? []
  const newest = added.map(code => failing.find(check => check.code === code)).find(check => check !== undefined)
  const lead = newest ?? failing.find(check => check.code === health.code) ?? failing.at(0)
  // Each failing check carries its own remediation; the payload's own summary
  // and remediation are the worst check's, for payloads from before that.
  const copy = lead
    ? (lead.code === health.code
        ? plainHealthCopy({ ...lead, summary: health.summary }, lead.remediation ?? health.remediation)
        : plainHealthCopy(lead, lead.remediation ?? null))
    : plainHealthCopy({ id: '', status: health.status, code: health.code, summary: health.summary }, health.remediation)
  const leadStatus = lead?.status ?? health.status
  // An urgent alert is critical whatever its check's status: stale daily data
  // is graded `warn`, and it is still the alert someone has to act on.
  const severity: AlertSeverity = urgentEvent || leadStatus === 'fail'
    ? AlertSeverities.critical
    : AlertSeverities.warning

  const fields: AlertField[] = []
  if (copy.next) fields.push({ label: AlertFieldLabels.next, value: copy.next })
  const others = failing.filter(check => check !== lead)
  const otherNew = others.filter(check => added.includes(check.code))
  const standing = others.filter(check => !added.includes(check.code))
  if (others.length > 0) {
    fields.push({
      label: AlertFieldLabels.alsoOpen,
      value: labelList([
        ...otherNew.map(check => `${plainHealthCopy(check, null).label} (new)`),
        ...standing.map(check => plainHealthCopy(check, null).label),
      ]),
    })
  }
  const fixed = fixedLines(health.cleared ?? [])
  if (fixed.length > 0) fields.push({ label: AlertFieldLabels.fixed, value: fixed.map(line => `• ${line}`).join('\n') })

  const label = website ? 'Website down' : copy.label
  return {
    ...base,
    severity,
    title: `${project.name}: ${label}${urgentEvent ? ' (urgent)' : ''}`,
    body: copy.line,
    fields,
  }
}

function runView(payload: WebhookPayload | InsightWebhookPayload): AlertView {
  const failed = payload.event === 'run.failed'
  const transitions = 'transitions' in payload ? payload.transitions : []
  const insights = 'insights' in payload ? payload.insights : []

  const fields: AlertField[] = [
    { label: AlertFieldLabels.event, value: payload.event, compact: true },
    { label: AlertFieldLabels.run, value: payload.run.status, compact: true },
  ]
  if (transitions.length > 0) {
    fields.push({
      label: `${AlertFieldLabels.changes} (${transitions.length})`,
      value: bulletList(transitions.map(t => `${t.provider}: ${t.from} → ${t.to} — ${t.query}`)),
    })
  }
  if (insights.length > 0) {
    fields.push({
      label: `${AlertFieldLabels.insights} (${insights.length})`,
      value: bulletList(insights.map(i => `[${i.severity}] ${i.title}`)),
    })
  }

  return {
    severity: failed ? AlertSeverities.critical : AlertSeverities.info,
    category: CANONRY_ALERT_CATEGORY,
    title: payload.project.name,
    fields,
    url: payload.dashboardUrl,
    footer: payload.project.canonicalDomain,
    ...(payload.run.finishedAt ? { timestamp: payload.run.finishedAt } : {}),
  }
}

function stars(rating: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(rating)))
  return `${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}`
}

/** Short enough for a list line; renderers clamp the whole field again. */
function snippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// Places shows at most five reviews, so an alert from it says so.
const SOURCE_LABELS = {
  gbp: 'Business Profile',
  places: 'Public listing (Places, partial)',
} as const

function reviewView(payload: ReviewWebhookPayload): AlertView {
  const { project, reviews } = payload
  const newest = reviews.reduce<string | undefined>((latest, r) => (!latest || r.updateTime > latest ? r.updateTime : latest), undefined)
  const origins = [...new Set(reviews.map(r => r.origin))]
  const sourceField: AlertField = {
    label: AlertFieldLabels.source,
    value: origins.map(origin => SOURCE_LABELS[origin]).join(', '),
    compact: true,
  }

  if (reviews.length === 1) {
    const review = reviews[0]!
    const fields: AlertField[] = [
      { label: AlertFieldLabels.location, value: review.location.displayName, compact: true },
      { label: AlertFieldLabels.rating, value: `${stars(review.starRating)} (${review.starRating}/5)`, compact: true },
    ]
    if (review.reviewerName) fields.push({ label: AlertFieldLabels.reviewer, value: review.reviewerName, compact: true })
    if (review.replied !== null) fields.push({ label: AlertFieldLabels.replied, value: review.replied ? 'yes' : 'no', compact: true })
    fields.push(sourceField)
    return {
      severity: AlertSeverities.warning,
      category: CANONRY_ALERT_CATEGORY,
      title: `${project.name}: new ${review.starRating}-star review`,
      body: review.comment
        ? (review.comment.length > 500 ? `${review.comment.slice(0, 499)}…` : review.comment)
        : 'Rating only, no text.',
      fields,
      url: googleBusinessReviewUrl(review.reviewUri) ?? googleBusinessReviewUrl(review.location.mapsUri) ?? payload.dashboardUrl,
      footer: project.canonicalDomain,
      timestamp: review.updateTime,
    }
  }

  return {
    severity: AlertSeverities.warning,
    category: CANONRY_ALERT_CATEGORY,
    title: `${project.name}: ${reviews.length} new negative reviews`,
    body: bulletList(reviews.map(r => {
      const text = r.comment ? ` "${snippet(r.comment)}"` : ''
      const by = r.reviewerName ? ` (${r.reviewerName})` : ''
      return `${stars(r.starRating)} ${r.location.displayName}:${text}${by}`
    })),
    fields: [sourceField],
    url: payload.dashboardUrl,
    footer: project.canonicalDomain,
    ...(newest ? { timestamp: newest } : {}),
  }
}

function ratingView(payload: RatingWebhookPayload): AlertView {
  const { project, ratings } = payload
  const line = (r: RatingWebhookPayload['ratings'][number]): string => {
    const counts = r.previousReviewCount !== null && r.reviewCount !== null
      ? ` (${r.previousReviewCount} → ${r.reviewCount} reviews)`
      : ''
    return `${r.location.displayName}: ${r.previousRating} → ${r.rating}${counts}`
  }
  const single = ratings.length === 1 ? ratings[0]! : null
  return {
    severity: AlertSeverities.warning,
    category: CANONRY_ALERT_CATEGORY,
    title: single
      ? `${project.name}: Google rating fell to ${single.rating}`
      : `${project.name}: Google rating fell at ${ratings.length} locations`,
    body: single ? line(single) : bulletList(ratings.map(line)),
    fields: [
      { label: AlertFieldLabels.source, value: SOURCE_LABELS.places, compact: true },
      {
        label: AlertFieldLabels.remediation,
        value: 'Read the newest reviews on Google Maps. Without Business Profile review access, Canonry sees at most five of them.',
      },
    ],
    url: single?.location.mapsUri ?? payload.dashboardUrl,
    footer: project.canonicalDomain,
    timestamp: ratings.reduce((latest, r) => (r.observedAt > latest ? r.observedAt : latest), ratings[0]?.observedAt ?? ''),
  }
}

/** Project any notification payload onto the neutral view. */
export function toAlertView(payload: AnyNotificationPayload): AlertView {
  if (isHealth(payload)) return healthView(payload)
  if (payload.event === 'review.negative') return reviewView(payload as ReviewWebhookPayload)
  if (payload.event === 'review.rating-dropped') return ratingView(payload as RatingWebhookPayload)
  return runView(payload as WebhookPayload | InsightWebhookPayload)
}

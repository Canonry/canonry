import { z } from 'zod'
import type {
  HealthWebhookPayload,
  InsightWebhookPayload,
  NotificationEvent,
  WebhookPayload,
} from '@ainyc/canonry-contracts'

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
  status: 'Status',
  check: 'Check',
  previously: 'Was',
  remediation: 'What to do',
  alsoFailing: 'Also failing',
  event: 'Event',
  run: 'Run',
  changes: 'Changes',
  insights: 'Insights',
} as const
export type AlertFieldLabel = (typeof AlertFieldLabels)[keyof typeof AlertFieldLabels]

export interface AlertField {
  label: string
  value: string
  /** Renderers that support side-by-side facts may place this inline. */
  compact?: boolean
}

export interface AlertView {
  severity: AlertSeverity
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

const HEALTH_EVENTS: ReadonlySet<NotificationEvent> = new Set(['health.degraded', 'health.recovered'])

function isHealth(
  payload: WebhookPayload | InsightWebhookPayload | HealthWebhookPayload,
): payload is HealthWebhookPayload {
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

function healthView(payload: HealthWebhookPayload): AlertView {
  const { health, project } = payload
  const recovered = payload.event === 'health.recovered'
  const severity: AlertSeverity = recovered
    ? AlertSeverities.success
    : health.status === 'fail'
      ? AlertSeverities.critical
      : AlertSeverities.warning

  const fields: AlertField[] = [
    { label: AlertFieldLabels.status, value: recovered ? 'recovered' : health.status, compact: true },
    { label: AlertFieldLabels.check, value: health.code, compact: true },
  ]
  if (health.previousStatus) {
    fields.push({ label: AlertFieldLabels.previously, value: health.previousStatus, compact: true })
  }
  if (health.remediation) {
    fields.push({ label: AlertFieldLabels.remediation, value: health.remediation })
  }
  // The headline names one check. Without the rest, the ranking decision
  // silently becomes a filtering decision.
  const others = health.failing.filter(check => check.code !== health.code)
  if (others.length > 0) {
    fields.push({
      label: `${AlertFieldLabels.alsoFailing} (${others.length})`,
      value: bulletList(others.map(check => `${check.status} — ${check.code}`)),
    })
  }

  // A website outage and a degraded measurement are different news, and the
  // liveness loop sends both through this payload. Titling a site-down alert
  // "measurement degraded", or its recovery as the whole project recovering,
  // is the one thing the separate liveness state exists to prevent.
  const website = health.code.startsWith('site.reachability.')
  return {
    severity,
    title: website
      ? (recovered ? `${project.name} website is back up` : `${project.name} website is down`)
      : recovered
        ? `${project.name} recovered`
        : `${project.name} — measurement degraded`,
    body: health.summary,
    fields,
    url: payload.dashboardUrl,
    footer: project.canonicalDomain,
    timestamp: health.checkedAt,
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
    title: payload.project.name,
    fields,
    url: payload.dashboardUrl,
    footer: payload.project.canonicalDomain,
    ...(payload.run.finishedAt ? { timestamp: payload.run.finishedAt } : {}),
  }
}

/** Project any notification payload onto the neutral view. */
export function toAlertView(
  payload: WebhookPayload | InsightWebhookPayload | HealthWebhookPayload,
): AlertView {
  return isHealth(payload) ? healthView(payload) : runView(payload)
}

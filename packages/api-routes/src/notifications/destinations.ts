import { z } from 'zod'
import type { AlertSeverity, AlertView } from './alert.js'
import { AlertSeverities } from './alert.js'

/**
 * Where a notification is being delivered, and how that destination wants its
 * body shaped.
 *
 * A chat webhook IS a webhook — it needs no separate channel type on the stored
 * notification, because the URL already identifies it. What differs is only the
 * envelope the receiver will accept: Discord and Slack both reject arbitrary
 * JSON, our own receiver expects the payload verbatim.
 *
 * Adding a destination is one entry in DESTINATION_ADAPTERS plus its renderer.
 * Nothing else in the delivery path changes: the SSRF guard, the retry ladder
 * and the delivery log are shared.
 */

export const webhookDestinationSchema = z.enum(['first-party', 'discord', 'slack'])
export type WebhookDestination = z.infer<typeof webhookDestinationSchema>
export const WebhookDestinations = webhookDestinationSchema.enum

export interface DestinationAdapter {
  readonly destination: WebhookDestination
  /** True when this adapter owns the given URL. */
  matches: (url: URL) => boolean
  /**
   * Reshape the neutral view into the receiver's envelope. Omitted for the
   * first-party destination, which takes the payload unchanged.
   */
  render?: (view: AlertView) => unknown
  /**
   * Whether to HMAC-sign the body. Third-party chat receivers never verify our
   * signature, and signing a body the receiver ignores only advertises that a
   * secret exists.
   */
  readonly signed: boolean
}

/** Host match, never substring: `discord.com.evil.test` must not match. */
function hostIs(url: URL, ...domains: readonly string[]): boolean {
  const host = url.hostname.toLowerCase()
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
}

// --- Discord -----------------------------------------------------------------

/** Discord rejects an embed whose description exceeds 4096 characters. */
const DISCORD_MAX_DESCRIPTION = 3800
const DISCORD_MAX_FIELD = 1000

const DISCORD_COLORS: Readonly<Record<AlertSeverity, number>> = {
  [AlertSeverities.critical]: 0xd9_36_3b,
  [AlertSeverities.warning]: 0xd9_8b_1e,
  [AlertSeverities.success]: 0x2e_9e_4f,
  [AlertSeverities.info]: 0x4a_5b_6c,
}

const SEVERITY_ICONS: Readonly<Record<AlertSeverity, string>> = {
  [AlertSeverities.critical]: '🔴',
  [AlertSeverities.warning]: '🟠',
  [AlertSeverities.success]: '✅',
  [AlertSeverities.info]: '📊',
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Chat receivers require an ABSOLUTE http(s) link and reject the whole message
 * when given anything else — Discord answers a relative `embed.url` with a 400
 * and `{"embeds": ["0"]}`, discarding the entire alert over the one field.
 *
 * A link the reader cannot click is worth less than no link, and it must never
 * cost them the message it was attached to. Callers that build a relative
 * dashboard path still get their alert delivered, minus the link.
 */
function absoluteLink(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

export interface DiscordWebhookBody {
  username: string
  embeds: Array<{
    author?: { name: string }
    title: string
    description?: string
    color: number
    fields?: Array<{ name: string, value: string, inline?: boolean }>
    url?: string
    timestamp?: string
    footer?: { text: string }
  }>
}

export function renderDiscord(view: AlertView): DiscordWebhookBody {
  return {
    username: 'Canonry',
    embeds: [{
      // The category line names who is speaking; the embed's colour carries
      // the severity, so the title stays the problem alone.
      ...(view.category ? { author: { name: view.category } } : {}),
      title: view.category ? view.title : `${SEVERITY_ICONS[view.severity]} ${view.title}`,
      ...(view.body ? { description: clamp(view.body, DISCORD_MAX_DESCRIPTION) } : {}),
      color: DISCORD_COLORS[view.severity],
      fields: view.fields.map(field => ({
        name: field.label,
        value: clamp(field.value, DISCORD_MAX_FIELD),
        ...(field.compact ? { inline: true } : {}),
      })),
      ...(absoluteLink(view.url) ? { url: absoluteLink(view.url) } : {}),
      ...(view.timestamp ? { timestamp: view.timestamp } : {}),
      ...(view.footer ? { footer: { text: view.footer } } : {}),
    }],
  }
}

// --- Slack -------------------------------------------------------------------

/** Slack truncates attachment text past roughly 3000 characters. */
const SLACK_MAX_TEXT = 2900
const SLACK_MAX_FIELD = 1000

const SLACK_COLORS: Readonly<Record<AlertSeverity, string>> = {
  [AlertSeverities.critical]: '#d9363b',
  [AlertSeverities.warning]: '#d98b1e',
  [AlertSeverities.success]: '#2e9e4f',
  [AlertSeverities.info]: '#4a5b6c',
}

export interface SlackWebhookBody {
  text: string
  attachments: Array<{
    color: string
    author_name?: string
    title: string
    title_link?: string
    text?: string
    fields?: Array<{ title: string, value: string, short?: boolean }>
    footer?: string
    ts?: number
  }>
}

export function renderSlack(view: AlertView): SlackWebhookBody {
  const headline = `${SEVERITY_ICONS[view.severity]} ${view.title}`
  return {
    // `text` is the notification preview and the accessible fallback, so it
    // must stand alone rather than repeat an empty string.
    text: headline,
    attachments: [{
      color: SLACK_COLORS[view.severity],
      ...(view.category ? { author_name: view.category } : {}),
      title: headline,
      ...(absoluteLink(view.url) ? { title_link: absoluteLink(view.url) } : {}),
      ...(view.body ? { text: clamp(view.body, SLACK_MAX_TEXT) } : {}),
      fields: view.fields.map(field => ({
        title: field.label,
        value: clamp(field.value, SLACK_MAX_FIELD),
        ...(field.compact ? { short: true } : {}),
      })),
      ...(view.footer ? { footer: view.footer } : {}),
      ...(view.timestamp
        ? { ts: Math.floor(new Date(view.timestamp).getTime() / 1000) }
        : {}),
    }],
  }
}

// --- Registry ----------------------------------------------------------------

const DISCORD_ADAPTER: DestinationAdapter = {
  destination: WebhookDestinations.discord,
  matches: url => hostIs(url, 'discord.com', 'discordapp.com')
    && url.pathname.startsWith('/api/webhooks/'),
  render: renderDiscord,
  signed: false,
}

const SLACK_ADAPTER: DestinationAdapter = {
  destination: WebhookDestinations.slack,
  matches: url => hostIs(url, 'slack.com') && url.pathname.startsWith('/services/'),
  render: renderSlack,
  signed: false,
}

/** Anything we do not recognise is our own receiver: verbatim payload, signed. */
const FIRST_PARTY_ADAPTER: DestinationAdapter = {
  destination: WebhookDestinations['first-party'],
  matches: () => true,
  signed: true,
}

export const DESTINATION_ADAPTERS: readonly DestinationAdapter[] = [
  DISCORD_ADAPTER,
  SLACK_ADAPTER,
  FIRST_PARTY_ADAPTER,
]

/**
 * Pick the adapter for a URL. Third-party chat endpoints are only ever matched
 * over HTTPS, so a plaintext lookalike falls through to the first-party path
 * (where the SSRF guard and signature still apply) rather than being handed a
 * chat-shaped body.
 */
export function resolveDestination(rawUrl: string): DestinationAdapter {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return FIRST_PARTY_ADAPTER
  }
  if (url.protocol !== 'https:') return FIRST_PARTY_ADAPTER
  return DESTINATION_ADAPTERS.find(adapter => adapter.matches(url)) ?? FIRST_PARTY_ADAPTER
}

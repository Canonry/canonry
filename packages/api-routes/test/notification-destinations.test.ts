import { test, expect } from 'vitest'
import type { HealthWebhookPayload, RatingWebhookPayload, ReviewWebhookPayload, WebhookPayload } from '@canonry/canonry-contracts'
import { AlertSeverities, AlertFieldLabels, CANONRY_ALERT_CATEGORY, toAlertView } from '../src/notifications/alert.js'
import {
  DESTINATION_ADAPTERS,
  WebhookDestinations,
  renderDiscord,
  renderSlack,
  resolveDestination,
} from '../src/notifications/destinations.js'

// A chat webhook is a webhook whose body has to look a particular way. The
// destination is resolved from the URL; the content decision lives once in the
// neutral AlertView, and each renderer only reshapes it.

const health = (over: Partial<HealthWebhookPayload['health']> = {}): HealthWebhookPayload => ({
  source: 'canonry',
  event: 'health.degraded',
  project: { name: 'harborline-hotel', canonicalDomain: 'harborline.test' },
  health: {
    status: 'fail',
    code: 'traffic.sync-lag.discarding',
    summary: 'A traffic source is discarding traffic instead of ingesting it.',
    remediation: 'Run `cnry traffic backfill … --days N --wait`.',
    checkedAt: '2026-07-31T18:00:00.000Z',
    previousStatus: 'warn',
    failing: [
      { id: 'traffic.source.sync-lag', status: 'fail', code: 'traffic.sync-lag.discarding', summary: 'x' },
      { id: 'content.winnability.coverage', status: 'warn', code: 'content.winnability.low-coverage', summary: 'y' },
    ],
    ...over,
  },
  dashboardUrl: 'https://canonry.test/projects/harborline-hotel',
})

test('the destination is resolved from the URL, and lookalikes fall back to first-party', () => {
  expect(resolveDestination('https://discord.com/api/webhooks/1/a').destination)
    .toBe(WebhookDestinations.discord)
  expect(resolveDestination('https://ptb.discord.com/api/webhooks/1/a').destination)
    .toBe(WebhookDestinations.discord)
  expect(resolveDestination('https://hooks.slack.com/services/T/B/x').destination)
    .toBe(WebhookDestinations.slack)

  // A lookalike host must never be handed a chat-shaped body.
  for (const url of [
    'https://discord.com.evil.test/api/webhooks/1/a',
    'https://hooks.slack.com.evil.test/services/T/B/x',
    'https://example.com/relay/discord',
    'http://discord.com/api/webhooks/1/a', // plaintext
    'https://discord.com/api/other/1',      // right host, wrong route
    'not a url',
  ]) {
    expect(resolveDestination(url).destination, url).toBe(WebhookDestinations['first-party'])
  }
})

test('only the first-party destination is signed, and only it sends the payload verbatim', () => {
  const first = resolveDestination('https://hooks.example.com/canonry')
  expect(first.signed).toBe(true)
  expect(first.render).toBeUndefined()

  for (const url of ['https://discord.com/api/webhooks/1/a', 'https://hooks.slack.com/services/T/B/x']) {
    const adapter = resolveDestination(url)
    // A chat receiver never verifies our HMAC; signing a body it ignores only
    // advertises that a secret exists.
    expect(adapter.signed, url).toBe(false)
    expect(adapter.render, url).toBeTypeOf('function')
  }
})

test('every registered destination is reachable and terminates in first-party', () => {
  // A registry whose catch-all is not last would shadow every adapter after it.
  expect(DESTINATION_ADAPTERS.at(-1)!.destination).toBe(WebhookDestinations['first-party'])
  const destinations = DESTINATION_ADAPTERS.map(a => a.destination)
  expect(new Set(destinations).size).toBe(destinations.length)
})

test('the neutral view decides content once, for every destination', () => {
  const view = toAlertView(health())
  expect(view.severity).toBe(AlertSeverities.critical)
  expect(view.category).toBe(CANONRY_ALERT_CATEGORY)
  // No wording from the check: its plain label, and its summary's first sentence.
  expect(view.title).toBe('harborline-hotel: Traffic sync behind')
  expect(view.body).toContain('discarding')

  const labels = view.fields.map(f => f.label)
  expect(labels).toEqual([AlertFieldLabels.next, AlertFieldLabels.alsoOpen])
  // The headline names one check; the rest must still travel, or ranking
  // silently becomes filtering.
  expect(view.fields.at(-1)!.value).toBe('• Content analysis incomplete')
})

test('an alert shows the check\'s own plain words, and never a check id or code', () => {
  const payload = health({
    code: 'google.auth.refresh-unreachable',
    summary: 'Could not reach Google to refresh the GSC token: fetch failed (EAI_AGAIN resolving oauth2.googleapis.com)',
    remediation: 'Check that this host can resolve and connect to Google (DNS filtering, firewall, or proxy), then re-run.',
    failing: [{
      id: 'google.auth.connection', status: 'fail', code: 'google.auth.refresh-unreachable', summary: 'Could not reach Google…',
      alert: { label: "Can't reach Google", line: "The server couldn't reach Google, so Search Console data didn't refresh.", next: "Nothing yet. If it repeats, check the server's internet or DNS." },
    }],
    added: ['google.auth.refresh-unreachable'],
  })
  const view = toAlertView(payload)
  expect(view.title).toBe("harborline-hotel: Can't reach Google")
  expect(view.body).toBe("The server couldn't reach Google, so Search Console data didn't refresh.")
  expect(view.fields).toEqual([{ label: AlertFieldLabels.next, value: "Nothing yet. If it repeats, check the server's internet or DNS." }])
  const rendered = JSON.stringify(renderDiscord(view))
  for (const internal of ['google.auth.refresh-unreachable', 'google.auth.connection', 'EAI_AGAIN']) expect(rendered).not.toContain(internal)
})

test('the category is the first line in both chat renderers', () => {
  const view = toAlertView(health())
  const discord = renderDiscord(view).embeds[0]!
  expect(discord.author).toEqual({ name: CANONRY_ALERT_CATEGORY })
  // The colour carries the severity, so the title is the problem alone.
  expect(discord.title).toBe('harborline-hotel: Traffic sync behind')
  expect(renderSlack(view).attachments[0]!.author_name).toBe(CANONRY_ALERT_CATEGORY)
})

test('a recovery is a recovery in both renderers, not another alarm', () => {
  const view = toAlertView({ ...health(), event: 'health.recovered' })
  expect(view.severity).toBe(AlertSeverities.success)
  expect(renderDiscord(view).embeds[0]!.color).toBe(0x2e_9e_4f)
  expect(renderSlack(view).attachments[0]!.color).toBe('#2e9e4f')
})

test('the same view renders into each receiver own envelope', () => {
  const view = toAlertView(health())

  const discord = renderDiscord(view)
  expect(discord.embeds).toHaveLength(1)
  expect(discord.embeds[0]!.color).toBeTypeOf('number')
  expect(discord.embeds[0]!.url).toBe('https://canonry.test/projects/harborline-hotel')
  expect(discord.embeds[0]!.fields![0]).toHaveProperty('name')

  const slack = renderSlack(view)
  expect(slack.attachments).toHaveLength(1)
  expect(slack.attachments[0]!.color).toBeTypeOf('string')
  expect(slack.attachments[0]!.title_link).toBe('https://canonry.test/projects/harborline-hotel')
  expect(slack.attachments[0]!.fields![0]).toHaveProperty('title')
  // `text` is Slack's notification preview and accessible fallback.
  expect(slack.text.length).toBeGreaterThan(0)
  // Slack takes epoch seconds, not an ISO string.
  expect(slack.attachments[0]!.ts).toBe(Math.floor(Date.parse('2026-07-31T18:00:00.000Z') / 1000))
})

test('each renderer clamps to its own limit, because both 400 past it', () => {
  const view = toAlertView(health({ summary: 'x'.repeat(9000) }))
  expect(renderDiscord(view).embeds[0]!.description!.length).toBeLessThanOrEqual(3800)
  expect(renderSlack(view).attachments[0]!.text!.length).toBeLessThanOrEqual(2900)
})

test('a long list is truncated with the remainder counted, not silently dropped', () => {
  const ids = ['ga.data.recent-data', 'gsc.data.recent-data', 'bing.auth.connection', 'gbp.data.recent-sync', 'ga.sync.recent-failures', 'gsc.sync.recent-failures']
  const many = ids.map((id, i) => ({ id, status: 'warn', code: `code.${i}`, summary: 's' }))
  const view = toAlertView(health({ failing: [{ id: 'traffic.source.sync-lag', status: 'fail', code: 'traffic.sync-lag.discarding', summary: 's' }, ...many] }))
  const also = view.fields.find(f => f.label === AlertFieldLabels.alsoOpen)!
  expect(also.value.split('\n')).toEqual(['• GA4 data stopped', '• Search Console data stopped', '• Bing sign-in', '• and 3 more'])
})

test('repeated problems are named once with a count', () => {
  const twice = { label: "Can't reach Google", line: 'x', next: null }
  const view = toAlertView(health({
    failing: [
      { id: 'traffic.source.sync-lag', status: 'fail', code: 'traffic.sync-lag.discarding', summary: 's' },
      { id: 'ga.auth.connection', status: 'fail', code: 'ga.auth.refresh-unreachable', summary: 's', alert: twice },
      { id: 'gbp.auth.connection', status: 'fail', code: 'gbp.auth.refresh-unreachable', summary: 's', alert: twice },
    ],
  }))
  expect(view.fields.find(f => f.label === AlertFieldLabels.alsoOpen)!.value).toBe("• Can't reach Google (2)")
})

test('run events render too, so this is not health-only', () => {
  const payload: WebhookPayload = {
    source: 'canonry',
    event: 'run.failed',
    project: { name: 'acme-coatings', canonicalDomain: 'acmecoatings.test' },
    run: { id: 'run_1', status: 'failed', finishedAt: '2026-07-31T18:00:00.000Z' },
    transitions: [{ query: 'roof coating', from: 'cited', to: 'not-cited', provider: 'openai' }],
    dashboardUrl: 'https://canonry.test/projects/acme-coatings',
  }
  const view = toAlertView(payload)
  expect(view.severity).toBe(AlertSeverities.critical)
  expect(view.fields.some(f => f.label.startsWith(AlertFieldLabels.changes))).toBe(true)
  expect(renderDiscord(view).embeds[0]!.title).toContain('acme-coatings')
  expect(renderSlack(view).attachments[0]!.title).toContain('acme-coatings')
})

// The test route used to POST the payload verbatim regardless of destination,
// so `cnry notify test` against a Discord webhook always returned 400 — a
// healthy destination reported as broken. These pin that the test route and the
// real notifier now make the same decision from the same registry.

test('the test route renders for the destination, exactly as a real send does', () => {
  const testPayload: WebhookPayload = {
    source: 'canonry',
    event: 'run.completed',
    project: { name: 'demo', canonicalDomain: 'demo.example' },
    run: { id: 'test-run-id', status: 'completed', finishedAt: '2026-07-31T18:00:00.000Z' },
    transitions: [{ query: 'test query', from: 'not-cited', to: 'cited', provider: 'gemini' }],
    dashboardUrl: '/projects/demo',
  }

  const discord = resolveDestination('https://discord.com/api/webhooks/1/a')
  const body = discord.render!(toAlertView(testPayload)) as { embeds?: unknown[] }
  // Discord rejects a body without content/embeds/file with a 400.
  expect(body.embeds).toBeDefined()
  expect(body).not.toHaveProperty('source')

  const slack = resolveDestination('https://hooks.slack.com/services/T/B/x')
  const slackBody = slack.render!(toAlertView(testPayload)) as { text?: string }
  expect(slackBody.text).toBeTruthy()

  // First-party still receives the payload verbatim, signed.
  const own = resolveDestination('https://hooks.example.com/canonry')
  expect(own.render).toBeUndefined()
  expect(own.signed).toBe(true)
})

test('an unusable link is dropped, never allowed to fail the whole message', () => {
  // Discord answers a relative `embed.url` with 400 `{"embeds": ["0"]}` and
  // discards the entire alert over that one field. Losing the link is a far
  // smaller loss than losing the alert.
  const relative = toAlertView({ ...healthPayloadFor('/projects/demo') })
  const discord = renderDiscord(relative)
  expect(discord.embeds[0]).not.toHaveProperty('url')
  expect(discord.embeds[0]!.title).toBeTruthy()  // the message still stands

  const slack = renderSlack(relative)
  expect(slack.attachments[0]).not.toHaveProperty('title_link')
  expect(slack.text).toBeTruthy()

  // An absolute link is kept.
  const absolute = toAlertView({ ...healthPayloadFor('https://canonry.test/projects/demo') })
  expect(renderDiscord(absolute).embeds[0]!.url).toBe('https://canonry.test/projects/demo')
  expect(renderSlack(absolute).attachments[0]!.title_link).toBe('https://canonry.test/projects/demo')
})

function healthPayloadFor(dashboardUrl: string): HealthWebhookPayload {
  return { ...health(), dashboardUrl }
}

const location = { name: 'locations/1', displayName: 'Harborline Bayport', mapsUri: 'https://maps.google.com/?cid=1' }

const oneReview = (over: Partial<ReviewWebhookPayload['reviews'][number]> = {}): ReviewWebhookPayload => ({
  source: 'canonry',
  event: 'review.negative',
  project: { name: 'harborline-hotel', canonicalDomain: 'harborline.test' },
  reviews: [{
    location,
    origin: 'gbp',
    reviewName: 'accounts/1/locations/1/reviews/r1',
    starRating: 2,
    comment: 'The room was not ready at check-in.',
    reviewerName: 'Sam Rivera',
    createTime: '2026-09-24T18:03:11.482Z',
    updateTime: '2026-09-24T18:03:11.482Z',
    replied: false,
    reviewUri: null,
    ...over,
  }],
  dashboardUrl: 'https://canonry.test/projects/harborline-hotel',
})

test('a single negative review leads with the rating and quotes the review', () => {
  const view = toAlertView(oneReview())
  expect(view.severity).toBe(AlertSeverities.warning)
  expect(view.title).toBe('harborline-hotel: new 2-star review')
  expect(view.body).toBe('The room was not ready at check-in.')
  expect(view.fields).toEqual([
    { label: AlertFieldLabels.location, value: 'Harborline Bayport', compact: true },
    { label: AlertFieldLabels.rating, value: '★★☆☆☆ (2/5)', compact: true },
    { label: AlertFieldLabels.reviewer, value: 'Sam Rivera', compact: true },
    { label: AlertFieldLabels.replied, value: 'no', compact: true },
    { label: AlertFieldLabels.source, value: 'Business Profile', compact: true },
  ])
  // With no per-review link, the location's Maps page is where to reply.
  expect(view.url).toBe('https://maps.google.com/?cid=1')
  expect(view.timestamp).toBe('2026-09-24T18:03:11.482Z')

  const discord = renderDiscord(view)
  expect(discord.embeds[0]!.title).toContain('harborline-hotel: new 2-star review')
  expect(discord.embeds[0]!.description).toBe('The room was not ready at check-in.')
})

test('a Places review says its source is partial, links the review, and shows no reply state', () => {
  const view = toAlertView(oneReview({
    origin: 'places',
    replied: null,
    comment: null,
    reviewUri: 'https://www.google.com/maps/reviews/abc',
  }))
  expect(view.body).toBe('Rating only, no text.')
  expect(view.url).toBe('https://www.google.com/maps/reviews/abc')
  expect(view.fields.map(f => f.label)).not.toContain(AlertFieldLabels.replied)
  expect(view.fields.at(-1)).toEqual({ label: AlertFieldLabels.source, value: 'Public listing (Places, partial)', compact: true })
})

test('several negative reviews render as one list', () => {
  const payload = oneReview()
  payload.reviews.push({ ...payload.reviews[0]!, reviewName: 'r2', starRating: 1, comment: 'Noisy   all\nnight.', reviewerName: null, updateTime: '2026-09-25T08:00:00.000Z' })
  const view = toAlertView(payload)
  expect(view.title).toBe('harborline-hotel: 2 new negative reviews')
  expect(view.body).toBe([
    '• ★★☆☆☆ Harborline Bayport: "The room was not ready at check-in." (Sam Rivera)',
    '• ★☆☆☆☆ Harborline Bayport: "Noisy all night."',
  ].join('\n'))
  expect(view.url).toBe('https://canonry.test/projects/harborline-hotel')
  expect(view.timestamp).toBe('2026-09-25T08:00:00.000Z')
})

test('a rating drop names both values and what to do about it', () => {
  const payload: RatingWebhookPayload = {
    source: 'canonry',
    event: 'review.rating-dropped',
    project: { name: 'harborline-hotel', canonicalDomain: 'harborline.test' },
    ratings: [{
      location,
      origin: 'places',
      previousRating: 4.6,
      rating: 4.5,
      previousReviewCount: 100,
      reviewCount: 101,
      observedAt: '2026-09-26T09:00:00.000Z',
    }],
    dashboardUrl: 'https://canonry.test/projects/harborline-hotel',
  }
  const view = toAlertView(payload)
  expect(view.title).toBe('harborline-hotel: Google rating fell to 4.5')
  expect(view.body).toBe('Harborline Bayport: 4.6 → 4.5 (100 → 101 reviews)')
  expect(view.url).toBe('https://maps.google.com/?cid=1')
  expect(view.fields.map(f => f.label)).toEqual([AlertFieldLabels.source, AlertFieldLabels.remediation])
  const slack = renderSlack(view)
  expect(slack.text).toContain('Google rating fell to 4.5')
})


// A degraded alert used to re-list every failing check with nothing saying
// which one was news. The sections below lead with what changed.

/** The lines of the "Also open" list. */
const alsoOpen = (payload: HealthWebhookPayload) =>
  toAlertView(payload).fields.find(field => field.label === AlertFieldLabels.alsoOpen)?.value.split('\n')

test('a degraded alert leads with what is new, keeps the rest, and says what was fixed', () => {
  const payload = health({
    failing: [
      { id: 'traffic.source.sync-lag', status: 'fail', code: 'traffic.sync-lag.discarding', summary: 'x' },
      { id: 'gsc.sync.recent-failures', status: 'fail', code: 'gsc.sync.repeated-failures', summary: 'y' },
      { id: 'ga.data.recent-data', status: 'warn', code: 'ga.data.aging', summary: 'z' },
      { id: 'backlinks.source.connected', status: 'warn', code: 'backlinks.source.none', summary: 'w' },
    ],
    added: ['gsc.sync.repeated-failures', 'ga.data.aging'],
    cleared: ['traffic.queue-backlog.remaining', 'bing.auth.verification-failed'],
  })

  const view = toAlertView(payload)
  // The first new problem is the headline, not the worst standing one.
  expect(view.title).toBe('harborline-hotel: Search Console sync failing')
  // The other new problem is listed first and marked; the standing ones follow.
  expect(alsoOpen(payload)).toEqual(['• GA4 data stopped (new)', '• Traffic sync behind', '• Backlinks source'])
  // What cleared is named when it has plain words, and counted when it has none.
  expect(view.fields.find(f => f.label === AlertFieldLabels.fixed)!.value).toBe('• The traffic backlog is cleared.\n• 1 other problem fixed.')

  // Both chat renderers carry the sections in that order.
  expect(renderDiscord(view).embeds[0]!.fields!.map(field => field.name)).toEqual(['Also open', 'Fixed'])
  expect(renderSlack(view).attachments[0]!.fields!.map(field => field.title)).toEqual(['Also open', 'Fixed'])
})

test('a new headline is never repeated under also open, and an empty section is never sent', () => {
  // Nothing cleared, so no "Fixed" section: an empty field value would make
  // Discord reject the whole message.
  const payload = health({ added: ['traffic.sync-lag.discarding'], cleared: [] })
  expect(toAlertView(payload).fields.map(field => field.label)).toEqual(['Next', 'Also open'])
  expect(alsoOpen(payload)).toEqual(['• Content analysis incomplete'])
})

test('a recovery says what was fixed in plain words, with no empty sections', () => {
  const view = toAlertView({
    ...health({ status: 'ok', code: 'health.ok', remediation: null, previousStatus: 'fail', failing: [], added: [], cleared: ['google.auth.refresh-unreachable', 'ga.data.aging'] }),
    event: 'health.recovered',
  })
  expect(view.severity).toBe(AlertSeverities.success)
  expect(view.title).toBe('harborline-hotel: Back to normal')
  expect(view.body).toBe('Google is reachable again. 1 other problem fixed.')
  expect(view.fields).toEqual([])
})

test('a no-signal alert, which has no failing check behind it, says health is unknown', () => {
  const payload = health({ status: 'warn', code: 'health.no-signal', summary: 'No health check produced a result (12 skipped).', remediation: null, failing: [], added: ['health.no-signal'], cleared: ['ga.data.aging'] })
  const view = toAlertView(payload)
  expect(view.title).toBe('harborline-hotel: Health unknown')
  expect(view.severity).toBe(AlertSeverities.warning)
  expect(view.fields).toEqual([{ label: AlertFieldLabels.fixed, value: '• 1 other problem fixed.' }])
})

test('an urgent alert is critical whatever its check is graded, and says urgent', () => {
  // Stale daily data is graded `warn`. On the urgent channel it is still the
  // alert someone has to act on, so it must not render as a routine warning.
  const view = toAlertView({
    ...health({
      status: 'warn',
      code: 'ga.data.stale',
      summary: 'GA4 syncs are running but have stored nothing newer than 2026-10-07 (5 days).',
      remediation: 'Run a GA4 sync and check its error.',
      previousStatus: 'ok',
      failing: [{ id: 'ga.data.recent-data', status: 'warn', code: 'ga.data.stale', summary: 'GA4 syncs are running but have stored nothing newer than 2026-10-07 (5 days).' }],
      added: ['ga.data.stale'],
    }),
    event: 'health.urgent',
  })
  expect(view.severity).toBe(AlertSeverities.critical)
  expect(view.title).toBe('harborline-hotel: GA4 data stopped (urgent)')
  expect(view.body).toContain('nothing newer than 2026-10-07')
  expect(view.fields.find(f => f.label === AlertFieldLabels.next)!.value).toBe('Run a GA4 sync and check its error.')
})

test('an urgent resolution is a success, and is not titled as the whole project recovering', () => {
  const view = toAlertView({
    ...health({
      status: 'ok',
      code: 'health.urgent.resolved',
      summary: 'GA4 data is current through 2026-10-12.',
      remediation: null,
      previousStatus: 'warn',
      failing: [],
      cleared: ['ga.data.stale'],
    }),
    event: 'health.urgent-resolved',
  })
  expect(view.severity).toBe(AlertSeverities.success)
  expect(view.title).toBe('harborline-hotel: Urgent problem fixed')
  expect(view.title).not.toContain('normal')
  expect(view.body).toBe('GA4 data is current through 2026-10-12.')
  expect(view.fields).toEqual([{ label: AlertFieldLabels.fixed, value: '• 1 other problem fixed.' }])
})

test('a website outage keeps its own title on the urgent events', () => {
  const outage = health({ status: 'fail', code: 'site.reachability.down', summary: 'https://harborline.test/ is not responding: HTTP 503.', previousStatus: 'ok', failing: [] })
  expect(toAlertView({ ...outage, event: 'health.urgent' }).title).toBe('harborline-hotel: Website down (urgent)')
  expect(toAlertView({ ...outage, event: 'health.urgent-resolved' }).title).toBe('harborline-hotel: Website is back up')
})

# Cloudflare Server-Side Traffic Setup

Canonry runs a small Worker on your zone to capture **server-side** evidence that AI crawlers and AI referrals reached your site. This is the only source that sees a crawler at all: a bot that never executes JavaScript is invisible to Google Analytics, so without this you are guessing about whether GPTBot, ClaudeBot or PerplexityBot actually fetch your pages.

Two delivery modes exist. This guide covers **Queue pull**, which keeps the API token server-side in Canonry so your zone holds no Canonry credential. For direct push, see `skills/canonry/references/server-side-traffic.md`.

---

## Before you start: size the request volume

**Do this first.** A Worker route runs for *every* matching request, and the Worker's filter does not reduce invocations — it only reduces what gets queued. On a JavaScript app a catch-all route will exceed the Workers Free allowance (100,000 requests/day, account-wide) several times over.

The arithmetic:

```
sessions/day  ×  pageviews/session  ×  same-origin requests/pageview
```

Only **same-origin** requests count. Assets on a third-party CDN never reach your zone, so they never invoke the Worker.

Count same-origin requests on one real page:

```bash
curl -s https://example.com/ \
  | grep -oE '(src|href)="/[^"]+\.(js|css|woff2?|png|jpg|svg)"' \
  | wc -l
```

A worked example from a real Nuxt storefront on Shopify:

| | |
|---|---|
| Sessions/day (GA4, 90d average) | 7,238 |
| Same-origin assets per page | 27 (all `/_nuxt/*`) |
| Images | 0 — served from `cdn.shopify.com`, never hit the zone |
| **Projected** | **~200k–400k/day** |
| Workers Free allowance | 100,000/day |

Measured after deploy: **958 invocations in 4 minutes**, about 345k/day. The estimate was right, and the free allowance would have been exhausted in roughly seven hours.

You have three options:

1. **Exclude static assets from the route** (below). On the example above this removed 27 of every 28 requests and brought it to ~14,500/day. No data is lost: crawlers request pages, not JS bundles.
2. **Workers Paid**, $5/month for 10M requests.
3. Accept the cap with **Fail open** set, and lose data once it trips.

Option 1 is usually right.

---

## Step 1 — Create an API token

`https://dash.cloudflare.com/profile/api-tokens` → **Create Token** → **Create Custom Token**.

| Scope | Permission | Level |
|---|---|---|
| Account | Queues | Edit |
| Account | Workers Scripts | Edit |
| Zone | Workers Routes | Edit |

Account Resources: include the target account. Zone Resources: include the target zone.

Set the first dropdown in each row to **Account** or **Zone** before its permissions appear in the second — zone permissions stay hidden until a Zone row exists.

Store it outside your shell history:

```bash
echo 'TOKEN' > ~/.canonry/cf-token && chmod 600 ~/.canonry/cf-token
```

Editing a token's permissions later does **not** change its value, so nothing needs re-pasting. Changes take up to ~30 seconds to propagate.

---

## Step 2 — Create the Queue

```bash
export CLOUDFLARE_API_TOKEN=$(cat ~/.canonry/cf-token)
export CLOUDFLARE_ACCOUNT_ID=<account-id>

npx wrangler queues create example-events
```

Note the returned `queue_id`.

Then enable HTTP pull. Canonry pulls over the Queues HTTP API, which is not the default consumer type:

```bash
npx wrangler queues consumer http add example-events
```

Retention defaults to 345600 seconds (4 days). Record whatever the queue actually reports and pass the same number to Canonry — it is used for configuration-drift checks, so a value that disagrees with Cloudflare is worse than no value.

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/<queue-id>" \
  | jq '.result.settings.message_retention_period'
```

---

## Step 3 — Connect the source

```bash
canonry traffic connect cloudflare <project> --delivery-mode queue-pull \
  --zone-id <zone-id> \
  --account-id <account-id> \
  --queue-id <queue-id> \
  --queue-name example-events \
  --api-token-file ~/.canonry/cf-token \
  --retention-seconds 345600
```

This writes `worker.js` and `wrangler.toml` into `./canonry-cloudflare-<project>/`. Both are secret-free — the Worker gets only a Queue producer binding, and the API token stays in `~/.canonry/config.yaml`. Confirm before deploying:

```bash
grep -iE 'bearer|secret|token|hmac' canonry-cloudflare-<project>/worker.js
```

The only matches should be the AI-referrer matching list.

### Optional: forward page views for AI visitor journeys

By default the Worker forwards only AI-referred requests and requests from bots and agents: known names, anything with `bot`, `crawler` or `spider` in its user agent, and any other client that is neither a normal browser nor a generic HTTP tool such as `curl`, when it requests a page, text file, sitemap, feed or PDF. Canonry decides server-side what each agent is, so a new agent needs no Worker redeploy. Each forwarded request is one delivery, priced like a page view in the table below. AI visitor journeys from a Cloudflare source record the AI landing but not the visitor's later visits. Add `--forward-page-views` to `traffic connect cloudflare` to also forward people's page views: document loads and form posts from browsers (Sec-Fetch-Dest `document`, or a GET that accepts HTML on older browsers). Assets, API and data calls, prefetches and non-browser clients are never page views. A reconnect without the flag keeps the current setting; `--no-forward-page-views` turns it off.

It does not add Worker invocations: the route already runs the Worker on every page. It adds one delivery per page view:

| | Per 100,000 page views |
|---|---|
| Queue pull | 100,000 messages = 300,000 Queue operations ($0.12 on Workers Paid after the 1M monthly operations included; the Free plan includes 10,000 operations a day, about 3,300 messages) |
| Direct push | 100,000 POSTs to Canonry, plus the CPU to sign and send each one (Workers Paid includes 30M CPU-ms a month) |
| Canonry inbound | about 1-2 KB per event, so roughly 100-200 MB |

Queue pull drains for up to 4 minutes per sync (`CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS`), AI and bot traffic included. If `traffic.source.queue-backlog` reports more than 1,000 messages left after syncs, shorten the interval, raise the time limit or switch to direct push, or the backlog grows until Queue retention drops messages. Each sync records why it stopped (`cnry runs <project> --kind traffic-sync --format json`, `syncSummary.stopReason`), and the doctor names that cause. Direct push is limited to 6,000 events per minute per source.

Canonry stores page views only for AI-touched visitors (AI visitor journeys, capped per visitor per day). Other page views count toward unknown traffic and the capped sample tail; Queue pull also keeps a 14-day delivery receipt per message for replay safety.

The page-view Worker reports a version ending in `+page-views`. `canonry doctor` warns until the deployed Worker reports it, and journey reads list the source in `partialSources` until then.

---

## Step 4 — Deploy the Worker

```bash
cd canonry-cloudflare-<project>
npx wrangler deploy
```

Deploying does **not** attach a route. The Worker is inert until Step 5.

---

## Step 5 — Routes

Two routes are needed: one that runs the Worker, one that keeps it off your static assets.

### The trap

The Worker's own **Domains and Routes** tab can only attach routes **to that Worker**. There is no way to create a route with no Worker from that screen, so adding your asset path there does the opposite of what you want — it routes assets *into* the Worker and doubles the load.

Asset exclusion is a **zone-level** operation: `dash.cloudflare.com` → your zone → **Workers Routes**, or the API below.

### Via API

```bash
ZONE=<zone-id>
TOKEN=$(cat ~/.canonry/cf-token)

# List what exists
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes" | jq '.result[]'

# Catch-all -> the Worker, with fail-open ON
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '{"pattern":"example.com/*","script":"canonry-traffic-<source-id>","request_limit_fail_open":true}' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes"

# Assets -> NO worker. Omitting "script" is what disables it.
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '{"pattern":"example.com/_nuxt/*"}' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes"
```

Cloudflare applies the **most specific** matching route, so the asset route wins on those paths.

Common asset prefixes: `/_nuxt/*` (Nuxt), `/_next/*` (Next.js), `/assets/*`, `/static/*`, `/build/*`.

### Fail open is not the default

`request_limit_fail_open` defaults to **`false`**, and it is set **per route**. Left off, a Worker error or an exhausted request allowance returns 5xx for every request on that route — the entire site, since this is a catch-all.

Verify explicitly:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes" \
  | jq '.result[] | {pattern, script, request_limit_fail_open}'
```

---

## Step 6 — Activate and schedule

```bash
canonry traffic activate <project> --source <source-id>
canonry schedule set <project> --kind traffic-sync --cron "*/15 * * * *" --source <source-id>
```

Connecting a source syncs it once; it does not schedule it. Without the schedule the watermark drifts and a later pull becomes unbounded.

**Use a 15-minute cadence, not daily.** Retention bounds how much a failed sync can recover: at `*/15` a sync can fail repeatedly and still catch up inside a 4-day window; at daily, one failure risks the gap. Cadence costs no extra queue operations, since operations scale with message count rather than pull count.

---

## Step 7 — Verify

```bash
canonry traffic sync <project> --source <source-id>
canonry doctor --project <project> --check 'traffic.*'
```

A healthy first sync:

```
Pulled events:    42
Crawler hits:     38  (12 hourly buckets)
AI referral hits: 0
Unknown hits:     4
```

`Unknown` is ordinary human traffic. `Crawler hits` is the signal this integration exists for.

Confirm the site is unaffected:

```bash
for p in / /about /some/product; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "https://example.com$p"
done
```

`traffic.source.recent-data` fails and `traffic.source.sync-lag` warns until the first successful sync carries data. Both clear on their own.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Authentication error` on a Workers API call | Token lacks that permission, or the edit has not propagated yet. Wait ~30s and retry. |
| Route added but no events | Route attached to the Worker's Domains tab only, or the Worker was never deployed. |
| Site returns 5xx after attaching | `request_limit_fail_open` is `false`. Set it to `true`. |
| Worker invocations far above expectations | No asset-exclusion route. Check for `/_nuxt/*`, `/_next/*`, `/assets/*`. |
| `queues consumer http add` fails | Token needs Queues: Edit at account scope. |
| Events pulled but all `Unknown` | Normal. Crawler and AI-referral classification needs actual bot traffic. |

---

## See also

- `skills/canonry/references/server-side-traffic.md` — adapter internals, direct-push mode, classification rules
- `docs/data-model.md` — where rollups land

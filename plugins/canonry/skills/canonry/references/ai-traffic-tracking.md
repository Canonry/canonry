# Tracking AI traffic to visits and conversions

Read this before you answer whether AI search sent visitors, whether those
visitors came back, or whether they bought, booked or became leads. Read it too
when someone says "our tracking is broken" or "AI referrals dropped".

Everything here is a stored read unless it says otherwise. Changing a setting,
connecting a source, a backfill or a GA sync each need approval for that exact
action.

## The funnel and what measures each step

Each step is usually 10 to 100 times smaller than the one above it. Most AI
answers are read inside the assistant, so a site can be read often and clicked
rarely. Report every step separately; never pool them.

| Step | What it is | Instrument | Read with |
|---|---|---|---|
| Crawled | AI and search bots fetch pages to index them | Server-side traffic, `crawler` | `cnry traffic events <p> --kind crawler` (`canonry_traffic_events`) |
| Read for a user | An assistant fetches a page live while answering someone (ChatGPT-User, Claude-User, Perplexity-User) | Server-side traffic, `ai-user-fetch` | `cnry traffic events <p> --kind ai-user-fetch` |
| Clicked | A person follows a link from an AI answer | Server-side `ai-referral` hits; GA4 AI sessions | `cnry traffic events <p> --kind ai-referral`; `cnry ga ai-referral-history <p>` (`canonry_ga_ai_referral_history`) |
| Came back | That person's later visits, from any channel | AI visitor journeys (server logs) | `cnry journeys summary\|list\|show <p>` (`canonry_journeys_summary`, `canonry_journeys_list`, `canonry_journey_get`) |
| Converted | Lead, booking or purchase | GA4 key events plus `measurement.leadEventNames` | `cnry ga measurement-analysis <p> --window 90d --host-scope all` (`canonry_ga_measurement_analysis`) |

Server-side hits are requests and GA4 counts sessions, and each instrument
misses some visits the other sees, so the two never match exactly. Compare
their trend, not their totals.

## Check the instrument before you report a zero

A zero means nothing until you know the instrument could have seen it. Work
through these in order and say which one applies.

1. **Is the conversion tracked at all?** Canonry counts the configured
   `measurement.leadEventNames` plus the events the GA4 property marks as key
   events, except funnel and engagement steps such as `view_item` or
   `add_to_cart` (listed in `leads.countedEvents.ignoredKeyEvents`). Read `leads.countedEvents` and `leads.events` in
   `cnry ga measurement-analysis <p> --format json` to see which events count
   and each one's total; an event with `measured: false` has not been fetched
   yet, so it is unknown, not zero. If every counted event is zero across every
   channel, not only AI, or GA4 lists no key events, the instrument is blind: report
   "conversions are not measured", never "AI drove no conversions". Adding an
   event the property does not mark as a key event is a setting change
   (`cnry project update <p> --add-lead-event <name>`) and needs approval; the
   next GA sync then refreshes the full window.
2. **Does GA4 receive the event?** Read the stored GTM snapshot
   (`cnry gtm snapshots <p>`, then `cnry gtm snapshot <p> <id>`;
   `canonry_gtm_snapshot_get`). If the booking or purchase trigger fires only
   Google Ads tags (`awct`) and no GA4 event tag, GA4 records no conversions.
   The fix is a GA4 Event tag on the same trigger, made by someone with
   publish rights in the site's GTM container. Canonry's GTM access is
   read-only.
3. **Do two instruments agree?** Compare Canonry's GA4 AI sessions with GA4's
   own `AI Assistant` channel (`cnry ga acquisition <p> --window 30d
   --group-by channel`), and with server-side `ai-referral` hits. Agreement
   between independent instruments rules out an ingestion fault. GA4 may file
   AI shopping links under another channel when they carry a different
   `utm_medium` (for example `feed`); the source still reads `chatgpt.com`.
4. **Paid or organic?** An AI-referral spike can be an ads test. GA4 rows carry
   `trafficClass`, and server-side referrals split paid from organic. Never
   compare a paid month with organic months, and say "the ads ended" rather
   than "AI traffic dropped" when the paid line is what fell.
5. **Is the source reading the right site?** Confirm the traffic source's
   service or host actually serves the domain (for example, check which backend
   a load balancer routes the domain to) before you claim a wiring gap.
6. **Is the source partial?**
   - The default Cloudflare Worker forwards only AI-referred and bot requests,
     so journeys miss later visits until the source is reconnected with
     `--forward-page-views` and the Worker redeployed. Journey reads list such
     sources in `partialSources`.
   - The WordPress logger runs inside WordPress, so it cannot see page views a
     cache serves before WordPress runs.
   - Vercel logs carry no IP, so journey keys use the user agent only
     (`keyBasis`); people with the same device and browser version merge,
     which undercounts people and overstates return rates.
   - A hosted checkout or booking engine on another domain is outside the
     site's server logs.
7. **Is a Queue backlog hiding recent traffic?** For Cloudflare Queue pull,
   read `cnry traffic status <p>` and the last sync's `syncSummary`
   (`cnry runs <p> --kind traffic-sync --format json`) before quoting recent
   days. Recent days look low while a backlog drains.
8. **Is it noise?** Scanners using AI agent names are mostly filtered already:
   requests judged likely fake (credential or admin paths, a user agent unlike
   OpenAI's or Mistral's published string, an IP outside a current published
   list) are left out of AI user fetch hits and counted as
   `totals24h.aiUserFetchLikelyFakeHits`. `cnry traffic samples <p> --kind
   ai-user-fetch` shows each sample's `trust` and `trustReasons`. Quote
   `verified` and `likely_real` requests and pages that returned 200; treat
   `unknown` as unconfirmed.

## What attribution can and cannot say

- GA4 credits a conversion to the session it happened in. A person who first
  came from ChatGPT and books days later from Google counts as Google. Journeys
  keep the earlier AI touch for 30 days, but they see a conversion only when
  its page (for example a booking confirmation URL) appears in the server logs.
- A return from an outside payment or booking step can take the credit in GA4
  unless that domain is listed under unwanted referrals in the GA4 web stream
  settings. That is a GA4 admin change for the site owner.
- A visitor key is a keyed hash of IP and user agent, scoped to the project.
  Never print or ask for visitor IPs.
- Since iOS 26, Safari freezes the OS version in its user agent; device labels
  use Safari's own version instead, so treat the iOS version as approximate.

## User stories

**"Did anyone from AI search buy, book or become a lead?"**
1. Run the instrument checks above, steps 1 and 2 first.
2. If conversions are measured: `cnry ga measurement-analysis <p> --window 90d
   --host-scope all` and read `leads.aiEngines` per engine and period. Quote
   event counts with their sessions; the lead rate is null when the evidence is
   mixed.
3. Add journeys for the cross-session view: `cnry journeys list <p> --returned
   true`, then `show` for visitors whose later visits reach a conversion page.
4. Say what is unmeasured. Example: "ChatGPT sent 120 sessions in 30 days.
   Bookings are not sent to GA4, so we cannot say how many booked."

**"A customer says they found us through ChatGPT. Can we trace them?"**
1. Get the date and time of their purchase, booking or form, and the device if
   known.
2. `cnry journeys list <p> --engine ChatGPT --since <a few days before>` and
   `cnry journeys show <p> <visitor-key>` for visitors active near that time.
3. A user-agent match is "likely", never proof, unless the key also includes
   the IP. Reading a provider's raw logs beyond what Canonry stored is a live
   read and needs approval.

**"AI referrals dropped. Is our tracking broken?"**
1. Pull the monthly series from both instruments (server-side `ai-referral` and
   GA4 AI sessions) and split paid from organic.
2. If both fell together, the traffic changed, not the tracking. Check for an
   ended ads test, a lost citation or mention (`references/aeo-analysis.md`), or
   a site change.
3. If only one fell, check that instrument: sync errors and stop reasons
   (`cnry traffic status`, `cnry runs <p> --kind traffic-sync`), the GA4 tag,
   or the source's service or host.

**"Which of our pages does AI read?"**
`cnry traffic events <p> --kind ai-user-fetch --since <date>`: keep verified
fetches with status 200, group by path, and leave out `robots.txt`. These are
the pages assistants open while answering people, even when nobody clicks.

**"What did an agent do on our site?"**
Read `cnry traffic agent-journeys <p> --since <date> --until <date>`, then
`cnry traffic agent-journey <p> <id>` with the same selectors. MCP equivalents
are `canonry_traffic_agent_journeys` and `canonry_traffic_agent_journey`.
Report the recorded request sequence and HTTP errors. Separate trust (each
sequence's `trustLevels`; `--trust verified|likely_real|unknown`) from request
correlation: IP/UA grouping is inferred, and requests without an IP are
unlinked. Likely fake requests are counted in `coverage.likelyFakeRequests`,
never listed; the count is null with a Property filter. Preserve source gaps and daily caps. For an Advanced
Property, use `--target-key` and report current-plan URL attribution and revision.
Do not infer clicks, a user's prompt, business outcomes or off-site browsing.

**"Do AI visitors come back?"**
`cnry journeys summary <p>`: `returnRate`, `returnedVia` and
`medianDaysToReturn`. Report `keyBasis` and `partialSources` with the numbers;
a user-agent-only or partial source changes what the rate means.

## Reporting language

- Lead with the step, the count and the window: "Assistants read the site 300
  times in 30 days (verified); 10 people clicked through; conversions are not
  measured."
- Keep crawled, read, clicked, came back and converted as separate numbers.
- Name the blind spot whenever a number is zero or low because an instrument
  cannot see it.

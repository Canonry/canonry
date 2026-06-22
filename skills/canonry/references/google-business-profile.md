# Google Business Profile Integration

Canonry integrates with the Google Business Profile (GBP) API to surface local AEO signals: search-keyword impressions, daily performance metrics, hotel lodging attributes, and booking/reservation CTAs (plus reviews on the projects where Google has granted v4 access — see the gating section). This data feeds the local-AEO dashboard and the Aero analyst.

> **Q&A is not available.** Google **retired** the My Business Q&A API (`mybusinessqanda.googleapis.com`) on 2025-11-03, and began winding down the public Q&A section on profiles shortly after. There is no programmatic way to read or write profile Q&A. Don't plan around it.

## What Canonry Automates

- Discover GBP accounts and locations the connected user manages, with explicit per-location selection
- Sync search-keyword impressions aggregated over a date window (default ~12 months; stored with `periodStart`/`periodEnd`)
- Sync daily performance metrics — impressions, website clicks, call clicks, direction requests (all 11 `DailyMetric`s)
- For hotels: sync lodging attributes (amenities, accessibility, pets, etc.) and place action links (booking CTAs)
- Roll the above into a composite summary scorecard (`canonry gbp summary`)
- Sync reviews per location — **only where Google has granted v4 access** (gated; unavailable on most projects — see below)

## What Stays Manual

- Replying to reviews (Phase 4 — write surface)
- Posting local posts / offers (Phase 4)
- Updating lodging attributes (Phase 4)
- Pub/Sub notifications setup (Phase 4)

For now, canonry is read-only on GBP. The Aero agent can draft suggested replies, but applying them is manual.

## Hard Prerequisite: API Access Approval

**Before anything works**, your Google Cloud project must be approved through Google's Business Profile API Basic Access form. Until approved, every API call returns HTTP 403 / 0 QPM — regardless of OAuth scope or which APIs you've enabled.

### Eligibility requirements

From [Google's prerequisites doc](https://developers.google.com/my-business/content/prereqs#request-access):

- **Active Verified Profile** — "Manage a Google Business Profile that is verified and active for 60+ days."
- **Website Requirement** — "Have a website representing the business listed on the GBP."
- **Profile Completeness** — Google recommends the profile be "fully complete and kept up-to-date with the current business information."

Brand-new profiles (under 60 days) and profiles with no associated website are not eligible.

### Submitting the access request

1. Go to the GBP API contact form: <https://support.google.com/business/contact/api_default>
2. Select **"Application for Basic API Access"** from the dropdown.
3. Provide:
   - Your **Google Cloud Console project number** (Cloud Console → Project Info dashboard, *not* the project ID)
   - Email address listed as an **owner or manager** on the target GBP profile

### Approval timeline

- Google sends a follow-up email after review (timing varies; common reports are days to a few weeks).
- Approval is signaled by a **quota change** in Google Cloud Console:
  - **Not approved**: quota is **0 QPM** (Queries Per Minute) — every API call returns 403.
  - **Approved**: quota is **300 QPM** — all enabled APIs become callable.

Check quota at Cloud Console → APIs & Services → quotas, filtered by one of the GBP APIs.

## GCP Setup

### Enable the right APIs

In Cloud Console → APIs & Services → Library, enable:

| API | Purpose |
|---|---|
| My Business Account Management API | List accounts |
| My Business Business Information API | List locations + place action links |
| Business Profile Performance API | Daily metrics + monthly search keywords |
| My Business Verifications API | (optional) Voice-of-Merchant state |
| **My Business Lodging API** | **Hotel attributes — required if working with lodging properties** |
| **My Business Place Actions API** | **Booking / reservation CTAs — required if hotels or restaurants use them** |

**Do NOT enable "My Business Q&A API"** — Google **retired** it on 2025-11-03. It's listed in some older setup docs but no longer functions.

### The legacy "Google My Business API" (v4 — reviews)

The **reviews** endpoint lives on the legacy `mybusiness.googleapis.com` (v4), a separate API from the v1 family above. It is the single biggest stumbling block, and **production testing (May 2026) proved the Basic API Access approval does NOT grant it.**

What we confirmed, with a project approved and running the v1 family at 300 QPM, authenticated as the exact approved account with the `business.manage` scope:

- The v4 reviews call still returns `403 SERVICE_DISABLED`.
- The API is **not searchable in the API Library** — the library page returns "Failed to load."
- `gcloud services enable mybusiness.googleapis.com` returns `PERMISSION_DENIED` reason `110002` (`AUTH_PERMISSION_DENIED`) **even as the approved account** — this is the signature of a producer-restricted (Google-allowlisted) service that the project owner cannot toggle.
- Per Google's [Basic setup](https://developers.google.com/my-business/content/basic-setup) doc: *"The Google My Business API is only visible in the Google API Console to users who submit and receive approval for their Google Account through the access request form."*

**Conclusion:** the v4 GMB API is gated independently of the v1 approval and Google controls the switch. The only routes are (1) the **shortcut "enable" link from the access-approval email**, opened as the approved account in the browser, or (2) replying to the access-request thread asking Google to enable `mybusiness.googleapis.com` for your project number. Self-service (library, gcloud) does not work. Build reviews behind this gate and ship the rest without it.

**Account-credential gotcha:** API calls use your **Application Default Credentials** (`gcloud auth application-default login` → `print-access-token`), while `gcloud services enable` uses the separate **gcloud CLI account** (`gcloud config get-value account`). These can be different identities. Verify the token's real account with `curl "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=$TOKEN"` before concluding anything about access — a "wrong account" symptom is often just the two credential stores disagreeing.

### Create OAuth client credentials

1. Cloud Console → APIs & Services → **OAuth consent screen** → set up consent (External works). Add your own email under "Test users" while the app is in test mode.
2. Cloud Console → APIs & Services → **Credentials** → **+ Create Credentials** → **OAuth client ID**.
3. Application type: **Web application**.
4. Authorized redirect URIs: `http://localhost:53682/callback` (or whatever port canonry's connect flow uses — match it exactly).
5. Save the **Client ID** and **Client secret**.

### Store credentials for canonry

Either set env vars before running CLI commands:

```bash
export GOOGLE_CLIENT_ID="…"
export GOOGLE_CLIENT_SECRET="…"
```

Or persist them in `~/.canonry/config.yaml`:

```yaml
google:
  clientId: "your-client-id"
  clientSecret: "your-client-secret"
```

OAuth tokens (per-user, obtained at connect time) are stored in the same file under `google.connections`. They are never written to the canonry database.

## Connect a Project

Once GCP setup is done and the access form is approved:

```bash
canonry gbp connect <project>
canonry gbp accounts <project>               # list accessible accounts (pick one)
canonry gbp locations discover <project> --account accounts/123   # discover that account's locations
canonry gbp locations <project>              # verify discovered locations
canonry gbp sync <project> --wait            # run a first sync
canonry gbp summary <project>                # check derived metrics
```

The OAuth scope requested is `https://www.googleapis.com/auth/business.manage`. **There is no read-only variant** — Google does not publish one. The consent screen will say "manage your business profile" even though canonry's read-only surface cannot write anything until Phase 4.

### Account selection is per project

A single OAuth user often manages **multiple GBP accounts** (a personal account, a location group, agency-managed businesses). Each canonry project tracks **one** account's locations — so to track two businesses, use two projects.

- **List accounts:** `canonry gbp accounts <project>` (API `GET /gbp/accounts`, MCP `canonry_gbp_accounts`) shows every account the connection can see, with its `accounts/{n}` resource name.
- **Pick one at discover time:** `canonry gbp locations discover <project> --account accounts/{n}`. Omitting `--account` reuses the account the project already tracks; on the very first discover with no `--account`, canonry falls back to the **first** account the user can see — so if you manage more than one account, always pass `--account` the first time to avoid silently tracking the wrong business.
- **Switching accounts is destructive:** re-pointing a project at a *different* account would drop the old account's locations and all its synced data, so it's rejected unless you pass `--switch-account` (API `switchAccount: true`). You can also `canonry gbp disconnect <project>` (which now clears the project's entire GBP footprint) and start fresh.

## The Summary Scorecard (`canonry gbp summary`)

`canonry gbp summary <project> [--location locations/XXX]` (API: `GET /gbp/summary`, MCP: `canonry_gbp_summary`) is the single composite read that rolls every synced GBP surface into one scorecard. All math lives in the API (`buildGbpSummary`) — the CLI and dashboard only render it, so `--format json` matches the API response field-for-field. Fields:

- **`scope`** — `{ locationName, locationCount }`. `locationName` is null when summarizing across all selected locations.
- **`performance`** — daily-metric roll-up:
  - `totals` — sum per `DailyMetric` over everything synced.
  - `recent7d` / `prior7d` — per-metric sums for the last 7 days vs the 7 days before, anchored to the **last complete (non-zero) day** (`freshness.dataThroughDate`), not wall-clock and not the max stored date. GBP data lags ~2–3 days and the trailing days can arrive as not-yet-reported zeros; anchoring to the last complete day keeps those lag zeros out of the recent window so a reporting-lag artifact is never shown as a real decline (#658). Both maps are backfilled with the union of metrics as explicit `0`s.
  - `deltaPct` — percent change recent-vs-prior per metric, **over complete days only**; **`null` when the prior window is `0`** (no divide-by-zero, and "appeared from nothing" is not a percentage).
- **`freshness`** — `{ dataThroughDate, latestStoredDate, pendingDays }` (#658). `dataThroughDate` is the last day with reported activity; `latestStoredDate` is the max stored date (≥ dataThroughDate when the lag tail was stored as zeros); `pendingDays` is how many trailing days are still pending vs today. Renderers show "data through &lt;date&gt; · Nd pending" and never treat the tail as a drop.
- **`timeseries`** — `[{ date, pending, metrics }]` over the most recent ~30 days, for the trend charts. Each day carries every in-window metric (0 where absent that day) and a `pending` flag marking the reporting-lag tail.
- **`keywords`** — `{ total, thresholdedCount, thresholdedPct }`. `thresholdedPct` (0–100) is the share of keywords whose exact count Google redacted — your headline data-fidelity number (expect ~89% for a busy hotel, 100% for an SMB).
- **`placeActions`** — `{ total, hasReservationCta, hasBookingCta, hasDirectMerchantCta }`. `hasDirectMerchantCta` is false when the only booking links are OTA/aggregator (Expedia/Booking) — a recommendation to add a direct CTA.
- **`lodging`** — `{ lodgingLocationCount, populatedLodgingCount, emptyLodgingCount }`. `emptyLodgingCount` counts lodging-capable locations whose Lodging API returns zero structured attributes. That is common even for complete hotels (the owner-set "Hotel details" amenity panel is a separate surface the API does not expose), so it is a verify signal, not a confirmed gap.

## Scheduling

`gbp-sync` is a schedulable run kind (alongside `answer-visibility` and `traffic-sync`). It needs no source — it syncs the project's selected locations:

```bash
canonry schedule set <project> --kind gbp-sync --preset daily
canonry schedule show <project> --kind gbp-sync
```

One schedule row per `(project, kind)`, so a GBP sync schedule coexists with a visibility-sweep schedule. The scheduler creates the `gbp-sync` run and runs the same worker the manual `canonry gbp sync` uses; on completion the run flows through the post-run pipeline (insights + Aero wake-up).

## Health Checks (`canonry doctor`)

```bash
canonry doctor --project <name> --check 'gbp.*'
```

- `gbp.auth.connection` — OAuth creds present + refresh token works.
- `gbp.auth.scopes` — granted scope includes `business.manage`.
- `gbp.account.access` — the tracked account is still listable. A `gbp.account.quota-pending` **warn** means the API access form is still pending Google approval (0 QPM) — auth is fine, the API just isn't enabled yet.
- `gbp.places.api-key` — Places API readiness for the listing cross-reference (#648). **Warns** when GBP is connected but no Places key is set, or when no selected location carries a Maps place id (re-run `gbp locations discover`). Skipped when Places is disabled (`places.tier: off`) or GBP isn't connected.
- `gbp.data.recent-sync` — a selected location synced in the last 7d (warn) / 30d (fail); warns when never synced.

## Insights (after a `gbp-sync` run)

A completed `gbp-sync` run generates location-scoped insights (`provider = 'gbp'`), surfaced in `canonry insights`, the dashboard, notifications (`insight.critical`/`insight.high`), and Aero's proactive wake-up:

- `gbp-lodging-gap` (low) — a lodging-capable location whose structured Lodging attributes canonry can't read via the GBP Lodging API, **and no Places evidence available** (Places disabled, no key, or no snapshot yet). This is a **verify-nudge, not a confirmed gap**: the Lodging API returns empty even for complete hotels because the owner-set "Hotel details" amenity panel writes to a separate surface the API doesn't expose. Treat `populatedGroupCount === 0` as "can't confirm via the API", not "owner set no amenities", and recommend verifying the "Hotel details" panel.
- `gbp-listing-discrepancy` (medium) — the version of the above with Places evidence (#648 Phase B): canonry can't read the Lodging attributes, *plus* a Places snapshot showing the public listing advertises specific amenities (e.g. breakfast, parking, pet-friendly). Because Places can read amenities the Lodging API can't, those amenities are likely already set in "Hotel details" and simply not API-readable, so this is still a **verify** (confirm in "Hotel details"), not a confirmed gap. Names the exact amenities. **Supersedes `gbp-lodging-gap`** when Places data exists. Requires a Places API key + a synced lodging location with a place id.
- `gbp-cta-gap` (medium) — place actions present but no direct-merchant booking CTA (only aggregators).
- `gbp-description-missing` (low) — a selected location with no owner business description (`profile.description`). Unlike the lodging nudge this is a **reliable, confirmable gap** (the description reads straight from the Business Information API): recommend adding a description (up to 750 chars), the cheapest owner-controlled prose AI engines lift to describe the business.
- `gbp-metric-drop` (high/medium) — a headline conversion metric (direction requests, website clicks, call clicks) fell sharply week-over-week within the synced window.
- `gbp-keyword-drop` (high/medium) — a head search term's impressions fell month-over-month.

The month-over-month keyword signal is powered by the **accumulating** `gbp_keyword_monthly` table: each sync fetches the last few complete months (one call per month, since the API aggregates a range into a single figure) and preserves older in-retention months, so a real monthly series builds up over time. The current-snapshot reads (`gbp keywords`, `gbp summary`) are unchanged — they still use the trailing-window `gbp_keyword_impressions` table.

## Owner-Set Attributes (`gbp attributes`)

Every `gbp sync` also captures the location's **owner-set attributes** via the Business Information API (`getAttributes`) and stores them snapshot-on-change in `gbp_attributes_snapshots`. Unlike the Lodging API (hotels only) this works for **any** business category: amenity / service / accessibility / identity / social-URL tags such as `has_onsite_services`, `offers_online_estimates`, `is_owned_by_women`, wheelchair accessibility, `url_instagram`, `url_facebook`. The API returns **only the attributes the owner has set**, so `attributeCount` is a reliable, owner-readable completeness signal (not a verify-nudge like the lodging gap).

Read them with `canonry gbp attributes <project> [--location <name>] [--format json]` (API `GET /gbp/attributes`, MCP `canonry_gbp_attributes`). The CLI prints each location's set attributes (`key: value`); `--format json` returns the full normalized records (`{name, valueType, values, uris}`).

## The Dashboard (`GbpSection`)

The project page shows a self-gating "Google Business Profile" section (only when a GBP connection exists): a **graph-first** performance block — a daily conversion-trend chart (the hero) plus a reach (impressions) area, with the reporting-lag tail greyed as "pending", a "data through &lt;date&gt;" label, and all-zero series collapsed to a "Not active" footnote (#658) — alongside the owner-vs-public gap insight (`gbp-listing-discrepancy`), the public-listing (Places) amenity block, a search-terms table, and a locations table with a track/untrack toggle and a Sync button. Every number is computed server-side by `buildGbpSummary`; the component only renders (Recharts via `ChartPrimitives`). The raw owner-configured Place Action CTAs and the lodging-completeness count are **deliberately not shown in the dashboard**: they are owner-set with no public counterpart to cross-reference, so an "Absent" / "empty" tile would read as a fact about the live listing when it is only an unverifiable owner signal (#648, PR #660). Operators still read them via `cnry gbp place-actions` / `cnry gbp lodging`, and the `/gbp/summary` API still carries both fields.

## Hotel-Specific Setup

For hotel groups, two extra signal sources are critical:

### Lodging attributes (`canonry gbp lodging`)

AI engines (Gemini, Perplexity, ChatGPT) pull hotel attributes verbatim from the Lodging resource to answer queries like "does X hotel have a pool?" or "is Y pet-friendly?". Coverage of these structured fields is the **highest-signal AEO surface for hotels** — higher than reviews or website content.

Canonry computes a coverage score per property and flags missing high-signal attributes (pool, free wifi, pets, parking, breakfast, fitness, spa, accessibility) in the summary endpoint.

A non-lodging location returns HTTP 400 `FAILED_PRECONDITION` ("This operation is not supported for this location. Please check the value of `Location.location_state.can_operate_lodging_data`") — not a 404. Fix the primary category in the Business Profile UI to a lodging category first. A lodging-category location returns HTTP 200 with only `{ "name": "..." }` whenever the structured Lodging resource is unset. That is the common case even for complete hotels, because the owner-set "Hotel details" amenity panel writes to a separate surface this API does not return. So an empty result is a "can't read via the API" verify, not proof the hotel has no amenities.

### Place action links (`canonry gbp place-actions`)

Booking and reservation CTAs surfaced in AI answers come from `placeActionLinks`, not from the website URL. Canonry tracks:

- `placeActionType` (`RESERVATION`, `BOOK`, `ORDER_FOOD`, …)
- `providerType` (`MERCHANT` for direct, `AGGREGATOR` for OTA links like Expedia/Booking)
- `isPreferred` flag
- `uri`

A property with only aggregator booking links and no direct merchant CTA is a recommendation to surface.

## Places enrichment — the rendered-listing cross-reference (#648)

For lodging locations, canonry pulls the **Places API (New) Place Details** — the amenities Google's *public* listing advertises (breakfast, parking, pet policy, accessibility, editorial summary) — and cross-references them against the owner-configured GBP profile. When the Lodging API returns nothing but the public listing advertises amenities, the `gbp-listing-discrepancy` insight names those amenities so the operator can verify they are set in the "Hotel details" panel (the listing may already be drawing them from there, a surface the Lodging API does not expose).

**Setup** — the Places API uses a plain **API key**, not OAuth (unrelated to `google.clientId`). A billing account (card) is required on the GCP project even within the free tier.

```yaml
# ~/.canonry/config.yaml — top-level `places` block (an API key, not OAuth, so
# it is separate from the `google` block — same as `ga4`, `bing`, `wordpress`).
places:
  apiKey: "AIza..."          # or env GOOGLE_PLACES_API_KEY
  tier: atmosphere           # atmosphere (default) | pro | off
  refreshIntervalDays: 7     # cost lever — re-fetch a location at most weekly
```

The next `gbp sync` then snapshots Place Details for selected lodging locations that carry a Maps place id (re-run `gbp locations discover` if `gbp.places.api-key` warns there are none). Read it back with `canonry gbp places <project>` (the `amenities` list is computed server-side).

**Cost** — Place Details is billed at the highest field-mask tier requested. The amenity booleans powering the cross-reference are the **Enterprise + Atmosphere** SKU: **1,000 free calls/month, then $25/1,000**. Because canonry fetches Places only for lodging locations and only past the refresh interval (default weekly), a typical operator book (a handful to ~200 hotels on a weekly refresh) stays inside the free tier — **$0/month**. Drop `tier` to `pro` (5,000 free, accessibility-only — thinner cross-reference) or `off` to disable. `accessibilityOptions` is Pro tier; the IDs-only refresh is free.

## Provenance: the three data planes (how to present GBP)

Every GBP number belongs to one of three planes. **Tag each figure by plane before you show or say it.** The two classic mistakes are presenting plane 1 as if it were plane 2, and presenting a plane-3 lag artifact as a real change.

| Plane | Source | How to present it |
|---|---|---|
| **1. Owner-configured** (CTAs, amenities, hours) | Business Info / Place Actions / Lodging APIs | "Owner profile completeness", never a fact about the live listing. An empty field is the operator's blind spot, not proof the public listing is empty. Surface as a finding **only when cross-referenced** against plane 2. |
| **2. Public rendered** (what searchers and AI see) | Places API (New): a thin, schema-bound subset | Label it a **partial** public view. Thin or empty Places data is NOT evidence the listing is sparse, because the full rendered listing also synthesizes Hotel Center pricing, OTA links, and Local Guide contributions that no API returns. |
| **3. Performance** (impressions, clicks, directions, calls) | Performance API, ~2 to 3 day reporting lag | NOT an owner-content signal: the owner-configured caveat does not apply. The honesty lever here is the lag. Anchor windows to the last complete day, show `freshness`, and never call the unreported tail a decline (worse right after US holidays). |

**The only thing to present as a "finding"** is the plane-1-vs-plane-2 delta: the `gbp-listing-discrepancy` insight. Quote its named amenities as a floor ("the public listing advertises at least X that your profile doesn't"), never a complete inventory.

## Important Constraints

- **GBP API returns owner-configured data only** — the API exposes only what the profile owner has set. Google's *rendered* hotel listing synthesizes additional amenities, room pricing, and booking links from Google Hotel Center, OTA feeds (Booking/Expedia/Hotels.com), and Places/user-contributed data — none of which the GBP API returns. So an empty Lodging API result does **not** mean the public listing is empty, and it does **not** prove the owner set no amenities: the owner-facing "Hotel details" amenity panel writes to a separate surface the Lodging API does not return, so it is commonly empty even for complete hotels. Treat it as a "verify the Hotel details panel", not a confirmed gap. **Canonry pulls the rendered-listing side from the Places API and cross-references it against the GBP profile** (issue #648, shipped) — see "Places enrichment" below.
- **No read-only OAuth scope** — `business.manage` is the only published scope. The consent screen will warn about write access even though canonry's v1 is read-only.
- **300 QPM shared quota** — across all GBP sub-APIs on one Google Cloud project. Canonry's sync worker caps per-location concurrency at 4 (~28 in-flight calls at peak) to stay well under the cap.
- **10 edits/min per profile** — hard cap on writes (relevant for Phase 4). Cannot be raised.
- **Privacy-redacted keyword impressions** — for each keyword aggregated over the requested window, Google returns either an exact `value` or only a `threshold` floor (`<N`). Canonry stores both shapes (`valueCount` / `valueThreshold`) against the row's `periodStart`/`periodEnd` and surfaces a "% thresholded" stat so the user understands data fidelity. Note the Performance API aggregates each keyword over the **whole** requested date range — it does not break impressions down per calendar month.
- **Hybrid v1/v4 surface, separately gated** — reviews live on the legacy v4 host (`mybusiness.googleapis.com/v4`); everything else is v1. **The Basic API Access approval grants the v1 family but NOT v4.** Confirmed in production: a project running v1 at 300 QPM still gets `403 SERVICE_DISABLED` on v4 reviews, and the v4 API is producer-restricted (`gcloud services enable` → `PERMISSION_DENIED 110002`) so it can't be self-enabled even by the approved account. Treat reviews as a separately-gated surface that may be unavailable; never block the rest of the integration on it.
- **Multi-location chains** — a 200-location chain hits ~600+ API calls per sync. Default sync may take minutes for large chains; scope with `canonry gbp sync <project> --location locations/XXX` to retry a subset.

## Real-World Data Shapes & Signal Patterns

Validated against three live businesses of different types (a computer-support shop, a roofing contractor, and a Venice Beach hotel). Bake these into any parsing or analysis code.

### Response-shape quirks (the parser MUST handle these)

- **Values are string-encoded integers.** Keyword counts come as `{ "insightsValue": { "value": "10939" } }` or `{ "insightsValue": { "threshold": "15" } }` — note the nesting under `insightsValue` and that `"10939"` is a string. `Number()` it.
- **Daily-metric zero days omit the value entirely.** A datedValue with no traffic is `{ "date": {"year":2026,"month":5,"day":1} }` — there is no `"value": "0"`. Treat a missing `value` as 0; don't skip the row.
- **Dates are split objects** (`{year, month, day}`), not ISO strings. Reassemble.

### Signal patterns (what the data actually looks like)

- **`BUSINESS_DIRECTION_REQUESTS` is the most reliably-populated conversion signal** across every business type — even a tiny roofing contractor logged 66/30d while its website-clicks (2) and call-clicks (1) were near-zero. For local/service businesses it's the headline AEO-conversion proxy, not website clicks.
- **Most of the 11 daily metrics are all-zero** for non-retail businesses (`BUSINESS_CONVERSATIONS`, `BUSINESS_BOOKINGS`, `BUSINESS_FOOD_*` were 0 for all three). Syncing all 11 is fine (zeros are cheap) but the dashboard should hide all-zero series.
- **Impressions skew to Maps for physical-destination businesses.** The hotel pulled 7,402 desktop-maps impressions vs 2,257 desktop-search in 30 days — people find it on Maps.
- **Keyword thresholding scales with volume.** A busy hotel was ~89% thresholded (its head terms like `hotels`→10,939 had exact values); both small businesses were **100% thresholded** (every keyword redacted). For the typical SMB location, expect zero exact keyword values — design the UI to lead with the `<N` floor, not exact counts.
- **An empty Lodging resource is the norm, but it does NOT prove the owner set no amenities.** A real operating hotel returned a lodging resource with only `{ "name": ... }` and zero place-action links, yet its GBP "Hotel details" panel had amenities filled in (breakfast, wifi, parking, accessibility). The GBP Lodging API does not expose that panel, so `populatedGroupCount === 0` means "canonry can't read structured attributes via the API", not "the hotel has none". Surface the lodging signal as a **verify** (check the "Hotel details" panel), not a confirmed gap. The place-action emptiness is a separate, genuinely owner-readable signal.
- **The Places cross-reference is a thin slice for hotels, not the full rendered listing.** Run live against the Venice Beach hotel at the Atmosphere tier, Place Details surfaced exactly one structured amenity, `wheelchair accessibility`, even though the rendered Google hotel module advertises far more (wifi, pool, room service, room rates). Those richer fields come from **Hotel Center**, which the Places API does not expose. So a thin or empty `gbp places` amenity list is NOT evidence the public listing is sparse; Places only carries a narrow, schema-bound subset (breakfast, dining, parking, pet-friendly, accessibility, restroom, family-friendly, outdoor seating, reservations). Read `gbp-listing-discrepancy` as a **floor** on the public-vs-owner gap (proof the listing advertises *at least* the named amenities), never a complete inventory. The owner-control point still stands at any size: even one amenity the profile fails to assert is a structured-data gap the operator can close.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every API call returns HTTP 403 | Access form not yet approved (0 QPM) | Submit the form; wait for approval email. Check quota in Cloud Console. |
| `redirect_uri_mismatch` during connect | OAuth client doesn't include the canonry callback URL | Add `http://localhost:53682/callback` (or the canonry-configured URL) to the OAuth client's authorized redirect URIs |
| "App not verified" warning at consent | Consent screen in test mode | Add the OAuth user to test users, or publish the consent screen |
| Empty accounts list after connect | OAuth user lacks manager access on any profile | Ask the profile owner to add the user at [business.google.com](https://business.google.com) → Users |
| Lodging endpoint returns 400 `FAILED_PRECONDITION` | Location primary category is not a lodging category | Update the primary category in the GBP UI to `Hotel`, `Resort`, `Motel`, etc. |
| Lodging returns 200 with only `{ "name": ... }` | The GBP Lodging API doesn't expose the "Hotel details" amenity panel (a separate surface), so it's commonly empty even when amenities ARE set | Not an error, and not proof of a gap. Surface as a verify: have the operator check the "Hotel details" panel; flag only if genuinely unset there |
| Place action links empty | No CTAs configured | Set them up in the GBP UI; for many local businesses this is genuinely empty (an AEO gap) |
| Reviews 403 `SERVICE_DISABLED` while v1 APIs work | Legacy v4 `mybusiness.googleapis.com` not enabled for this account/project | See "The legacy Google My Business API" above — enable via the approval-email shortcut as the approved account; can't be done via library or gcloud |
| Q&A API unreachable | Google retired the Q&A API on 2025-11-03 | Permanent. Q&A is not available programmatically |
| Keyword impressions mostly `threshold` instead of `value` | Low-volume keywords are privacy-redacted by Google | Expected — even a busy hotel can be ~89% thresholded; tiny businesses are 100%. Surfaced as `thresholdedKeywordPct` in the summary |

## Related Files in This Skill

- `references/canonry-cli.md` — full CLI command reference
- `references/aeo-analysis.md` — interpretation patterns for citation and visibility data

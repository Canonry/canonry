# Google Business Profile Integration

Canonry integrates with the Google Business Profile (GBP) API to surface local AEO signals: search-keyword impressions, daily performance metrics, hotel lodging attributes, and booking/reservation CTAs (plus reviews on the projects where Google has granted v4 access — see the gating section). This data feeds the local-AEO dashboard and the Aero analyst.

> **Q&A is not available.** Google shut down the My Business Q&A API — it returns HTTP 501 `API_UNSUPPORTED`. There is no programmatic way to read or write profile Q&A. Don't plan around it.

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

**Do NOT enable "My Business Q&A API"** — Google shut it down (HTTP 501 `API_UNSUPPORTED`). It's listed in some older setup docs but no longer functions.

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
  - `recent7d` / `prior7d` — per-metric sums for the last 7 days vs the 7 days before, anchored to the **most recent stored metric date** (not wall-clock — GBP data lags ~2–3 days, so anchoring to "today" would always show empty recent windows). Both maps are backfilled with the union of metrics as explicit `0`s so a metric present in only one window still appears in both.
  - `deltaPct` — percent change recent-vs-prior per metric; **`null` when the prior window is `0`** (no divide-by-zero, and "appeared from nothing" is not a percentage).
- **`keywords`** — `{ total, thresholdedCount, thresholdedPct }`. `thresholdedPct` (0–100) is the share of keywords whose exact count Google redacted — your headline data-fidelity number (expect ~89% for a busy hotel, 100% for an SMB).
- **`placeActions`** — `{ total, hasReservationCta, hasBookingCta, hasDirectMerchantCta }`. `hasDirectMerchantCta` is false when the only booking links are OTA/aggregator (Expedia/Booking) — a recommendation to add a direct CTA.
- **`lodging`** — `{ lodgingLocationCount, populatedLodgingCount, emptyLodgingCount }`. `emptyLodgingCount` counts lodging-capable locations with zero structured attributes — the AEO gap to surface.

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
- `gbp.data.recent-sync` — a selected location synced in the last 7d (warn) / 30d (fail); warns when never synced.

## Insights (after a `gbp-sync` run)

A completed `gbp-sync` run generates location-scoped insights (`provider = 'gbp'`), surfaced in `canonry insights`, the dashboard, notifications (`insight.critical`/`insight.high`), and Aero's proactive wake-up:

- `gbp-lodging-gap` (high) — a lodging-capable location with an empty attribute profile.
- `gbp-cta-gap` (medium) — place actions present but no direct-merchant booking CTA (only aggregators).
- `gbp-metric-drop` (high/medium) — a headline conversion metric (direction requests, website clicks, call clicks) fell sharply week-over-week within the synced window.
- `gbp-keyword-drop` (high/medium) — a head search term's impressions fell month-over-month.

The month-over-month keyword signal is powered by the **accumulating** `gbp_keyword_monthly` table: each sync fetches the last few complete months (one call per month, since the API aggregates a range into a single figure) and preserves older in-retention months, so a real monthly series builds up over time. The current-snapshot reads (`gbp keywords`, `gbp summary`) are unchanged — they still use the trailing-window `gbp_keyword_impressions` table.

## The Dashboard (`GbpSection`)

The project page shows a self-gating "Google Business Profile" section (only when a GBP connection exists): the performance scorecard with 7-day deltas, CTA-presence + lodging-completeness tiles, a search-terms table, and a locations table with a track/untrack toggle and a Sync button. Every number is computed server-side by `buildGbpSummary` — the component only renders.

## Hotel-Specific Setup

For hotel groups, two extra signal sources are critical:

### Lodging attributes (`canonry gbp lodging`)

AI engines (Gemini, Perplexity, ChatGPT) pull hotel attributes verbatim from the Lodging resource to answer queries like "does X hotel have a pool?" or "is Y pet-friendly?". Coverage of these structured fields is the **highest-signal AEO surface for hotels** — higher than reviews or website content.

Canonry computes a coverage score per property and flags missing high-signal attributes (pool, free wifi, pets, parking, breakfast, fitness, spa, accessibility) in the summary endpoint.

A non-lodging location returns HTTP 400 `FAILED_PRECONDITION` ("This operation is not supported for this location. Please check the value of `Location.location_state.can_operate_lodging_data`") — not a 404. Fix the primary category in the Business Profile UI to a lodging category first. A lodging-category location with no amenities filled in returns HTTP 200 with only `{ "name": "..." }` — that empty profile is itself a finding (AI engines have no structured amenity data to cite).

### Place action links (`canonry gbp place-actions`)

Booking and reservation CTAs surfaced in AI answers come from `placeActionLinks`, not from the website URL. Canonry tracks:

- `placeActionType` (`RESERVATION`, `BOOK`, `ORDER_FOOD`, …)
- `providerType` (`MERCHANT` for direct, `AGGREGATOR` for OTA links like Expedia/Booking)
- `isPreferred` flag
- `uri`

A property with only aggregator booking links and no direct merchant CTA is a recommendation to surface.

## Important Constraints

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
- **Empty lodging / place-action profiles are the norm, and the emptiness is the product.** A real operating hotel returned a lodging resource with only `{ "name": ... }` (no amenities) and zero place-action links. That gap — "AI engines have no structured amenity data or direct-booking CTA to cite" — is exactly what canonry should surface, not an error to suppress.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every API call returns HTTP 403 | Access form not yet approved (0 QPM) | Submit the form; wait for approval email. Check quota in Cloud Console. |
| `redirect_uri_mismatch` during connect | OAuth client doesn't include the canonry callback URL | Add `http://localhost:53682/callback` (or the canonry-configured URL) to the OAuth client's authorized redirect URIs |
| "App not verified" warning at consent | Consent screen in test mode | Add the OAuth user to test users, or publish the consent screen |
| Empty accounts list after connect | OAuth user lacks manager access on any profile | Ask the profile owner to add the user at [business.google.com](https://business.google.com) → Users |
| Lodging endpoint returns 400 `FAILED_PRECONDITION` | Location primary category is not a lodging category | Update the primary category in the GBP UI to `Hotel`, `Resort`, `Motel`, etc. |
| Lodging returns 200 with only `{ "name": ... }` | The lodging profile has no amenities filled in | Not an error — it's an AEO gap to flag to the operator |
| Place action links empty | No CTAs configured | Set them up in the GBP UI; for many local businesses this is genuinely empty (an AEO gap) |
| Reviews 403 `SERVICE_DISABLED` while v1 APIs work | Legacy v4 `mybusiness.googleapis.com` not enabled for this account/project | See "The legacy Google My Business API" above — enable via the approval-email shortcut as the approved account; can't be done via library or gcloud |
| Q&A returns HTTP 501 `API_UNSUPPORTED` | Google shut down the Q&A API | Permanent — Q&A is not available programmatically |
| Keyword impressions mostly `threshold` instead of `value` | Low-volume keywords are privacy-redacted by Google | Expected — even a busy hotel can be ~89% thresholded; tiny businesses are 100%. Surfaced as `thresholdedKeywordPct` in the summary |

## Related Files in This Skill

- `references/canonry-cli.md` — full CLI command reference
- `references/aeo-analysis.md` — interpretation patterns for citation and visibility data

# Google Business Profile Integration

Canonry integrates with the Google Business Profile (GBP) API to surface local AEO signals: reviews, Q&A coverage, monthly search-keyword impressions, daily performance metrics, hotel attributes, and booking CTAs. This data feeds the local-AEO dashboard and the Aero analyst.

## What Canonry Automates

- Discover GBP accounts and locations the connected user manages
- Sync reviews (text, rating, replies) per location
- Sync monthly search-keyword impressions (last 12 months)
- Sync daily performance metrics — impressions, website clicks, call clicks, direction requests
- Sync Q&A questions and top answers (read-only)
- For hotels: sync lodging attributes (amenities, accessibility, pets, etc.) and place action links (booking CTAs)
- Surface a "profile completeness" score and unanswered-content backlog

## What Stays Manual

- Replying to reviews (Phase 4 — write surface)
- Posting Q&A answers (Phase 4)
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
| My Business Q&A API | Questions and top answers |
| My Business Verifications API | (optional) Voice-of-Merchant state |
| **My Business Lodging API** | **Hotel attributes — required if working with lodging properties** |
| **My Business Place Actions API** | **Booking / reservation CTAs — required if hotels or restaurants use them** |

The legacy "Google My Business API" (v4) is no longer listed in the API Library. It hosts the **reviews** endpoint and becomes callable as a side-effect of the access form being approved — you cannot enable it manually.

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
canonry gbp locations discover <project>
canonry gbp locations <project>              # verify discovered locations
canonry gbp sync <project> --wait            # run a first sync
canonry gbp summary <project>                # check derived metrics
```

The OAuth scope requested is `https://www.googleapis.com/auth/business.manage`. **There is no read-only variant** — Google does not publish one. The consent screen will say "manage your business profile" even though canonry's read-only surface cannot write anything until Phase 4.

## Hotel-Specific Setup

For hotel groups, two extra signal sources are critical:

### Lodging attributes (`canonry gbp lodging`)

AI engines (Gemini, Perplexity, ChatGPT) pull hotel attributes verbatim from the Lodging resource to answer queries like "does X hotel have a pool?" or "is Y pet-friendly?". Coverage of these structured fields is the **highest-signal AEO surface for hotels** — higher than reviews or website content.

Canonry computes a coverage score per property and flags missing high-signal attributes (pool, free wifi, pets, parking, breakfast, fitness, spa, accessibility) in the summary endpoint.

A 404 on the lodging endpoint means the location's primary category is not a lodging category (`Hotel`, `Resort`, `Motel`, etc.). Fix the primary category in the Business Profile UI first.

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
- **Privacy-redacted keyword impressions** — Google returns either `value` or `threshold` per `(month, keyword)` row. Canonry stores both shapes and surfaces a "% thresholded" stat so the user understands data fidelity.
- **Hybrid v1/v4 surface** — reviews still live on the legacy v4 host (`mybusiness.googleapis.com/v4`). Other endpoints are v1. Both work post-approval.
- **Multi-location chains** — a 200-location chain hits ~600+ API calls per sync. Default sync may take minutes for large chains; scope with `canonry gbp sync <project> --location locations/XXX` to retry a subset.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every API call returns HTTP 403 | Access form not yet approved (0 QPM) | Submit the form; wait for approval email. Check quota in Cloud Console. |
| `redirect_uri_mismatch` during connect | OAuth client doesn't include the canonry callback URL | Add `http://localhost:53682/callback` (or the canonry-configured URL) to the OAuth client's authorized redirect URIs |
| "App not verified" warning at consent | Consent screen in test mode | Add the OAuth user to test users, or publish the consent screen |
| Empty accounts list after connect | OAuth user lacks manager access on any profile | Ask the profile owner to add the user at [business.google.com](https://business.google.com) → Users |
| Lodging endpoint returns 404 | Location primary category is not a lodging category | Update the primary category in the GBP UI to `Hotel`, `Resort`, `Motel`, etc. |
| Place action links empty for a hotel | No CTAs configured | Set them up in the GBP UI or via the Place Actions API (manual) |
| Reviews call works but v1 calls 403 | One of the v1 sub-APIs is not enabled in Cloud Console | Re-check the API enable list above |
| Keyword impressions mostly `threshold` instead of `value` | Low-volume keywords are privacy-redacted by Google | Expected — surfaced as `thresholdedKeywordPct` in the summary |

## Related Files in This Skill

- `references/canonry-cli.md` — full CLI command reference
- `references/aeo-analysis.md` — interpretation patterns for citation and visibility data

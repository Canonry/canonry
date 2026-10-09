# Google Analytics 4 Setup

Canonry integrates with Google Analytics 4 (GA4) via a **service account** — no OAuth redirect flow required. You grant a service account read-only access to your GA4 property once, and canonry handles the rest.

You can complete the setup via the **web dashboard** or the **CLI** — both are documented below.

---

## Prerequisites

- A Google Cloud project (the same one you use for Google Search Console is fine)
- Admin access to your GA4 property
- The **Google Analytics Data API** enabled in your GCP project

---

## Step 1 — Enable the Google Analytics Data API

This is the most commonly missed step. The GA4 Data API must be explicitly enabled in your GCP project.

1. Open [Google Cloud Console](https://console.cloud.google.com) and select your project
2. Navigate to **APIs & Services → Library**
3. Search for **Google Analytics Data API**
4. Click **Enable**

Or go directly:
```
https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=YOUR_PROJECT_ID
```

> **Note:** If you skip this step, connecting will fail with a `SERVICE_DISABLED` error even if your service account credentials are correct and the account has GA4 property access.

---

## Step 2 — Create a Service Account

1. In Google Cloud Console: **IAM & Admin → Service Accounts → Create Service Account**
2. Name it anything (e.g. `canonry-ga4`)
3. **Skip** the optional GCP role grant — GA4 access is set in GA itself, not here
4. Click **Done**
5. Open the service account → **Keys → Add Key → Create new key → JSON**
6. Download the `.json` key file

---

## Step 3 — Grant Property Access in GA4

The service account needs **Viewer** (or higher) access to your GA4 property.

1. Go to [Google Analytics](https://analytics.google.com)
2. Admin → **Property Access Management** (in the Property column)
3. Click **+** → **Add users**
4. Enter the service account email (e.g. `canonry-ga4@your-project.iam.gserviceaccount.com`)
5. Role: **Viewer** → Save

> Access propagates within a few seconds to a minute.

---

## Step 4 — Find Your GA4 Property ID

1. GA4 Admin → **Property Settings**
2. Copy the **Property ID** (a plain number, e.g. `123456789`)

> This is **not** the Measurement ID (which starts with `G-`).

---

## Step 5 — Connect via Canonry

### Web UI

1. Navigate to your project → **Traffic** tab
2. Enter your **GA4 Property ID** (the numeric ID from Step 4)
3. Click **Upload .json key file** and select the service account key file you downloaded in Step 2
4. Click **Connect GA4**

Canonry verifies the credentials by making a test API call. On success, the page refreshes to show your traffic data.

### CLI

```bash
canonry ga connect <project> --property-id <id> --key-file ./canonry-ga4.json
```

Example:
```bash
canonry ga connect ainyc --property-id 527609434 --key-file ./canonry-ga4.json
```

Canonry will verify the credentials by making a test API call. On success:
```
GA4 connected for project "ainyc" (property 527609434).
```

---

## Usage

### Web UI

The **Traffic** tab on each project page provides:

- **Connection status** — shows the connected property ID and service account email
- **Traffic overview** — total sessions, organic sessions, and total users
- **Top landing pages table** — sortable by sessions, organic sessions, users, and organic percentage
- **Google organic search traffic**: GA4's "Google organic search traffic: Landing page + query string" report (clicks, impressions, CTR, average position and active users per landing page, with GA4's own Total row) for the last 7, 28 or 90 days. Needs the property's Search Console link; see [Search Console landing pages](#search-console-landing-pages).
- **Sync** — pull the latest traffic data from GA4
- **Disconnect** — remove the GA4 connection and purge stored traffic data

### CLI

```bash
# Sync last 30 days of traffic data
canonry ga sync ainyc

# Show top landing pages by sessions
canonry ga traffic ainyc

# Show landing page coverage with index + citation overlay
canonry ga coverage ainyc

# GA4's Search Console landing-page report (7d, 28d or 90d; 28d is GA4's default)
canonry ga search-landing-pages my-project --window 28d

# Refresh only that report
canonry ga sync my-project --only search-landing

# Connection status
canonry ga status ainyc

# Disconnect
canonry ga disconnect ainyc
```

### Search Console landing pages

`canonry ga search-landing-pages` and the dashboard's **Google organic search traffic** table show GA4's own "Google organic search traffic: Landing page + query string" report (Reports, Library, Search Console collection). GA4 only has these figures once the property is linked to Search Console:

1. In GA4, open **Admin, Product links, Search Console links** and link the Search Console property for the site, choosing the web data stream.
2. Run `canonry ga sync <project>` (or `--only search-landing`). Every GA sync, including a scheduled data refresh, refreshes the report.

What to expect:

- Each window (7, 28 or 90 days) ends **yesterday in the GA4 property's time zone**, exactly like GA4's own "Last N days" ranges, so the 28-day window matches the report GA4 opens on.
- The **Total** row is GA4's own total for every page, not a sum of the rows listed.
- **Active users** is GA4's plain Active users metric from the same report, which is what GA4 shows in this column (it is not limited to Google organic sessions).
- Search Console data reaches GA4 about **48 hours late**, so the last days of each window are thin, the same as in GA4.
- These figures come through GA4's Search Console link, so they can differ from Canonry's own Search Console sync (`canonry google performance`) for the same days.
- At most 10,000 landing pages are stored per window, the ones with the most clicks, then impressions; the read says when GA4 reported more.

---

## Troubleshooting

### Google organic search traffic reads `unavailable`

GA4 refused the Search Console metrics for the property, which is what a property **without a Search Console link** is expected to do (the exact response from an unlinked property has not been captured yet). Google's message is shown with the status. Link Search Console as described in [Search Console landing pages](#search-console-landing-pages), then run `canonry ga sync <project> --only search-landing`. A failed or refused refresh never fails the GA sync and keeps the last good snapshot of the same GA4 property, which still shows its own dates. A snapshot from a property the project was connected to before is never shown: `canonry ga connect` with a different property drops it, and until the next sync the report reads as never synced.

### `GA4 API authentication failed — The Google Analytics Data API is not enabled`

The API is disabled in your GCP project. Enable it at:
```
https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=YOUR_PROJECT_ID
```

### `GA4 API authentication failed — check service account permissions`

Either:
- The service account hasn't been added to the GA4 property (Step 3)
- The wrong property ID was used (Step 4)
- Access hasn't propagated yet — wait 1–2 minutes and retry

### `Failed to get access token`

The JSON key file is invalid or the private key is corrupted. Download a fresh key from the GCP service account console.

### `JSON file is missing required fields: client_email and private_key`

You uploaded the wrong type of credential file. Make sure you downloaded a **service account key** (IAM & Admin → Service Accounts → Keys), not an OAuth client JSON.

### `No GA4 connection found`

You haven't connected GA4 to this project yet.

**UI:** Navigate to the **Traffic** tab and use the connect form.

**CLI:** Run `canonry ga connect` with your property ID and key file.

# Google Analytics 4 Setup

Canonry integrates with Google Analytics 4 (GA4) via a **service account** — no OAuth redirect flow required. You grant a service account read-only access to your GA4 property once, and canonry handles the rest.

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

> **Note:** If you skip this step, `canonry ga connect` will fail with a `SERVICE_DISABLED` error even if your service account credentials are correct and the account has GA4 property access.

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

```bash
# Sync last 30 days of traffic data
canonry ga sync ainyc

# Show top landing pages by sessions
canonry ga traffic ainyc

# Show landing page coverage with index + citation overlay
canonry ga coverage ainyc

# Connection status
canonry ga status ainyc

# Disconnect
canonry ga disconnect ainyc
```

---

## Troubleshooting

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

### `No GA4 connection found`

Run `canonry ga connect` first before `sync`, `traffic`, or `coverage`.

# Google Search Console Setup

Canonry integrates with Google Search Console (GSC) via **OAuth 2.0** to pull search performance data, inspect URL indexing status, and submit pages for indexing. This is separate from the GA4 integration (which uses a service account).

You can complete the entire setup via the **web dashboard** or the **CLI** — both are documented below.

---

## Prerequisites

- A Google Cloud project
- A site verified in [Google Search Console](https://search.google.com/search-console)
- The **Search Console API** and **Web Search Indexing API** enabled in your GCP project

---

## Step 1 — Enable the Required APIs

Two APIs are needed:

1. **Search Console API** — for search analytics, URL inspection, and coverage data
2. **Web Search Indexing API** — for submitting URLs for indexing

In Google Cloud Console:

1. Navigate to **APIs & Services → Library**
2. Search for **Google Search Console API** → click **Enable**
3. Search for **Web Search Indexing API** → click **Enable**

Or go directly:
```
https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=YOUR_PROJECT_ID
https://console.developers.google.com/apis/api/indexing.googleapis.com/overview?project=YOUR_PROJECT_ID
```

> **Note:** The Indexing API is only required if you plan to use the request-indexing feature. All other GSC features work with just the Search Console API.

---

## Step 2 — Create OAuth Client Credentials

1. In Google Cloud Console: **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Name: anything (e.g. `canonry`)
4. Under **Authorized redirect URIs**, add the callback URL(s) — see below
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**

> If you haven't configured the OAuth consent screen yet, Google will prompt you. For personal use, set it to **External** with **Testing** status and add your Google account as a test user.

### Which redirect URIs to register

Canonry has two callback paths depending on your setup:

**Option A — Shared callback (recommended).** If you configure a `publicUrl` in your canonry server config or pass `--public-url` when connecting, canonry uses a single shared callback for all projects:

```
http://localhost:4100/api/v1/google/callback
```

Register this one URI and you're done. For a custom host, replace `localhost:4100` with your server address.

**Option B — Per-project callbacks (auto-detect fallback).** If no `publicUrl` is configured, canonry generates a per-project redirect URI based on the request headers:

```
http://localhost:4100/api/v1/projects/<project-name>/google/callback
```

This means you'd need to register a separate redirect URI for **each project** you connect. To avoid this, use Option A by setting a public URL (see Step 3 below).

> **Tip:** If Google rejects the connection with a `redirect_uri_mismatch` error, the error page shows the exact URI to add to your OAuth client's authorized redirect URIs.

---

## Step 3 — Configure Canonry with OAuth Credentials

This is a one-time setup that tells canonry your Google OAuth app credentials. You need to do this before connecting any project to GSC.

### Web UI

1. Go to **Settings** (gear icon in the sidebar)
2. Find the **Google Search Console** card
3. Enter your **Client ID** and **Client Secret**
4. Click **Configure Google OAuth** (or **Update OAuth app** if already configured)

The card shows "Ready" when credentials are saved.

### CLI

**During `canonry init`:**
```bash
canonry init --google-client-id <CLIENT_ID> --google-client-secret <CLIENT_SECRET>
```

**After initial setup:**
```bash
canonry settings google --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
```

**Environment variables (CI/Docker):**
```bash
export GOOGLE_CLIENT_ID=your-client-id
export GOOGLE_CLIENT_SECRET=your-client-secret
canonry bootstrap
```

---

## Step 4 — Connect GSC to a Project

### Web UI

1. Navigate to your project → **Search Console** tab
2. Click **Connect to Google Search Console**
3. A popup opens with the Google OAuth consent screen
4. Sign in and grant access
5. The popup closes automatically and the page refreshes with your connection status

> If the popup is blocked by your browser, canonry falls back to a full-page redirect. Allow popups for your canonry server URL for the smoothest experience.

### CLI

```bash
canonry google connect <project>
```

This opens your browser to the Google OAuth consent screen. After granting access, canonry stores the tokens and you're ready to go.

If running canonry on a remote server with a different public URL:
```bash
canonry google connect <project> --public-url https://your-server.com
```

---

## Step 5 — Set Your GSC Property

After connecting, tell canonry which Search Console property to use.

### Web UI

1. On the **Search Console** tab, a property selector dropdown appears after connecting
2. Select your property from the list
3. Canonry saves the selection immediately

### CLI

```bash
# List available properties
canonry google properties <project>

# Set the one you want
canonry google set-property <project> https://example.com/
```

> Properties in GSC are typically `https://example.com/` (URL prefix) or `sc-domain:example.com` (domain property). Use whichever matches your verified property.

---

## Step 6 — Configure Sitemaps (Optional)

### Web UI

On the **Search Console** tab, enter your sitemap URL in the sitemap input field.

### CLI

```bash
# Auto-discover from GSC + robots.txt
canonry google discover-sitemaps <project> --wait

# Or set manually
canonry google set-sitemap <project> https://example.com/sitemap.xml

# List configured sitemaps
canonry google list-sitemaps <project>
```

---

## Usage

### Web UI

The **Search Console** tab on each project page provides:

- **Connection status** — shows whether GSC is connected and which property is selected
- **Search performance table** — date, query, page, clicks, impressions, CTR, and position
- **Index coverage summary** — breakdown of indexed, not indexed, and deindexed pages
- **URL inspection** — inspect individual URLs and view inspection history
- **Request indexing** — submit URLs to Google directly from the UI

### CLI

```bash
# Sync search analytics data (default: last 28 days)
canonry google sync <project>
canonry google sync <project> --days 90 --full --wait

# Search performance data
canonry google performance <project>
canonry google performance <project> --days 30 --keyword "best widgets"

# Index coverage summary
canonry google coverage <project>
canonry google coverage-history <project>

# Inspect a specific URL
canonry google inspect <project> https://example.com/page

# Bulk inspect all sitemap URLs
canonry google inspect-sitemap <project> --wait

# View inspection history
canonry google inspections <project>
canonry google inspections <project> --url https://example.com/page

# Find deindexed pages
canonry google deindexed <project>

# Submit URLs for indexing
canonry google request-indexing <project> https://example.com/new-page
canonry google request-indexing <project> --all-unindexed

# Connection management
canonry google status <project>
canonry google disconnect <project>
```

---

## Troubleshooting

### `Google connection is incomplete — please reconnect`

The OAuth tokens are missing or expired beyond recovery.

**UI:** On the Search Console tab, click **Disconnect**, then **Connect to Google Search Console** again.

**CLI:**
```bash
canonry google disconnect <project>
canonry google connect <project>
```

### `redirect_uri_mismatch` error during OAuth

Google rejected the callback because the redirect URI isn't registered. The error page shows the exact URI that was used.

**Fix:** Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), click your OAuth client, and add the URI shown in the error to **Authorized redirect URIs**.

### `Token exchange failed (400)`

The OAuth callback failed. Common causes:
- The redirect URI in your Google Cloud Console doesn't match the canonry server URL
- The authorization code expired (they're single-use and expire in minutes)
- Try connecting again — the code is generated fresh each time

### `Search Console API not enabled`

Enable it at:
```
https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=YOUR_PROJECT_ID
```

### `Indexing API returned 403`

Either:
- The Web Search Indexing API isn't enabled in your GCP project
- The OAuth scopes don't include indexing — disconnect and reconnect to re-authorize

### `No properties found`

Your Google account doesn't have any verified properties in Search Console, or you authorized with the wrong account. Verify your site at [Google Search Console](https://search.google.com/search-console).

### `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set`

Both values are required.

**UI:** Go to **Settings** and check the Google Search Console card — fill in both fields.

**CLI:**
```bash
canonry settings google --client-id <ID> --client-secret <SECRET>
```

### Popup blocked during OAuth (UI)

Some browsers block the OAuth popup. Either:
- Allow popups for your canonry server URL and try again
- Canonry will automatically fall back to a full-page redirect if the popup can't open

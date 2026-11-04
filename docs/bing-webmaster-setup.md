# Bing Webmaster Tools Setup

Canonry connects to Bing Webmaster Tools (WMT) with an API key. It pulls URL coverage, indexing status, search performance, crawl stats, sitemaps, site settings and keyword search volume, and it submits pages for indexing.

You can complete the entire setup via the **web dashboard** or the **CLI** — both are documented below.

---

## Prerequisites

- A [Bing Webmaster Tools](https://www.bing.com/webmasters/) account
- Your site verified in Bing WMT
- An API key from your Bing WMT account

---

## Step 1 — Verify Your Site in Bing Webmaster Tools

If your site isn't already verified:

1. Go to [Bing Webmaster Tools](https://www.bing.com/webmasters/)
2. Sign in with your Microsoft account
3. Click **Add a Site** and enter your domain
4. Choose a verification method:
   - **Auto-verify via Google Search Console** (fastest — imports your GSC-verified sites)
   - **CNAME record** — add a DNS record
   - **XML file** — upload a verification file to your site root
   - **Meta tag** — add a meta tag to your homepage
5. Complete verification

> **Tip:** If you've already verified your site in Google Search Console, Bing can import it automatically — this is the fastest path.

---

## Step 2 — Get Your API Key

1. In Bing Webmaster Tools, click the **gear icon** (Settings) in the top navigation
2. Go to **API Access**
3. Copy the **API Key**

The API key grants access to all sites verified under your Bing WMT account.

---

## Step 3 — Configure the API Key in Canonry

This is a one-time setup that stores your Bing API key so canonry can authenticate with the Bing WMT API.

### Web UI

1. Go to **Settings** (gear icon in the sidebar)
2. Find the **Bing Webmaster Tools** card
3. Enter your **API Key**
4. Click **Configure Bing** (or **Update API key** if already configured)

The card shows "Ready" when the key is saved.

### CLI

```bash
canonry bing connect <project> --api-key <YOUR_API_KEY>
```

If you omit `--api-key`, canonry will prompt you for it interactively.

---

## Step 4 — Connect Bing to a Project and Set Your Site

### Web UI

1. Navigate to your project page
2. The Bing integration section shows your connection status
3. If connected, select your site from the dropdown of verified sites
4. Canonry saves the selection and begins pulling coverage data

### CLI

```bash
# Connect (if not done in Step 3)
canonry bing connect <project> --api-key <YOUR_API_KEY>

# List all verified sites
canonry bing sites <project>

# Set the one you want
canonry bing set-site <project> https://example.com/
```

> The site URL must exactly match what's verified in Bing WMT (including trailing slash if present).

---

## Usage

### Web UI

The project page shows Bing Webmaster data including:

- **Connection status** — whether Bing is connected and which site is selected
- **Coverage summary** — percentage indexed, with breakdown of indexed / not indexed / unknown URLs
- **Last inspection timestamp**
- **URL inspection** — inspect individual URLs from the project page

### CLI

```bash
# Connection status
canonry bing status <project>

# URL coverage summary (indexed / not indexed / unknown)
canonry bing coverage <project>

# Stored query rows, one per query per week (impressions, clicks, CTR)
canonry bing performance <project>

# Inspect a specific URL
canonry bing inspect <project> https://example.com/page

# View all inspected URLs
canonry bing inspections <project>

# Submit a single URL for indexing
canonry bing request-indexing <project> https://example.com/new-page

# Submit all unindexed URLs
canonry bing request-indexing <project> --all-unindexed

# Disconnect
canonry bing disconnect <project>
```

### Stored Bing data

`canonry bing sync <project>` reads every data method Bing's API has and stores the results. The daily `data-refresh` schedule runs it for every connected project, so most operators never run it by hand.

| Read | What it holds | Source method |
|------|---------------|---------------|
| `canonry bing traffic` | Daily site clicks and impressions. This is the Bing site total. | `GetRankAndTrafficStats` |
| `canonry bing queries` | Clicks, impressions and position per query, one row per week | `GetQueryStats` |
| `canonry bing pages` | The same per page URL | `GetPageStats` |
| `canonry bing crawl-stats` | Daily Bingbot crawl counts, HTTP status counts, robots.txt blocks, pages in index | `GetCrawlStats` |
| `canonry bing sitemaps` | Sitemaps Bing has, with status, URL count and last crawl; child sitemaps under their index | `GetFeeds`, `GetFeedDetails` |
| `canonry bing submit-sitemap` | Ask Bing to read a sitemap: adds a new one, rereads a listed one. It shows in the list after the next sync | `SubmitFeed` |
| `canonry bing site` | URL and content submission quotas left, crawl settings, crawl issues, blocked URLs, page preview blocks, sitelink blocks, URL parameters, geo-targeting, Fetch as Bingbot history, connected pages, user roles | 12 `Get*` settings methods |
| `canonry bing keyword-demand` | Weekly Bing search volume for each tracked query, in the project's country and language | `GetKeywordStats` |

Bing only keeps about six months of history. Canonry keeps every day and week it has read, so history builds up beyond Bing's window from the first sync.

The sync paces its calls through the same per-account limit as the URL inspection sweep: one request start every two seconds per Bing API key. If Bing still throttles after the client's retries, the sync stops early and marks the run `partial` rather than holding the account limit open. Connected pages and user roles need the site owner's key. With a delegated key, they are stored as `unauthorized`, which does not count as a failure.

### Live reads

These ask Bing directly each time they run:

```bash
canonry bing query-pages <project> "<query>"          # pages that showed for a query, per week
canonry bing page-queries <project> <page-url>        # queries a page showed for, per week
canonry bing query-history <project> "<query>"        # one query per day (add --page <url> for weekly rows with position)
canonry bing url-traffic <project> <url> --children   # clicks and impressions for a URL and the URLs under it
canonry bing url-children <project> <url>             # index details for the URLs under a directory
canonry bing links <project> [--url <page-url>]       # inbound links (Bing often returns none for smaller sites)
canonry bing fetched-urls <project>                   # Fetch as Bingbot history
canonry bing keywords <project> "<keyword>"           # any keyword's Bing volume, weekly history and related keywords
```

### What Bing's API does not expose

The **AI Performance** report in Bing Webmaster Tools is not in Bing's API. That includes Copilot citations, grounding queries, intents, citation share and Topics Portfolio. Canonry cannot read it until Microsoft adds it.

---

## IndexNow (Optional)

IndexNow sends an instant crawl signal to Bing: "these URLs changed, re-crawl them now." Without it, Bing discovers pages on its own schedule (days to weeks). With IndexNow, typically hours.

### Setup

1. Generate a key (any unique string, e.g. a UUID)
2. Host a key file at your site root:
   ```
   https://example.com/<key>.txt
   ```
   File content: just the key string, nothing else.

3. Submit URLs:
   ```bash
   curl -X POST "https://www.bing.com/indexnow" \
     -H "Content-Type: application/json; charset=utf-8" \
     -d '{
       "host": "example.com",
       "key": "<key>",
       "keyLocation": "https://example.com/<key>.txt",
       "urlList": [
         "https://example.com/",
         "https://example.com/page-1"
       ]
     }'
   ```

Expected response: `202 Accepted`

> **Note:** IndexNow only covers Bing (and Yandex). It does NOT affect Google, ChatGPT, Claude, or Gemini.

---

## Submission Limits

Bing WMT enforces these limits on URL submissions via the API:

- **Batch limit:** 500 URLs per request
- **Daily limit:** set per site by Bing, and usually far below the documented 10,000. A site often gets 100 a day.

`canonry bing request-indexing` reads the site's remaining quota (`GetUrlSubmissionQuota`) before it submits anything. It sends only what Bing will accept. The other URLs come back as per-URL errors that give the reason, and the response includes `quota`. To check the quota at any time, run `canonry bing site <project> --kind url-submission-quota`.

---

## Troubleshooting

### `No Bing connection found`

You haven't connected Bing to this project yet.

**UI:** Go to **Settings** and enter your Bing API key, then return to the project page.

**CLI:**
```bash
canonry bing connect <project> --api-key <key>
```

### `Bing API returned 401 Unauthorized`

Your API key is invalid or expired. Get a fresh key from Bing WMT → Settings → API Access.

**UI:** Go to **Settings**, update the API key in the Bing Webmaster Tools card.

**CLI:**
```bash
canonry bing disconnect <project>
canonry bing connect <project> --api-key <NEW_KEY>
```

### `No site URL configured`

After connecting, you must select which site to use.

**UI:** On the project page, select your site from the Bing site dropdown.

**CLI:**
```bash
canonry bing sites <project>           # see available sites
canonry bing set-site <project> <url>  # set the active site
```

### `Site not found` or empty sites list

Your site may not be verified in Bing WMT, or the API key belongs to a different account. Check at [Bing Webmaster Tools](https://www.bing.com/webmasters/).

### Coverage shows mostly "Unknown"

This is normal for first-time setup. Bing hasn't inspected most URLs yet. Run inspections to populate coverage data:

**UI:** Use the URL inspection feature on the project page to inspect key URLs.

**CLI:**
```bash
canonry bing inspect <project> https://example.com/important-page
```

Or submit URLs for indexing to prompt Bing to crawl them:
```bash
canonry bing request-indexing <project> --all-unindexed
```

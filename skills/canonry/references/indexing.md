# Indexing Workflows for AEO

Getting pages indexed fast is high-leverage AEO work. Unindexed pages are invisible to AI citation regardless of content quality.

## Priority Order

1. **Google Indexing API** — fastest path to ChatGPT/Perplexity visibility (they lean on Google)
2. **Bing WMT + IndexNow** — fastest path to Copilot/Bing AI visibility
3. **Sitemap submission** — baseline for both; do once on setup

---

## Google Search Console

### Check coverage
```bash
cnry google coverage <project>
```

Statuses to act on:
- `URL is unknown to Google` → highest priority, submit immediately
- `Discovered - currently not indexed` → Google found it but hasn't crawled — submit to accelerate
- `indexed` → no action needed

### Sync GSC data
```bash
cnry google sync <project>                    # incremental sync
cnry google sync <project> --full --wait      # full re-sync
```

### Check search performance
```bash
cnry google performance <project>                        # default 28 days
cnry google performance <project> --days 90 --keyword "term"
```

### Discover and inspect sitemaps
```bash
cnry google discover-sitemaps <project> --wait   # auto-discover sitemaps and queue inspection
cnry google list-sitemaps <project>               # list submitted sitemaps
cnry google inspect-sitemap <project> --wait      # bulk inspect all sitemap URLs
```

### Inspect individual URLs
```bash
cnry google inspect <project> <url>              # inspect specific URL
cnry google inspections <project>                # inspection history
cnry google inspections <project> --url <url>    # filter by URL
cnry google deindexed <project>                  # pages that lost indexing
```

### Submit URLs to Google Indexing API
```bash
# Single URL
cnry google request-indexing <project> <url>

# All unindexed at once
cnry google request-indexing <project> --all-unindexed
```

**Requirements:**
- "Web Search Indexing API" enabled in the GCP project
- OAuth connection set up in canonry (`cnry settings` shows Google connection)
- Officially intended for JobPosting/BroadcastEvent schema; in practice Google processes all URLs

**After submitting:** Check coverage again after 48h. Once indexed, run a sweep — pages must be indexed before citation is possible.

---

## Bing Webmaster Tools

### One-time setup
```bash
cnry bing connect <project> --api-key <key>
cnry bing set-site <project> https://example.com/
```

Get API key from: https://www.bing.com/webmasters/ → Settings → API Access

### Check connection and coverage
```bash
cnry bing status <project>
cnry bing coverage <project>
cnry bing performance <project>
```

### Inspect URLs
```bash
cnry bing inspect <project> <url>
cnry bing inspections <project>
```

### Inspect every URL in your sitemap
```bash
cnry bing inspect-sitemap <project>                       # default https://<domain>/sitemap.xml
cnry bing inspect-sitemap <project> --sitemap-url <url>   # explicit sitemap or sitemap index
cnry bing inspect-sitemap <project> --wait                # block until the run finishes
```
Bing has no native sitemap inspection API — this command fetches the sitemap, diffs against the tracked URL set, then calls `GetUrlInfo` for each discovered URL so coverage reflects the full sitemap rather than only previously inspected pages.

### Submit URLs for indexing
```bash
cnry bing request-indexing <project> <url>
cnry bing request-indexing <project> --all-unindexed
```

### Submit sitemap (manual, one-time)
Bing WMT → Sitemaps → submit `https://example.com/sitemap.xml`

### IndexNow (instant crawl signal)
IndexNow is a direct ping to Bing: "these URLs changed, crawl them now." Without it, Bing discovers pages on its own schedule (days to weeks). With it, typically hours.

**Host the key file at the root:**
```
https://example.com/<key>.txt
```
File content: just the key string, nothing else.

**Submit URLs:**
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

**Note:** IndexNow only covers Bing (and Yandex). It does NOT affect ChatGPT, Claude, or Gemini.

---

## When to Use What

| Goal | Tool |
|---|---|
| Get pages into ChatGPT / Perplexity / Claude | Google Indexing API |
| Get pages into Copilot / Bing AI | IndexNow + Bing WMT |
| Audit what Google currently knows | `cnry google coverage <project>` |
| Audit what Bing currently knows | `cnry bing coverage <project>` |
| Fast crawl of new/updated pages on Bing | IndexNow batch submit |
| Ongoing Google crawl health | `cnry google sync` + `cnry google performance` |
| Ongoing Bing crawl health | Bing WMT sitemap + `cnry bing performance` |
| Find deindexed pages | `cnry google deindexed <project>` |

---

## General Workflow for New Client Pages

1. `cnry google coverage <project>` — identify unindexed pages
2. `cnry google request-indexing <project> --all-unindexed` — push to Google
3. `cnry bing request-indexing <project> --all-unindexed` — push to Bing
4. Submit sitemap to Bing WMT (manual, one-time per site)
5. Send IndexNow batch for key URLs
6. Re-check coverage after 48h
7. Run a sweep after pages confirmed indexed

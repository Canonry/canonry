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
canonry google coverage <project>
```

Statuses to act on:
- `URL is unknown to Google` → highest priority, submit immediately
- `Discovered - currently not indexed` → Google found it but hasn't crawled — submit to accelerate
- `indexed` → no action needed

### Sync GSC data
```bash
canonry google sync <project>                    # incremental sync
canonry google sync <project> --full --wait      # full re-sync
```

### Check search performance
```bash
canonry google performance <project>                        # default 28 days
canonry google performance <project> --days 90 --keyword "term"
```

### Discover and inspect sitemaps
```bash
canonry google discover-sitemaps <project> --wait   # auto-discover sitemaps and queue inspection
canonry google list-sitemaps <project>               # list submitted sitemaps
canonry google inspect-sitemap <project> --wait      # bulk inspect all sitemap URLs
```

### Inspect individual URLs
```bash
canonry google inspect <project> <url>              # inspect specific URL
canonry google inspections <project>                # inspection history
canonry google inspections <project> --url <url>    # filter by URL
canonry google deindexed <project>                  # pages that lost indexing
```

### Submit URLs to Google Indexing API
```bash
# Single URL
canonry google request-indexing <project> <url>

# All unindexed at once
canonry google request-indexing <project> --all-unindexed
```

**Requirements:**
- "Web Search Indexing API" enabled in the GCP project
- OAuth connection set up in canonry (`canonry settings` shows Google connection)
- Officially intended for JobPosting/BroadcastEvent schema; in practice Google processes all URLs

**After submitting:** Check coverage again after 48h. Once indexed, run a sweep — pages must be indexed before citation is possible.

---

## Bing Webmaster Tools

### One-time setup
```bash
canonry bing connect <project> --api-key <key>
canonry bing set-site <project> https://example.com/
```

Get API key from: https://www.bing.com/webmasters/ → Settings → API Access

### Check connection and coverage
```bash
canonry bing status <project>
canonry bing coverage <project>
canonry bing performance <project>
```

### Inspect URLs
```bash
canonry bing inspect <project> <url>
canonry bing inspections <project>
```

### Inspect every URL in your sitemap
```bash
canonry bing inspect-sitemap <project>                       # default https://<domain>/sitemap.xml
canonry bing inspect-sitemap <project> --sitemap-url <url>   # explicit sitemap or sitemap index
canonry bing inspect-sitemap <project> --wait                # block until the run finishes
```
Bing has no native sitemap inspection API — this command fetches the sitemap, diffs against the tracked URL set, then calls `GetUrlInfo` for each discovered URL so coverage reflects the full sitemap rather than only previously inspected pages.

### Submit URLs for indexing
```bash
canonry bing request-indexing <project> <url>
canonry bing request-indexing <project> --all-unindexed
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
| Audit what Google currently knows | `canonry google coverage <project>` |
| Audit what Bing currently knows | `canonry bing coverage <project>` |
| Fast crawl of new/updated pages on Bing | IndexNow batch submit |
| Ongoing Google crawl health | `canonry google sync` + `canonry google performance` |
| Ongoing Bing crawl health | Bing WMT sitemap + `canonry bing performance` |
| Find deindexed pages | `canonry google deindexed <project>` |

---

## General Workflow for New Client Pages

1. `canonry google coverage <project>` — identify unindexed pages
2. `canonry google request-indexing <project> --all-unindexed` — push to Google
3. `canonry bing request-indexing <project> --all-unindexed` — push to Bing
4. Submit sitemap to Bing WMT (manual, one-time per site)
5. Send IndexNow batch for key URLs
6. Re-check coverage after 48h
7. Run a sweep after pages confirmed indexed

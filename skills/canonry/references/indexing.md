# Indexing Workflows for AEO

Getting pages indexed fast is high-leverage AEO work. Unindexed pages = invisible to AI citation regardless of how good the content is.

## Priority Order

1. **Google Indexing API** — fastest path to ChatGPT/Perplexity visibility (they lean on Google)
2. **Bing WMT + IndexNow** — fastest path to Copilot/Bing AI visibility
3. **Sitemap submission** — baseline for both; do this once on setup

---

## Google Search Console

### Check coverage
```bash
canonry google coverage <project>
```

Statuses to act on:
- `URL is unknown to Google` → highest priority, submit immediately
- `Discovered - currently not indexed` → Google found it but hasn't crawled — can also submit
- `indexed` → no action needed

### Submit URLs to Google Indexing API
```bash
# Single URL
canonry google request-indexing <project> <url>

# All unindexed URLs at once
canonry google request-indexing <project> --all-unindexed
```

**Requirements:**
- "Web Search Indexing API" must be enabled in the GCP project
- OAuth connection must be set up in canonry (`canonry settings` shows Google connection)
- Officially for JobPosting/BroadcastEvent schema pages; in practice Google processes all URLs
- Results visible in GSC within 24–72h

**After submitting:** Check coverage again after 48h. Once indexed, run a sweep — pages need to be indexed before citation is possible.

---

## Bing Webmaster Tools

### One-time setup
```bash
canonry bing connect <project> --api-key <key>
canonry bing set-site <project> https://example.com/
```

Get API key from: https://www.bing.com/webmasters/ → Settings → API Access

### Check connection
```bash
canonry bing status <project>
```

`verified: false` in the API response is sometimes a false negative — check the WMT dashboard directly. If the site dashboard loads, it's verified.

### Submit sitemap (manual, one-time)
Go to Bing WMT → Sitemaps → submit `https://example.com/sitemap.xml`

### IndexNow (instant crawl signal)
IndexNow is a direct ping to Bing: "these URLs changed, crawl them now." Without it, Bing discovers pages on its own schedule (days to weeks). With it, typically hours.

**The key file must be hosted at the root:**
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
      "https://example.com/page-1",
      "https://example.com/page-2"
    ]
  }'
```

Expected response: `202 Accepted`

**Note:** IndexNow only covers Bing (and Yandex). It does NOT affect ChatGPT, Claude, or Gemini.

### Check Bing coverage
```bash
canonry bing coverage <project>
```
Requires verified site + 24–48h for data to populate.

---

## When to Use What

| Goal | Tool |
|---|---|
| Get pages into ChatGPT/Perplexity/Claude | Google Indexing API |
| Get pages into Copilot/Bing AI | IndexNow + Bing WMT |
| Audit what Google currently knows | `canonry google coverage` |
| Fast crawl of new/updated pages on Bing | IndexNow batch submit |
| Ongoing Bing crawl health | Bing WMT sitemap + coverage |

---

## ainyc.ai Indexing State (as of 2026-03-18)

- **Google indexed:** 5/19 pages (26.3%)
- **Unindexed:** 14 pages — all submitted via Google Indexing API on 2026-03-17 and 2026-03-18
- **Bing:** Connected, sitemap submitted, IndexNow fired for 5 key URLs
- **IndexNow key:** `fa4af6b46e7a4c0ba9f61ea76e9a0c48` (live at `/fa4af6b46e7a4c0ba9f61ea76e9a0c48.txt`)
- **Next check:** 2026-03-20 — rerun `canonry google coverage ainyc` to confirm pages moved to indexed

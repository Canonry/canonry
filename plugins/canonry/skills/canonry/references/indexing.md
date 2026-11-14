# Indexing Workflows for AEO

Use stored inspection evidence to find search indexing gaps. Google and Bing inspection results describe their own indexes.

Obtain approval for the exact site, URLs, and action before starting a live inspection, sync, crawl request, or sitemap submission.

## Priority Order

1. **Sitemap submission** — general-site discovery signal; submit on setup and resubmit after material sitemap changes
2. **Bing WMT + IndexNow** — crawl notification path for Bing-backed surfaces
3. **Google Indexing API** — only for eligible JobPosting and livestream BroadcastEvent pages

---

## Google Search Console

### Check coverage
```bash
cnry google coverage <project>
```

Statuses to act on:
- `URL is unknown to Google` → check that the sitemap lists the URL and that Google can access the page.
- `Discovered - currently not indexed` → review crawl access, internal links, and the sitemap.
- `indexed` → the inspection confirms indexing for that URL.

### Sync GSC data
```bash
cnry google sync <project>                    # incremental sync
cnry google sync <project> --full --wait      # full re-sync
```

### Check search performance
```bash
cnry google performance <project>                        # top rows by clicks
cnry google performance <project> --days 90 --keyword "term"
cnry google performance <project> --start 2026-06-01 --end 2026-06-30 --order-by date
cnry google query-totals <project> --window 30d        # one row per named query (not a property total)
```

### Discover and inspect sitemaps
```bash
cnry google discover-sitemaps <project> --wait   # select a submitted GSC sitemap and queue inspection
cnry google list-sitemaps <project>               # list submitted sitemaps
cnry google inspect-sitemap <project> --wait      # bulk inspect all sitemap URLs
```

### Submit or resubmit sitemaps
```bash
cnry google submit-sitemap <project> https://example.com/sitemap.xml
cnry google submit-sitemap <project> --configured  # Canonry's saved default
cnry google submit-sitemap <project> --all         # prefer sitemap indexes (fallback: top-level files)
cnry google submit-sitemap <project> --all-files   # include top-level files and index children (batched by 50)
```

An accepted submission asks Google to refetch the sitemap; it does not guarantee
that any URL will be indexed. Existing read-only GSC connections must reconnect
once to grant the full `webmasters` scope required for sitemap submission.

### Inspect individual URLs
```bash
cnry google inspect <project> <url>              # inspect specific URL
cnry google inspections <project>                # inspection history
cnry google inspections <project> --url <url>    # filter by URL
cnry google deindexed <project>                  # pages that lost indexing
```

### Submit URLs to Google Indexing API
```bash
# An eligible URL
cnry google request-indexing <project> <url>
```

**Requirements:**
- "Web Search Indexing API" enabled in the GCP project
- OAuth connection set up in canonry (`cnry settings` shows Google connection)
- The URL has eligible `JobPosting` or livestream `BroadcastEvent` structured data

The bulk `--all-unindexed` flag uses stored inspection results on the project domain. If every selected URL qualifies, you can use the bulk command. Check coverage again after submission.

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

### Submit or resubmit a sitemap

```bash
cnry bing submit-sitemap <project> https://example.com/sitemap.xml
```

An accepted submission asks Bing to read the sitemap. The stored sitemap list updates after Bing reads it and Canonry syncs again.

### IndexNow
IndexNow notifies participating search engines when URLs change. Search engines decide when to crawl and index them.

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

HTTP `200` means the search engine received the URLs. HTTP `202` means it received them and key validation is pending. See the [IndexNow protocol](https://www.indexnow.org/documentation).

---

## When to Use What

| Goal | Tool |
|---|---|
| Notify Google about an eligible job or livestream page | Google Indexing API |
| Notify participating search engines of changed URLs | IndexNow |
| Audit what Google currently knows | `cnry google coverage <project>` |
| Audit what Bing currently knows | `cnry bing coverage <project>` |
| Fast crawl of new/updated pages on Bing | IndexNow batch submit |
| Ask Google to refetch changed sitemaps | `cnry google submit-sitemap <project> --all` |
| Ongoing Google crawl health | `cnry google sync` + `cnry google performance` |
| Ongoing Bing crawl health | Bing WMT sitemap + `cnry bing performance` |
| Find deindexed pages | `cnry google deindexed <project>` |

---

## General Workflow for New Client Pages

1. `cnry google submit-sitemap <project> --configured` — submit the saved sitemap
2. Read `cnry google coverage <project>` to identify unindexed pages.
3. For each eligible job or livestream page, run `cnry google request-indexing <project> <url>`.
4. Submit the sitemap with `cnry bing submit-sitemap <project> <url>`.
5. Notify Bing about changed URLs with `cnry bing request-indexing <project> <url>` or IndexNow.
6. Check coverage again before interpreting changes in search visibility.

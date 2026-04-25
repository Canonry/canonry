---
name: canonry
description: "Agent-first AEO (Answer Engine Optimization) operating platform using canonry CLI and aeo-audit tool. Use when: (1) running citation sweeps across AI providers (Gemini, ChatGPT, Claude, Perplexity); (2) auditing technical SEO with structured data validation; (3) implementing schema markup, sitemaps, llms.txt; (4) diagnosing indexing issues via Google Search Console and Bing Webmaster Tools; (5) optimizing content for AI readability and entity consistency. NOT for: general web development, content writing, PPC campaigns, or social media management."
metadata:
  {
    "agent":
      {
        "emoji": "📡",
        "requires": { "bins": ["canonry"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "canonry",
              "bins": ["canonry"],
              "label": "Install canonry globally",
              "command": "npm install -g canonry"
            },
            {
              "id": "npx",
              "kind": "npx",
              "package": "@ainyc/aeo-audit",
              "bins": ["aeo-audit"],
              "label": "Use aeo-audit via npx",
              "command": "npx @ainyc/aeo-audit@latest"
            }
          ],
      },
  }
---

# Canonry

Agent-first AEO operating platform — track and act on site visibility across AI answer engines (Gemini, ChatGPT, Claude, Perplexity) and traditional search engines using the `canonry` CLI and `aeo-audit` for technical SEO analysis.

## When to Use

✅ **USE this skill when:**

- Tracking which keyphrases earn citations (or lose them) across AI providers
- Running technical SEO audits with 14‑factor scoring
- Implementing structured data (JSON‑LD: LocalBusiness, FAQPage, Service)
- Diagnosing indexing gaps in Google Search Console / Bing Webmaster Tools
- Optimizing `llms.txt`, `llms‑full.txt`, sitemaps, robots.txt for AI crawlers
- Patching missing H1 tags, meta descriptions, image alt text
- Submitting URLs to Google Indexing API and Bing IndexNow
- Analyzing competitor citation patterns in AI answers

## When NOT to Use

❌ **DON'T use this skill when:**

- General WordPress development (use `wordpress` skill if available)
- Content writing or copy creation (human‑led task)
- Paid search/SEM campaigns (different specialty)
- Social media management or outreach
- Local business listing management (e.g., GBP, Yelp)
- Backlink building or outreach campaigns

## Core Philosophy

- **AI models are black boxes** — Measure citation outcomes, not assume causality
- **Position, then wait** — Site changes take weeks/months to reflect in AI indexes; canonry tells us *when* it happens, not *if*
- **Signal‑over‑noise** — Trim keyphrase lists to high‑intent queries; avoid granular targeting until base visibility exists
- **CLI‑native, UI‑optional** — Prefer API‑driven changes over manual CMS clicks; faster, repeatable, auditable

## Toolchain

### canonry (AEO Operating Platform)
```bash
# List projects
canonry project list

# Run a sweep (all providers)
canonry run <project> --wait

# Check per‑phrase citation status
canonry evidence <project>

# Show latest run summary
canonry status <project>

# Add/remove keyphrases
canonry keyword add <project> "polyurea roof coating"
canonry keyword remove <project> "best roof coating for a warehouse"

# Submit URLs to Bing
canonry bing request-indexing <project> <url>

# Submit to Google Indexing API
canonry google request-indexing <project> <url>
```

### aeo-audit (Technical SEO Analysis)
```bash
# Run audit (JSON output)
npx @ainyc/aeo-audit@latest "https://example.com" --format json

# 14‑factor scoring includes:
# - Structured Data (JSON‑LD)
# - Content Depth
# - AI‑Readable Content (llms.txt, llms‑full.txt)
# - E‑E‑A‑T Signals
# - FAQ Content
# - Citations & Authority Signals
# - Definition Blocks
# - Technical SEO (H1, alt text, meta)
```

### Google Search Console / Bing WMT
```bash
# GSC coverage summary
canonry google coverage <project>

# Bing coverage summary  
canonry bing coverage <project>

# Force refresh cached data
canonry google refresh <project>
canonry bing refresh <project>
```

## Workflow

### 1. Diagnose
```bash
# Baseline AEO visibility
canonry run <project> --wait
canonry evidence <project>

# Technical SEO audit
npx @ainyc/aeo-audit@latest "https://client.com" --format json > audit.json
```

### 2. Prioritize
Gaps sorted by impact:
1. **Missing H1** → immediate content patch
2. **No structured data** → JSON‑LD injection
3. **Thin content** → definition blocks ("What is…")
4. **County‑level targeting** → refine after base visibility
5. **E‑E‑A‑T signals** → Person schema, author tags (needs client input)

### 3. Execute
- **Schema injection**: LocalBusiness + FAQPage JSON‑LD via site‑appropriate method (Elementor Custom Code, theme hooks, etc.)
- **Content patches**: H1, meta title/description, image alt text via REST API or CMS
- **AI‑readable files**: Upload `llms.txt`, `llms‑full.txt` to site root
- **Indexing requests**: Submit all URLs to Google Indexing API + Bing IndexNow
- **Keyphrase strategy**: Trim to 8‑12 high‑intent queries; remove noise

### 4. Monitor
- Weekly canonry sweeps to track citation changes
- Correlate visibility shifts with deployment dates
- Watch for competitor displacement in keyphrases

### 5. Report
Clear, data‑first summaries:
> “Lost `emergency dentist brooklyn` on Gemini — two competitors moved in. Here’s what to fix.”

## Common Patterns

### New Site (0 citations)
- Focus on indexing first: submit sitemap to GSC/Bing, request indexing
- Implement base schema (LocalBusiness, Service)
- Create `llms.txt` with service‑area details
- Trim keyphrases to 8‑12 core queries
- Expect 4‑8 weeks for first citations

### Established Site (regression)
- Compare canonry runs to identify when loss occurred
- Check for recent competitor content or site changes
- Validate schema is still present and error‑free
- Re‑submit affected URLs to indexing APIs

### County‑Level Targeting
```yaml
# Service areas in llms.txt / schema
Michigan:
  - Oakland County (Troy, Auburn Hills, Pontiac)
  - Macomb County (Sterling Heights, Shelby Township)
  - Wayne County (Detroit, Dearborn)
  - Lapeer County (HQ: Almont)

Florida:
  - Miami‑Dade County (Miami, Coral Gables)
  - Broward County (Fort Lauderdale, Hollywood)
  - Palm Beach County (West Palm Beach, Boca Raton)
```
- Reference counties in schema `areaServed` and `llms.txt`
- **Do not** create separate keyphrases per county until base visibility exists

### WordPress/Elementor Specifics
- REST API user with Application Passwords (`/wp‑json/wp/v2/`)
- Elementor data patched via `_elementor_data` meta field
- Schema injection via Elementor Pro Custom Code (`elementor_snippet` CPT)
- Yoast SEO title/description fields often NOT REST‑writable → manual WP Admin edit
- `wp‑login.php` may be hidden (security plugin) → file uploads require manual WP File Manager

## Example: Full AEO Audit + Action Plan

```bash
# 1. Audit
npx @ainyc/aeo-audit@latest "https://client.com" --format json > audit.json

# 2. Parse score
cat audit.json | jq '.overallScore, .overallGrade'

# 3. Check AEO baseline
canonry status client-project
canonry evidence client-project

# 4. Generate action list
cat audit.json | jq -r '.factors[] | select(.score < 70) | "- \(.name): \(.score)/100 (\(.grade)) - \(.recommendations[0])"'
```

## Boundaries & Safety

- **Never touch live WordPress without explicit approval**
- **Back up `~/.canonry/config.yaml` before any config edit**
- **Never fabricate citation data** — if a sweep hasn’t run, say so
- **Client data stays private** — canonry repo is public; no real domains in issues
- **Respect API rate limits** — batch operations, avoid tight loops

## Output Templates

### Audit Summary
```
## AEO/SEO Audit — https://client.com

**Overall:** 66/100 (D)

**Top strengths (A/A+):**
- AI‑Readable Content (100) — llms.txt, llms‑full.txt present
- FAQ Content (100) — FAQPage schema detected
- AI Crawler Access (100) — robots.txt allows all bots

**Critical gaps (F):**
- Definition Blocks (0) — no "What is…" sections
- E‑E‑A‑T Signals (45) — missing Person schema, author tags
- Citations & Authority (44) — no external references to industry sources

**Immediate actions:**
1. Add H1 tag to homepage (Technical SEO: 60/100)
2. Create "What is polyurea?" section on /services/ (Definition Blocks: 0/100)
3. Submit all 5 URLs to Bing IndexNow (indexing: 2/5)
```

### Citation Report
```
## canonry sweep — client-project

**Run:** 2026‑04‑03T13:44Z (ID: 4a45ebfc...)

**Keyphrase visibility (12 tracked):**
✅ polyurea roof coating — 3/3 providers
✅ commercial roof coating — 2/3 providers  
❌ polyurea roof coating Michigan — 0/3 (geo gap)
❌ commercial roofing contractor Michigan — 0/3 (geo gap)

**Changes since last sweep (2026‑03‑27):**
- Lost `flat roof coating Michigan` on Gemini (−1)
- Gained `industrial roof coating` on Claude (+1)
- No change on ChatGPT (stable)

**Next steps:**
- Build Michigan location page (/michigan/)
- Add county‑level references to llms.txt
- Re‑sweep in 7 days
```

---

**Tools:** canonry v1.37+, @ainyc/aeo‑audit v1.3+  
**Reference:** [AINYC AEO Methodology](https://ainyc.ai/aeo-methodology)
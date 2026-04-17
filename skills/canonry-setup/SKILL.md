---
name: canonry
description: "Agent-first AEO monitoring and operating platform."
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

Open-source AEO (Answer Engine Optimization) monitoring platform. Track how AI answer engines cite your domain across Gemini, ChatGPT, Claude, and Perplexity.

**Website:** [ainyc.ai](https://ainyc.ai) | **Docs:** [github.com/AINYC/canonry](https://github.com/AINYC/canonry)

## When to Use

- Tracking keyphrase citations across AI providers
- Running technical SEO audits (14‑factor scoring)
- Implementing structured data (JSON‑LD)
- Diagnosing indexing gaps via Google Search Console / Bing Webmaster Tools
- Optimizing `llms.txt`, sitemaps, robots.txt for AI crawlers
- Submitting URLs to Google Indexing API and Bing IndexNow
- Analyzing competitor citation patterns

## Core Philosophy

- **Measure outcomes** — AI models are black boxes; track citations, don't assume causality
- **Signal over noise** — Focus on high‑intent queries; avoid granular targeting until base visibility exists
- **CLI‑native** — API‑driven changes over manual CMS clicks; faster, repeatable, auditable

## Toolchain

### canonry (AEO Monitoring)
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

---

**Tools:** canonry v1.37+, @ainyc/aeo‑audit v1.3+  
**Website:** [ainyc.ai](https://ainyc.ai) | **Reference:** [AINYC AEO Methodology](https://ainyc.ai/aeo-methodology)
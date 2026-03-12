# Canonry Roadmap

## Current State

Canonry is a fully functional open-source AEO monitoring tool with the following capabilities:

- **Multi-provider visibility runs**: Gemini, OpenAI, Claude, and local LLM (OpenAI-compatible API)
- **CLI / API / UI surface parity**: Every feature accessible through all three surfaces
- **Config-as-code**: `canonry.yaml` with `canonry apply` / `canonry export`
- **Scheduling**: Cron-based with presets (daily, weekly, twice-daily, custom), timezone support, catch-up on missed runs
- **Webhooks**: HMAC-SHA256 signed payloads, events: `citation.lost`, `citation.gained`, `run.completed`, `run.failed`
- **Auto-generate keywords**: LLM-powered keyword generation per project
- **Multi-project support**: Full CRUD with multi-project dashboard
- **Usage counters**: Per-provider daily quotas enforced in job runner
- **Audit logging**: All config mutations tracked with diffs
- **Snapshot history**: Timeline with computed transitions, run diffs, per-provider breakdowns
- **Auth**: API key auth with scopes, same path local and cloud
- **OpenAPI spec**: Auto-generated at `/api/v1/openapi.json`
- **SQLite**: Local-first with Drizzle ORM and auto-migration

Published as `@ainyc/canonry` on npm.

---

## Competitive Landscape

Canonry competes with paid AEO monitoring tools:

| Tool | Price | Key Differentiator |
|------|-------|--------------------|
| Profound | $499+/mo | AEO Content Score, prompt volumes, enterprise SOV |
| Otterly | $29-989/mo | Daily snapshots, GEO Audit SWOT, per-prompt pricing |
| Peec | ~99-530+/mo | Looker Studio integration, per-platform add-ons |
| Scrunch | $250+/mo | Shadow sites for AI optimization, enterprise RBAC |
| HubSpot AEO Grader | Free | Brand positioning only, no deep tracking |

**Canonry's structural advantages**: open-source, local-first, API-first, config-as-code, no vendor lock-in, no per-prompt pricing, full data ownership.

---

## Phase 2.5: Core Metrics (Quick Wins)

These build on existing infrastructure with minimal schema/architecture changes.

### Citation Position & Prominence Tracking
**Gap**: Canonry records binary `cited`/`not-cited`. Profound tracks "prominence" (where in the answer your brand appears). Otterly tracks citation ordering.
**Implementation**: When normalizing provider results, record the *index* of your domain in `groundingSources[]` and whether the domain appears in the first paragraph of `answerText`. Add `citationPosition` (int, nullable) and `prominenceScore` (float 0-1) to `querySnapshots`.
**Impact**: Transforms flat binary tracking into ranked visibility — "you're cited, but dropping from position 1 to position 4."

### Share of Voice (SOV) Metrics
**Gap**: Every competitor (Profound, Otterly, Peec) offers SOV. Canonry doesn't compute it.
**Implementation**: SOV = (runs where cited / total runs) as a percentage, computed per keyword and aggregated per project. Pure query-time computation over existing `querySnapshots` data — no schema changes needed. Add `GET /api/v1/projects/:name/sov` endpoint. Show on dashboard as a primary metric gauge.
**Impact**: The single most-requested AEO metric. Makes Canonry dashboards immediately comparable to paid tools.

### Sentiment Classification of Mentions
**Gap**: Profound and Otterly classify mentions as positive/neutral/negative. Canonry stores `answerText` but doesn't analyze tone.
**Implementation**: Use a cheap model (Haiku/GPT-4o-mini) to classify sentiment of how the domain is mentioned. Add `sentimentTone` ('positive'|'neutral'|'negative') and `sentimentSnippet` (the relevant excerpt) to `querySnapshots`. Run as a post-processing step after the main query.
**Impact**: Distinguishes "Brand X is the industry leader" from "Brand X has been criticized for..."

### Competitor Share-of-Voice Comparison
**Gap**: Canonry tracks `competitorOverlap` (which competitors appear) but doesn't compute comparative SOV.
**Implementation**: Extend the SOV endpoint to return SOV for each competitor alongside your domain. Render as a stacked bar chart or comparison table on the dashboard.
**Impact**: Answers "who's winning the AI answer war for this keyword?"

### Results CSV/JSON Export
**Gap**: Otterly highlights CSV export. Canonry's `canonry export` exports config YAML, not results data.
**Implementation**: Add `canonry export <project> --format csv --include-results` that exports snapshot data as CSV. Add corresponding `GET /api/v1/projects/:name/export?format=csv&include=results` endpoint.
**Impact**: Enables BI tool integration (Excel, Looker Studio, Tableau) without API coding.

---

## Phase 3: Deeper Analysis & New Providers

### Site Audit + Technical Readiness Score
**Existing asset**: `@ainyc/aeo-audit` (v1.2.2, published on npm, MIT) already scores websites across 13 weighted factors: structured data, content depth, AI-readable content, E-E-A-T signals, FAQ content, citations/authority, schema completeness, entity consistency, content freshness, extractability, definition blocks, named entities, AI crawler access (+ optional geo signals). Programmatic API: `runAeoAudit(url, opts) -> report`.
**Implementation**: Import `@ainyc/aeo-audit` as a dependency in `packages/canonry`. Wire into a new `site-audit` run kind: `POST /api/v1/projects/:name/runs` with `kind: 'site-audit'`. Store audit results in a new `auditSnapshots` table. Add `canonry audit <project>` CLI command. Show Technical Readiness score as a second gauge on the project dashboard alongside Answer Visibility.
**Impact**: Completes the "monitor + optimize" loop. Two score families give Canonry a unique dual-lens view.

### Perplexity Provider
**Gap**: Profound tracks 5+ engines. Perplexity is the #2 most-requested engine after ChatGPT.
**Implementation**: New `packages/provider-perplexity/` adapter using Perplexity's OpenAI-compatible API with `web_search` focus. Minimal work given existing OpenAI adapter as template.
**Impact**: Engine coverage from 3 to 4+ puts Canonry ahead of most mid-market tools.

### Answer Snapshots & Diff Viewer
**Gap**: No tool shows exactly *how* AI answers changed over time for the same query.
**Implementation**: Canonry already stores `answerText`. Build a side-by-side diff view in the UI comparing answer text across runs for the same keyword. Highlight added/removed citations and text changes.
**Impact**: Unique feature — even Profound doesn't show full answer diffs.

### Prompt-to-Topic Clustering
**Gap**: Profound offers "prompt-level analytics" grouping queries by topic.
**Implementation**: Use an LLM call to cluster keywords into topic groups (e.g., "pricing", "comparison", "how-to"). Store topic assignments in a new `keywordTopics` table. Aggregate SOV and sentiment by topic on the dashboard.
**Impact**: Analysts think by topic, not keyword-by-keyword. This is how Profound justifies $499/mo.

### Content Optimization Recommendations
**Gap**: Profound's "AEO Content Score" is their most differentiated feature. No open-source tool offers this.
**Implementation**: For keywords where the domain is `not-cited`, analyze the AI answer to extract: (a) what sources *were* cited and why, (b) what content format the answer favors, (c) structured data the cited pages use. Generate actionable recommendations. Store in a `recommendations` table linked to snapshots.
**Impact**: Moves Canonry from "monitoring" to "optimization."

### Claude Code Skill
**Gap**: AI agents need a way to interact with Canonry data.
**Implementation**: Ship a Claude Code skill (like `@ainyc/aeo-audit`'s `/aeo` skill) that wraps the Canonry CLI/API. Modes: `status`, `run`, `evidence`, `audit`. The skill calls the local CLI or API under the hood.
**Impact**: AI agents get natural-language access to Canonry through existing surfaces.

### Crawl Health Monitoring
**Gap**: Profound tracks AI crawler frequency. Sites that block AI crawlers get worse citations.
**Existing asset**: `@ainyc/aeo-audit` already checks per-bot `robots.txt` rules for GPTBot, ClaudeBot, PerplexityBot as its "AI Crawler Access" factor.
**Implementation**: Run a single-factor audit (`runAeoAudit(url, { factors: ['ai-crawler-access'] })`) or add a dedicated `GET /api/v1/projects/:name/crawl-health` endpoint.
**Impact**: Answers "can AI engines even access my content?" Near-zero new code thanks to `aeo-audit`.

### Anomaly Detection & Smart Alerts
**Gap**: Profound offers "anomaly detection." Current Canonry webhooks fire on every citation change.
**Implementation**: Track rolling SOV averages. Alert only when SOV drops/spikes beyond a configurable threshold. Add alert rules: `citation.anomaly`, `sov.drop`, `sov.spike`.
**Impact**: Reduces alert noise. Analysts get signal, not every fluctuation.

---

## Phase 4: Long-Term Initiatives

### Google AI Overviews Provider
Requires SerpAPI or similar to scrape Google search results with AI Overview snippets. "Bring your own SerpAPI key" approach.

### ChatGPT UI Scraping Provider ("Bring Your Own Browser")
Browser automation where the user logs into ChatGPT and Canonry reads the page via Playwright/Puppeteer. Most accurate ChatGPT visibility data possible.

### Historical Trend Analytics & Forecasting
Time-series analytics over SOV, sentiment, and citation position. 7/30/90-day trends. Moving averages and linear regression for SOV projections.

### Multi-Tenant Cloud Mode
Postgres mode, team workspaces, API key scoping per team, Stripe billing integration.

### Integrations Ecosystem
Slack (alerts), Google Sheets (export), Looker Studio (data source), Zapier/n8n (webhook docs), Google Search Console (correlate organic vs. AI visibility).

### Agency/Multi-Brand Management
Project grouping ("workspaces" or "organizations"), cross-project dashboards, templated configs for agency workflows.

---

## Priority Matrix

| Feature | Effort | Impact | Priority |
|---------|--------|--------|----------|
| Share of Voice metrics | Low | Very High | **P0** |
| Citation position/prominence | Low | High | **P0** |
| Competitor SOV comparison | Low | High | **P0** |
| Sentiment classification | Low | High | **P1** |
| Results CSV/JSON export | Low | Medium | **P1** |
| Perplexity provider | Low | High | **P1** |
| Answer diff viewer | Medium | High | **P1** |
| Site audit / tech readiness | Low-Medium (uses `@ainyc/aeo-audit`) | High | **P2** |
| Prompt-to-topic clustering | Medium | High | **P2** |
| Content optimization recs | Medium | Very High | **P2** |
| Anomaly detection alerts | Medium | Medium | **P2** |
| Claude Code skill | Low-Medium | High | **P2** |
| Crawl health monitoring | Low (uses `@ainyc/aeo-audit`) | Medium | **P2** |
| Google AI Overviews provider | Medium | High | **P2** |
| ChatGPT UI scraping | High | High | **P3** |
| Trend analytics & forecasting | High | Medium | **P3** |
| Cloud multi-tenant mode | High | High | **P3** |
| Integrations ecosystem | High | Medium | **P3** |
| Agency multi-brand mgmt | Medium | Medium | **P3** |

---

## What Makes Canonry Uniquely Competitive

Paid tools charge $29-$499+/month per seat and gate features behind tiers. Canonry's open-source positioning means:

1. **No per-prompt pricing** — run as many queries as your API keys allow
2. **Local-first privacy** — data never leaves your machine unless you choose cloud
3. **Config-as-code** — version-controlled monitoring configs, CI/CD friendly
4. **Extensible providers** — add any OpenAI-compatible LLM, no vendor approval needed
5. **API-first** — every feature is automatable, not locked behind a UI
6. **Full data ownership** — SQLite file you can query directly, export anywhere

The strategy is: match paid tools on core metrics (SOV, sentiment, prominence), then differentiate on openness, extensibility, and developer experience.

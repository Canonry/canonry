# SoV Rework — Retrieval Share, Mention Share, Discovery v2

**Status:** planning. Replaces the current "Share of Voice" metric (PR #533) which is misleadingly named and uses a narrow universe, AND reworks the existing Discovery feature into a multi-source query-expansion pipeline.

**Why this exists:** the current SoV computes `project_cited_slots / total_cited_slots` across `(query × provider)` snapshots inside the tracked basket. It's mathematically defined but pretends to be a market metric. Centralized platforms (Profound, Ahrefs) brute-force-sample millions of queries and ground their SoV in a real market. Canonry can't match that — but it can do better than the current implementation by using **side-channel data the providers (and Google) already give us**: grounding sources, search queries, answer-text brand mentions, and per-customer GSC impressions.

This document scopes **two new metrics** (Retrieval Share, Mention Share) and **a rework of the existing Discovery feature** with two new input sources (GSC impressions, passive snapshot mining) plus a zero-friction "standing suggestions" UX. Together they get us "80% as good" as a centralized platform on the dimensions that matter most for an AEO analyst, without leaving the per-customer data we already capture.

| Surface | Today | After rework |
|---------|-------|--------------|
| Hero gauge #3 (SoV) | `cited_slots` ratio — misleading name, narrow universe | **Retrieval Share** — % of grounding-source slots (real SERP slice proxy) |
| At-risk row | Mention Gaps + Citation Gaps + Index Coverage | **+ Mention Share** (head-to-head competitive) |
| Discovery | ICP-only, manual one-shot, no GSC | **Multi-source** (ICP / GSC / Snapshot mining / Auto) with zero-friction "standing suggestions" panel |

---

## 1. Soundness framework (read this first)

Before any specific metric, three principles every SoV-class metric in canonry must honor:

### 1.1 The universe must be defined and disclosed

Every share-type metric has a numerator and a denominator. The denominator IS the universe. We never publish a share without telling the operator what universe we're dividing by:

- **Tracked basket** — bounded by the user's chosen queries. Shifts as they add/remove queries.
- **Per-query retrieval window** — bounded by what an LLM's retrieval layer pulled for that query.
- **Competitive frame** — bounded by the configured competitor list.

The DTO carries `universe: 'tracked-basket' | 'retrieval' | 'competitive'` so the UI and CLI can label it. No exceptions.

### 1.2 Coverage is reported alongside the value

Some snapshots have grounding data; some don't. Some queries get mentioned; many don't. We always emit a `coverage` field: "% of snapshots that contributed to this metric." A 50% Retrieval Share with 8% coverage is a different signal than 50% with 95% coverage. Don't hide it in the description — surface it as a structured field.

### 1.3 Provider asymmetry is a measured bias, not a hidden one

Gemini grounding returns 30+ sources; OpenAI returns ~8; Perplexity returns ~5. Aggregate slot-share gets heavily weighted toward verbose providers. Two options for handling:

- **Aggregate** (slot-weighted): more honest about total "answer real-estate captured." Bias toward verbose providers is real and reflects truth.
- **Per-provider then averaged**: equally weights each provider's verdict. Better for "how am I doing across the LLM landscape."

We will publish **both** as separate fields. Aggregate is the headline number (because it matches the "share" intuition); per-provider average is in the breakdown for the analyst who wants to mentally adjust for provider mix.

---

## 2. Metric 1 — Retrieval Share

> Of every URL the LLMs' retrieval layers pulled for your tracked queries, what % is your domain.

### 2.1 Definition

For each `(query × provider × model × location)` snapshot, the `query_snapshots.raw_response` envelope already stores `groundingSources: GroundingSource[]` (`{ uri, title }`). After deduping by registrable domain per snapshot (already done at provider-normalize time for `citedDomains`; we must do the same for grounding):

```
For each snapshot S with len(groundingSources) > 0:
  total_retrieval_slots += distinctDomains(S.groundingSources).length
  project_retrieval_slots += distinctDomains(S.groundingSources).filter(d => belongsToProject(d, projectDomains)).length
  competitor_retrieval_slots += distinctDomains(S.groundingSources).filter(d => belongsToProject(d, competitorDomains)).length

RetrievalShare% = round(project_retrieval_slots / total_retrieval_slots * 100)
```

`belongsToProject` is the existing `citedDomainBelongsToProject` (subdomain-aware) — same matcher as Citation Share for consistency.

### 2.2 Why this universe is the right move

The grounding sources are the LLM's **retrieval candidates** — what its search backend pulled before the LLM picked which to actually cite in the answer. That's much closer to a SERP slice than `citedDomains` (which is the LLM's editorial filter). For Gemini specifically, grounding sources = Google's search results for the query Gemini issued. So Retrieval Share approximates "share of voice in Google's index for your tracked queries" — close to what an SEO analyst means by "SoV."

This is **not** a true market SoV (we still don't sample queries we don't track). But it's a much honester proxy than counting only final citations.

### 2.3 Data dependencies

**Already stored**, no migration needed:
- `query_snapshots.raw_response` JSON contains `groundingSources` for OpenAI, Claude, Gemini, Perplexity (confirmed via `grep groundingSources packages/provider-*/src/normalize.ts`)
- Provider normalizers already extract them into the envelope

**Need to expose** at the composites layer:
- The current `OverviewSnapshot` shape (in `packages/api-routes/src/composites.ts:388`) doesn't carry `groundingSources` — it's stripped during the SELECT. We'll need to add it to the loader projection.

### 2.4 Aggregation rule

Three numbers, all in the DTO:

| Field | Aggregation | Use |
|-------|-------------|-----|
| `score` | aggregate slot-weighted across all snapshots | headline gauge value |
| `perProviderAverage` | per-(provider, model) share, then arithmetic mean | bias-corrected secondary |
| `breakdown` | `{ projectSlots, competitorSlots, otherSlots, totalSlots, snapshotsWithGrounding, snapshotsTotal }` | stacked-bar source + trust signal |

Coverage = `snapshotsWithGrounding / snapshotsTotal`. Display when <80%.

### 2.5 Threats to validity

Each documented in JSDoc; tested where testable.

1. **Provider grounding format drift.** Google can change the response shape; we'd silently lose grounding data. **Mitigation:** assert in tests that the per-provider extractor returns ≥1 grounding source on a fixture response; flag in `doctor` if the latest run has 0 grounding sources for an API provider that historically had them.

2. **Opaque-redirect URLs (Gemini).** Gemini grounding URIs are `vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ...` — opaque. The Gemini normalizer already falls back to extracting the destination from `source.title` (see `plans/ai-attribution-research.md` finding #2). Retrieval Share inherits this — only domain-level data, no path. **Acceptable** for SoV (we only care about domain match).

3. **Cross-snapshot duplicates.** If Gemini grounds 4 queries on the same `wikipedia.org` URL, we count it 4 times in the total. **This is correct** — each snapshot is an independent retrieval event. Documented.

4. **Per-snapshot dedupe assumption.** Provider extractors *currently* dedupe `citedDomains` via Set. We must verify they do the same for `groundingSources` — if not, the calc is wrong. **Test invariant:** "same domain cited twice in one grounding response counts once per snapshot."

5. **Zero-grounding providers.** CDP / local providers don't return grounding sources. Snapshots from them contribute zero to both numerator and denominator. **Documented:** Retrieval Share is API-provider-only.

6. **Query basket dependence.** Same as every other tracked-basket metric — adding a query changes the score. **Documented in tooltip:** "Bounded by your tracked queries."

7. **Subdomain matching for competitors.** Same audit issue as PR #533 — must subdomain-match on both project and competitor sides. **Already fixed** in the SoV audit; Retrieval Share reuses the same helper.

### 2.6 Tone calibration

Retrieval Share thresholds are looser than Citation Share because the denominator is larger:

| Band | Range | Meaning |
|------|-------|---------|
| positive | ≥15% | exceptional retrieval presence; you own a meaningful slice of what gets surfaced |
| caution | 5-14% | competitive presence |
| negative | <5% | minor source in retrieval; competitors likely dominate |

Per-provider averages can be higher (some providers retrieve fewer sources). Bands stay the same; "negative" is calibrated to aggregate score.

### 2.7 Implementation plan

**File: `packages/intelligence/src/retrieval-share.ts`** — new pure function `buildRetrievalShare`.

```typescript
export interface RetrievalShareSnapshot {
  provider: string
  model: string | null
  /** Grounding-source domains extracted per snapshot (deduped). Empty for
   *  providers that don't expose grounding. */
  groundingDomains: readonly string[]
}

export interface RetrievalShareOptions {
  projectDomains: readonly string[]
  competitorDomains: readonly string[]
}

export interface RetrievalShareBreakdown {
  projectSlots: number
  competitorSlots: number
  otherSlots: number
  totalSlots: number
  snapshotsWithGrounding: number
  snapshotsTotal: number
}

export interface RetrievalShareResult extends ScoreSummaryDto {
  /** Per-(provider, model) share averaged across providers — bias-corrected
   *  view for analysts who don't want verbose providers (Gemini) to dominate. */
  perProviderAverage: number | null
  /** Structured breakdown for stacked-bar rendering. */
  breakdown: RetrievalShareBreakdown
  /** What % of `snapshotsTotal` actually had grounding data. <80% means
   *  the operator should treat the score as low-confidence. */
  coverage: number
}

export function buildRetrievalShare(
  snapshots: readonly RetrievalShareSnapshot[],
  options: RetrievalShareOptions,
): RetrievalShareResult
```

**File: `packages/intelligence/src/grounding-domains.ts`** — pure helper to extract `groundingDomains` from `GroundingSource[]` with the same subdomain-aware dedup as `extractCitedDomainsFromSources`. Avoids duplicating per-provider extraction; called by the composites loader.

**File: `packages/api-routes/src/composites.ts`** changes:
- Extend `OverviewSnapshot` shape (line 388) with `groundingDomains: string[]`
- Extend `loadSnapshotsByRunIds` SELECT to include `rawResponse`
- After load, parse `groundingSources` from `rawResponse` envelope and call `extractDomainsFromGrounding` → store on the snapshot
- Wire `buildRetrievalShare` into `scores: ProjectOverviewScoresDto`

**File: `packages/contracts/src/composites.ts`** — add `retrievalShare: ScoreSummaryDto & { perProviderAverage, breakdown, coverage }` to `ProjectOverviewScoresDto`. Backward-compatible additive change.

**File: `apps/web/src/build-dashboard.ts` + `view-models.ts`** — expose `retrievalShare` on `ProjectCommandCenterVm`.

**File: `apps/web/src/pages/ProjectPage.tsx`** — render as a new hero row alongside Mention / Cited / Retrieval Share. Replaces the existing "Share of Voice" row (delete old SoV from PR #533).

**Mock data** — three new entries in `mock-data.ts` mirroring the three existing projects.

### 2.8 Tests (specifies the metric's correctness contract)

In `packages/intelligence/test/retrieval-share.test.ts`:

1. Returns `No data` tone neutral on empty input.
2. Returns 0% with neutral tone when all snapshots have empty grounding (coverage 0).
3. 100% when project is the sole grounding source across all snapshots.
4. Dilutes correctly: project in 1 of 30 grounding URLs = 3.3%.
5. **Subdomain match for project** — `docs.mine.com` matches `mine.com`.
6. **Subdomain match for competitor** — `offers.roofle.com` matches `roofle.com` (the audit invariant).
7. **Cross-provider double-count** — same URL grounded by 4 providers counts as 4 slots.
8. **Per-snapshot dedupe** — if a single snapshot's grounding has two entries for the same domain (defensive against future provider changes), counts once.
9. **Per-provider average** divergence from aggregate when providers differ wildly in grounding count.
10. **Coverage signal** — 5 snapshots, only 2 have grounding → coverage = 40%.
11. **Tone bands** — ≥15% positive, 5-14% caution, <5% negative.
12. **Distinct from Citation Share** — same data, RetrievalShare ≠ CitationShare (asserts that the two pure functions produce different numbers on a snapshot where cited ⊂ grounded).

Plus a composites integration test verifying:
- `OverviewSnapshot` carries `groundingDomains`
- `retrievalShare` is populated end-to-end from real DB-shaped data
- Snapshots without `rawResponse.groundingSources` contribute 0 (not crash)

### 2.9 Risks specific to this metric

- **`rawResponse` parsing slows down `loadSnapshotsByRunIds`.** Each row's JSON envelope is parsed. For a project with 200 snapshots per run this is fine; for a project with 5000 it adds 50-100ms. **Mitigation:** add an indexed `grounding_domains` column to `query_snapshots` in a future migration, backfill via the existing `backfill answer-visibility` flow. For now, parse on read — the data is small.
- **Gemini grounding token instability** (see plans/ai-attribution-research.md). Doesn't affect Retrieval Share (we only care about domain), but flag if Gemini ever stops populating `source.title`.

---

## 3. Metric 2 — Mention Share

> Across answer text in the run, what % of brand mentions are yours vs your configured competitors.

### 3.1 Definition

For each `(query × provider × model × location)` snapshot with non-empty `answerText`:

```
For each snapshot S:
  if answerMentioned(S, projectBrandNames) and not already counted for this S:
    project_mention_snapshots += 1
  for each competitor C in competitorDomains:
    if competitorBrandMentioned(S, C):
      competitor_mention_snapshots[C] += 1

total = project_mention_snapshots + sum(competitor_mention_snapshots.values())
MentionShare% = round(project_mention_snapshots / total * 100)
```

Notes:
- **Per-snapshot count, not per-occurrence** — if the LLM says "AINYC" three times in one answer, that's still one snapshot mention. Matches `answerMentioned` semantics (binary per snapshot).
- **Symmetric** — project and competitors are both counted as "brands surfaced in answer text." The metric is "of brands surfaced, what % is you."
- **Requires competitors configured** — without competitors, denominator = numerator = project_mention_snapshots, share would be 100% which is meaningless. Surface "no competitors configured" state explicitly.

### 3.2 Why this universe is the right move

This is the **head-to-head competitive metric**. It strips out Wikipedia / news / vertical sites entirely and answers: "When the LLM names a brand in its prose, how often is it you vs the competition." That's the question an AEO analyst genuinely asks. It's complementary to Retrieval Share (which is about citations) and Mention Coverage (which is your raw presence rate, ignoring competitors).

### 3.3 Data dependencies

**Already stored**, no migration needed:
- `query_snapshots.answer_mentioned` — boolean per snapshot for project
- `query_snapshots.answer_text` — the prose to scan for competitor brands
- Competitor list — `competitors` table

**Need to reuse**:
- `effectiveBrandNames` (contracts) — for project brand-token extraction
- `brandLabelFromDomain` (contracts) — for competitor brand-token extraction
- The brand-token matching used by `determineAnswerMentioned` — needs to be exported / generalized so we can run it against competitor brand strings, not just the project's.

### 3.4 Aggregation rule

```typescript
interface MentionShareBreakdown {
  projectMentions: number              // snapshots where project brand surfaced
  competitorMentions: number           // sum across all configured competitors
  perCompetitor: Array<{ domain: string; brand: string; mentionSnapshots: number; share: number }>
  snapshotsWithAnswerText: number      // denominator universe (snapshots that even had prose to scan)
  snapshotsTotal: number               // raw snapshot count
}
```

Coverage = `snapshotsWithAnswerText / snapshotsTotal`. Note this is usually high (>95%); flag if <70%.

### 3.5 Threats to validity

1. **Brand-token ambiguity.** Single-word brands like "Apple" or "Square" generate false positives. **Mitigation:** the existing `effectiveBrandNames` filter (min 3 chars, alphanumeric required, etc.) already handles this — Mention Share inherits the same rules. We do NOT lower the bar.

2. **Competitor brand name extraction.** A competitor stored as `offers.roofle.com` extracts to "roofle" via `brandLabelFromDomain` — but the operator might want to display "Roofle, Inc." in the UI. **Resolution:** brand-matching uses the extracted token (`roofle`); display layer can use a separate `displayBrand` field if the operator sets one. Out of scope for this PR.

3. **Token-collision with non-brand words.** "Conductor" is a competitor brand AND a common English word. **Risk:** false-positive mention in answers about orchestras. **Mitigation:** require word-boundary match (already in the existing helper); accept residual noise as a known limitation; document it.

4. **Provider answer-text quality.** Some providers return shorter prose than others. A snapshot with a 50-word answer has less room to mention brands than a snapshot with 500 words. **Documented** — not a metric correction, an interpretive note.

5. **Asymmetric coverage** — `answerMentioned` for project is precomputed; for competitors we have to scan answer text on read. **Mitigation:** scan is fast (regex match per competitor × per snapshot), but for projects with 100+ snapshots and 20+ competitors this could be 2000 regex ops per overview call. **Cache** the extracted competitor brand-tokens; benchmark in a test. If slow, consider precomputing into `query_snapshots.competitor_mentions: text` (JSON array) via migration + backfill.

6. **"No competitors configured" state.** Without competitors, this metric is undefined. **Surface as `value: 'Add competitors'` with neutral tone**, not as `100%`. This is a common pitfall in share metrics.

7. **Project mention threshold matches `answerMentioned`** — same definition, no drift.

### 3.6 Tone calibration

Mention Share thresholds are looser than Retrieval/Citation Share because it's already a competitive frame (other sources are excluded):

| Band | Range | Meaning |
|------|-------|---------|
| positive | ≥50% | you win head-to-head more than half the time |
| caution | 25-49% | meaningful share but losing the head-to-head |
| negative | <25% | competitors dominate the conversation |

### 3.7 Implementation plan

**File: `packages/intelligence/src/mention-share.ts`** — new pure function `buildMentionShare`.

```typescript
export interface MentionShareSnapshot {
  /** True if project brand was mentioned. Use precomputed answerMentioned. */
  projectMentioned: boolean
  /** Raw answer text for scanning competitor mentions. */
  answerText: string | null
}

export interface MentionShareOptions {
  /** Brand tokens to match for each tracked competitor. Caller computes via
   *  `brandLabelFromDomain` + any display-brand override. */
  competitors: ReadonlyArray<{ domain: string; brandTokens: readonly string[] }>
}

export interface MentionShareResult extends ScoreSummaryDto {
  breakdown: MentionShareBreakdown
  coverage: number
}

export function buildMentionShare(
  snapshots: readonly MentionShareSnapshot[],
  options: MentionShareOptions,
): MentionShareResult
```

**File: `packages/intelligence/src/brand-mention-match.ts`** — extract a shared `matchesBrandToken(text, brandToken)` helper used by both `determineAnswerMentioned` (in canonry-contracts) and the new mention-share logic. Single source of truth for the matching rule.

**File: `packages/api-routes/src/composites.ts`** — extend the SELECT to include `answerText` if not already; wire `buildMentionShare` with `effectiveBrandNames`-style competitor brand extraction.

**File: `packages/contracts/src/composites.ts`** — add `mentionShare: ScoreSummaryDto & { breakdown, coverage }` to `ProjectOverviewScoresDto`.

**File: `apps/web/src/pages/ProjectPage.tsx`** — render in the at-risk row alongside Citation Gaps + Mention Gaps. NOT in the hero — keep hero to the three presence metrics (Mention, Cited, Retrieval Share). Mention Share is competitive nuance, not headline KPI.

### 3.8 Tests

In `packages/intelligence/test/mention-share.test.ts`:

1. Returns "No data" tone neutral on empty snapshots.
2. Returns "Add competitors" with neutral tone when no competitors configured.
3. 100% project share when only project is mentioned, no competitors surface.
4. 50% when project and one competitor each mention in 1 of 2 snapshots.
5. Multi-competitor split: project in 4 snapshots, competitor A in 4, competitor B in 2 → share = 4/10 = 40%.
6. Token-collision invariant: competitor brand "conductor" doesn't match the prose "the symphony's conductor."
7. Word-boundary invariant: brand "roofle" doesn't match "rooflesoft."
8. `answerMentioned: true` snapshot with empty answerText still counts as project mention (`answerMentioned` is the source of truth for project side).
9. Coverage signal correctness.
10. Per-competitor breakdown counts.
11. Tone bands.

### 3.9 Risks specific to this metric

- **Scan cost** for many competitors × many snapshots. Benchmark; precompute if slow.
- **Brand-token quality varies** by competitor configuration. Surfaces in `doctor` if a brand-token is too short / generic — already done for project's `effectiveBrandNames`.

---

## 4. Feature 3 — Discovery v2 (multi-source query expansion)

> Make the existing Discovery feature smarter by adding two new input sources alongside the current ICP-driven one: real GSC impressions (highest-quality signal) and passive snapshot mining (continuous signal). Then layer a zero-friction "standing suggestions" UX on top so the operator gets ambient guidance without manually triggering anything.

This is a **rework of an existing feature**, not a new one. The current Discovery (`packages/api-routes/src/discovery/`, `canonry discover`) is ICP-only and one-shot. After investigating, the originally-proposed "Query Expansion" idea overlapped meaningfully with Discovery — both mine Gemini `searchQueries`. Consolidating into one feature with three input sources is cleaner.

### 4.1 The mental model

**Today:**
```
ICP text → Gemini synthesis → probe → bucket → promote
```

**v2:**
```
[ ICP text   ] ↘
[ GSC data   ] → seed candidates → probe → bucket → promote
[ Snapshot   ] ↗
  searchQueries
```

The probe/bucket/promote pipeline is unchanged — we're adding two new seed sources upstream. Plus we add a zero-friction surface that skips the probe phase entirely for the cases where the source itself is already high-confidence (GSC: real user demand; you don't need an LLM to second-guess it).

### 4.2 The three sources, compared

| Source | Signal | Latency | Quality | Operator effort | Best for |
|--------|--------|---------|---------|-----------------|----------|
| **ICP** (existing) | LLM's interpretation of "what you are" | One-shot | Variable — depends on prompt quality | High — write a paragraph | Cold start; new category exploration |
| **GSC** (new) | Real Google SERP impressions you're already getting | Continuous (re-syncs daily) | Highest — actual user demand | Zero (after one-time GSC connect) | Ambient expansion; "what am I already known for that I'm not tracking?" |
| **Snapshot mining** (new) | LLMs' actual web searches while answering your tracked queries | Continuous (grows with every run) | High — context-aware adjacency | Zero | "What do LLMs think is adjacent to my domain?" |
| **Hybrid auto** (new default) | All available + deduped | Continuous | Composite | Zero | Most operators most of the time |

Critical: **GSC is the asymmetric signal**. Profound doesn't have it because Profound doesn't have a per-customer GSC connection — they can sample broadly across the web, but they can't see what's actually driving traffic to *your* domain. Canonry's per-customer integration gives us a higher-precision signal than any centralized aggregator can match on this dimension.

### 4.3 User experience — two surfaces

The rework adds two distinct UX entry points serving different operator moods.

#### 4.3.1 "Standing suggestions" — zero-friction (Settings tab)

Always-on panel below the existing tracked-query list. No discovery session, no probe phase, no decisions needed:

```
┌─ Suggested queries ────────────────────────────────────────┐
│                                                             │
│ From Google Search Console — already getting impressions:  │
│   ☑ best aeo agency nyc         340 imp · pos 4.2 · 30d   │
│   ☑ canonry alternatives        180 imp · pos 12 · 30d    │
│   ☐ aeo platform comparison      95 imp · pos 18 · 30d    │
│   [Track 2 selected]                  [Discover more →]    │
│                                                             │
│ Observed in LLM searches — Gemini grounded on these while  │
│ answering your queries:                                    │
│   ☐ aeo platform brooklyn         12 mentions · 7d         │
│   ☐ answer engine seo agency       8 mentions · 14d        │
│   [Track selected]                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Click "Track" → POST /projects/:name/queries. Done. Three clicks from notification to expanded tracking. No probe, no bucket, no LLM evaluation needed — for these sources the signal itself is the evidence.

The **"Discover more →"** button at the bottom links to the Discovery tab for the heavier-weight flow.

#### 4.3.2 "Discovery session" — full pipeline (Discovery tab)

Existing UI extended with a source picker. Default selection is **Auto** (uses all available sources):

```
┌─ Discovery: expand your tracked queries ───────────────────┐
│                                                             │
│ Source:                                                     │
│  ◉ Auto — pulls from GSC + observed LLM searches          │
│                  (45 candidates ready)                     │
│  ○ GSC impressions only      (45 candidates ready)         │
│  ○ Observed in LLM searches  (12 candidates ready)         │
│  ○ ICP description           [text input...]               │
│                                                             │
│ Probe budget: [100] candidates                              │
│ Locations:    [All locations ▼]                             │
│                                                             │
│ [Start discovery]                                           │
└─────────────────────────────────────────────────────────────┘
```

The **candidate-count badges next to each source are the UX killer feature** — they show the operator the signal volume per source *before* committing to a session. They see "GSC has 45 candidates, observed searches have 12, ICP has whatever I type." This is impossible in the current ICP-only flow.

Sessions list (existing) gets a `source` column so the operator can see "this session ran from GSC" vs "this session ran from ICP." Promote workflow unchanged.

#### 4.3.3 CLI

Mirrors the source picker:

```bash
# Existing — still works
canonry discover run <project> --icp "..."

# New
canonry discover run <project> --source gsc --gsc-days 30 --min-impressions 10
canonry discover run <project> --source snapshots --lookback 90
canonry discover run <project> --source auto    # default — uses all available

# New, zero-friction (no session — just the standing suggestions)
canonry queries suggested <project>             # list suggestions across sources
canonry queries suggested <project> --source gsc
canonry queries suggested <project> --add 1,3,5 # bulk add by index
canonry queries suggested <project> --format json
```

### 4.4 Source specifications

For each source, precise spec so tests can pin behavior.

#### Source B — GSC impressions

**Query:**
```sql
SELECT query, SUM(impressions) AS imp, AVG(CAST(position AS REAL)) AS pos,
       MIN(date) AS first_seen, MAX(date) AS last_seen
FROM gsc_search_data
WHERE project_id = ?
  AND date >= date('now', '-30 days')
GROUP BY query
HAVING imp >= 10                         -- noise floor
  AND query NOT IN (project's tracked queries)
  AND query NOT MATCH any tracked query Jaccard ≥ 0.9
ORDER BY imp DESC
LIMIT 100
```

**Filters:**
- `lookbackDays` — default 30, configurable
- `minImpressions` — default 10, configurable (drops single-impression noise)
- Drop pure-brand queries (matches `effectiveBrandNames`)
- Drop queries already in tracked basket (exact + Jaccard ≥0.9)
- Drop queries dismissed in `dismissed_query_suggestions` table (v2.4 addition; see 4.5)

**Output per candidate:**
```typescript
{
  source: 'gsc',
  query: 'best aeo agency nyc',
  evidence: {
    impressions: 340,
    position: 4.2,
    firstSeen: '2026-04-15',
    lastSeen: '2026-05-14',
    dayCount: 22,         // days within lookback that had ≥1 impression
  },
  confidence: 'high' | 'medium' | 'low',  // based on impressions × dayCount
}
```

**Confidence rule:**
- high: ≥100 impressions and ≥5 days
- medium: ≥30 impressions and ≥3 days
- low: ≥10 impressions or ≥3 days

Confidence drives whether the standing-suggestions panel pre-checks the box for the operator.

#### Source C — Snapshot mining

**Logic:** as in the original Query Expansion proposal (section deleted). Aggregate `searchQueries` from Gemini snapshots' `raw_response`, normalize, rank by recency-weighted frequency, filter out tracked + brand + generic queries.

Same Jaccard ≥0.9 dedup against tracked basket and against GSC candidates (so the standing-suggestions panel doesn't show the same suggestion twice).

**Output per candidate:**
```typescript
{
  source: 'snapshot',
  query: 'aeo platform brooklyn',
  evidence: {
    snapshotCount: 12,           // distinct (query × provider × model) snapshots that grounded this
    weight: 8.4,                 // recency-weighted frequency
    firstSeen: '2026-04-10',
    lastSeen: '2026-05-13',
    sourceQueries: ['best aeo agency nyc', 'aeo agency brooklyn heights'],  // your tracked queries that surfaced it
  },
  confidence: 'high' | 'medium' | 'low',  // based on weight × snapshotCount
}
```

#### Source A — ICP (unchanged)

Existing logic preserved. The DTO output gets a `source: 'icp'` tag for consistency.

#### Source D — Hybrid auto

Pulls from B + C (and from A if `icpDescription` is provided), merges, dedupes by canonical query form, ranks by composite score:

```
composite = w_gsc * normalize(impressions) + w_snap * normalize(weight) + w_icp * 1.0
```

Default weights: `w_gsc = 0.6`, `w_snap = 0.3`, `w_icp = 0.1` (GSC dominates because real demand > LLM speculation > prompted synthesis). Configurable via `~/.canonry/config.yaml`.

A candidate sourced from multiple inputs displays all evidence:
```typescript
{
  source: 'hybrid',
  query: 'best aeo agency nyc',
  evidence: {
    gsc: { impressions: 340, position: 4.2, ... },
    snapshot: { snapshotCount: 8, weight: 5.2, ... },
  },
  confidence: 'high',   // multi-source corroboration → bump confidence
}
```

### 4.5 Dismissal model (the missing piece)

Current Discovery has no dismissal — once a candidate is rejected, it can resurface on the next session. For ambient suggestions this is intolerable.

Add `dismissed_query_suggestions` table:

```sql
CREATE TABLE dismissed_query_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_query TEXT NOT NULL,   -- normalized form
  source TEXT NOT NULL,            -- 'gsc' | 'snapshot' | 'icp' | 'hybrid'
  reason TEXT,                     -- optional operator note
  dismissed_at TEXT NOT NULL,
  UNIQUE(project_id, canonical_query)
)
```

Both standing suggestions and Discovery sessions filter against this. Dismissals are per-project and have no TTL (the operator decided "not interested" — respect that). Bulk-dismiss UI: "Hide all" on a source group.

CLI: `canonry queries dismiss <project> "<query>"` and `canonry queries undismiss <project> "<query>"`.

### 4.6 Threats to validity

1. **GSC sync lag.** GSC data is delayed by ~2-3 days from Google's side. **Acceptable** — we surface `lastSeen` so the operator can see freshness; "no GSC data in the last 7d" warning if the sync is stale (already covered by existing doctor check).

2. **GSC API quotas.** Heavy projects could hit Google's daily quota. **Mitigation:** standing suggestions read from the cached `gsc_search_data` table (no API call); the existing GSC sync handles quota separately.

3. **GSC connection not configured.** Many projects won't have GSC connected. **UX:** if no GSC, source picker grays out the GSC option with a "Connect GSC →" link; standing-suggestions panel hides the GSC card entirely. Snapshot mining still works.

4. **Same-canonical-query across sources.** "AEO agency NYC" from GSC and "best AEO agency NYC" from snapshots — close but not identical. **Mitigation:** Jaccard ≥0.9 canonical-form dedup; the surviving suggestion takes the higher-impressions evidence as primary.

5. **GSC vs LLM-discovered divergence.** Some queries appear in GSC (real Google users searching) but not in any LLM snapshot (no LLM has thought to search for them while grounding). Or vice versa. **By design** — that divergence IS the signal. Surface both with clear source attribution.

6. **Position bias in GSC ranking.** A query at position 25 with 50 impressions might be lower-quality than position 4 with 20 impressions. **Mitigation:** confidence rule weights impressions × dayCount but doesn't penalize position — operator sees position in the evidence and judges.

7. **Brand-token collision in GSC.** Project brand "Canonry" might appear in queries like "canonry pricing" which the operator doesn't want to track separately. **Mitigation:** the existing `effectiveBrandNames`-pure-brand filter, with optional override flag `--include-brand-queries`.

8. **Probe budget exhaustion in hybrid sessions.** With 100-candidate budget and 60 GSC + 15 snapshot candidates, the session needs to prioritize. **Behavior:** probe by composite-score-DESC until budget runs out; remaining go to the standing-suggestions panel without probing.

### 4.7 Architecture

```
packages/intelligence/src/
  query-discovery-sources/
    gsc-source.ts                ← pure: rows + filters → candidates
    snapshot-source.ts           ← pure: snapshots + filters → candidates
    hybrid-merge.ts              ← pure: merge + composite scoring
  query-normalize.ts             ← normalization, Jaccard, brand-token filter (shared)

packages/db/src/
  schema.ts                      ← + dismissed_query_suggestions table
  migrate.ts                     ← + migration version N+1

packages/api-routes/src/
  discovery/
    routes.ts                    ← extend POST /discover/run with `source: 'icp' | 'gsc' | 'snapshot' | 'auto'`
    orchestrate.ts               ← extend `executeDiscovery` to accept multi-source seed inputs
    standing-suggestions.ts      ← NEW route: GET /projects/:name/query-suggestions
    dismissals.ts                ← NEW route: POST/DELETE /projects/:name/query-suggestions/dismiss

packages/canonry/src/
  discovery-run.ts               ← buildDefaultDeps gets GSC + snapshot data fetchers
  commands/queries.ts            ← + `canonry queries suggested` subcommand
  commands/discover.ts           ← + `--source` flag
  mcp/tool-registry.ts           ← + canonry_query_suggestions_list, canonry_query_dismiss

apps/web/src/
  components/project/
    StandingSuggestionsPanel.tsx ← NEW, rendered in Settings tab
    DiscoverySection.tsx          ← extend with source picker + per-source candidate counts
```

### 4.8 DTO shape

```typescript
// Per-candidate (used by both standing suggestions and discovery preview)
export interface QueryCandidateDto {
  canonicalQuery: string         // normalized, stop-word-stripped form for dedup
  displayQuery: string            // human-readable form (most-frequent variant)
  source: 'gsc' | 'snapshot' | 'icp' | 'hybrid'
  confidence: 'high' | 'medium' | 'low'
  evidence: {
    gsc?: { impressions: number; position: number; firstSeen: string; lastSeen: string; dayCount: number }
    snapshot?: { snapshotCount: number; weight: number; firstSeen: string; lastSeen: string; sourceQueries: string[] }
    icp?: { sessionId: string; prompt: string }
  }
  alreadyDismissed: boolean       // true if in dismissed_query_suggestions
}

// Standing suggestions response
export interface QuerySuggestionsResponseDto {
  candidates: QueryCandidateDto[]
  sourceCounts: {
    gsc: number
    snapshot: number
    icp: number
  }
  meta: {
    gscConnected: boolean
    gscStaleness: 'fresh' | 'stale' | 'missing'      // freshness flag
    snapshotsAvailable: number
    dismissedCount: number
  }
}

// Extend existing discovery POST body
export interface DiscoveryRunRequestDto {
  source?: 'icp' | 'gsc' | 'snapshot' | 'auto'      // NEW, default 'auto'
  icpDescription?: string                            // required if source === 'icp' or 'auto' (optional)
  gscLookbackDays?: number                          // GSC-source tuning
  minImpressions?: number                            // GSC-source tuning
  snapshotLookbackDays?: number                     // Snapshot-source tuning
  maxProbes?: number                                 // existing
  locations?: string[]                               // existing
}
```

### 4.9 Phasing inside Discovery v2

Even within this feature, ship in independent slices:

**v2.1: Standing suggestions panel (GSC-only)** — fastest user value. New endpoint, new UI panel, new CLI subcommand. No changes to the existing Discovery session pipeline. Operator can `Track` queries straight to basket without probe. This alone delivers the "zero-friction" promise.

**v2.2: GSC-driven Discovery sessions** — extend `POST /discover/run` to accept `source: 'gsc'`, plumb through to the probe pipeline. UI source picker.

**v2.3: Snapshot-mining source** — `source: 'snapshot'` in both standing suggestions and Discovery sessions.

**v2.4: Hybrid auto + dismissal model** — composite scoring, `dismissed_query_suggestions` table, dismissal UI/CLI.

Each is a single PR. Order matters: v2.1 → v2.2 → v2.3 → v2.4. Each adds capability without breaking prior surfaces.

### 4.10 Tests

For each source's pure function (in `packages/intelligence/test/`):

**GSC source (`gsc-source.test.ts`):**
1. Empty input → empty list.
2. Project with 1 GSC row above min → 1 candidate; evidence matches row.
3. Tracked query in GSC → excluded.
4. Jaccard ≥0.9 vs tracked → excluded.
5. Pure-brand query → excluded.
6. Dismissed → excluded.
7. Confidence bands: 100imp×5d=high, 30imp×3d=medium, 10imp×3d=low.
8. Sort by impressions DESC.
9. Multiple-row aggregation (same query across multiple pages → sum impressions).
10. Day-count = distinct dates with ≥1 impression.

**Snapshot source (`snapshot-source.test.ts`):**
Same invariants as the original Query Expansion tests (sections 4.8 in the old plan), with `source: 'snapshot'` tagging.

**Hybrid merge (`hybrid-merge.test.ts`):**
1. Two sources both surface same canonical query → one candidate with both evidence fields populated.
2. Composite score = weighted sum; weights configurable.
3. Multi-source corroboration → confidence bump.
4. Source-specific dedup against tracked basket and dismissed list.
5. Probe-budget priority sort.

**Integration tests:**
1. `POST /discover/run` with `source: 'gsc'` produces a session with `source: 'gsc'` on the row; standing-suggestions decrement.
2. Standing-suggestions endpoint reads from cached GSC data (no live Google API call).
3. Dismissal: `POST /query-suggestions/dismiss` → next standing-suggestions call omits it.

### 4.11 Risks specific to Discovery v2

- **Migration ordering.** `dismissed_query_suggestions` table is a v2.4 add. v2.1-v2.3 must filter against it conditionally (`if table exists`). **Mitigation:** ship dismissal in v2.1 — it's small, and makes every subsequent slice cleaner. Actually let me move it to v2.1.
- **Composite score tuning.** Default weights (`0.6/0.3/0.1`) are guesses. Surface in config; revisit after seeing real distributions.
- **GSC connection prerequisite for v2.1.** Projects without GSC see only the snapshot card, which won't have many candidates for new projects (few runs = few snapshots). **UX:** empty-state copy "Connect GSC for better suggestions →" with deep link to the existing GSC connect flow.

---

## 5. Phasing & PR sequence

Ship in five focused PRs, each independently mergeable. Don't bundle.

### PR-1: Retrieval Share

- Highest leverage (replaces the misleading SoV)
- Smallest blast radius (one new metric, no UX paradigm shift)
- Self-contained: no downstream feature depends on it
- **Acceptance bar:** all 12+ unit tests pass, integration test confirms end-to-end, Retrieval Share reads sensibly on the ainyc project after deploy (`curl /overview | jq '.scores.retrievalShare'`).

### PR-2: Mention Share

- Builds on PR-1's competitor-domain plumbing (no overlap, but it's already there)
- Adds the head-to-head competitive metric
- Surfaces in the at-risk row, not hero — pure secondary signal
- **Acceptance bar:** competitor token-match invariants hold, "no competitors configured" state surfaces sanely

### PR-3: Standing suggestions panel (Discovery v2.1)

- Highest UX leverage of the Discovery rework — zero-friction GSC suggestions
- New endpoint `/projects/:name/query-suggestions`, new Settings-tab panel, new CLI `canonry queries suggested`
- Includes `dismissed_query_suggestions` table + dismissal API (small enough to bundle; saves a follow-up migration)
- **Acceptance bar:** ainyc project with GSC connected shows ≥3 real candidates after deploy; "Track 2 selected" actually adds them; dismissed query doesn't resurface

### PR-4: Multi-source Discovery sessions (Discovery v2.2 + v2.3)

- Extend `POST /discover/run` with `source: 'gsc' | 'snapshot' | 'auto'`
- Source picker in Discovery UI with candidate counts
- **Acceptance bar:** all three sources produce sensible session candidates on the ainyc project; existing ICP flow unchanged

### PR-5: Hybrid auto + composite scoring (Discovery v2.4)

- Cross-source merge, composite-score ranking, configurable weights
- "Auto" becomes the default source for new sessions
- **Acceptance bar:** hybrid session on ainyc produces a superset of single-source results with no duplicates; corroborated candidates show multi-evidence in the preview

Each PR is gated by:
- Pure-function unit tests (the metric/source's correctness contract)
- Composites or routes integration test (DB-shape → metric/source end-to-end)
- Lint + typecheck workspace-clean
- Manual verification on the live ainyc project post-deploy

---

## 6. Overall architecture notes

### 6.1 Where each thing lives

```
packages/intelligence/src/
  retrieval-share.ts             ← Metric 1
  mention-share.ts               ← Metric 2
  brand-mention-match.ts         ← shared brand-token helper (consolidated)
  query-normalize.ts             ← normalization + Jaccard helpers (shared by all 3 sources)
  query-discovery-sources/
    gsc-source.ts                ← Source B
    snapshot-source.ts           ← Source C
    hybrid-merge.ts              ← Source D

packages/db/src/
  schema.ts                      ← + dismissed_query_suggestions
  migrate.ts                     ← + migration version

packages/contracts/src/
  composites.ts                  ← + RetrievalShareDto, MentionShareDto
  discovery.ts                   ← + QueryCandidateDto, QuerySuggestionsResponseDto, extend DiscoveryRunRequestDto

packages/api-routes/src/
  composites.ts                  ← Wire Retrieval Share + Mention Share into /overview
  discovery/
    routes.ts                    ← Extend /discover/run with source picker
    orchestrate.ts               ← Multi-source seed handling
    standing-suggestions.ts      ← NEW route
    dismissals.ts                ← NEW route

packages/canonry/src/
  discovery-run.ts               ← buildDefaultDeps with GSC + snapshot fetchers
  commands/queries.ts            ← `canonry queries suggested`
  commands/discover.ts           ← `--source` flag
  mcp/tool-registry.ts           ← + canonry_query_suggestions_list, canonry_query_dismiss

apps/web/src/
  pages/ProjectPage.tsx          ← Render Retrieval Share in hero (replace SoV); Mention Share in at-risk
  components/project/
    StandingSuggestionsPanel.tsx ← NEW (Settings tab)
    DiscoverySection.tsx         ← extend with source picker
```

### 6.2 What we deprecate

PR-1 **removes the current SoV** (`buildShareOfVoice`) entirely. It was a soft-ship; nothing relies on it externally, no migration needed. The hero row that currently renders SoV gets replaced by Retrieval Share. Mock data updated.

If we want to keep the old function as a "Citation Share" metric (the narrow inside-the-cited-list view), surface it in the deeper analytics layer — not the hero. Decision pending; leaning toward dropping it since Retrieval Share subsumes the use case.

### 6.3 Backwards compatibility

All DTO changes are additive. Older API clients (CLI, MCP, external) continue to work. The hero re-render is a UI change only; the underlying `/overview` payload grows. Existing Discovery sessions (created with the old single-source ICP model) continue to work — they get a default `source: 'icp'` tag added on read.

### 6.4 Telemetry

Each metric and each Discovery source, on first usage per project, emits a `telemetry.metric.first-value` event with anonymous bucket: `{ metric, valueBucket, coverageBucket }`. Lets us see across the install base whether the metrics are producing meaningful distributions vs zero / 100 / NaN clumps — which would indicate the metric is broken in the wild before users complain.

For Discovery: telemetry on source selection ratio (`{ source, sessionCount }`) and standing-suggestions adoption rate (`{ source, candidatesShown, candidatesAdded, candidatesDismissed }`). This is how we learn which source is actually pulling its weight in the field.

### 6.5 Doctor checks

Three new health checks:

- `metrics.retrieval-share.coverage` — warns if a project's last 5 runs have <50% Retrieval Share coverage.
- `metrics.mention-share.competitors` — warns if Mention Share is enabled but the project has 0 competitors configured.
- `discovery.gsc-available` — warns if GSC is connected but the project has no `gsc_search_data` rows in the last 7 days (sync may be broken; suggestions can't surface).

---

## 7. What we are explicitly NOT doing in this rework

To bound the scope:

- **Not crawling the open web.** No SERP scraping, no proxy aggregation. Every metric uses only data we already capture from provider responses + GSC.
- **Not building a "Profound competitor" market view.** Our metrics are explicitly tracked-basket-bounded, with that framing surfaced honestly.
- **Not replacing the existing ICP-driven Discovery.** v2 extends it with new input sources; ICP remains a first-class option.
- **Not deduplicating Discovery sessions across sources.** Each source produces its own session with its own probe budget; merging happens at the suggestion-aggregation layer, not the session layer.
- **Not adding new database columns to `query_snapshots`.** All metrics compute from existing data. If perf becomes an issue, we add `grounding_domains` / `competitor_mentions` columns in a future migration with backfill — not now. (The one new table is `dismissed_query_suggestions`, which is purely additive and small.)
- **Not changing Mention Coverage or Citation Coverage.** Those are the headline presence metrics and remain unchanged. The new metrics are additive nuance.

---

## 8. Open questions

Before starting PR-1, decide:

1. **Should we keep the current "Citation Share" (renamed from SoV) as a deeper analytics view?** Or fully delete it in favor of Retrieval Share? Leaning: delete; Retrieval Share is strictly more informative.

2. **Per-provider average — surface in UI or just CLI/API?** Adds visual complexity. Leaning: API-only for v1; UI consideration deferred.

3. **Coverage threshold for the warning label.** Proposing <80% for Retrieval Share, <70% for Mention Share. Verify against ainyc data after PR-1 ships.

4. **Standing-suggestions default behavior for GSC.** If a project has 50+ GSC candidates, pre-checking all of them feels presumptuous; pre-checking none feels lazy. Leaning: pre-check only `confidence: high` candidates; let operator manually check the rest.

5. **GSC lookback default.** 30 days is the standard SEO window. Verify it's sensible against ainyc's data once v2.1 ships.

6. **Composite scoring weights.** `0.6 GSC / 0.3 snapshot / 0.1 ICP` is a guess. Track adoption rate per source after v2.4 ships and re-tune.

7. **Should standing suggestions show in the Overview tab too** (as a small "X queries suggested" callout under the at-risk row), or only in Settings? UX call — leaning Settings-only to keep the Overview focused on analytics rather than configuration.

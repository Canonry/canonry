# SoV Rework — Empirical Analysis

Generated: 2026-05-16
DB: `/home/arberx/.canonry/data.db`
Projects analyzed: ainyc, demand-iq, gjelina-hotel
GSC lookback: 30 days, min impressions: 10

Source script: `scripts/sov-rework-analysis.ts` (re-runnable: `pnpm tsx scripts/sov-rework-analysis.ts --project <name>`)

---

## TL;DR — three plan assumptions confirmed wrong across all projects

After running the proposed Retrieval Share / Mention Share / Discovery v2 metrics against three projects of different maturity levels, the cross-cutting findings are:

| Finding | Evidence | Plan revision |
|---------|----------|---------------|
| **Retrieval Share ≈ Current SoV** — the "bigger universe" assumption fails because Gemini grounding URLs are opaque redirects | All 3 projects: difference is -0.2 to +0.8 percentage points | **Drop Retrieval Share.** Either fix Gemini extraction (follow redirects, slow) or accept it's redundant with Citation Share. |
| **Mention Share is the killer metric** — varies wildly across projects and surfaces real competitive position | demand-iq shows 5.2% (getting crushed: 5 mentions vs 92 competitor mentions); gjelina shows 52% (parity); ainyc shows 50% | **Promote to headline addition.** Most actionable single metric in the entire rework. |
| **Discovery v2 source value is run-count and maturity dependent** | ainyc (49 runs): snapshot mining = 53 candidates with ≥5 occurrences. gjelina (1 run): all 86 snapshot candidates have frequency=1. gjelina (mature SEO): 60 high-confidence GSC. demand-iq (mid): 7 high-confidence GSC | **No fixed "best source" exists.** Source picker must show per-source candidate counts; operator picks what's strongest for their project. |
| **GSC and snapshot mining are genuinely separate universes** | Overlap: ainyc 0, demand-iq 0, gjelina 2 of 416 | **Hybrid mode is additive, not corroborating.** Reframe: "Hybrid = union of all available sources" rather than "Hybrid = consensus." |
| **GSC noise floor is too low** | demand-iq's top GSC candidates include unrelated brand searches ("calssa", "aev solar", "doukas media") | **Raise default min-impressions to 30.** Allow tuning down per-project. |
| **Snapshot mining needs minimum frequency threshold** | gjelina with 1 run: all 86 candidates are frequency=1; pure noise | **Min frequency = 2 (default), 3 for "confident" tier.** Hide single-occurrence suggestions. |
| **Brand-token filter has gaps** | demand-iq: "demand iq" and "demandiq" both passed the filter (domain has hyphen, brand variants don't) | **Add fuzzy brand matching.** Levenshtein-3 or whitespace-collapse variants. |

---

## Cross-project comparison

| Metric | ainyc (49 runs, early) | demand-iq (3 visible runs, established) | gjelina-hotel (1 run, mature SEO) |
|--------|------------------------|------------------------------------------|------------------------------------|
| Tracked queries | 11 | 20 | 7 |
| Competitors configured | 3 | 19 | 9 |
| Snapshots in latest run | 44 | 80 | 28 |
| Retrieval Share | 3.9% | 0.5% | 2.2% |
| Current SoV (cited) | 3.1% | 0.4% | 2.4% |
| **Mention Share** | **50.0%** | **5.2%** | **52.2%** |
| Competitors mentioned | 1 of 3 | 15 of 19 | 7 of 9 |
| GSC candidates (≥10 imp) | 3 | 72 | 350 |
| GSC high-confidence | 0 | 7 | 60 |
| Snapshot-mined candidates | 2,114 | 484 | 86 |
| Snapshot candidates ≥5 occ | 53 | 0 | 0 |
| Hybrid overlap | 0 | 0 | 2 |

---

## Project: `ainyc` (early-stage AEO agency)

- **Project domains:** ainyc.ai
- **Competitors:** 3 configured — aeoagents.com, brandingnewyorkcity.com, pbjmarketing.com
- **Tracked queries:** 11
- **Latest visibility run:** 2026-05-13T06:00:00.007Z

### A. Data availability — latest run (44 snapshots)

| Provider | Snapshots | w/ Grounding | w/ SearchQueries | w/ AnswerText | Avg grounding | Avg cited | Grounding/cited ratio |
|---|---|---|---|---|---|---|---|
| `openai::gpt-5.4` | 11 | 100% (11) | 100% (11) | 100% (11) | 2.5 | 2.1 | 1.2× |
| `perplexity::sonar` | 11 | 100% (11) | 0% (0) | 100% (11) | 8.3 | 8.3 | 1.0× |
| `gemini::gemini-3-flash-preview` | 11 | 100% (11) | 100% (11) | 100% (11) | 1.0 | 6.5 | **0.2×** |
| `claude::claude-sonnet-4-6` | 11 | 100% (11) | 100% (11) | 100% (11) | 6.9 | 6.9 | 1.0× |

### B/C. Retrieval Share simulation

- **Aggregate Retrieval Share (proposed):** 3.9% (8/206 grounding slots)
- **Current SoV (cited-slot ratio, in production today):** 3.1% (8/261 cited slots)
- **Difference:** +0.8 percentage points
- **Per-provider Retrieval Share** (bias-corrected average: 4.9%): perplexity 0.0% / claude 5.3% / openai 14.3% / gemini 0.0%
- **Breakdown:** project 3.9% / competitor 4.4% / other 91.7%
- **Tone under proposed bands:** negative · **Tone under current SoV bands:** negative

### D. Mention Share simulation

- Snapshots with answer text: 44/44 (100%)
- Project brand mentions: **7 snapshots**
- Competitor brand mentions: **7 snapshots across 1 competitor** (pbjmarketing.com)
- **Mention Share (proposed): 50.0% (7/14)**

### E. GSC source — candidate volume

- GSC rows last 30d ≥10 imp: **3** (all low confidence: 29, 26, 23 impressions)
- Survivors: 3 candidates — `ai nyc`, `nyc ai`, `ai seo new york city`

### F. Snapshot mining — candidate volume

- Mined from 1,462 snapshots across 49 runs
- Distinct candidates: **2,114**
- Frequency distribution: 53 ≥5 occ · 72 3-4 occ · 147 2 occ · 1,842 1 occ

Top candidates: `AEO Agency New York City` (30), `best AEO agency New York 2025` (27), `how to appear in AI search results 2025` (27), `how to rank on ChatGPT 2025` (26)

### G. Hybrid overlap: 0 corroborated

---

## Project: `demand-iq` (B2B SaaS for contractors — established but competitive)

- **Project domains:** demand-iq.com
- **Competitors:** 19 configured
- **Tracked queries:** 20
- **Latest visibility run:** 2026-05-13T17:23:20.088Z

### A. Data availability — latest run (80 snapshots)

| Provider | Snapshots | w/ Grounding | w/ SearchQueries | w/ AnswerText | Avg grounding | Avg cited | Grounding/cited ratio |
|---|---|---|---|---|---|---|---|
| `perplexity::sonar` | 20 | 100% (20) | 0% (0) | 100% (20) | 8.9 | 8.9 | 1.0× |
| `openai::gpt-5.4` | 20 | 85% (17) | 100% (20) | 100% (20) | 3.3 | 2.8 | 1.2× |
| `gemini::gemini-3-flash-preview` | 20 | 100% (20) | 100% (20) | 100% (20) | 1.0 | 6.6 | **0.2×** |
| `claude::claude-sonnet-4-6` | 20 | 100% (20) | 100% (20) | 100% (20) | 7.6 | 7.6 | 1.0× |

### B/C. Retrieval Share simulation

- **Aggregate Retrieval Share:** 0.5% (2/406 grounding slots)
- **Current SoV:** 0.4% (2/518 cited slots)
- **Difference:** +0.1 percentage points
- **Breakdown:** project 0.5% / competitor 11.6% / other 87.9%
- Both tones: negative

### D. Mention Share simulation — the killer view

- Snapshots with answer text: 80/80 (100%)
- Project brand mentions: **5 snapshots**
- Competitor brand mentions: **92 snapshots across 15 competitors**
- **Mention Share: 5.2% (5/97)**

This is the most actionable single metric in the entire rework. demand-iq is getting **completely outclassed** in the conversation:

| Competitor | Mentions | Share of competitive total |
|---|---|---|
| roofr.com | 20 | 21.7% |
| buildxact.com | 13 | 14.1% |
| hover.to | 9 | 9.8% |
| roofsnap.com | 9 | 9.8% |
| handoff.ai | 7 | 7.6% |
| clearestimates.com | 6 | 6.5% |
| snaptimate.com | 6 | 6.5% |
| roofle.com | 6 | 6.5% |
| sumoquote.com | 3 | 3.3% |
| (10 more) | … | … |

roofr.com alone has 4× the mentions of demand-iq. This is the headline metric that would have an operator pick up the phone.

### E. GSC source — candidate volume

- GSC rows last 30d ≥10 imp: **72**
- Filtered out: 1 exact-tracked, 0 Jaccard ≥0.9, 2 pure-brand
- Survivors: 69 candidates (7 high, 16 medium, 46 low confidence)

But the top candidates are mostly brand searches or unrelated noise:

| Query | Imp | Pos | Confidence | Note |
|---|---|---|---|---|
| demand iq | 1711 | 3.6 | high | brand (filter missed it — token doesn't match domain) |
| demandiq | 681 | 3.5 | high | brand variant |
| project map it | 249 | 4.4 | high | unclear — partner product? |
| calssa | 234 | 4.5 | high | unrelated (California Solar Storage Assn?) |
| polaris seo digital marketing company | 136 | 10.0 | high | unrelated |
| hvac lead | 136 | 12.2 | high | **legit candidate** |
| demand iq login | 125 | 4.5 | high | brand variant |

**Brand-token filter needs to catch "demand iq" / "demandiq" variants of `demand-iq.com`** — these passed the filter because the domain has a hyphen but the brand mentions don't.

### F. Snapshot mining — candidate volume

- Mined from 204 snapshots across 3 runs
- Distinct candidates: **484**
- Frequency distribution: 0 ≥5 occ · 10 3-4 occ · 16 2 occ · 458 1 occ

Top snapshot candidates (max occurrences: 3) — moderately useful but volume-limited because only 3 runs:

`best contractor online estimating software 2026 official pricing features`, `best lead generation tools for roofing contractors 2026`, `instant estimate software home services 2025`, `instant estimating tool for home services 2025`, …

### G. Hybrid overlap: 0 corroborated

---

## Project: `gjelina-hotel` (mature local SEO, hospitality)

- **Project domains:** gjelinahotel.com
- **Competitors:** 9 configured
- **Tracked queries:** 7
- **Latest visibility run:** 2026-05-15T19:38:12.972Z

### A. Data availability — latest run (28 snapshots)

| Provider | Snapshots | w/ Grounding | w/ SearchQueries | w/ AnswerText | Avg grounding | Avg cited | Grounding/cited ratio |
|---|---|---|---|---|---|---|---|
| `perplexity::sonar` | 7 | 100% (7) | 0% (0) | 100% (7) | 8.7 | 8.7 | 1.0× |
| `openai::gpt-5.4` | 7 | 100% (7) | 100% (7) | 100% (7) | 2.4 | 2.4 | 1.0× |
| `gemini::gemini-3-flash-preview` | 7 | 100% (7) | 100% (7) | 100% (7) | 1.0 | 5.3 | **0.2×** |
| `claude::claude-sonnet-4-6` | 7 | 100% (7) | 100% (7) | 100% (7) | 7.1 | 7.1 | 1.0× |

### B/C. Retrieval Share simulation

- **Aggregate Retrieval Share:** 2.2% (3/135 grounding slots)
- **Current SoV:** 2.4% (4/165 cited slots) — **Retrieval Share is LOWER than current SoV** for this project
- **Difference:** −0.2 percentage points
- **Breakdown:** project 2.2% / competitor 20.7% / other 77.0%
- Both tones: negative

### D. Mention Share simulation

- Snapshots with answer text: 28/28 (100%)
- Project brand mentions: **12 snapshots**
- Competitor brand mentions: **11 snapshots across 7 competitors**
- **Mention Share: 52.2% (12/23)** — near parity, slight project lead

Per-competitor breakdown is well-distributed (top is venicevhotel.com at 3, then hotelerwin/samesun at 2). No single competitor dominates.

### E. GSC source — candidate volume (gold mine)

- GSC rows last 30d ≥10 imp: **350**
- Filtered out: 2 exact-tracked, 1 Jaccard ≥0.9, 12 pure-brand
- Survivors: **335 candidates (60 high, 124 medium, 151 low)**

Top candidates are exactly what an analyst would want to track:

| Query | Imp | Pos | Confidence |
|---|---|---|---|
| hotels venice beach | 1565 | 14.1 | high |
| hotels in venice beach ca | 1302 | 13.3 | high |
| venice beach hotels | 938 | 18.0 | high |
| hotels near venice beach | 878 | 15.7 | high |
| hotels in venice beach los angeles | 820 | 13.1 | high |
| hotels venice beach california | 617 | 12.6 | high |
| (50+ more high-confidence) | | | |

**This is the case for GSC.** Mature SEO + competitive local vertical = hundreds of high-quality candidates.

(The top 3 entries with thousands of impressions — "gjelina", "gjelina venice", "gjelina menu" — are brand searches that DID get filtered out as pure-brand. The filter works for `gjelina` because the brand matches the domain.)

### F. Snapshot mining — pure noise at this run count

- Mined from 28 snapshots across **1 run**
- Distinct candidates: 86
- **All 86 have frequency=1** — no ranking signal possible

Top candidates are coherent but every one is single-occurrence. Useless until the project has more run history.

### G. Hybrid overlap

- GSC-only: 330
- Snapshot-only: 84
- Corroborated: **2** (`boutique hotels venice beach`, `boutique hotels venice beach ca`)

The 2 corroborated candidates suggest the two sources will agree more as a project accumulates runs, but at 1 run it's basically zero.

---

## Revised plan implications

Based on these findings, the SoV rework plan needs the following changes:

### 1. Drop Retrieval Share

The grounding universe is barely larger than the cited universe — the Gemini opaque-redirect issue (`plans/ai-attribution-research.md` finding #2) means we only recover ~1 distinct domain per Gemini grounding response. Across all 3 projects the difference vs current SoV is ≤1 percentage point. The metric pretends to be different but isn't.

**Action:** remove Retrieval Share from the plan entirely. Keep the current SoV (rename to "Citation Share" so the name is honest about what it measures), don't add Retrieval Share.

### 2. Promote Mention Share to PR-1 (was PR-2)

This is empirically the most valuable single metric. demand-iq's 5.2% with 92 competitor mentions across 15 competitors is exactly the kind of headline number that justifies the whole rework — the kind of metric an analyst sees and immediately knows what to fix.

**Action:** Mention Share becomes PR-1 of the rework. Hero gauge or at-risk row card.

### 3. Discovery v2 source picker shows real candidate counts

The empirical data confirms there's no universal "best source" — it depends on run history (snapshot mining) and SEO maturity (GSC). The plan's mockup already had per-source candidate counts ("GSC has 45 ready, Observed has 12 ready") — this is correct and important. Make sure those counts are computed live from the same filters the session would apply.

**Action:** keep source-picker-with-counts UX. Add empty-state copy when the project doesn't have enough runs / GSC traffic for a source to be useful.

### 4. Tighten source filters based on observed noise

- **GSC min-impressions default:** raise from 10 to 30. Tunable.
- **GSC brand-token filter:** add fuzzy variants (whitespace-collapse, hyphen-strip) so `demandiq` matches `demand-iq.com`.
- **Snapshot mining min frequency:** add minimum frequency=2 (default) to suppress single-occurrence noise. Confidence tier = ≥3 occurrences.
- **Snapshot mining cold-start:** when a project has <5 runs, hide snapshot suggestions entirely with a "Run more sweeps to build snapshot suggestions" hint.

### 5. Reframe "Hybrid" mode

Empirically the overlap between GSC and snapshot mining is 0-2 candidates. The plan's framing of "composite scoring with weights" implied corroboration, but the data shows the two sources are mostly disjoint universes.

**Action:** rename "Hybrid auto" → "All sources combined" with copy "Shows GSC + observed in LLM searches in one list, marked by source." No composite scoring; just dedupe + tag.

### 6. Confidence tiers per source need recalibration

Current proposed thresholds (≥100 imp ≥5 days = high) are sensible for established projects but produce 0 high-confidence candidates for early-stage ones (ainyc had 0 high). Verify against more projects before locking in.

### 7. New scope: "Mention Share" deserves its own structured breakdown

The demand-iq per-competitor table (roofr.com 21.7%, buildxact.com 14.1%, …) is incredibly valuable on its own. Surface as a panel under Mention Share, not just in JSDoc.

---

## What this analysis did NOT cover

- **Per-query analysis** — we aggregated across queries. A drill-down view per query (which queries are dragging the mention share down?) is worth its own design pass.
- **Historical trend** — only the latest run was analyzed. Adding multi-week trend on Mention Share would show whether the gap is widening or closing.
- **Provider-specific behavior** — Gemini's opaque-redirect issue is documented but we didn't try following the redirects to recover the actual destination URLs. That's a separate research question (rate-limit ceiling, parse cost).
- **GSC sync freshness** — if a project's GSC sync is stale (>14 days old), the candidate list is stale too. Should surface in the UI.
- **Token-collision false positives** — Mention Share assumes brand tokens are clean signals. A spot-check on demand-iq's "hover.to" mentions (could the LLM be talking about "hover" the verb?) would validate. Worth a future deep-dive.

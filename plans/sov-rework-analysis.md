# SoV Rework — Empirical Analysis

Generated: 2026-05-16T17:35:28.265Z
DB: `/home/arberx/.canonry/data.db`
Projects analyzed: 1
GSC lookback: 30 days, min impressions: 10

---

## Project: `ainyc` (ainyc)

- **Project domains:** ainyc.ai
- **Competitors:** 3 configured — aeoagents.com, brandingnewyorkcity.com, pbjmarketing.com
- **Tracked queries:** 11
- **Latest visibility run:** 2026-05-13T06:00:00.007Z

### A. Data availability — latest run

Snapshots in latest run: 44

| Provider | Snapshots | w/ Grounding | w/ SearchQueries | w/ AnswerText | Avg grounding | Avg cited | Grounding/cited ratio |
|---|---|---|---|---|---|---|---|
| `openai::gpt-5.4` | 11 | 100% (11) | 100% (11) | 100% (11) | 2.5 | 2.1 | 1.2× |
| `perplexity::sonar` | 11 | 100% (11) | 0% (0) | 100% (11) | 8.3 | 8.3 | 1.0× |
| `gemini::gemini-3-flash-preview` | 11 | 100% (11) | 100% (11) | 100% (11) | 1.0 | 6.5 | 0.2× |
| `claude::claude-sonnet-4-6` | 11 | 100% (11) | 100% (11) | 100% (11) | 6.9 | 6.9 | 1.0× |

### B/C. Retrieval Share simulation

**Aggregate Retrieval Share (proposed):** 3.9% (8/206 grounding slots)
**Current SoV (cited-slot ratio, in production today):** 3.1% (8/261 cited slots)
**Difference:** 0.8 percentage points

**Per-provider Retrieval Share** (bias-corrected average: 4.9%):

| Provider | Slots | Share |
|---|---|---|
| `perplexity::sonar` | 91 | 0.0% |
| `claude::claude-sonnet-4-6` | 76 | 5.3% |
| `openai::gpt-5.4` | 28 | 14.3% |
| `gemini::gemini-3-flash-preview` | 11 | 0.0% |

**Breakdown:** project 3.9% / competitor 4.4% / other 91.7%
**Current SoV breakdown:** project 3.1% / competitor 5.0% / other 92.0%

**Tone under proposed bands (≥15 pos, 5-14 caution, <5 neg):** negative
**Tone under current SoV bands (≥30 pos, 10-29 caution, <10 neg):** negative

### D. Mention Share simulation

**Snapshots with answer text:** 44 / 44 (100%)
**Project brand mentions:** 7 snapshots
**Competitor brand mentions:** 7 snapshots across 1 competitors
**Mention Share (proposed):** 50.0% (7/14)

Per-competitor breakdown:
| Competitor | Mention snapshots | Share of competitive total |
|---|---|---|
| pbjmarketing.com | 7 | 100.0% |

### E. GSC source — candidate volume

GSC rows in last 30 days, ≥10 impressions: **3**
Filtered out: 0 exact-tracked, 0 Jaccard ≥0.9, 0 pure-brand
**Survivors:** 3 candidates

Confidence distribution: 0 high · 0 medium · 3 low

Top 15 GSC candidates:
| Query | Imp | Pos | Days | Confidence |
|---|---|---|---|---|
| ai nyc | 29 | 8.6 | 17 | low |
| nyc ai | 26 | 7.6 | 15 | low |
| ai seo new york city | 23 | 6.6 | 6 | low |

### F. Snapshot mining — candidate volume

Mined from 1462 snapshots across 49 runs
**Distinct candidates after filters:** 2114

Frequency distribution:
- ≥5 occurrences: 53
- 3-4 occurrences: 72
- 2 occurrences: 147
- 1 occurrence: 1842

Top 15 snapshot-mined candidates:
| Query | Occurrences | From your queries |
|---|---|---|
| AEO Agency New York City | 30 | AEO Agency in NYC / NYC AEO Agency +2 more |
| what is AEO Agency NYC | 27 | AEO Agency NYC / AEO Agency in NYC +1 more |
| best AEO agency New York 2025 | 27 | best AEO agency New York |
| how to appear in AI search results 2025 | 27 | how to appear in AI search results |
| how to rank on ChatGPT 2025 | 26 | how to rank on ChatGPT |
| optimize website for AI search 2025 | 26 | optimize website for AI search |
| how to get your business cited by AI chatbots 2025 | 24 | how to get my business cited by AI |
| AI SEO agency NYC 2026 | 21 | AI SEO agency NYC |
| AEO answer engine optimization best practices 2025 | 17 | optimize website for AI search |
| what is NYC AEO Agency | 14 | NYC AEO Agency |
| AEO agency NYC answer engine optimization agency New York | 13 | AEO Agency in NYC / AEO Agency NYC |
| best AEO agency New York Answer Engine Optimization agency NYC 2026 | 13 | best AEO agency New York |
| answer engine optimization agency New York City | 11 | AEO Agency in NYC / Answer Engine Optimization Agency NYC |
| AEO modeling agency NYC | 11 | AEO Agency in NYC / AEO Agency NYC |
| what is an AEO agency New York | 11 | best AEO agency New York |

### G. Hybrid overlap

GSC-only candidates: 3
Snapshot-only candidates: 2114
Corroborated by both: 0
Total unique hybrid candidates: 2117

---
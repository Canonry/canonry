# AEO Analysis: Interpreting Canonry Results

## What Citation Means

A "cited" keyword means the client's domain appeared in an AI provider's response when that query was asked. It does NOT mean:
- The AI recommended them positively
- The citation is prominent
- It will persist on the next sweep

A "not-cited" keyword means the AI answered without mentioning the client at all.

## Reading Evidence Output

```
✓ cited  AEO Agency NYC             ← strong signal: branded/direct match
✓ cited  AEO Agency in NYC
✗ not-cited  how to rank on ChatGPT  ← informational gap: content doesn't exist or isn't indexed
✗ not-cited  best AEO agency New York ← competitive gap: others cited instead
```

### Keyword Categories

**Branded/direct keywords** (e.g., "AEO Agency NYC"):
- If cited: good — entity is established for core queries
- If not cited: urgent — something is broken at a fundamental level

**Competitive keywords** (e.g., "best AEO agency New York"):
- If not cited: check who IS cited — competitor analysis needed
- These are harder wins; require established authority

**Informational/how-to keywords** (e.g., "how to get cited by AI"):
- If not cited: almost always a content gap — page for this topic doesn't exist or isn't indexed
- These are high-leverage — informational content positions a site as authoritative

## Diagnosing Citation Gaps

### Step 1: Check indexing first
Not cited ≠ bad content. Often the page just isn't indexed yet.
```bash
canonry google coverage <project>
```
If key pages are "unknown to Google," submit them before drawing conclusions.

### Step 2: Check if content exists
Is there a page on the site targeting that keyword? If not, that's the gap — not a canonry config issue.

### Step 3: Check competitors
For competitive keywords, if others are cited and the client isn't, compare:
- Do competitors have more specific, dedicated pages?
- Do they have better schema/structured data?
- Are they more established in Google's index?

### Step 4: Check across providers
Not all providers cite the same way. Gemini and OpenAI may cite a domain while Claude doesn't, or vice versa. Check `--format json` for per-provider breakdown.

## Trend Interpretation

**Stable cited**: No action needed. Monitor for regressions.

**New citation (was not-cited, now cited)**: Win. Correlate with what changed — new content, indexing, schema update. Document it.

**Regression (was cited, now not-cited)**: Investigate immediately.
- Did a competitor page launch?
- Did a page go down or get deindexed?
- Did the model update?

**Fluctuation (cited in some runs, not others)**: Normal for competitive keywords. Track trend over 5+ runs before drawing conclusions.

## What to Recommend

### Low overall citation (< 50%)
1. Audit indexing — `canonry google coverage`
2. Submit unindexed pages to Google Indexing API
3. Submit sitemap to Bing WMT + IndexNow
4. Check if core pages have proper schema (use aeo-audit skill)
5. Identify which keywords have no corresponding page → content gap

### Branded terms not cited
This is a red flag. Check:
- Is the homepage indexed?
- Is there an `llms.txt`?
- Does schema include `LocalBusiness`/`Organization` with the exact brand name?

### Informational terms not cited
Content strategy play:
- Does the page exist? If not, create it.
- Is it indexed? If not, submit it.
- Is it structured for AI extraction? (FAQ schema, clear H2s, definition-style answers)

## The AEO Timeline Reality

- Site changes → takes weeks/months to appear in sweeps (or never)
- Google indexing → 24–72h for Indexing API, longer for organic
- Bing indexing → hours with IndexNow, days without
- Model training updates → unknown schedule, outside our control

Never say "run a sweep to see if it worked." Always say "this positions the site correctly — sweeps will tell us when/if that pays off."

## ainyc.ai Citation State (as of 2026-03-18)

**Cited (4/11):**
- AEO Agency NYC
- AEO Agency in NYC
- Answer Engine Optimization Agency NYC
- NYC AEO Agency

**Not cited (7/11):**
- AI SEO agency NYC
- best AEO agency New York
- generative engine optimization agency NYC
- how to rank on ChatGPT
- how to get my business cited by AI
- how to appear in AI search results
- optimize website for AI search

**Analysis:** Branded/location terms solid. Informational/how-to terms are a content gap — several target pages exist (`/aeo-methodology`, `/how-to-choose-an-nyc-aeo-agency`, blog posts) but are not yet indexed by Google (all "unknown to Google" as of 2026-03-18). These should move once Google crawls them.

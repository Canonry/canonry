# AEO Analysis: Interpreting Canonry Results

## What Citation Means

A "cited" keyword means the client's domain appeared in an AI provider's response when that query was asked. It does NOT mean:
- The AI recommended them positively
- The citation is prominent
- It will persist on the next sweep

A "not-cited" keyword means the AI answered without mentioning the client at all.

## Reading Evidence Output

```
✓ cited  AEO Agency NYC             ← branded/direct match
✓ cited  best plumber brooklyn
✗ not-cited  how to fix a leaky faucet  ← informational gap: no page for this topic
✗ not-cited  emergency plumber near me  ← competitive gap: others cited instead
```

### Keyword Categories

**Branded/direct keywords** (e.g., "[business name] [city]"):
- If cited: good — entity is established for core queries
- If not cited: urgent — something broken at a fundamental level (indexing, schema, llms.txt)

**Competitive keywords** (e.g., "best [service] [city]"):
- If not cited: check who IS cited — competitor analysis needed
- Harder wins; require established authority and trust signals

**Informational/how-to keywords** (e.g., "how to [do X]"):
- If not cited: almost always a content gap — no page targeting this topic, or it's not indexed
- High-leverage — informational content positions a site as authoritative to AI models

## Using Analytics

### Citation Rate Trends (`--feature metrics`)
Shows citation rate over time across providers. Use to identify:
- Improving or declining visibility trends
- Provider-specific performance differences
- Impact of content/indexing changes over time

**Key phrase normalization:** When new key phrases are added to a project mid-history, canonry automatically normalizes each time bucket to only include key phrases that existed before that bucket started. This prevents newly-added (typically uncited) key phrases from creating a false drop in the citation rate trend. The chart displays dashed vertical annotation lines at points where key phrases were added (e.g. "+3 kp"), and each bucket's tooltip shows the key phrase count ("kp") used for that bucket's calculation.

### Gap Analysis (`--feature gaps`)
Categorizes keywords as cited, gap (competitor cited but you're not), or uncited (nobody cited). Priorities:
- **Gap keywords** are highest priority — competitors are winning these
- **Uncited keywords** may need content or may be too broad

### Source Breakdown (`--feature sources`)
Shows which source categories AI models cite for your keywords. Helps identify:
- Whether competitors dominate specific categories
- Content format opportunities (FAQ, how-to, comparison pages)

## Diagnosing Citation Gaps

### Step 1: Check indexing first
Not cited ≠ bad content. Often the page isn't indexed yet.
```bash
canonry google coverage <project>
```
If key pages are "unknown to Google," submit them before drawing conclusions.

### Step 2: Check if content exists
Is there a page on the site targeting that keyword? If not, that's the gap — not a canonry or provider issue.

### Step 3: Check competitors
For competitive keywords, if others are cited and the client isn't:
- Do competitors have more specific, dedicated pages?
- Do they have stronger schema/structured data?
- Are they more established in the index?

Run `canonry evidence <project> --format json` and check `competitorOverlap` in snapshots.

### Step 4: Check across providers
Gemini, OpenAI, Claude, and Perplexity may behave differently. One citing a domain while another doesn't is normal — each has its own knowledge base and update schedule.

### Step 5: Check analytics trends
```bash
canonry analytics <project> --feature gaps --window 30d
```
Look for patterns: are gaps growing or shrinking? Are new competitors appearing?

### Step 6: Check GA4 traffic for impact
A lost citation isn't always a lost user. Before declaring a regression real, confirm whether AI-referral traffic actually fell on the same window:
```bash
canonry ga status <project>                          # confirm lastSyncedAt is recent; re-sync if stale
canonry ga ai-referral-history <project> --format json
                                                      # daily {date, source, medium, attribution, sessions, users}
canonry ga attribution <project> --trend             # 7d/30d direction per channel + biggest mover
```
Read the result against the citation loss window:
- **AI sessions flat or up** → the citation loss may be sweep-side noise (provider variance, query refresh). Track for one more cycle before alarming the client.
- **AI sessions dropped on the same date** → real outage; escalate. Cross-reference `aiReferrals[]` from `canonry ga traffic` to identify which provider lost traffic.
- **Organic dropped but AI held** → the citation loss is masking a separate indexing issue. Re-run Step 1.

GA4 also covers the inverse case: a *gain* on `attribution --trend` for the AI channel that isn't reflected in citation count usually means a provider expanded an existing citation's exposure (more queries triggering it) — a quiet win worth flagging in the next report.

## Trend Interpretation

**Stable cited** — monitor for regressions, no action needed.

**New citation** (was not-cited, now cited) — win. Correlate with what changed: new content, indexing, schema update.

**Regression** (was cited, now not-cited) — investigate immediately:
- Did a competitor page launch?
- Did the page get deindexed or go down?
- Did the model update?
- Check `canonry google deindexed <project>` for index losses

**Fluctuation** (cited in some runs, not others) — normal for competitive keywords. Track trend over 5+ runs before drawing conclusions. AI answers are non-deterministic.

## What to Recommend

### Low overall citation (< 50%)
1. Audit indexing — `canonry google coverage <project>`
2. Submit unindexed pages to Google Indexing API
3. Submit sitemap to Bing WMT + send IndexNow batch
4. Check core pages for schema (LocalBusiness / Organization / FAQPage)
5. Map uncited keywords to pages — which have no corresponding page?

### Branded terms not cited
Red flag. Check:
- Is the homepage indexed?
- Does `llms.txt` exist and list the business clearly?
- Does schema include the exact brand name in `name` field?

### Informational terms not cited
Content strategy play:
- Does a page targeting this topic exist? If not, create it.
- Is it indexed? If not, submit it.
- Is it structured for AI extraction? (FAQ schema, clear H2s, definition-style answers)

### Provider variance (cited on one, not others)
Expected — each provider has independent knowledge. Focus on the ones that matter most for the client's audience. Don't over-optimize for one provider at the expense of others.

## The AEO Timeline Reality

- Site changes → weeks/months to appear in sweeps (or never)
- Google indexing → 24–72h with Indexing API, longer organic
- Bing indexing → hours with IndexNow, days without
- Model training updates → unknown schedule, outside our control

**Never say:** "Deploy this and re-run canonry to see if it worked."
**Always say:** "This positions the site correctly. Canonry will tell us if/when that pays off."

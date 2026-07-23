# AEO Analysis: Interpreting Canonry Results

Canonry tracks two independent signals per (query × provider): **mention** (the brand is named in the AI answer text, `answerMentioned`) and **citation** (the domain appears in the grounding sources, `cited`/`citedDomains`). **Mention is the primary read; citation is secondary.** Never compute one from the other, and never coerce `answerMentioned` null → false — null means "not checked," not "not mentioned."

## What Mention Means

A "mentioned" query means the client's brand was NAMED in the AI provider's answer text when that query was asked — the model said the brand out loud in its prose. This is the primary gauge of AI visibility: it is what the user actually reads. It does NOT mean:
- The AI recommended them positively (it may name them neutrally or unfavorably)
- The brand was the headline answer
- It will persist on the next sweep

A "not-mentioned" query means the answer text never named the client. `answerMentioned = null` is distinct: the mention was not checked for that snapshot — treat it as missing, not negative.

**Mention share** is the competitive read: of all brand names appearing across the answer set (the project plus tracked competitors), the fraction that were the project = AI share-of-voice. A competitor taking mention share on a query you used to own is the highest-signal regression.

### First diagnostic read (mention-first)

```bash
cnry get <project> scores.mentionCoverage.value     # mention rate (primary)
cnry get <project> scores.mentionShare.value        # mention share / AI share-of-voice (primary)
cnry analytics <project> --feature gaps             # mentionGap[] / notMentioned[] (who's named instead of you)
```

Read citation as the secondary lens only after the mention read:

```bash
cnry get <project> scores.citationCoverage.value    # cited rate (secondary)
```

## What Citation Means

A "cited" query means the client's domain appeared in an AI provider's grounding sources when that query was asked — the structured source list, not the prose. It is the **secondary** signal. It does NOT mean:
- The AI recommended them positively
- The citation is prominent
- It will persist on the next sweep
- That the brand was also mentioned in the answer text (citation and mention are independent — a model can cite the domain without naming the brand, and vice versa)

A "not-cited" query means the AI answered without grounding on the client's domain.

## Reading Evidence Output

`cnry evidence` renders a two-glyph cell per (query × provider): `[C/c][M/m]` — uppercase = present, lowercase = absent, `–` = no snapshot. **C/c = cited** (secondary), **M/m = mentioned** (primary). Always print the legend before the table; never collapse the two signals into one cell. Lead your interpretation with the mention glyph.

```
Legend: [C/c][M/m]  C=cited c=not-cited  M=mentioned m=not-mentioned  –=no snapshot

[C][M]  AEO Agency NYC             ← mentioned AND cited: branded/direct match, fully visible
[c][M]  best plumber brooklyn      ← mentioned but NOT cited: named in the answer, domain not in sources (mention win, citation gap)
[C][m]  ai seo tools               ← cited but NOT mentioned: domain grounded, brand never named (citation without share of voice)
[c][m]  how to fix a leaky faucet  ← neither: informational gap, no page for this topic
[c][m]  emergency plumber near me  ← neither: competitive gap, others mentioned/cited instead
```

The summary line reports each signal independently: `Mentioned: X / Y` (primary) and `Cited: X / Y` (secondary) — a query can be one, both, or neither.

### Query Categories

**Branded/direct queries** (e.g., "[business name] [city]"):
- If mentioned: good — the engine names you for your own core queries (and check the citation as the secondary confirmation)
- If not mentioned: urgent — the engine won't even say your name; something broken at a fundamental level (indexing, schema, llms.txt). Losing the citation for your own name is the secondary signal on the same query.

**Competitive queries** (e.g., "best [service] [city]"):
- If not mentioned: check who IS mentioned (mention share) — competitor analysis needed. Then check who is cited as the secondary lens.
- Harder wins; require established authority and trust signals

**Informational/how-to queries** (e.g., "how to [do X]"):
- If not mentioned (and not cited): almost always a content gap — no page targeting this topic, or it's not indexed
- High-leverage — informational content positions a site as authoritative to AI models, earning the mention first and the citation second

## Using Analytics

### Mention + Citation Rate Trends (`--feature metrics`)
`BrandMetricsDto` returns both `mentionTrend` (primary) and `trend` (the citation trend, secondary) over time across providers. Read mention first. Use to identify:
- Improving or declining mention trends (does the engine name you more or less often?), then citation trends
- Provider-specific performance differences
- Impact of content/indexing changes over time

**Query normalization:** When new queries are added to a project mid-history, canonry automatically normalizes each time bucket to only include queries that existed before that bucket started. This prevents newly-added (typically not-yet-mentioned/uncited) queries from creating a false drop in the rate trend. The chart displays dashed vertical annotation lines at points where queries were added (e.g. "+3 q"), and each bucket's tooltip shows the query count ("q") used for that bucket's calculation.

### Gap Analysis (`--feature gaps`)
`GapAnalysisDto` returns mention buckets — `mentionedQueries[]`, `mentionGap[]` (a competitor is mentioned but you're not), `notMentioned[]` (nobody named) — alongside the cited buckets (`cited[]`, `gap[]`, `uncited[]`). Read the mention buckets first. Priorities:
- **`mentionGap[]` queries** are highest priority — competitors are taking mention share (AI share-of-voice) you're not winning
- **`notMentioned[]` queries** may need content or may be too broad
- The cited `gap[]` / `uncited[]` buckets are the secondary lens on the same queries

### Source Breakdown (`--feature sources`)
Shows which source categories AI models cite for your queries. Helps identify:
- Whether competitors dominate specific categories
- Content format opportunities (FAQ, how-to, comparison pages)

### Winnability gate + briefs (`canonry content targets|map|brief`)
Every content target carries a deterministic `winnabilityClass`: **ownable** (worth writing for) or **ceded** (the cited surface is dominated by aggregators/OTAs or editorial media, a head term first-party content cannot realistically win). It is derived (no LLM) by classifying each cited domain through the shared surface classifier (own > tracked competitor > stored discovery class > static allow-list), so well-known aggregators/editorial cede immediately, no discovery run required. **`canonry discover run`** improves recall for niche domains the allow-list misses; a target only fails open to `ownable` when none of its cited surface is recognized. `canonry doctor --project <project> --check content.winnability.coverage` reports recognized-coverage of the cited surface and, when the project has no ICP, nudges you to set one (discovery needs it).
- `canonry content targets <project> --ownable` — the winnable shortlist (ownable rows sort first by default).
- `canonry content map <project>` — the winnability map: which cited surfaces are ceded vs the ranked ownable targets.
- `canonry content brief <project> <targetRef>` — synthesize a structured brief (angle, why-winnable, schema hookup) for an **ownable** target. Ceded targets are rejected — don't chase them.
Recommend briefs only for ownable targets; for ceded head terms, advise earning placement on the aggregator/editorial surface instead of writing a competing page.

## Diagnosing Mention + Citation Gaps

### Step 0: Read the mention signal first
Before anything else, separate the two signals. `cnry analytics <project> --feature gaps` tells you whether the query is in `notMentioned[]` (the engine never names you), `mentionGap[]` (a competitor is named instead), or only in the cited `gap[]`/`uncited[]` (a citation gap while the mention may hold). The fix priority follows the mention: earn the name first, the source citation second. `answerMentioned = null` means the snapshot wasn't checked — re-run, don't read it as not-mentioned.

> **Known gap:** `cnry health` is citation-only today (no mention dimension). For the mention-first read, use `cnry overview` / `cnry get <project> scores.mentionCoverage.value` / `cnry get <project> scores.mentionShare.value` until health is extended.

### Step 1: Check indexing
Not mentioned / not cited ≠ bad content. Often the page isn't indexed yet, which starves both signals.
```bash
cnry google coverage <project>
```
If key pages are "unknown to Google," submit them before drawing conclusions.

### Step 2: Check if content exists
Is there a page on the site targeting that query? If not, that's the gap — not a canonry or provider issue.

### Step 3: Check competitors
For competitive queries, if others are mentioned/cited and the client isn't (check mention share first, cited domains second):
- Do competitors have more specific, dedicated pages?
- Do they have stronger schema/structured data?
- Are they more established in the index?

Run `cnry evidence <project> --format json` and check `competitorOverlap` in snapshots.

### Step 4: Check across providers
Gemini, OpenAI, Claude, and Perplexity may behave differently. One citing a domain while another doesn't is normal — each has its own knowledge base and update schedule.

### Step 5: Check analytics trends
```bash
cnry analytics <project> --feature gaps --window 30d
```
Look for patterns: are gaps growing or shrinking? Are new competitors appearing?

### Step 6: Check GA4 traffic for impact
A lost mention (or lost citation) isn't always a lost user. Before declaring a regression real, confirm whether AI-referral traffic actually fell on the same window:
```bash
cnry ga status <project>                          # confirm lastSyncedAt is recent; re-sync if stale
cnry ga ai-referral-history <project> --format json
                                                      # daily {date, source, medium, attribution, sessions, users}
cnry ga attribution <project> --trend             # 7d/30d direction per channel + biggest mover
```
Read the result against the citation loss window:
- **AI sessions flat or up** → the citation loss may be sweep-side noise (provider variance, query refresh). Track for one more cycle before alarming the client.
- **AI sessions dropped on the same date** → real outage; escalate. Cross-reference `aiReferrals[]` from `cnry ga traffic` to identify which provider lost traffic.
- **Organic dropped but AI held** → the citation loss is masking a separate indexing issue. Re-run Step 1.

GA4 also covers the inverse case: a *gain* on `attribution --trend` for the AI channel that isn't reflected in citation count usually means a provider expanded an existing citation's exposure (more queries triggering it) — a quiet win worth flagging in the next report.

## Trend Interpretation

Read transitions on the mention signal first (primary), then the citation signal (secondary). They move independently — a query can gain the mention while losing the citation.

**Stable mentioned** — the engine keeps naming you; monitor for regressions, no action needed. (Track the cited state as the secondary confirmation.)

**New mention** (was not-mentioned, now mentioned) — primary win. Correlate with what changed: new content, indexing, schema update. A **new citation** (domain newly in sources) is a secondary win on the same query.

**Regression** — investigate immediately, leading with a **lost mention** (was mentioned, now not). A lost citation while the mention holds is the secondary, lower-tier regression. Either way:
- Did a competitor take the mention share (`mentionGap[]`)?
- Did a competitor page launch?
- Did the page get deindexed or go down?
- Did the model update?
- Check `cnry google deindexed <project>` for index losses

**Fluctuation** (mentioned/cited in some runs, not others) — normal for competitive queries. Track the trend over 5+ runs before drawing conclusions. AI answers are non-deterministic.

## What to Recommend

### Low overall mention rate (< 50%)
Mention rate is the primary KPI — fix this before cited rate.
1. Audit indexing — `cnry google coverage <project>` (an unindexed page can't be named or cited)
2. Submit unindexed pages to Google Indexing API
3. Submit sitemap to Bing WMT + send IndexNow batch
4. Check core pages for schema (LocalBusiness / Organization / FAQPage) so the brand name is unambiguous
5. Map `notMentioned[]` / `mentionGap[]` queries to pages — which have no corresponding page, and who is named instead?

A low cited rate while the mention rate holds is the secondary problem: the engine names you but grounds on other sources — pursue the citation (schema, llms.txt, indexing) after the mention is secured.

### Branded terms not mentioned
Red flag — the engine won't even say your name. Check (the lost citation for your own name is the secondary signal here):
- Is the homepage indexed?
- Does `llms.txt` exist and list the business clearly?
- Does schema include the exact brand name in `name` field?
- Is a brand alias missing? (`spec.brandAliases` widens the `answerMentioned` detector for variants like "Acme Cloud" vs "AcmeCloud".)

### Informational terms not mentioned
Content strategy play:
- Does a page targeting this topic exist? If not, create it — give the engine a reason to name you.
- Is it indexed? If not, submit it.
- Is it structured for AI extraction? (FAQ schema, clear H2s, definition-style answers)

### Provider variance (mentioned/cited on one, not others)
Expected — each provider has independent knowledge. Focus on the ones that matter most for the client's audience. Don't over-optimize for one provider at the expense of others.

## The AEO Timeline Reality

- Site changes → weeks/months to appear in sweeps (or never)
- Google indexing → 24–72h with Indexing API, longer organic
- Bing indexing → hours with IndexNow, days without
- Model training updates → unknown schedule, outside our control

**Never say:** "Deploy this and re-run canonry to see if it worked."
**Always say:** "This positions the site correctly. Canonry will tell us if/when that pays off."

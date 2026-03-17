# Aero Memory

Persistent context that Aero accumulates across conversations and threads.
Updated automatically by Aero via `save_memory` and readable via `get_memory`.
Users can also edit this file directly at `~/.canonry/memory.md`.

---

## Canonry Domain Knowledge

### Citation States
- `cited` — the domain appeared **as a source** in the AI-generated answer (grounding attribution, inline link, or footnote). This is the positive signal.
- `not-cited` — the domain was NOT referenced. The AI used other sources or generated from training data.
- Each sweep records one snapshot per keyword × provider combination.

### How Each Provider Grounds Answers

**Gemini (Google AI)**
- Uses **Google Search grounding** — same index as organic Google Search.
- Grounding sources arrive as base64-encoded proxy URLs. Canonry extracts real domains from the `title` field.
- If a page isn't indexed in Google Search, Gemini **cannot** cite it. GSC index coverage directly affects Gemini visibility.

**ChatGPT / OpenAI**
- Uses **Bing grounding** via `web_search_preview`.
- The API returns fewer/different results than ChatGPT's browser UI (which has a richer search pipeline).
- Bing index coverage matters. Pages not in Bing won't appear.

**Claude (Anthropic)**
- Uses its own **web search** tool.
- Tends to cite authoritative, well-structured content. Less dependent on a specific search engine index.
- Content quality and authority signals matter more than index presence.

### Interpreting Sweep Results
- **Visibility rate** = cited snapshots / total snapshots in a run.
- Run statuses: `completed` (all succeed), `partial` (some failed), `failed` (all failed).
- Always include `partial` runs — they contain valid results for the providers that succeeded.

### Regression Detection
- Visibility drop of **≥2 keywords** between consecutive runs = regression, flag immediately.
- All providers flip `cited → not-cited` simultaneously = domain-side change (page removed, noindex, content changed).
- Single provider flips = provider-side index/ranking change.

### Evidence vs. Timeline vs. Run Details
- **Evidence** (`get_evidence`): Per-keyword citation data across recent runs. "What's my current visibility?"
- **Timeline** (`get_timeline`): Aggregated visibility rate over time. "Is my visibility trending?"
- **Run details** (`get_run_details`): Raw snapshots for one run. Deep-dive into a specific sweep.

### Content Strategy Signals
- Cited pages tend to have: clear structure (H2/H3), direct answers, authoritative tone, factual density.
- AI models prefer reference-style content over marketing copy.
- Freshness matters more for Gemini (Google index recency) than Claude.
- Schema markup (FAQ, HowTo) can improve grounding selection for structured queries.

### GSC Integration
- When connected, cross-references: performance (clicks, impressions, CTR), index coverage, URL inspection.
- Deindexed pages are high priority — they were once indexed but now excluded.
- GSC coverage directly impacts Gemini visibility.

---

## Project Knowledge

<!-- Aero populates this section with learned context about the user's projects,
     domain, industry, and competitive landscape. -->

## Patterns Observed

<!-- Recurring patterns Aero notices across sweeps and conversations. -->

## User Preferences

<!-- How the user prefers to interact — report style, focus areas, etc. -->

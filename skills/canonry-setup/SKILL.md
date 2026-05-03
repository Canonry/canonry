---
name: canonry
description: "Agent-first AEO operating platform."
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
              "package": "@ainyc/canonry",
              "bins": ["canonry"],
              "label": "Install canonry globally",
              "command": "npm install -g @ainyc/canonry"
            },
            {
              "id": "npx",
              "kind": "npx",
              "package": "@ainyc/canonry",
              "bins": ["canonry"],
              "label": "Run canonry via npx",
              "command": "npx @ainyc/canonry@latest init"
            }
          ],
      },
  }
---

# Canonry

Agent-first open-source AEO (Answer Engine Optimization) operating platform. Track how AI answer engines cite your domain across Gemini, ChatGPT, Claude, and Perplexity, then act on the signal through the content engine and integrations.

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

## How to Operate

A canonry engagement follows the same loop regardless of project size:

1. **Diagnose** — Run a baseline sweep (`canonry run <project> --wait`) and a technical audit (`npx @ainyc/aeo-audit@latest <url> --format json`). See `references/aeo-analysis.md` for interpretation.
2. **Prioritize** — Triage by impact: indexing gaps → schema gaps → content gaps → keyphrase strategy. Branded-term losses are urgent.
3. **Execute** — Apply fixes via the canonry CLI or platform integrations. See `references/canonry-cli.md` for the full command catalog and `references/wordpress-integration.md` for the WordPress workflow.
4. **Monitor** — Re-run sweeps weekly. Correlate visibility shifts with deployments and competitor moves.
5. **Report** — Lead with data, not interpretation: "Lost `<keyword>` on Gemini between <date> and <date> — two competitors moved in. Here's what to fix."

## Common Starting Points

- **New site, 0 citations** → submit to GSC/Bing first; basic LocalBusiness/Service schema; `llms.txt`; trim to 8–12 high-intent keyphrases. See `references/indexing.md`.
- **Established site, regression** → diff canonry runs to find the loss window; verify schema is intact; resubmit affected URLs. See `references/aeo-analysis.md`.
- **Multi-county targeting** → reference counties in `areaServed` schema and `llms.txt`; do not split into per-county keyphrases until base visibility exists.

## Google Analytics 4

GA4 is a first-class signal alongside citation tracking. Connect once with `canonry ga connect <project> --property-id <id> --key-file <path>`; `canonry ga sync` then pulls daily landing-page traffic, AI-referral sessions across 10 known providers (chatgpt, perplexity, claude, gemini, openai, anthropic, copilot, phind, you.com, meta.ai), and social referrals split into Organic vs Paid via GA4's `channelGroup` — and persists everything into four DB tables (`gaTrafficSnapshots`, `gaAiReferrals`, `gaSocialReferrals`, `gaTrafficSummaries`). All read commands query that local store, so they are fast and quotaless once a sync has run. AI referrals are tracked across three GA4 attribution dimensions (session source / first-user source / manual UTM) and joined to landing pages, so you can see which page each AI provider sent traffic to. Use `canonry ga traffic` for the current snapshot, `canonry ga attribution --trend` for a unified channel-share overview with biggest-mover deltas, and `canonry ga ai-referral-history` / `canonry ga social-referral-history` for daily series. See `references/canonry-cli.md` for the full command catalog and return-shape details.

## Boundaries & Safety

- **Never touch live WordPress without explicit approval**
- **Back up `~/.canonry/config.yaml` before any config edit**
- **Never fabricate citation data** — if a sweep hasn't run, say so
- **Client data stays private** — canonry repo is public; no real domains in issues
- **Respect API rate limits** — batch operations, avoid tight loops

## References

| File | Read when |
|---|---|
| `references/canonry-cli.md` | Looking up specific canonry commands or flags |
| `references/aeo-analysis.md` | Interpreting sweep output, diagnosing regressions, planning content fixes |
| `references/indexing.md` | Submitting URLs, checking GSC/Bing coverage, fixing indexing gaps |
| `references/wordpress-integration.md` | Connecting to WordPress, editing pages, pushing staging → live |

---

**Tools:** canonry v3+, @ainyc/aeo-audit v1.3+  
**Website:** [ainyc.ai](https://ainyc.ai) | **Reference:** [AINYC AEO Methodology](https://ainyc.ai/aeo-methodology)

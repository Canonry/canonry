---
name: canonry
description: "Set up and operate Canonry AEO projects: inspect mention and citation coverage, diagnose regressions, run technical audits, and act through the Canonry CLI or MCP tools."
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
              "package": "@canonry/canonry",
              "bins": ["canonry"],
              "label": "Install canonry globally",
              "command": "npm install -g @canonry/canonry"
            }
          ],
      },
  }
---

# Canonry

Agent-first open-source AEO (Answer Engine Optimization) operating platform. Track how AI answer engines **mention** your brand in answers and **cite** your domain in sources across Gemini, ChatGPT, Claude, and Perplexity, then act on the signal through the content engine and integrations.

**Website:** [canonry.ai](https://canonry.ai) | **Docs:** [github.com/Canonry/canonry](https://github.com/Canonry/canonry)

**CLI:** invoke as `cnry` (short form) or `canonry` — both ship with the npm package and are interchangeable. Examples in this skill use `cnry`.

## Runtime Preflight

Before using the native Codex or Claude Code plugin, verify the separately
installed Canonry runtime. It requires Node.js 22.14 or newer, and the native
plugin specifically needs the global package so `canonry-mcp` remains on
`PATH`; a one-off `npx` invocation is not sufficient:

```bash
node --version
command -v cnry
cnry --version
```

Then prepare the runtime in this order:

1. With approval, install the global runtime if `command -v cnry` failed.
2. Check only whether `$CANONRY_CONFIG_DIR/config.yaml` (when that variable is
   set) or `~/.canonry/config.yaml` exists; do not print the file. If it does
   not exist, pause and ask the operator to run `cnry init --skip-skills --skip-mcp`
   in their own private terminal, then confirm completion without
   pasting the output. Never execute `init` inside the agent session: it prompts
   for provider credentials and prints the new full-access API key once. The
   plugin already supplies the skills and MCP registration.
3. After a fresh initialization, get approval and run `cnry start --format
   json`; `start` waits for the health endpoint before returning. On an
   existing installation, try the doctor command first and start only when the
   transport is unavailable. Never stop or restart a healthy daemon just to
   install the plugin.
4. Run `cnry doctor --format json` after the daemon is ready. A successful JSON
   response proves the health-check path works; individual checks may still
   report actionable `warn` or `fail` statuses. Plugin installation state is
   read live, so installing the plugin alone does not require a daemon restart.

Never ask the operator to paste credentials into the chat, print the raw API
key, or inspect `~/.canonry/config.yaml` for secrets. The plugin does not expand
the configured key's server-enforced scope, but it gives the client tools that
can exercise that scope. Fresh `cnry init` creates a full-instance `*` key, so
the default plugin has teammate-level access to every project and shared
instance settings. A write-capable key exposes write tools by default; a
read-only key restricts the catalog to reads, while a project-scoped key keeps
its project route boundary but is not tenant isolation: a write-capable scoped
key can still mutate shared instance settings. Do not work around a missing
tool or `403` by switching credentials.

## When to Use

- Tracking brand **mentions** in AI answer text and **citations** in source links across providers
- Expanding the tracked-query basket from an ICP description (`cnry discover run`)
- Running technical SEO audits (14‑factor scoring)
- Implementing structured data (JSON‑LD)
- Diagnosing indexing gaps via Google Search Console / Bing Webmaster Tools
- Wiring server-side traffic (Cloud Run, WordPress, Vercel) and GA4 referrals into a single AEO signal
- Optimizing `llms.txt`, sitemaps, robots.txt for AI crawlers
- Submitting URLs to Google Indexing API and Bing IndexNow
- Analyzing competitor citation patterns
- Operating guarded ChatGPT ads lifecycle changes and reconciling unresolved mutation receipts

## Core Philosophy

- **Measure outcomes** — AI models are black boxes; track mentions + citations, don't assume causality
- **Signal over noise** — Focus on high‑intent queries; avoid granular targeting until base visibility exists
- **CLI‑native** — API‑driven changes over manual CMS clicks; faster, repeatable, auditable
- **Recover before retrying ads writes** — Page through `pending`, `unknown`, and `reconciling` receipts. Resume `campaign_tree_activate` through its bodyless exact-executor recovery operation; reconcile other supported receipts by verifying the checkpointed provider ID on the receipt-bound account. Never resend a mutation under a different key; an uncheckpointed create remains unresolved. A fresh pending generic receipt waits for its minimum-idle window, inconclusive reads back off, and a quarantined receipt requires human remediation.
- **Separate approval from ads execution** — A human with `ads.approve` creates a short-lived grant for the exact paused campaign tree and a different executor key. The operator may activate only that tree with `ads.activate`; it cannot mint or widen its own approval.

## What Canonry Measures (Vocabulary)

Two parallel signals are tracked per (query × provider) snapshot. They are independent — a model can do either, both, or neither — never conflate them.

| Term | Means | Headline metric |
|---|---|---|
| **mentioned** | The project's brand or domain appears in the LLM's **answer text** (the prose the model returns). | **Mention Coverage** — share of (query × provider) snapshots where the brand was mentioned. **Mention Share** is the project's share among the cited+mentioned set vs competitors. |
| **cited** | The project's domain appears in the LLM's **source links** (the grounding citations returned alongside the answer). | **Citation Coverage** — share of snapshots where the domain was in the source list. |

Configure `spec.brandAliases` on the project (or pass via `cnry apply`) so the mention detector catches "Meta" alongside "Facebook", etc. The downloadable report (`cnry report`) and the dashboard both lead with Mention Coverage; Citation Coverage rides as the secondary gauge.

## How to Operate

A canonry engagement follows the same loop regardless of project size:

1. **Diagnose** — After explicit approval for the quota-consuming persisted runs, run a baseline sweep (`cnry run <project> --wait`) and a technical audit (`cnry technical-aeo run <project> --wait`, then `cnry technical-aeo score <project> --format json`). The audit crawls every page in the project's sitemap (auto-discovered from `/sitemap.xml`, the sitemap index, or `robots.txt`) so readiness reflects the whole site, not just one page, and persists the score to the dashboard. Read Mention Coverage first, Citation Coverage second. See `references/aeo-analysis.md`.
2. **Prioritize** — Triage by impact: indexing gaps → schema gaps → content gaps → query strategy. Branded-term losses are urgent.
3. **Execute** — Apply fixes via the canonry CLI or platform integrations. Use `--dry-run` on supported mutations (`cnry project delete`, `cnry query replace`, `cnry backfill ...`) to preview before committing. See `references/canonry-cli.md` for the full command catalog and `references/wordpress-integration.md` for the WordPress workflow.
4. **Monitor** — Re-run sweeps weekly only through an operator-approved schedule or after fresh explicit approval (`cnry run --all --wait` fans out across every project). Correlate visibility shifts with deployments and competitor moves.
5. **Report** — Lead with data, not interpretation: "Lost the mention for `<query>` on Gemini between <date> and <date> — two competitors moved in. Here's what to fix." For a one-command client-facing summary, run `cnry report <project>` to generate a self-contained HTML bundle (mention + citation hero, competitor landscape, GSC + GA4 performance, insights, suggested next queries). Same payload is available via `--format json` and the `canonry_report` MCP tool.

**Verifying without polluting metrics**: when a test would help — "did the latest provider deploy work?", "is this regression reproducible?", "would this query actually surface us?" — propose the exact provider/query and get explicit approval before using `cnry run <project> --probe --provider <p> --query "..."`. Probe runs still cost quota and write a snapshot, but are excluded from the dashboard, analytics, intelligence, report, and notifications. Approval for one probe does not authorize repeats unless the operator approved a bounded batch; use real sweeps only when the operator wants the data to feed metrics.

## Surgical Reads

When you need a specific value rather than a full payload, use the dot-path getter:

```bash
cnry get <project> scores.mentionShare.value
cnry get <project> scores.mentionCoverage.value
cnry get <project> insights[0].severity
cnry get <project> --from report scores.citationCoverage.value
```

`cnry get` resolves a path into the project's overview (default) or any registered source (`report`, `traffic`, `discovery`, etc.). Returns scalar values without forcing the agent to grep through a 30 KB JSON dump.

## Common Starting Points

- **New site, 0 citations** → submit to GSC/Bing first; basic LocalBusiness/Service schema; `llms.txt`; trim to 8–12 high-intent queries. See `references/indexing.md`.
- **Established site, regression** → diff canonry runs to find the loss window; verify schema is intact; resubmit affected URLs. See `references/aeo-analysis.md`.
- **Empty / generic query basket** → describe the ICP and let discovery expand: `cnry discover run <project> --icp "..." --wait`, then `cnry discover promote <session-id>` to adopt the cited + aspirational queries. Multi-location projects can geo-constrain with `--locations <label,...>`.
- **Multi-county targeting** → reference counties in `areaServed` schema and `llms.txt`; do not split into per-county queries until base visibility exists.

## Google Analytics 4

GA4 is a first-class signal alongside citation tracking. Connect once with `cnry ga connect <project> --property-id <id> --key-file <path>`; `cnry ga sync` then pulls daily landing-page traffic, AI-referral sessions across 10 known providers (chatgpt, perplexity, claude, gemini, openai, anthropic, copilot, phind, you.com, meta.ai), and social referrals split into Organic vs Paid via GA4's `channelGroup` — and persists everything into four DB tables (`gaTrafficSnapshots`, `gaAiReferrals`, `gaSocialReferrals`, `gaTrafficSummaries`). All read commands query that local store, so they are fast and quotaless once a sync has run. AI referrals are tracked across three GA4 attribution dimensions (session source / first-user source / manual UTM) and joined to landing pages, so you can see which page each AI provider sent traffic to. Use `cnry ga traffic` for the current snapshot, `cnry ga attribution --trend` for a unified channel-share overview with biggest-mover deltas, and `cnry ga ai-referral-history` / `cnry ga social-referral-history` for daily series. See `references/canonry-cli.md` for the full command catalog and return-shape details.

## Server-Side Traffic

When the project ships behind a server you control, wire crawler + AI-referral evidence directly from the edge: `cnry traffic connect cloud-run | wordpress | vercel <project> ...` writes credentials to `~/.canonry/config.yaml`, `cnry traffic sync` pulls and classifies logs into hourly buckets, and `cnry traffic events / sources / status` expose the rollups. See `references/server-side-traffic.md` for adapter-specific setup.

**Vercel gotcha:** a freshly connected Vercel source captures only going-forward traffic — `lastSyncedAt` is seeded to NOW to avoid the 30-day default window exceeding Vercel's ~14-day request-logs retention (which would otherwise throw on every first sync). Use `cnry traffic backfill <project> --source <id> --days N` for historical recovery. If an idle Vercel/Cloud Run source has been failing long enough that `lastSyncedAt` aged past retention, unstick it with `cnry traffic reset <project> --source <id> --advance-to-now`.

## Local AEO (Google Business Profile)

For businesses with a physical location or service area, Google Business Profile is the local-AEO signal source — reviews, search-keyword impressions, daily performance metrics, and (for hotels) structured amenities + booking CTAs all feed how AI engines answer local-intent queries. Connect with `cnry gbp connect <project>`, discover locations with `cnry gbp locations discover <project>`, and pick which sync with `cnry gbp locations select/deselect`.

**Hard prerequisites and gotchas — read `references/google-business-profile.md` before attempting setup:** GBP requires a Google access-form approval (0 QPM until granted), the only OAuth scope is the write-capable `business.manage`, **reviews live on a separately-gated legacy v4 API that the Basic approval does NOT grant** (and can't be self-enabled), and the **Q&A API was retired (2025-11-03)**. Keyword data is heavily privacy-redacted (often 100% for small businesses); an empty place-action profile is a real AEO finding to surface, but an empty lodging result is a verify-not-a-gap (the Lodging API can return 0 readable groups even when the owner-facing "Hotel details" panel has amenities set). The reference doc has the full setup walkthrough, the real-world data shapes, and the troubleshooting matrix.

## Built-in Analyst (Aero)

Canonry ships a built-in agent — Aero — for users who don't already have one. Drive it from the CLI:

```bash
cnry agent ask <project> "what changed since the last sweep?"
cnry agent ask <project> "..." --provider claude --scope read-only
cnry agent memory list <project>          # durable project notes
```

Aero also wakes unprompted after every `run.completed` so insights and regressions get analyzed without a user click. Users who already run their own agent (Claude Code, Codex, custom) wire webhooks instead: `cnry agent attach <project> --url <webhook-url>` subscribes to `run.completed`, `insight.critical`, `insight.high`, `citation.gained`.

## Boundaries & Safety

- **Get explicit approval before every mutation or quota-consuming sweep** — reads and `--dry-run` previews are safe defaults
- **Never touch live WordPress without explicit approval**
- **Back up `~/.canonry/config.yaml` before any config edit**
- **Never fabricate mention or citation data** — if a sweep hasn't run, say so; never coerce `answerMentioned` null → false (null = "not checked")
- **Client data stays private** — canonry repo is public; no real domains in issues
- **Respect API rate limits** — batch operations, avoid tight loops

## References

| File | Read when |
|---|---|
| `references/canonry-cli.md` | Looking up specific canonry commands, flags, or JSON return shapes |
| `references/aeo-analysis.md` | Interpreting sweep output, diagnosing regressions, planning content fixes |
| `references/indexing.md` | Submitting URLs, checking GSC/Bing coverage, fixing indexing gaps |
| `references/wordpress-integration.md` | Connecting to WordPress, editing pages, pushing staging → live |
| `references/server-side-traffic.md` | Wiring server-log evidence (Cloud Run, WordPress, Vercel adapters) for AI Visibility — Server-Side. Connect, sync, manage sources, troubleshoot. |
| `references/google-business-profile.md` | Connecting Google Business Profile for local AEO: access-form approval, GCP API enablement, the v4-reviews access gate, hotel lodging/place-action signals, data shapes, troubleshooting. |

---

**Tools:** canonry v4+, @ainyc/aeo-audit v1.3+
**Website:** [canonry.ai](https://canonry.ai) | **Org:** [ainyc.ai](https://ainyc.ai) | **Reference:** [AINYC AEO Methodology](https://ainyc.ai/aeo-methodology)

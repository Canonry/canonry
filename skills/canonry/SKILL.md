---
name: canonry
description: "Operate Canonry (the `cnry` / `canonry` CLI) for AEO. Load this BEFORE any canonry operator task: creating or configuring a project, connecting GSC, GA4, Bing, Google Business Profile or a Cloudflare traffic source, running or scheduling a sweep, reading mention and citation coverage, running a technical audit, submitting sitemaps, or diagnosing why a number moved. Covers anything touching cnry, canonry doctor, ~/.canonry, @canonry/canonry, the canonry_* MCP tools, mention share, or direct-push / queue-pull traffic. Load it before acting, not after something fails."
compatibility: Requires Node.js 22.14+ and globally installed @canonry/canonry; canonry-mcp must be on PATH.
metadata:
  agent: >-
    {"emoji":"📡","requires":{"bins":["canonry"]},"install":[{"id":"npm","kind":"npm","package":"@canonry/canonry","bins":["canonry"],"label":"Install canonry globally","command":"npm install -g @canonry/canonry"}]}
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
   not exist, pause and ask the operator to run `cnry bootstrap` in their own
   private terminal, then confirm completion without pasting the output.
   Bootstrap needs no provider credential, but it prints the new full-access
   API key once. Use `cnry init` only as an optional interactive first-time
   path when the operator also wants provider/OAuth provisioning. The plugin
   already supplies the skills and MCP registration.
3. After a fresh bootstrap, get approval and run `cnry start --format
   json`; `start` waits for the health endpoint before returning. On an
   existing installation, try the doctor command first and start only when the
   transport is unavailable. Never stop or restart a healthy daemon just to
   install the plugin.
4. Run `cnry doctor --format json` after the daemon is ready. A successful JSON
   response proves the health-check path works; individual checks may still
   report actionable `warn` or `fail` statuses. No provider is a warning, not a
   failure: Page Health works without one and AI Visibility stays disabled.
   Plugin installation state is
   read live, so installing the plugin alone does not require a daemon restart.

Never ask the operator to paste credentials into the chat, print the raw API
key, or inspect `~/.canonry/config.yaml` for secrets. The plugin does not expand
the configured key's server-enforced scope, but it gives the client tools that
can exercise that scope. Fresh `cnry bootstrap` creates a full-instance `*` key.
The default plugin has teammate-level access to every project and shared
instance setting. A write-capable key exposes write tools by default; a
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
- Wiring server-side traffic (Cloudflare, Cloud Run, WordPress, Vercel) and GA4 referrals into a single AEO signal
- Inspecting Google Ads conversion goals and GTM live configuration as read-only conversion evidence
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

1. **Diagnose** — After explicit approval for the quota-consuming persisted runs, run a baseline sweep (`cnry run <project> --wait`) and a technical audit (`cnry technical-aeo run <project> --wait`, then `cnry technical-aeo score <project> --format json`). Use `cnry site-health overview <project> --format json` only to add crawl metadata; it never replaces the score. The audit discovers the in-scope site from the root, sitemaps, and internal links, persists the crawl graph and score, and keeps dead-link checks off unless explicitly requested. Read Mention Coverage first, Citation Coverage second. See `references/aeo-analysis.md`.
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

## Google Ads and GTM

Google Ads and GTM are separate, project-scoped sources for one conversion
contract. Provider snapshots are static configuration evidence. They do not
prove browser events, tag firing, or recorded conversions. Stored snapshots are
the safe default. A bounded live read needs `google-marketing.read-live`. Version
1 does not mutate Google Ads or edit, version, or publish GTM. Read
`references/google-marketing.md` before assessing or refreshing this evidence.
The operator must complete OAuth, resource selection, and contract creation.
Never request OAuth credentials or a Google Ads developer token.

## Server-Side Traffic

When the project ships behind a server you control, connect Cloud Run, WordPress,
or Vercel. `cnry traffic sync` pulls and classifies their logs into hourly
buckets. For Cloudflare, choose `direct-push` or `queue-pull` on the local,
credential-owning host. Direct push requires a public Canonry HTTPS receiver.
It does not use `traffic sync`. Queue pull sends events to a Cloudflare Queue,
then Canonry drains it through `traffic sync` and the `traffic-sync` schedule.

If the connect response reports `activationRequired`, attach the Worker route
first. Then run `cnry traffic activate <project> --source <id>`. Activation
pauses all sibling sources. It also moves the one `traffic-sync` schedule to
Queue pull. A first source becomes active automatically.

Each default Queue tick drains at most 1,000 messages. Use `cnry traffic status`
and the `traffic.source.queue-backlog` doctor check to read the backlog. If more
than 1,000 messages remain, get approval before a manual sync or a shorter
schedule interval. Use `cnry traffic events`, `cnry traffic sources`, and
`cnry traffic status` for every adapter. See
`references/server-side-traffic.md` for setup and smoke tests.

**WordPress safety:** incremental pulls are fixed `[since, until)` windows; a
new or idle source begins at the plugin's 365-day maximum retention horizon.
Canonry rejects an endpoint that returns events outside that window. Keep
existing WordPress rollups intact: generic replace-mode backfill is unavailable
until a retention-aware repair can prove coverage and declare any unrecoverable
span.

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

- **Get explicit approval before every mutation or quota-consuming sweep.** Also get approval before each live provider read. Stored reads and `--dry-run` previews are safe defaults.
- **Never touch live WordPress without explicit approval**
- **Back up `~/.canonry/config.yaml` before any config edit**
- **Never fabricate mention or citation data** — if a sweep hasn't run, say so; never coerce `answerMentioned` null → false (null = "not checked")
- **Client data stays private** — canonry repo is public; no real domains in issues
- **Respect API rate limits** — batch operations, avoid tight loops
- **Keep Google marketing read-only in v1** — stored evidence is the default.
  `google-marketing.read-live` permits bounded provider reads only. It grants no
  Google Ads mutation or GTM edit or publish authority.

## References

| File | Read when |
|---|---|
| `references/canonry-cli.md` | Looking up specific canonry commands, flags, or JSON return shapes |
| `references/aeo-analysis.md` | Interpreting sweep output, diagnosing regressions, planning content fixes |
| `references/indexing.md` | Submitting URLs, checking GSC/Bing coverage, fixing indexing gaps |
| `references/wordpress-integration.md` | Connecting to WordPress, editing pages, pushing staging → live |
| `references/server-side-traffic.md` | Wiring server-side evidence from Cloudflare, Cloud Run, WordPress, and Vercel. Connect, inspect, sync pull sources, and troubleshoot. |
| `references/google-business-profile.md` | Connecting Google Business Profile for local AEO: access-form approval, GCP API enablement, the v4-reviews access gate, hotel lodging/place-action signals, data shapes, troubleshooting. |
| `references/google-marketing.md` | Inspecting first-class Google Ads and GTM evidence. Covers the conversion-integrity chain, static and runtime truth, live-read scope, v1 read-only boundary, and future write approvals. |

---

**Tools:** canonry v4+, @canonry/aeo-audit@4
**Website:** [canonry.ai](https://canonry.ai) | **Org:** [ainyc.ai](https://ainyc.ai) | **Reference:** [AINYC AEO Methodology](https://ainyc.ai/aeo-methodology)

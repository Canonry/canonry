<!-- Generated from skills/aero/references/getting-started.md by pnpm guide:sync. Do not edit. -->

> This copy ships with the Canonry skill. The playbooks it names by slug, and
> the Aero skill it refers to, ship with the Aero skill: add them with
> `cnry skills install aero`, or read one over MCP with
> `canonry_help({playbook: "<slug>"})`.

# Getting started

Read this when the user is new to Canonry, the project has no results yet, or
the user asks what to do or what to ask next. It walks one loop from an empty
project to monthly results. Other playbooks hold the detail; this one says
which step comes next and who does it.

## How to use it

- Find the stage before advising. Read `canonry_projects_list`, then
  `canonry_project_setup` (CLI: `cnry project setup <project>`). While its
  `complete` is false, `nextAction` names the next first-run step: follow it
  when it disagrees with this playbook. Once `complete` is true, `nextAction`
  describes only the latest scheduled run. Pick the stage from
  `firstResultAt`: within the first month, stages 4 to 6; after that, stage 7,
  and stage 8 once a month has ended.
- One stage at a time. Name the next step, say who does it, and get approval
  before any scan, check, probe, discovery session, sync, live read, connection
  or write. Approval for one step does not cover the next one or a repeat.
- The operator enters every credential (engine keys, Google sign-in, Bing,
  traffic and WordPress tokens) in the dashboard or their own terminal. Never
  ask for one in chat or put one in a tool argument. If a tool is missing or
  returns 403, say which step the operator must do and where.
- MCP hosts and built-in Aero call the `canonry_*` tools named here. CLI hosts
  run the `cnry` command in parentheses, or find it with
  `cnry help --format json`. On `CONNECTION_ERROR` or missing config, run
  `cnry doctor --format json`, then `cnry bootstrap`, and propose
  `cnry start`.
- Never promise a result or a date for any fix.

| `nextAction` | Stage | Next step |
|---|---|---|
| no project yet | 1 | Agree the domain, country and language, then create the project |
| `run_agent_readiness` | 3 | Propose the first site scan |
| `retry_agent_readiness` | 3 | Explain `tracks.agentReadiness.error`, then propose a retry |
| `connect_engine` | 2 | Give the scan score; the operator adds an AI engine key, then Search Console |
| `add_queries` | 1 | Choose the tracked queries |
| `publish_plan` | 1 | Review and publish the draft with approval (`canonry_measurement_draft_action`) |
| `run_ai_visibility` | 3 | Preview the first check, then ask |
| `repair_ai_visibility` | 2 | The operator fixes what `tracks.aiVisibility.failedEngines` names |
| `wait` | 3 | Report progress and when to check back; never start a second run |
| `open_project` | 4 | Read the baseline |

## 1. Set up the project

The numbers mean something only if the project describes the business
correctly.

- **Domain.** Use the one canonical host, and check that `www` and older
  domains redirect to it. List as owned domains only sites the business
  controls.
- **Brand identity.** Set the display name and aliases, including former
  names and common misspellings. Canonry splits queries into branded and
  non-brand from these (`canonry_queries_list` shows each `queryClass`). A
  figure labelled `pooled` later means no usable alias. If the name is a
  common phrase or another business shares it, plan to read branded answers
  to confirm each mention is about this business.
- **Queries.** Write them as a buyer asks an AI assistant, not as SEO
  keywords, and ask for a recommendation ("who should I hire for X in
  <city>"), not a how-to. Cover each thing the business sells; add a city only
  for a local market; use the buyers' language. For a new category, add
  queries that describe the problem without naming it. Keep a small branded
  set (the brand with reviews, prices or location). No count fits every
  business; size the first check with `canonry_run_preview`. Add with
  `canonry_queries_add`, or expand from a customer description with
  `canonry_discover_run_start` and `canonry_discover_promote_preview`, then
  `canonry_discover_promote` with `includeCompetitors: false` (CLI
  `--no-competitors`). Read `aeo-discovery`; a session spends provider calls.
- **Competitors.** Hand-pick a short list of direct competitors that sell to
  the same buyer. Leave out marketplaces, directories, review sites and sister
  brands. After the first check, `canonry_competitors_suggest` shows who the
  answers name: propose additions one at a time with that evidence and let
  the user choose. Never bulk-add cited domains. Add an alias when answers name
  a competitor differently from its domain. Preview with
  `canonry_competitors_change_preview`.
- **Markets.** If the business serves several places, add each location and
  check all of them. For a portfolio of Properties or markets, read
  `portfolio-analysis`.
- Changing domains, aliases or competitors recomputes past checks, so a figure
  already reported can change. Note the date, and say a period was restated
  instead of calling the difference a change.

Create the project with `canonry_project_upsert` (display name, domain,
country, language; CLI: `cnry project create`). Edit it with
`canonry_project_update` (CLI: `cnry project update`), after showing the exact
change.

## 2. Connect evidence sources

Each source answers a different question. Start with an AI engine key and
Search Console; the rest can follow.

| Source | What it adds | Who connects it |
|---|---|---|
| AI engine keys | The AI visibility check itself (`openai` measures ChatGPT) | Operator: dashboard Settings, or `cnry settings provider <name>` in their terminal |
| Google Search Console | Real searches, clicks and indexing | Use `canonry_gsc_connect` and give the operator the Google consent link. After sign-in, list properties with `canonry_gsc_properties` and select the approved one with `canonry_gsc_set_property`. |
| GA4 | Visits from search and AI assistants | Use `canonry_ga_oauth_start` when Google consent is needed. After sign-in, use `canonry_ga_properties` and `canonry_ga_connect` to select the approved property. |
| Bing Webmaster Tools | Bing's index and searches | Use `canonry_bing_connect` with the key saved in Canonry Settings. Choose the approved site from the result with `canonry_bing_set_site`. The operator enters a missing key in the dashboard. |
| Cloud Run logs | AI crawlers and AI referral visits | Use `canonry_traffic_connect_cloud_run` with the saved credential for the project's GCP project, service and region. For first-time credential entry, the operator uses **Traffic → Connect a source** in the dashboard. |
| Other server-side traffic | AI crawlers and AI referral visits from logs | Use the setup instructions for the site's log source in the server-side traffic reference. |
| Google Business Profile | Local profile, reviews, calls | Operator: Google sign-in, then location choice |
| WordPress | Publishing pages | Operator: `cnry wordpress connect` |

- Connect Search Console for every project. Skipping it should be the user's
  stated choice, since the plan then cannot see real searches.
- A short first Search Console sync can start on an unusual week. Before
  reading any trend, propose a longer backfill, which the operator or a CLI
  host runs: `cnry google sync <project> --days 180 --wait`. No MCP tool does
  this.
- Check what each source measures. Search Console should list the sitemap
  index, not one sub-sitemap (`canonry_sitemaps`). A GA4 sync can complete
  with zero rows when the tag is missing, so confirm recent days hold visits.
  Consent banners make GA4 undercount.
- Connecting a traffic source does not sync it. Vercel and Cloudflare Queue
  sources get a `traffic-sync` schedule automatically; for Cloud Run and
  WordPress, set one (`canonry_schedule_set`). Check that `lastSyncedAt` keeps
  moving (`canonry_traffic_status`). Read `ai-traffic-tracking` before quoting
  AI visits.
- Business Profile: select only this business's own locations.
  `canonry_gbp_locations` flags a location whose website is another domain
  (`websiteMatchesProject: false`). Deselecting a location deletes its stored
  history.
- A local model does not return sources, so its citations are not measured.
- Before quoting any source, check its freshness with `canonry_status`.

CLI hosts: setup detail is in the co-installed `canonry/references/`.

## 3. First measurement

The Agent Readiness scan crawls the site and needs no AI engine. The AI
visibility check asks each engine every tracked query, on the operator's
engine accounts.

- **Agent Readiness.** Propose a bounded first scan:
  `canonry_agent_readiness_run` with `maxPages: 100` (CLI:
  `cnry agent-readiness run <project> --max-pages 100 --wait`). Never rerun a
  queued or running scan; read its progress from `canonry_project_setup` once
  and tell the user when to check back. Read `site-health`.
- **AI visibility.** Show `canonry_run_preview` so the user sees the number of
  requests, get approval, then call `canonry_run_trigger` (CLI:
  `cnry run <project> --wait`). The price depends on the operator's engine
  plans. On a Simple project with several locations, pass `allLocations: true`
  (CLI: `--all-locations`); the preview counts only the default location, so
  multiply its requests by the number of locations. An Advanced plan sets each
  location itself: its preview already covers them, and it rejects
  `allLocations`. The first check runs once and creates no schedule.
- Before reading numbers, confirm the run finished (`canonry_run_get`). A
  partial run is a capture failure, not a low reading. Read a few branded
  answers to confirm each mention is about this business.

## 4. Read the baseline

Follow `orchestration` Workflow 1 without its onboarding report unless asked;
the scan is already done. For a new user, give items 1 and 2 first and offer
the rest as questions to ask.

1. How often answers name the business when buyers ask about the category
   (non-brand mention rate), and its mention share against the tracked
   competitors. Branded results go on their own line. Citation comes second
   (`canonry_project_overview`, `canonry_visibility_stats`).
2. Who is named instead (`canonry_competitor_landscape` with
   `answers: not-mentioned` and `queryClass: non-brand`), and on which queries
   (the non-brand rows of `canonry_visibility_stats` where the business is not
   mentioned).
3. Which sites the non-brand answers rely on (`canonry_analytics_sources` with
   `queryClass: non-brand`). If a few domains supply most citations, getting
   listed there matters. If they spread thin, the business's own site matters
   more.
4. The Agent Readiness score and top issues (`canonry_agent_readiness_score`,
   `canonry_agent_readiness_issues`), with `complete` and `termination` from
   `canonry_agent_readiness_overview` for the same run. A 100-page scan that
   stopped at its budget covers those pages, not the site.
5. Search: totals from `canonry_gsc_performance_daily`, branded and non-brand
   searches from `canonry_organic_evidence`, and pages by index state
   (`canonry_gsc_coverage`).

State the baseline as a level: one check shows no trend, and missing data is
unknown, not zero. No outside benchmark says what is good. Answer "is this
good?" against the tracked competitors on the same non-brand queries (with
none tracked, propose some); branded answers should name the business almost
every time. Asked why AI leaves the business out, give several possible
factors (page content, links, listings on cited sites, entrenched
competitors, each engine's habits), never one cause.

## 5. Make the first plan

Sort ideas into the same seven groups every time:

1. **Indexing and discovery.** Pages engines cannot see yet
   (`canonry_gsc_coverage`, `canonry_sitemaps`). An unindexed page cannot be
   read or cited, so fix this early.
2. **Structured data.** What existing pages should state machine-readably.
   Check the live HTML and the latest scan first. Mark up only facts that are
   visible on the page and the owner confirmed, and leave unknown fields out.
   Never mark up ratings from other sites as the business's own
   `aggregateRating`.
3. **Existing pages.** Titles, answer-first intros, headings and internal
   links, each aimed at a measured query.
4. **New pages.** One crawlable page per service, location or comparison that
   no page answers yet. Link each from a plain HTML hub page, not only the
   sitemap, and give concrete figures the owner confirmed (price ranges,
   timelines). Use `canonry_content_targets` filtered to ownable targets;
   `canonry_content_brief` drafts a brief for one (one model call, needs
   approval). A ceded target, where directories, marketplaces or editorial
   sites supply most citations, needs a listing or mention on those sites, not
   a new page.
5. **Editorial.** Topics that build authority. Do not turn tracked queries
   into post titles one by one; answer them in an FAQ inside related content.
6. **Off-site.** The directories, review sites and lists the answers already
   cite for the category (`canonry_analytics_sources`, `canonry_content_map`).
   These need owner accounts and move slowly, so start them early. On review
   sites, the number and recency of real reviews matter most: ask real
   customers to leave one there. Never write, buy or reward reviews. Keep the
   name, address and phone identical everywhere.
7. **Prerequisites.** Missing connections, stale data or missing access.

Give each item the data behind it, with numbers, and who ships it: the agent
drafts it, the site editor ships it, or only the owner can do it. Order the
top three by the Aero skill's priorities: branded queries that do not name the
business, then queries where a competitor is named and it is not, then queries
where it is neither named nor cited. Break ties with real Search Console
demand. For a new or little-known brand, first make its own site the best
answer about itself. Keep dropped ideas with their reasons so they do not come
back. For a single gap, use `orchestration` Workflow 4.

## 6. Ship

- The agent drafts and the owner approves and publishes. Show the exact change
  before any edit to a live site.
- Base every fact in new copy or markup on a short fact list the owner
  confirmed. A rewrite must not add claims.
- Give new pages internal links and links to real third-party pages, and check
  that each link resolves.
- Space new posts out instead of publishing several on one day.
- After a change goes live, read the live HTML: the markup parses and the links
  work. Then, with approval, submit the sitemap
  (`canonry_gsc_sitemaps_submit`, `canonry_bing_submit_sitemap`) and rescan.
- Record what shipped, with its live URL and date. For a content target, use
  `canonry_content_dismiss` (a write; needs approval). Keep other changes, the
  fact list and dropped ideas in agent memory (`canonry_memory_set`, a write)
  or the user's own notes, so later sessions and reports can read them.
- WordPress sites can publish through the CLI. Other sites ship through
  whoever edits them.

## 7. Watch on a cadence

- A check that runs only when someone remembers it is not monitoring. Each
  schedule is standing approval for recurring work, so propose it with its
  size: the requests per check from `canonry_run_preview` times the checks a
  month. `canonry_schedule_preview` shows when it runs; `canonry_schedule_set`
  saves it.
- **AI visibility checks.** Pick a cadence the operator can afford and keep it
  steady. More checks a month give tighter monthly comparisons; a month with
  fewer than 5 completed runs is too thin to call a move (`lowRunCount`).
- **No AI engine spend.** A daily `data-refresh` (Search Console, GA4, Bing,
  Business Profile), a `traffic-sync` for each pull source, and a periodic
  `site-audit`. These still use Google and Bing API quota and crawl the site.
- Between checks the AI numbers stay flat by design. Read daily movement in
  searches, indexing and visits.
- Alerts for people: the operator subscribes a watched channel to
  `health.urgent` and `health.urgent-resolved` (site down, data stopped
  arriving) and, for a local business, `review.negative`, in the dashboard or
  with `cnry notify add`. `canonry_agent_webhook_attach` feeds an agent instead.
- Compare like with like: the same queries, engines, models and locations. A
  change is real only when it is bigger than normal check-to-check movement
  and holds. Use `regression-playbook` for drops and `orchestration`
  Workflow 3 for a weekly review.

## 8. Report monthly

Read `reporting` and use its monthly template. Build the report after the
month ends and its data is final: Search Console fills in a month's last days
late. A person reviews it before it is sent.

- Lead with the non-brand mention rate and mention share from
  `canonry_visibility_compare`, which marks moves within noise, then citation.
  Show Google clicks beside visits from AI assistants, because clicks can fall
  as assistants answer more.
- Start monthly reports after the work has had a full month. Credit a move
  only when it follows a recorded ship date; never credit movement that began
  before the work.
- Show changes in both directions. Never present AI crawl or page-read volumes
  as results: they move when platforms change how they fetch pages.
- `canonry_doctor` with `reportMonth` checks readiness. It is a live read, so
  ask first.

## Questions the user can ask

| Stage | Ask | The agent reads |
|---|---|---|
| Set up | Which queries should we track? | `canonry_queries_list`, `canonry_gsc_query_totals` |
| Set up | Who should count as my competitors? | `canonry_competitors_list`, `canonry_competitors_suggest` |
| Connect | Which accounts should I connect, and why? | `canonry_status`, `canonry_project_get` |
| Connect | Is anything connected but not updating? | `canonry_status` |
| First check | How big is the first check? | `canonry_run_preview` |
| Baseline | Where do I stand against my competitors? | `canonry_project_overview` |
| Baseline | Who does AI name instead of me, and for what? | `canonry_competitor_landscape` |
| Baseline | Which websites does AI rely on in my market? | `canonry_analytics_sources` |
| Plan | What are the top three things to fix first? | stages 4 and 5 |
| Plan | Which queries am I closest to winning? | `canonry_content_targets` |
| Plan | Which outside sites would help AI recommend me? | `canonry_content_map` |
| Ship | Is the change live, and can Google see it? | the live page, then `canonry_gsc_inspections` for its URL |
| Watch | Did anything change since the last check? | `canonry_project_overview` (`whatChanged`) |
| Watch | Is this drop real, or normal variation? | `regression-playbook` |
| Report | What has improved since we started? | `canonry_visibility_compare` |

## Talking to someone new

- Use plain words and define each term once: a mention is the answer naming
  the business, a citation is the answer linking to its site, a non-brand
  query does not name it, mention share is its part of all names given, and
  Agent Readiness is how well AI tools can read the site.
- Name engines by the assistant people know: `openai` is ChatGPT, then
  `gemini`, `claude` and `perplexity`. If the user asks about one the project
  does not check, say it is not measured yet.
- When asked to "just fix it", say no one controls what an assistant
  recommends, then give the next step or the top three from stage 5, each with
  who ships it.
- Cover one stage per answer: the numbers first, then the recommended next
  step. Then add one line, "You can also ask:", with two or three questions
  from the table that fit the stage. Use the definitions and this line only
  while the user is new; stop once they ask their own questions.

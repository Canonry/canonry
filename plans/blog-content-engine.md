# Blog Content Engine — Implementation Plan

**Status:** Planned
**Created:** 2026-04-26
**Spec:** [`docs/gtm.md`](../docs/gtm.md) §3a
**Architectural contract:** [`docs/adr/0009-content-action-outcome-ledger-and-publish-boundary.md`](../docs/adr/0009-content-action-outcome-ledger-and-publish-boundary.md)
**Roadmap entry:** [`docs/roadmap.md`](../docs/roadmap.md) — "Citation-Driven Content Opportunities + Action Outcome Ledger" (P0, lead Wave-0 investment)

## Context

This plan implements the Wave-0 lead feature: a citation-driven blog content opportunity engine with action-typed recommendations, JSON-canonical briefs, transformer-based publish payloads, and the Content Action Outcome Ledger. Three stacked PRs:

| PR | Scope | Effort | Demo value |
|---|---|---|---|
| **PR 1** | Deterministic read layer (no LLM, no persistence beyond ledger plumbing) | ~5 days | "URL-level competitor map + action-typed targets, explainable scores" |
| **PR 2** | Web UI surfacing (Content Targets / Sources / Actions sections) | ~3 days | "Analyst-grade dashboard view of the recommendation engine" |
| **PR 3** | Brief + transformers + publish loop + action ledger lifecycle + outcome computation | ~7 days | "Closed observation→action→measurement loop" |

This plan covers PR 1 in **TDD-ordered phase detail**; PR 2 and PR 3 are scoped at outline level and will be re-planned to phase detail when they become active.

## Test Strategy

**Test pyramid** (Vitest across all packages, per [`docs/testing.md`](../docs/testing.md)):

```
         ╱──────────────╲      Integration (5%)
        ╱  fixture →     ╲     • full pipeline: fixture DB → API → CLI
       ╱   API → CLI      ╲    • parity test: byte-identical JSON
      ╱────────────────────╲
     ╱  Component (25%)     ╲   Component
    ╱  • routes (Fastify     ╲  • Fastify inject() against in-memory SQLite
   ╱     inject)              ╲ • Real DB, fixture-seeded, no mocks
  ╱  • CLI runners             ╲  (per CLAUDE.md: prior incident burned us
 ╱──────────────────────────────╲  on mocked DB tests)
╱     Unit (70%)                 ╲
│  • scorer (pure fn)             │ Unit
│  • classifier (pure fn)         │ • pure functions only
│  • query-shape filter           │ • table-driven cases
│  • page-matcher                 │ • snapshot tests for sort order
│  • confidence calculator        │
└──────────────────────────────────┘
```

**Discipline:**
- Vitest only (`pnpm run test`).
- DB tests use real SQLite + fixture seeds; no DB mocks.
- Pure functions get table-driven tests covering happy path + every classifier branch + every score corner case.
- Cross-cutting **CLI/API parity test**: `JSON.stringify(api response)` MUST equal `JSON.stringify(cli --format json output)` for any seed. One fixture, all read commands, one assertion each.
- Snapshot tests for the scorer sort order so ranking changes are intentional, not accidental.

**TDD ordering per phase:** failing test → minimal implementation to pass → refactor as needed → next phase. No skipping the failing-test step.

## Architecture (PR 1)

```
packages/contracts/src/content.ts                  ← types only, no logic
       │
       ├──→ packages/intelligence/src/
       │      content-targets.ts                   ← scorer + classifier + orchestrator (PURE)
       │      query-shape.ts                       ← blog-shaped query filter (PURE)
       │      site-inventory.ts                    ← user's published-page inventory builder
       │      page-matcher.ts                      ← token-overlap matcher (PURE)
       │
       ├──→ packages/api-routes/src/
       │      content.ts                           ← thin Fastify handlers, throw AppError
       │      content-data.ts                      ← Drizzle query functions
       │
       └──→ packages/canonry/src/
              commands/content.ts                  ← CLI handlers (call ApiClient)
              cli-commands/content.ts              ← spec registrations
              client.ts                            ← typed ApiClient methods (extend)
              agent/tools.ts                       ← Aero read tools (extend)
```

**Strict layering:**
- `intelligence/` knows nothing about HTTP or CLI
- `api-routes/` knows nothing about CLI or transformers
- `commands/` calls `client.ts` only — never `intelligence/` directly
- Aero tools call `client.ts` for parity with the CLI surface

## PR 1 — Phase-by-phase TDD plan

### New files for PR 1

```
packages/contracts/src/content.ts                       [NEW]
packages/contracts/test/content.test.ts                 [NEW]

packages/intelligence/src/content-targets.ts            [NEW]
packages/intelligence/src/query-shape.ts                [NEW]
packages/intelligence/src/site-inventory.ts             [NEW]
packages/intelligence/src/page-matcher.ts               [NEW]
packages/intelligence/test/content-targets.test.ts      [NEW]
packages/intelligence/test/query-shape.test.ts          [NEW]
packages/intelligence/test/page-matcher.test.ts         [NEW]
packages/intelligence/test/site-inventory.test.ts       [NEW]
packages/intelligence/test/fixtures/snapshots.ts        [NEW]

packages/api-routes/src/content.ts                      [NEW]
packages/api-routes/src/content-data.ts                 [NEW]
packages/api-routes/test/content.test.ts                [NEW]
packages/api-routes/test/content-data.test.ts           [NEW]
packages/api-routes/test/fixtures/seed.ts               [NEW]   ← shared seed factory

packages/canonry/src/commands/content.ts                [NEW]
packages/canonry/src/cli-commands/content.ts            [NEW]
packages/canonry/test/cli-content.test.ts               [NEW]
packages/canonry/test/agent-tools-content.test.ts       [NEW]
packages/canonry/test/cli-api-parity.test.ts            [NEW]   ← cross-cutting

packages/canonry/src/client.ts                          [EXTEND]
packages/canonry/src/agent/tools.ts                     [EXTEND]
packages/canonry/src/cli-commands.ts                    [EXTEND]   (register specs)
```

### Fixture seed (the foundation — written first)

`packages/api-routes/test/fixtures/seed.ts` — single canonical fixture covering every classifier branch + the query-shape filter + site-inventory behavior. Re-exported for use by `intelligence/test/`, `canonry/test/`. **All tests below use this seed.**

Project `example.com` with:

```
6 keywords / queries:
  Q1 "best crm for saas"               → no page anywhere       (CREATE, competitor-evidence)
  Q2 "best email marketing software"   → page /blog/email-marketing-comparison pos #4, NOT cited (REFRESH)
  Q3 "what is mrr"                     → page /glossary/mrr pos #22 (EXPAND)
  Q4 "saas billing guide"              → page /blog/saas-billing pos #6, IS cited, no schema (ADD-SCHEMA)
  Q5 "buy crm software"                → transactional → FILTERED OUT by query-shape
  Q6 "best payment processor"          → no GSC row, but inventory has /blog/payment-processor-guide
                                           → semantic match → REFRESH (not CREATE)

3 competitors: competitor-a.com, competitor-b.com, competitor-c.com

Snapshot data (last 5 runs) on (gemini-2.5-pro US, openai-gpt-4o US):
  Q1: 3 competitor citations, our domain absent
  Q2: 2 competitor citations in groundingSources, our domain absent
  Q3: occasionally cited (we're winning weakly)
  Q4: cited consistently across providers, no schema in WP audit
  Q6: 2 competitor citations, our domain absent

GSC rows:
  (Q2, /blog/email-marketing-comparison, pos=4, impr=2400)
  (Q3, /glossary/mrr, pos=22, impr=800)
  (Q4, /blog/saas-billing, pos=6, impr=1200)

GA4 traffic per page (gaTrafficSnapshots):
  /blog/email-marketing-comparison: 340 sessions
  /blog/saas-billing: 580 sessions
  /blog/payment-processor-guide: 50 sessions
  /glossary/mrr: 110 sessions

GA4 project-level (gaAiReferrals):
  totalAiReferralSessions: 142

WP audit:
  /blog/saas-billing: hasSchema=false  (the add-schema case)
  /blog/email-marketing-comparison: hasSchema=true
  others: hasSchema=true

Inventory sources for Q6 match:
  GA4 landing pages includes /blog/payment-processor-guide
```

### Phase A — Contracts (foundation, no logic) — ~half day

1. **RED:** `packages/contracts/test/content.test.ts` — assert `ContentTargetRowDto` parses from a static JSON fixture using `zod.parse()` round-trip. Add similar tests for `ContentTargetsResponseDto`, `ContentSourcesResponseDto`, `ContentGapsResponseDto`.
2. **GREEN:** define DTOs in `content.ts`:

```ts
export const ContentAction = z.enum(['create', 'expand', 'refresh', 'add-schema'])
export const DemandSource = z.enum(['gsc', 'competitor-evidence', 'both'])
export const ActionConfidence = z.enum(['high', 'medium', 'low'])
export const PageType = z.enum(['blog-post','comparison','listicle','how-to','guide','glossary'])

export const ContentTargetRowDto = z.object({
  targetRef: z.string(),
  query: z.string(),
  action: ContentAction,
  ourBestPage: z.object({
    url: z.string(),
    gscImpressions: z.number(),
    gscClicks: z.number(),
    gscAvgPosition: z.number(),
    organicSessions: z.number(),
  }).nullable(),
  winningCompetitor: z.object({
    domain: z.string(),
    url: z.string(),
    title: z.string(),
    citationCount: z.number(),
  }).nullable(),
  score: z.number(),
  scoreBreakdown: z.object({
    demand: z.number(),
    competitor: z.number(),
    absence: z.number(),
    gapSeverity: z.number(),
  }),
  drivers: z.array(z.string()),
  demandSource: DemandSource,
  actionConfidence: ActionConfidence,
  existingAction: z.object({
    actionId: z.string(),
    state: z.string(),
    lastUpdated: z.string(),
  }).nullable(),
})

export const ContentTargetsResponseDto = z.object({
  targets: z.array(ContentTargetRowDto),
  contextMetrics: z.object({
    totalAiReferralSessions: z.number(),
    latestRunId: z.string(),
    runTimestamp: z.string(),
  }),
})

// ContentSourcesResponseDto, ContentGapsResponseDto, similar pattern.
```

3. Add to `packages/contracts/src/index.ts` exports. Run `pnpm typecheck` clean.

### Phase B — Query-shape filter (pure) — ~quarter day

1. **RED:** `query-shape.test.ts` — table-driven:

```
"best crm for saas"            → blog-shaped ✓
"how to set up a payment api"  → blog-shaped ✓
"best email marketing software" → blog-shaped ✓
"what is mrr"                  → blog-shaped ✓
"saas billing guide"           → blog-shaped ✓
"buy crm software"             → not blog-shaped ✗ (transactional)
"example.com"                  → not blog-shaped ✗ (navigational)
"crm software login"           → not blog-shaped ✗ (navigational)
"buy enterprise subscription"  → not blog-shaped ✗ (transactional)
"contact sales"                → not blog-shaped ✗ (navigational)
```

2. **GREEN:** implement `isBlogShapedQuery(query: string): boolean` in `intelligence/src/query-shape.ts`. Conservative regex/keyword heuristic; explicit transactional/navigational/branded patterns excluded; everything else passes.

```ts
const TRANSACTIONAL = /\b(buy|price|pricing|cost|cheap|discount|coupon|deal|sale|free trial)\b/i
const NAVIGATIONAL = /\b(login|sign[- ]?in|contact|support|help|download|app)\b|\.com\b/i

export function isBlogShapedQuery(query: string): boolean {
  if (TRANSACTIONAL.test(query)) return false
  if (NAVIGATIONAL.test(query)) return false
  return true
}
```

### Phase C — Page matcher (pure) — ~quarter day

1. **RED:** `page-matcher.test.ts`:

```
matchesQuery("/blog/best-crm-for-saas", "best crm for saas")    → true (substring)
matchesQuery("/blog/saas-crm-comparison", "best crm for saas")   → true (≥2 token overlap: crm, saas)
matchesQuery("/blog/payment-processing", "best crm for saas")    → false (0 overlap)
matchesQuery("/about", "best crm for saas")                      → false
matchesQuery("/blog/CRM-Guide-2026", "what is crm")              → true (case-insensitive)
```

2. **GREEN:** implement `matchesQuery(url: string, query: string, opts?: { minOverlap?: 2 }): boolean` in `intelligence/src/page-matcher.ts`. Pure tokenizer + intersection.

### Phase D — Site inventory (data layer + matcher integration) — ~half day

1. **RED:** `site-inventory.test.ts` — using fixture seed:

```
buildInventory(projectId) returns SitePage[] where each row is
  { url, source: 'gsc'|'ga4'|'sitemap'|'wp', firstSeenAt }

Acme inventory should include:
  /blog/email-marketing-comparison (from GSC + GA4)
  /blog/saas-billing (from GSC + GA4 + WP audit)
  /glossary/mrr (from GSC + GA4)
  /blog/payment-processor-guide (from GA4 only — no GSC ranking yet)

Filtered to blog-shaped paths only:
  /blog/, /posts/, /articles/, /guides/, /learn/, /resources/, /glossary/
  (NOT /pricing, /about, /products/...)
```

2. **GREEN:** implement `buildInventory(db, projectId): Promise<SitePage[]>` in `intelligence/src/site-inventory.ts`. Pulls from:
   - `gaTrafficSnapshots.landingPage` (broad coverage)
   - `gscSearchData.page`
   - WP integration if configured (posts API)
   - Sitemap inspection runs if available
   Deduplicates by URL, filters to blog-shaped paths.

### Phase E — Action classifier (pure, AEO-first tree) — ~half day

1. **RED:** `content-targets.test.ts` (classifier table):

```
no page → CREATE
page exists, position 4, NOT cited → REFRESH
page exists, position 22, NOT cited → EXPAND
page exists, position 6, cited, no schema → ADD-SCHEMA
page exists, position 6, cited, has schema → null (skip)
page exists, position 50, NOT cited → CREATE (treated as no page)
page exists, position 50, cited → ADD-SCHEMA (cited check overrides rank)
WP audit absent (hasSchema null) → ADD-SCHEMA never fires; falls through to refresh/expand
inventory match only (no GSC, slug overlaps) → REFRESH (medium confidence)
```

2. **GREEN:** implement `classifyAction(input: ClassifierInput): ContentAction | null` in `intelligence/src/content-targets.ts`. AEO-first tree:

```ts
interface ClassifierInput {
  ourPage: { url: string; position: number; source: 'gsc'|'inventory' } | null
  ourPageInGroundingSources: boolean
  ourPageHasSchema: boolean | null  // null = audit unavailable
}

export function classifyAction(input: ClassifierInput): ContentAction | null {
  if (!input.ourPage) return 'create'
  if (input.ourPageInGroundingSources) {
    if (input.ourPageHasSchema === false) return 'add-schema'
    return null  // skip (winning + has schema, or audit unavailable)
  }
  // Not cited — SEO triage
  if (input.ourPage.position <= 10) return 'refresh'
  if (input.ourPage.position <= 30) return 'expand'
  return 'create'  // pos > 30 = effectively invisible
}
```

### Phase F — Scorer (pure, additive two-branch) — ~half day

1. **RED:** `content-targets.test.ts` (scorer table):

```
high impressions + 3 competitors → high score, demandSource='both'
zero impressions + 3 competitors → moderate score, demandSource='competitor-evidence'
high impressions + 0 competitors → low score (we're not competing)
high impressions + 3 competitors + we are cited → very low (1 - cited_rate)
score >= 0 always
drivers[] non-empty when score > 0
scoreBreakdown sums correctly to score (within fp tolerance)
```

2. **GREEN:** implement `scoreTarget(input: ScorerInput): { score, scoreBreakdown, drivers, demandSource }` — pure, no I/O.

```ts
score = (demand_score + competitor_score) * (1 - our_cited_rate) * content_gap_severity

demand_score      = log(gscImpressions + 1) * (1 + aiReferralFactor)
competitor_score  = log(competitorCount + 1) * recentMissRate * citationCount

content_gap_severity = {
  1.0  if no existing page or position > 30,
  0.6  if existing page with low CTR,
  0.3  if existing page with OK CTR but losing AI citations,
  0.1  if page is already competitive
}
```

3. **SNAPSHOT:** golden test against the fixture — assert sort order produces `[Q4 add-schema, Q1 create, Q2 refresh, Q6 refresh, Q3 expand]`. Snapshot the score values; intentional formula changes break the test (good).

### Phase G — Confidence calculator (pure) — ~quarter day

1. **RED:** `content-targets.test.ts` confidence cases:

```
GSC impressions ≥ 100 + ≥3 runs of citation history → 'high'
GSC sparse OR <3 runs → 'medium'
no GSC + only competitor branch fired → 'low'
inventory-match without GSC → 'medium' (we have a page but no ranking signal)
```

2. **GREEN:** implement `calculateConfidence(input): 'high' | 'medium' | 'low'` as a pure helper.

### Phase H — Data layer (real DB, fixture seed) — ~half day

1. **RED:** `content-data.test.ts` — set up an in-memory SQLite, seed via factory, then assert each query function:

```
listCandidateQueries(projectId) returns 5 (Q5 filtered out by isBlogShapedQuery)
resolveOurBestPage(projectId, "what is mrr") returns /glossary/mrr (GSC source)
resolveOurBestPage(projectId, "best payment processor") returns /blog/payment-processor-guide (inventory source)
resolveOurBestPage(projectId, "best crm for saas") returns null
listGroundingSourcesByQuery(projectId, "best crm for saas") returns 3 competitor URLs
listWpSchemaAudit(projectId) returns map { '/blog/saas-billing': false, '/blog/email-marketing-comparison': true, ... }
listGaTrafficByPage(projectId, '/blog/saas-billing') returns 580
getProjectAiReferralAggregate(projectId) returns 142
listInProgressActions(projectId) returns the existingAction map (empty in fixture; populates when test creates one)
```

2. **GREEN:** implement Drizzle query functions in `api-routes/src/content-data.ts`. Each function returns plain objects (not Drizzle row types). Uses `parseJsonColumn()` per AGENTS.md JSON-column rule.

### Phase I — Orchestrator (`buildContentTargets`) — ~half day

This is the function that ties Phases B–H together. Lives in `intelligence/src/content-targets.ts`.

1. **RED:** `content-targets.test.ts` orchestrator integration:

```
buildContentTargets(db, projectId) returns ContentTargetRowDto[] where:
  - Q1 → CREATE, score >0, demandSource='competitor-evidence', drivers includes "3 competitors cited"
  - Q2 → REFRESH, score >0
  - Q3 → EXPAND
  - Q4 → ADD-SCHEMA
  - Q5 → not present (filtered)
  - Q6 → REFRESH (inventory match, medium confidence)

Sort order matches snapshot.
existingAction is null on all rows (no actions in fixture).
```

2. **GREEN:** implement `buildContentTargets(db, projectId): Promise<ContentTargetRowDto[]>`:

```ts
async function buildContentTargets(db, projectId) {
  const queries = await listCandidateQueries(db, projectId)  // applies isBlogShapedQuery
  const inventory = await buildInventory(db, projectId)
  const inProgress = await listInProgressActions(db, projectId)
  const wpAudit = await listWpSchemaAudit(db, projectId)
  const aiReferrals = await getProjectAiReferralAggregate(db, projectId)

  const rows = []
  for (const query of queries) {
    const ourPage = resolveOurBestPage(db, projectId, query, inventory)  // GSC first, then inventory
    const groundingSources = await listGroundingSourcesByQuery(db, projectId, query)
    const ourPageInGroundingSources = groundingSources.some(g => g.uri.startsWith(project.canonicalDomain))
    const action = classifyAction({ ourPage, ourPageInGroundingSources, ourPageHasSchema: ourPage ? wpAudit.get(ourPage.url) ?? null : null })
    if (action === null) continue  // skip already winning

    const scoring = scoreTarget({ /* ... */ })
    const confidence = calculateConfidence({ /* ... */ })
    const targetRef = hashTargetRef(projectId, query, action, ourPage?.url ?? null, latestRunId)

    rows.push({
      targetRef, query, action, ourBestPage: ourPage, winningCompetitor,
      ...scoring, actionConfidence: confidence,
      existingAction: inProgress.get(targetRef) ?? null,
    })
  }
  return rows.sort((a, b) => b.score - a.score)
}
```

### Phase J — API routes (Fastify inject) — ~half day

1. **RED:** `api-routes/test/content.test.ts` — using existing API test harness:

```
GET /projects/acme/content/targets returns 200
  - body matches ContentTargetsResponseDto
  - sorted by score desc
  - in-progress actions hidden by default
GET /projects/acme/content/targets?include-in-progress=true includes them with existingAction populated
GET /projects/acme/content/targets?limit=2 returns 2 rows
GET /projects/acme/content/sources returns expected shape
GET /projects/acme/content/gaps returns expected shape
GET /projects/missing/content/targets returns 404 (NOT_FOUND error code)
GET /projects/acme/content/targets?sort=invalid returns 400 (VALIDATION_ERROR)
```

2. **GREEN:** implement the Fastify plugin in `api-routes/src/content.ts`:

```ts
export async function contentRoutes(app: FastifyInstance) {
  app.get('/projects/:name/content/targets', async (req) => {
    const project = resolveProject(app.db, req.params.name)  // throws notFound on miss
    const includeInProgress = req.query.['include-in-progress'] === 'true'
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
      throw validationError('limit must be a non-negative number')
    }
    let rows = await buildContentTargets(app.db, project.id)
    if (!includeInProgress) rows = rows.filter(r => !r.existingAction)
    if (limit !== undefined) rows = rows.slice(0, limit)
    return {
      targets: rows,
      contextMetrics: { /* ... */ },
    }
  })
  // ...sources, gaps similar
}
```

3. Register the plugin in the api-routes index.

### Phase K — ApiClient methods + CLI commands — ~half day

1. **RED:** `cli-content.test.ts` — capture stdout, assert JSON shape, exit codes:

```
`canonry content targets acme --format json` → JSON parses to ContentTargetsResponseDto, exit 0
`canonry content gaps acme --format json` → matches expected shape
`canonry content sources acme --query "what is mrr" --format json` → expected shape
`canonry content targets nonexistent --format json` → exit 1, stderr has { error: { code, message } }
`canonry content targets acme` (no --format) → human-readable table, exit 0
`canonry content targets acme --include-in-progress --format json` → in-progress action shown
`canonry content targets acme --limit 0` → validation error, exit 1
```

2. **GREEN:**
   - Extend `client.ts` with `listContentTargets()`, `listContentGaps()`, `listContentSources()` methods (typed return values, no `as Record<string, unknown>` per AGENTS.md ApiClient rule).
   - Implement command handlers in `commands/content.ts` (each ~15 lines using `createApiClient()`).
   - Register specs in `cli-commands/content.ts` (subcommand-per-spec pattern from existing `cli-commands/wordpress.ts`).
   - Add to `cli-commands.ts` registration array.

### Phase L — Aero tools — ~quarter day

1. **RED:** `agent-tools-content.test.ts`:

```
get_content_targets tool exists in buildReadTools()
get_content_gaps tool exists
get_grounding_sources tool exists
calling tool returns AgentToolResult with parsed ContentTargetsResponseDto
tool.parameters schema validates expected inputs (Typebox, not Zod)
```

2. **GREEN:** extend `agent/tools.ts` with three Typebox-schemated read tools, each calling `ctx.client.listContentX()`. Pattern from existing `buildListKeywordsTool`.

### Phase M — Cross-cutting parity test — ~quarter day

1. **RED:** `cli-api-parity.test.ts`:

```ts
it('content targets: CLI --format json matches API response byte-for-byte', async () => {
  const apiResp = await api.inject({ method: 'GET', url: '/api/v1/projects/acme/content/targets' })
  const cliOut = await runCli(['content', 'targets', 'acme', '--format', 'json'])
  expect(JSON.parse(cliOut)).toEqual(JSON.parse(apiResp.body))
})
// repeat for gaps, sources
```

2. **GREEN:** passes by construction since CLI calls API. Failure indicates a contract drift bug.

### PR 1 deliverable checklist

- [ ] All Phase A–M tests green
- [ ] `pnpm typecheck && pnpm lint && pnpm test` clean across workspace
- [ ] Version bumped in root + `packages/canonry/package.json` (per AGENTS.md versioning rule)
- [ ] No new DB tables (PR 1 ephemeral; in-progress actions DTO field is forward-compat for PR 3)
- [ ] No LLM calls in any code path under `intelligence/content-targets.ts`, `api-routes/content.ts`, or `commands/content.ts` (assert via grep in CI; optional)
- [ ] CLI/API parity test passes for all 3 read commands
- [ ] `docs/gtm.md` Wave 0 PR 1 boxes ticked off in the PR description

### Open implementation choices to lock before Phase A starts

1. **`isBlogShapedQuery` heuristic source of truth** — hand-written regex list (~30 patterns) in `query-shape.ts`. Document patterns inline.
2. **`recent_miss_rate` window** — last 5 runs OR last 14 days, whichever shorter. Document as a constant.
3. **`actionConfidence` thresholds** — high if GSC impr ≥ 100 AND ≥ 3 runs of history; low if no GSC AND < 2 runs; medium otherwise. Tunable later.
4. **Page-matcher token threshold** — minimum overlap of 2 meaningful tokens (excluding stopwords) OR full-query substring match.
5. **WP schema audit data shape** — quick spike confirms `integration-wordpress` exposes per-page `hasSchema` cleanly (or add a small helper).
6. **Inventory source priority** — when a URL appears in multiple sources (GSC + GA4 + WP), prefer GSC for position data, GA4 for traffic data, dedupe on URL.

Resolve these before opening Phase A; they're 1-hour decisions, not multi-day spikes.

## PR 2 — UI surfacing (outline)

Re-plan to phase detail when PR 1 lands.

```
apps/web/src/components/project/
  ContentTargetsSection.tsx          [NEW]
  ContentSourcesSection.tsx          [NEW]
  ContentGapsSection.tsx             [NEW]
  ActionTypeFilter.tsx               [NEW]
  ScoreDriverChips.tsx               [NEW]
apps/web/src/pages/ProjectPage.tsx   [EXTEND]
```

TDD discipline (Vitest + React Testing Library):

- Component tests against fixture API responses (reuse the same seed JSON from PR 1).
- Action-type filter behavior: clicking `expand` chip filters table client-side.
- Empty/loading states (skeletons, TanStack Query suspense).
- Score-driver chips render `drivers[]` text verbatim.
- Existing-action annotation visible when present.

**Strict rule:** zero new logic in components. All data + computed metrics already in DTOs. Pure presentation.

## PR 3 — Brief + transformers + ledger + outcomes (outline)

Largest of the three; will be its own dedicated plan when PR 1 lands.

### New files (preview)

```
packages/contracts/src/content.ts                       [EXTEND] ContentBriefDto, ContentPublishPayloadDto, ContentActionDto
packages/intelligence/src/content-prompts.ts            [NEW]    brief LLM templates (must include unknownFields discipline)
packages/intelligence/src/content-outcomes.ts           [NEW]    pure outcome computation
packages/intelligence/test/content-prompts.test.ts      [NEW]    snapshot tests against frozen LLM responses
packages/intelligence/test/content-outcomes.test.ts     [NEW]

packages/publish-transformers/                          [NEW PACKAGE]
  package.json
  src/index.ts                                          ← registry + dispatcher
  src/types.ts                                          ← TransformerInput, PublishPayload
  src/wordpress.ts                                      ← markdown → minimal Gutenberg + core/html fallback
  src/ghost.ts                                          ← markdown → mobiledoc fragment
  src/next-mdx.ts                                       ← markdown + frontmatter (gray-matter)
  src/generic.ts                                        ← passthrough
  src/markdown.ts                                       ← shared remark/rehype pipeline
  test/wordpress.test.ts
  test/ghost.test.ts
  test/next-mdx.test.ts
  test/generic.test.ts
  test/fixtures/                                        ← input markdown + expected output JSON

packages/db/src/schema.ts                               [EXTEND] contentBriefs + content_actions tables
packages/db/src/migrate.ts                              [EXTEND] vN: add new tables (per AGENTS.md schema rule)

packages/api-routes/src/content.ts                      [EXTEND] POST /content/briefs, /content/publish-payload, GET /content/actions, etc.
packages/canonry/src/commands/content.ts                [EXTEND] brief, publish-payload, actions, action, mark-published, dismiss
packages/canonry/src/cli-commands/wordpress.ts          [EXTEND] create-draft (renamed from publish-draft)
packages/integration-wordpress/src/wordpress-client.ts  [EXTEND] createDraftPost() + WP poll for draft → published
```

### TDD ordering (preview)

1. **Transformers first** (pure, easy) — golden fixture tests for each transformer.
2. **Schema extension** — `contentBriefs` + `content_actions` tables with proper migration entries (AGENTS.md schema rule).
3. **Brief endpoint with frozen LLM responses** — recorded LLM response in `test/fixtures/`; assert prompt construction includes `winningCompetitorUrls`, `searchQueries`, `recommendedAction`; assert brief output passes Zod validation; assert idempotency via `(query, action, targetPage)` triple.
4. **Action ledger** — state machine transitions with table-driven tests; idempotency contract enforced; `existingAction` annotation on `targets` rows now returns real data.
5. **WP create-draft + draft-published poll** — `integration-wordpress` test patterns; mock WP API at HTTP boundary; assert `draft-created` state transition (not `published`); poll test asserts `draft-created → published` transition only on `status: publish`.
6. **Outcome computation** — pure function tests; observation-set intersection logic; threshold logic (≥3 eligible runs OR ≥14 days); `firstMeasurement` vs `result` separation; `newEvidence[]` for post-baseline expansion.
7. **Aero write tools** — `generate_content_brief`, `dismiss_content_action`; explicit invocation only.
8. **Mutation isolation test** — network-call interceptor asserts only `wordpress create-draft` opens an outbound HTTP socket to a CMS.

### PR 3 risks

| Risk | Mitigation |
|---|---|
| Brief prompt quality varies between LLM runs | Snapshot test against a frozen response; require human review of prompt changes |
| Ghost mobiledoc spec drift | Pin to a specific spec version in transformer; document in transformer file |
| Gutenberg block JSON shape underspecified | Start with `core/html` fallback only — minimum viable |
| WP `createPage` API quirks | Already handled by `integration-wordpress` — don't reinvent |
| `unknownFields[]` discipline could be sloppily implemented | Ship criterion forces test that asserts no inferred values leak into `knownFields` |
| Outcome threshold tuning (3 runs / 14 days) might be wrong | Document as constants; tune post-dogfood |

## Cross-cutting concerns

### Telemetry (lands incrementally per PR)

PR 1: nothing (read layer).
PR 3:
- `content_action_promoted`
- `content_brief_generated`
- `content_publish_payload_generated`
- `wp_draft_created` / `wp_draft_published`
- `content_published_marked`
- `content_action_first_measured`
- `content_action_validated`
- `content_action_dismissed`
- `external_publish_confirmed`

Per-action-type outcome rates surface as analytics queries on top of these events.

### Documentation maintenance per AGENTS.md

- Each new CLI command: update `packages/canonry/AGENTS.md`
- New table in `packages/db/src/schema.ts`: update `docs/data-model.md`
- New API route file: update `packages/api-routes/AGENTS.md`
- New package (`packages/publish-transformers/`): create `AGENTS.md` + `CLAUDE.md` per AGENTS.md keep-doc-current rule

### Version bumps

Each PR bumps the version per AGENTS.md versioning rule. PR 1 = patch (no breaking changes); PR 3 = minor (new features, new tables).

## Definition of done (whole feature, not just PR 1)

The blog content engine is "done" when:

- All Wave 0 ship gate items in `docs/gtm.md` are checked.
- A user (or agent) can run the full lifecycle on a fixture project: targets → brief → publish-payload → mark-published → wait → validated outcome.
- Demo fixture in `canonry demo` walks an audience through the loop end-to-end.
- ADR 0009 is moved from Proposed → Accepted.

## Out of scope for this plan

- Wave 0 hardening items (credential encryption, agent-docs accuracy audit, demo mode) — separate plans.
- Wave 1 onboarding work (UI wizard extensions, hosted demo sandbox, etc.).
- Wave 2 expansion (additional CMS transformers, fix commands, .pkg installer).
- Future ML-based ranker (out of v1, see ADR 0009).

## See also

- [`docs/gtm.md`](../docs/gtm.md) §3a — full product spec
- [`docs/adr/0009-content-action-outcome-ledger-and-publish-boundary.md`](../docs/adr/0009-content-action-outcome-ledger-and-publish-boundary.md) — architectural contracts
- [`docs/roadmap.md`](../docs/roadmap.md) — feature priority
- [`AGENTS.md`](../AGENTS.md) — agent-first contract, UI/CLI parity, error handling, JSON parsing, schema-migration rules
- [`docs/testing.md`](../docs/testing.md) — Vitest workflow

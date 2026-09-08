# Historical Competitor Landscape

Canonry derives the competitor landscape from stored answer and source evidence. The read never starts discovery, calls an answer engine, or writes data.

```text
completed/partial answer-visibility snapshots
                 +
project pins + frozen market competitors + stored classifications
                 |
                 v
        windowed historical landscape
                 |
       +---------+----------+
       |                    |
 pinned competitors      observed competitors
 always visible          ranked by mentions,
 and shown first         then citations
```

## Reading the result

- `project` is the tracked brand.
- `pinned` contains user-managed competitors. Pins remain visible with zero observations.
- `observed` contains stored direct-competitor identities that were mentioned or cited in the selected window.
- `otherSources` contains cited aggregators, editorial sites, unknown domains, and other non-competitive surfaces. These rows do not enter share of voice.
- Mention share is `row mention credits / (project + selected competitor mention credits)`, expressed as percentage points from 0 to 100. Each answer gives a brand at most one mention credit.
- `basis` is `tracked` when any pin is configured. Only pins enter that denominator. Observed rows remain visible with null shares. Without pins, `basis` is `observed` if the selected history contains classified competitor evidence; otherwise it is null.
- Observed comparisons require at least **3 direct competitors, each mentioned in at least 3 distinct answers**. Each candidate must meet the answer floor before entering the denominator. This publication floor rejects a lone alternative and one-answer lists; it is not a statistical confidence claim. Evaluate it separately after class, market, provider, model, location, run, and window filters, before display caps.
- `availability` is `measured` or `not-measured`, with a machine-readable `reason`. No comparison set, an unsplit class, insufficient observed evidence, no answers, and no brand mentions all produce null percentages. Failed reads remain HTTP errors and render as `unavailable`.
- `comparison` publishes the complete selected domain/count set even when display rows are capped. `evidence.mentionCredits` is the project count plus that set's mention counts. CLI, dashboard, and reports label each percentage with its basis and query class.
- `observedNames` lists raw provider recommendations and answer counts, including unknown names and platforms. They are observations, never rate inputs. Only stored direct-competitor classifications and frozen identities supply candidates. The shared exact brand matcher recounts their presence from answer text. Domain normalization deduplicates identities, and repeated names or domain aliases within an answer earn one credit. No suffix-stripping, fuzzy identity guesses, new classification calls, or provider requests occur during the read.
- Share of voice needs one query class behind it. `queryClass=all`, and omitting the parameter, pool branded and non-brand queries, and a brand wins its own branded queries by definition. Pooled readings return `shareOfVoice: null` on every row and publish the counts instead. Request `queryClass=branded` or `queryClass=non-brand` for a ratio. A project with no brand name or alias cannot split the classes, so a class-scoped read on one is refused rather than answered with an empty landscape.
- Citation count is independent from mention count. Each answer gives a domain at most one citation credit.

Observed competitors sort by mention count, then citation count. Other sources sort by citation count. The server returns at most 100 observed rows and 100 other-source rows and sets `truncated`. Pinned rows are never capped. Each row includes at most three stored sample URLs.

## Existing projects

Existing competitors remain pinned. Saved sweeps supply historical mentions and citations without new provider requests or changes to provider settings.
The dashboard defaults to 30 days. The All window includes older evidence.

Known direct competitors appear under Observed when the selected history contains matching mentions or citations.
Unknown domains remain under Other cited sources until discovery classifies them or an operator pins them. Raw recommended names remain under Names observed in answers. Names alone cannot establish a comparison set.
Ordinary visibility sweeps capture answers and sources, but do not classify unknown domains or create pins.

Missing historical answers and URLs remain unavailable. Stored domain citations still count, even without a stored URL.
Simple observations without usable query text remain in All, but do not enter either explicit query-class filter.
Advanced Measurement retains the query classes from its frozen Target assignments.

## Retroactive pins

Adding a Simple-project competitor changes the identity set used by the next read. Canonry immediately re-evaluates the selected historical window against already stored answer text and source URLs. It does not rerun old prompts and does not rewrite old snapshots.

This means a newly pinned brand can acquire historical mentions and citations when the old evidence contains a matching brand alias or domain. Evidence that was never captured cannot be reconstructed.

## Simple and Advanced Measurement

| Surface | Pin source | Historical scope | Write behavior |
| --- | --- | --- | --- |
| Simple | Project competitors | Project answer-visibility snapshots | `competitor add/remove` updates the project pin set. |
| Advanced market | Project pins plus that market's frozen competitors | Usage edges and query classes frozen into each contributing run revision | A pin updates a draft. A published draft becomes active measurement configuration. |
| Advanced all markets | Union of project pins and every market's identities | Raw in-scope evidence across all markets | Read-only because there is no single target market. Percentages are recomputed from raw evidence, never averaged from market percentages. |

Draft-only market pins appear in `marketState.draft.pendingCompetitorDomains`.
Project pins and active or pending-draft market competitors express current operator intent. They reinterpret selected stored history.
Historical-only identities and aliases match only answers from runs that used their frozen revision.
All-markets scope combines aliases when multiple markets name the same registrable domain.

## API, CLI, and MCP

Stored read:

```http
GET /api/v1/projects/{name}/analytics/competitors
  ?window=7d|30d|90d|all
  &groupKey={advanced-market-key}
  &scope=all-markets
  &provider={provider}
  &model={exact-requested-model-id}
  &groupBy=model
  &queryClass=all|branded|non-brand
  &location={label}
  &runId={id}
```

`groupKey` and `scope=all-markets` are mutually exclusive. An Advanced scope requires an active version 2 measurement plan.

```bash
canonry competitor landscape <project> --window 30d
canonry competitor landscape <project> --group-key north
canonry competitor landscape <project> --scope all-markets --format json
```

The read-only MCP equivalent is `canonry_competitor_landscape`. Advanced market pinning uses the revision-guarded draft action endpoint. MCP agents can use the generic measurement-draft action workflow.

## Optional model comparison for agents

The default landscape combines the selected observations. The optional `groupBy=model` parameter also returns a `modelComparison` object.
This read-only feature is available through the API, CLI, and MCP. It does not change the web interface or start a sweep.

Each group contains observations for one provider and one exact requested model ID.
The `basis` field is `requested-model`. A null `model` identifies historical observations without a recorded requested model.
Canonry does not substitute the current model or an upstream-reported model for missing requested identity.

The separate `servedModels` field records upstream-reported identity as `known`, `unknown`, or `mixed`.
A mixed group retains every disclosed model and indicates whether some observations lack served identity.
The requested model and served model are different evidence fields, even when their values match.

Each group includes the project, pinned competitors, observed competitors, other cited sources, and evidence counts.
Mentions, citations, and share of voice use only the observations in that group.
The `snapshotCount`, answer-text count, and source count disclose the sample behind each group.
The default combined fields remain available in the same response.

These groups are not a matched-query or equal-weight comparison. Different models can have different questions, dates, locations, and sample counts.
A difference in share of voice does not establish that one model performs better.
The same stored-evidence and missing-source limits apply to each group.

The server sorts groups by provider and requested model ID. It returns at most 50 groups.
`totalGroups` records the full group count. `modelComparison.truncated` identifies omitted groups.
Each group retains every pin and at most 100 observed competitors and 100 other sources.
A group-level `truncated` field identifies omitted rows. Row caps do not change the denominators.

An exact `model` filter requires `provider`. This filter does not require `groupBy=model`.
Model comparison works for Simple projects, one Advanced market, and Advanced all-markets scope.
Existing query-class, location, run, and window filters still apply. Advanced reads retain their frozen Property, Target, and market scope.
The feature does not create model-specific pins or change sweep selection.

```bash
canonry competitor landscape <project> --by-model --format json
canonry competitor landscape <project> --by-model --provider gemini --model gemini-3-flash-preview --window 30d
canonry competitor landscape <project> --group-key north --by-model --query-class non-brand --format jsonl
canonry competitor landscape <project> --scope all-markets --by-model --provider openai --format json
```

The CLI maps `--by-model` to `groupBy=model`. Text output shows each group with separate requested and served identities, counts, and share of voice.
Both JSON formats preserve the complete response. JSONL emits one compact document, not one line per model.

Built-in Aero can shorten large tool messages. It marks omitted rows with `__truncated` and omission counts.
The full structured response remains in the tool result's `details` field.

The existing `canonry_competitor_landscape` MCP tool accepts the same fields:

```json
{
  "project": "acme",
  "scope": "all-markets",
  "groupBy": "model",
  "provider": "gemini",
  "model": "gemini-3-flash-preview",
  "queryClass": "non-brand",
  "window": "30d"
}
```

## Evidence boundary

Only `completed` and `partial` answer-visibility runs contribute. Probe and non-terminal results are excluded and counted separately in the response. Results without answer text cannot enter the mention denominator. Incomplete source captures can prove a citation that was captured, but they cannot prove a domain was not cited.

The web table displays stored sample URLs for the selected window. It does not link a historical row to the latest-only evidence table. That link presents old evidence as current.

## Shared readers

`visibility-stats --share-of-voice` and both report renderers use this same
landscape reader and comparison policy. Their existing run windows still apply.
Simple visibility stats retain the current tracked-query basket. Advanced
portfolio stats and reports select all markets through frozen execution/Target
assignments, retaining their query classes even when query text suggests another
class. Reports publish non-brand and branded shares separately. Overview and
trend mention-share instruments retain their explicitly tracked comparison sets.

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
- Mention share is `row mention credits / (project + direct-competitor mention credits)`, expressed as percentage points from 0 to 100. Each answer gives a brand at most one mention credit.
- Citation count is independent from mention count. Each answer gives a domain at most one citation credit.

Observed competitors sort by mention count, then citation count. Other sources sort by citation count. The server returns at most 100 observed rows and 100 other-source rows and sets `truncated`. Pinned rows are never capped. Each row includes at most three stored sample URLs.

## Retroactive pins

Adding a Simple-project competitor changes the identity set used by the next read. Canonry immediately re-evaluates the selected historical window against already stored answer text and source URLs. It does not rerun old prompts and does not rewrite old snapshots.

This means a newly pinned brand can acquire historical mentions and citations when the old evidence contains a matching brand alias or domain. Evidence that was never captured cannot be reconstructed.

## Simple and Advanced Measurement

| Surface | Pin source | Historical scope | Write behavior |
| --- | --- | --- | --- |
| Simple | Project competitors | Project answer-visibility snapshots | `competitor add/remove` updates the project pin set. |
| Advanced market | Project pins plus that market's frozen competitors | Usage edges and query classes frozen into each contributing run revision | A pin updates a draft. A published draft becomes active measurement configuration. |
| Advanced all markets | Union of project pins and every market's identities | Raw in-scope evidence across all markets | Read-only because there is no single target market. Percentages are recomputed from raw evidence, never averaged from market percentages. |

Draft-only market pins are disclosed in `marketState.draft.pendingCompetitorDomains`. Historical runs keep the competitors and execution membership frozen in the plan revision they used, so later market edits do not rewrite the past.

## API, CLI, and MCP

Stored read:

```http
GET /api/v1/projects/{name}/analytics/competitors
  ?window=7d|30d|90d|all
  &groupKey={advanced-market-key}
  &scope=all-markets
  &provider={provider}
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

## Evidence boundary

Only `completed` and `partial` answer-visibility runs contribute. Probe and non-terminal results are excluded and counted separately in the response. Results without answer text cannot enter the mention denominator. Incomplete source captures can prove a citation that was captured, but they cannot prove a domain was not cited.

The web table displays stored sample URLs for the selected window. It does not link a historical row to the latest-only evidence table. That link presents old evidence as current.

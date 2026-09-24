# Batch mode for scheduled sweeps

Scheduled sweeps run unattended, so they rarely need answers within seconds.
Batch mode sends a provider's share of a sweep to that provider's asynchronous
batch API, which charges 50% of the standard **token** price, instead of calling
it once per answer. The request body for each answer is the same one the sync
path sends, and the result is read back by the same parser, so a batch answer is
stored in the same shape as a sync answer. The only difference is how the answer
was dispatched, and every answer records that.

Batch mode is **off by default** and opt-in twice: the operator enables it per
provider in `config.yaml`, and a project opts in per provider for its scheduled
sweeps.

| Provider | Batch mode |
|---|---|
| Claude | Supported (Message Batches API) |
| OpenAI, Gemini | Not yet. Their batch support for web search is still being verified. |
| Perplexity, local, CDP | Never. Perplexity has no batch discount; the others have no batch API. |

## Enable it

### 1. Instance: `config.yaml`

```yaml
providers:
  claude:
    apiKey: sk-ant-...
    batch:
      enabled: true              # required; false or absent = never batch
      maxRequestsPerBatch: 5000  # optional; split larger sweeps (never above the provider's 100,000)
      deadlineHours: 12          # optional; cancel a batch that has not ended by then (default 24)
    pricing:                     # optional price overrides, USD
      models:
        claude-sonnet-4-6:
          inputPerMTok: 3
          outputPerMTok: 15
          searchPer1k: 10
          batchTokenDiscount: 0.5
```

A malformed `batch` or `pricing` block refuses the config at load, naming the
key. When `batch.enabled` is true for a provider whose adapter has no batch API,
`canonry serve` logs `provider.batch.unsupported` once at boot, and that
provider's sweeps run sync.

### 2. Project: `providerDispatchModes`

A project marks the providers its **scheduled** sweeps should batch. Providers it
does not list run `sync`.

```bash
canonry project update acme --dispatch-mode claude=batch
canonry project update acme --clear-dispatch-mode claude
canonry project show acme            # "Dispatch modes:   claude=batch (scheduled sweeps; others sync)"
```

The same map is `providerDispatchModes` on `PUT /api/v1/projects/{name}`,
`POST /api/v1/projects`, and in a `canonry apply` spec. In both write paths an
omitted value **leaves the stored preference unchanged** (the dashboard's settings
save and older config files never clear it), and `{}` clears it. Provider names
must be registered adapters. A preference for an engine the project no longer
runs is dropped, the same way model overrides are.

## Which runs batch

The decision is made once, when the run is queued, and frozen onto the run
(`runs.provider_dispatch_modes`, `dispatchModes` on the run DTO). Changing the
project preference or `config.yaml` afterwards never changes a queued run.

- **Scheduled sweeps** batch the providers the project marks `batch` that are
  eligible. An ineligible one runs sync, and the scheduler logs
  `run.dispatch-sync-fallback` with the reason.
- **Manual and API runs** stay sync unless the request asks for batch:
  `canonry run acme --dispatch-mode batch`, or `"dispatchMode": "batch"` on
  `POST /api/v1/projects/{name}/runs` (also `POST /api/v1/runs` and the MCP
  `canonry_run_trigger` tool). That batches every eligible provider in the run.
  A batch request that **no** provider can honour is refused with `400`, and
  `error.details.ineligible` names each provider's reason. `dispatchMode: "sync"`
  (or omitting it) runs everything sync.

A provider is eligible only when every one of these holds:

| Rule | Reason code when it fails |
|---|---|
| The run measures a published measurement plan | `not_plan_run` |
| The run is a full sweep (no measurement scope, no query list) | `scoped_run` |
| The run is not a probe | `probe_run` |
| The adapter has a batch API AND `providers.<name>.batch.enabled` is true | `batch_unavailable` |
| Every answer of that provider has a model frozen in the run's manifest | `model_not_frozen` |

Both portfolio kinds batch: a Simple project with a published (v1) plan and an
Advanced (v2) portfolio go through the same queue path. **Planless runs never
batch, by design.** Their answers carry no execution id, so a failed batch line
could neither be de-duplicated nor filled afterwards.

Dispatch mode is not part of a run's execution identity. Toggling batch mode
does not break a chart series. Each answer records `dispatchMode`
(`sync`/`batch`) and `stopReason`, so the two modes can still be told apart.

## While a batch is outstanding

- The run stays `running`. There is no separate status. `GET /api/v1/runs/{id}`
  lists `providerBatches` (status, request / ingested / recorded counts,
  submitted, ended, deadline, error), and `canonry run show <id>` prints for each
  outstanding one:

  ```
  waiting on provider batch: claude — 120 requests, submitted 2026-09-24T06:00:05.000Z, deadline 2026-09-25T06:00:05.000Z
  ```

- Sync providers in the same run answer as usual. Their rows appear immediately,
  and their errors are held until the run finalizes.
- The next scheduled sweep of the project is skipped, because sweeps never
  overlap. It is logged as `run.skipped-active` with `reason: "batch-pending"`.
  The deadline keeps this bounded: a batch that has not ended by its deadline is
  cancelled, whatever finished is ingested, and the run finalizes.
- `POST /runs/{id}/cancel` also cancels the run's batches at the provider.

## When a batch ends

Every result line is mapped back to its answer slot and recorded through the
same pipeline as a sync answer.

| Outcome | What happens |
|---|---|
| Line succeeded | Recorded, `dispatchMode: batch`, priced at the batch tier |
| Line errored, expired or was cancelled | Slot stays missing, the provider gets a run error entry, and its reserved daily quota is released (not billed) |
| The answer's web search errored | Slot stays missing, exactly as the sync path refuses the same body |
| The provider definitely rejected the submit | That provider falls back to sync in the same run |
| The submit outcome is unknown (timeout, dropped connection) | The batch is recorded `unknown` and **never resubmitted**, and its slots stay missing |

A run with missing slots finalizes as `partial`. Nothing fills it automatically.
Fill it synchronously, at the sync price:

```bash
canonry run completeness <run-id>          # what is missing, and whether a fill is admitted
canonry run fill <run-id> --provider claude --wait
```

A run that dispatched a batch can be filled for 24 hours **after it finalized**.
Other runs keep the old rule of 24 hours after they started. Without this, a
batch that ran to its deadline would leave a run already too old to fill.

## Costs

Each answer stores its usage (input, cached, cache-write and output tokens, and
web searches), read off the provider's own response, together with a price
estimated when it was recorded. The estimate uses canonry's built-in price
table (Claude models) unless `config.yaml` overrides the model. An answer
whose model has no known price records `estimatedCostMicros: null`.

`GET /api/v1/runs/{id}` sums it per provider and price tier in `usage`, and
`canonry run show` prints it as a table. Answers recorded before usage capture
count nowhere. Cost sums the priced answers only, and a group with no priced
answer reports its cost as unknown, never as zero.

Only tokens are discounted. The search fee stays at the full sync price in batch
(Claude: $10 per 1,000 searches, and canonry caps an answer at 5 searches). So
the saving per answer is half the token share of its cost:

```
saving = 0.5 × token cost / (token cost + search fee)
```

For example, a `claude-sonnet-4-6` answer ($3 / $15 per million input / output
tokens) with 20,000 input tokens (search results are billed as input), 800
output tokens and 2 searches costs $0.072 in tokens plus $0.02 in search, so
$0.092 sync and $0.056 in batch. That is a saving of 0.5 × 0.072 / 0.092 = 39%,
not 50%. The more of an answer's cost is search, the smaller the saving. The
`usage` table is how to check the real figure per provider instead of assuming it.

## Risks

- **Zero data retention.** Anthropic batch processing is not ZDR eligible, and
  results are kept for up to 29 days. Keep `batch.enabled` off on any deployment
  that needs ZDR.
- **Spend limits.** Anthropic batches can slightly exceed a workspace's
  configured spend limit.
- **Latency.** Answers can arrive up to the deadline (24 hours by default) after
  the sweep started, and the project's next sweep waits for them.
- **Comparability.** Claude's batch loop runs more iterations before it returns
  `pause_turn`, search results can be hours older, and a fill mixes batch and
  sync answers for one provider in one run. `dispatchMode` and `stopReason` on
  every answer let you separate them.
- **Expiry.** An expired or cancelled batch leaves slots that a fill can only
  complete at the sync price, and only if someone runs the fill.
- **Web-search throttling.** Batch web searches draw on the organization's
  web-search rate limit, and the provider throttles them, so a very large batch
  takes longer and is more likely to reach its deadline. Lower
  `maxRequestsPerBatch` or `deadlineHours` if that happens.
- **Duplicate paid submissions.** A batch is written as `submitting` before the
  submit call and is never resubmitted automatically, so a crash cannot pay for
  the same answers twice.

## Reference

| Surface | Batch mode |
|---|---|
| `config.yaml` | `providers.<name>.batch`, `providers.<name>.pricing` |
| API | `dispatchMode` on `POST /projects/{name}/runs` and `POST /runs`, `providerDispatchModes` on project writes and apply, `dispatchModes` / `providerBatches` / `usage` on runs, `dispatchMode` / `stopReason` / `usage` on snapshots |
| CLI | `canonry run --dispatch-mode`, `canonry project create/update --dispatch-mode` / `--clear-dispatch-mode`, `canonry run show` |
| MCP | `canonry_run_trigger` (`request.dispatchMode`), `canonry_project_upsert` / `canonry_apply_config` (`providerDispatchModes`), `canonry_run_get` |
| Storage | `docs/data-model.md`: `provider_batches`, `provider_batch_requests`, and the dispatch columns on `projects`, `runs` and `query_snapshots` |

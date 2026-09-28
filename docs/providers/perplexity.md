# Perplexity Provider Design

## Role

`packages/provider-perplexity` is the answer-visibility adapter for Perplexity. It calls the **Agent API** (`POST https://api.perplexity.ai/v1/agent`) and reads which domains an answer cites for each tracked query.

Perplexity retired Sonar Chat Completions on 2026-09-27 ([migration guide](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar)). Rows written before the switch are Sonar responses; the adapter still parses them (see [Stored history](#stored-history)).

## Model selection

The configured model is either an Agent API **preset** or a **`vendor/model` slug**:

| Configured | Request field | Notes |
|------------|---------------|-------|
| `fast` (default) | `preset: "fast"` | Perplexity's suggested replacement for `sonar` |
| `low`, `medium`, `high`, `xhigh` | `preset` | Heavier, costlier search tiers |
| `perplexity/sonar`, `openai/gpt-5.1`, … | `model` | One model plus Canonry's `web_search` tool |

Retired names still validate and resolve through `PROVIDER_MODEL_ALIASES` in `packages/contracts/src/models.ts`: `sonar` → `fast`, `sonar-pro` / `sonar-reasoning` / `sonar-reasoning-pro` → `low`, `sonar-deep-research` → `medium`. The long preset names (`fast-search`, `pro-search`, `deep-research`, `advanced-deep-research`) fold into the short ones.

## Request

```json
{
  "preset": "fast",
  "input": "best crm for startups",
  "tools": [{ "type": "web_search", "user_location": { "city": "New York", "region": "New York", "country": "US" } }],
  "tool_choice": { "type": "web_search" }
}
```

- The query goes in unmodified. The location rides on the `web_search` tool as `user_location` (treatment `request-param`), not in the text as it did with Sonar.
- `tool_choice` forces the search, so the retrieval contract is `search-required-v1`, the same as Claude. Canonry sends no `instructions`; a preset's built-in prompt is part of the engine being measured.
- The Agent API rejects unknown fields with a 400, so `user_location` carries only `city`, `region`, and `country` (no `type` or `timezone`, unlike OpenAI's).
- `anthropic/*` slugs also send `max_output_tokens: 4096`, which the API requires for them, on every request path (sweep, key check, text generation). Presets and other slugs stay uncapped.
- The key check sends the same preset or model with `input: 'Say "ok"'` and no forced search.

## Response parsing

| Field | Source |
|-------|--------|
| `answerText` | `output_text` parts of every `message` item, joined |
| `groundingSources` | `search_results` item `results[]`, then `fetch_url_results` `contents[]`, then `url_citation` annotations on the message; deduplicated by URL in output order |
| `citedDomains` | Unique hosts of `groundingSources` |
| `searchQueries` | `search_results` item `queries[]` |
| `retrievalStatus` | `used` with a `search_results` or `fetch_url_results` item; `not-used` with a message and neither; `unknown` otherwise |
| `servedModel` | Top-level `model` (the model a preset resolved to) |
| `model` | The resolved preset or slug that was requested |

There is no top-level `citations` or `search_results` on an Agent response. A failed or cancelled run comes back as HTTP 200 with `status` and `error` set, so the adapter checks `status` and throws for anything but `completed` or `incomplete`. An `incomplete` run passes only when it still carries answer text; one that stopped before any answer throws, so it is recorded as a failed slot rather than a measured non-mention. HTTP 429 and 5xx retry through `withRetry`; other 4xx do not.

## Comparability

Switching the engine behind `perplexity` is treated as a model change:

- `normalizeExecutionIdentity` (contracts) resolves retired ids, so a plan run whose config still says `sonar` gets an execution identity naming `fast` and starts a new series.
- The provider registry, `packages/config`, project overrides (on write, and on read in the job runner, run queue, query tracking, and research) resolve the same way, so the frozen slot, snapshot `model`, and identity agree.
- A v2 plan revision published with a frozen `sonar` keeps that id in its slots and snapshots (the revision is immutable); its identity still resolves to `fast`, and `servedModel` shows the Agent model. A revision that froze different retired ids on different nodes (`sonar` and `sonar-pro`) records every model that now answers (`fast + low`); before the switch such a mixed-model engine was left out of the identity, so without this its checksum would not move. Mixed-model engines with no retired id are still left out.
- A partial run measured before the switch cannot be filled (refusal `model_retired`): its missing slots would run the replacement engine under the old run's identity. The run's stored identity decides, since runs queued since the switch never record a retired id; for a mixed-model engine an earlier identity omitted, the frozen slots decide.

## Stored history

`reparseStoredResult` dispatches on shape. A response with an `output` array is Agent; anything else is Sonar Chat Completions and keeps its parser: `choices[0].message.content`, sources from `search_results` (preferred, keeps titles) or `citations`, no search queries, and `retrievalStatus: unknown`. Both work direct or wrapped under `apiResponse`, so `canonry backfill` and reparse read old sweeps as before.

## Data stored per snapshot

`query_snapshots.raw_response`:

```json
{
  "model": "fast",
  "groundingSources": [{ "uri": "https://example.com/page", "title": "Page Title" }],
  "searchQueries": ["best crm for startups"],
  "apiResponse": {
    "object": "response",
    "status": "completed",
    "model": "perplexity/sonar",
    "output": [
      { "type": "search_results", "queries": ["..."], "results": [{ "id": 1, "url": "...", "title": "..." }] },
      { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "...", "annotations": [] }] }
    ]
  }
}
```

## Capturing fixtures

The fixtures in `packages/provider-perplexity/test/fixtures/` follow the Agent API schema in Perplexity's official SDK but are **not live captures** (see that folder's README). To replace them, run each request shape with a key and save the body:

```bash
curl -sS https://api.perplexity.ai/v1/agent \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY" -H 'content-type: application/json' \
  -d '{"preset":"fast","input":"best crm for startups","tools":[{"type":"web_search"}],"tool_choice":{"type":"web_search"}}' \
  > packages/provider-perplexity/test/fixtures/agent-fast-cited.json

curl -sS https://api.perplexity.ai/v1/agent \
  -H "Authorization: Bearer $PERPLEXITY_API_KEY" -H 'content-type: application/json' \
  -d '{"preset":"fast","input":"Say \"ok\""}' \
  > packages/provider-perplexity/test/fixtures/agent-no-search.json
```

Then update the exact values `test/agent-api.test.ts` asserts.

## Upstream references

- Migration guide: <https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar>
- Presets: <https://docs.perplexity.ai/docs/agent-api/presets>
- Response schema: `@perplexity-ai/perplexity_ai` `src/generated/api.ts` (`ResponsesResponseOutput`)
- Sonar (stored history): <https://docs.perplexity.ai/docs/sonar/openai-compatibility>

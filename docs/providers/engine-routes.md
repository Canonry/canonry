# Generic Engine Routes

Generic engine routes let one Canonry install use an OpenAI-compatible gateway
for text work without treating the gateway as a measured answer engine. No
router is privileged: OpenRouter is one optional preset, alongside LiteLLM,
Vercel AI Gateway, and a custom OpenAI-compatible endpoint.

## Connection versus route

A **connection** is instance-global transport policy:

- Stable connection ID, label, OpenAI-compatible endpoint, quota, and optional API key.
- The API key is write-only. A successful write and every read return only
  `secretConfigured`. An omitted `apiKey` preserves the stored credential only
  when the canonical endpoint is unchanged; changing endpoint or preset
  endpoint requires an explicit replacement key.
- A connection is shared by all routes that name it. Treat it as one upstream
  credential and one shared budget, not as project-scoped configuration.

A **route** is a stable selection on that connection:

- A server-reserved `route:` ID, label, connection ID, and model ID.
- The server owns its revision, source, and evidence capabilities. Clients do
  not submit those fields.
- One connection can support several routes with different model IDs, while
  still sharing the same connection quota and credential.

## Configure one

Start by creating or updating a connection. Supply quota limits on every
write. `--api-key` is write-only input. It does not appear in text, JSON,
JSONL, or subsequent reads.

```bash
canonry settings engine-connection gateway:research \
  --label "Research gateway" \
  --preset litellm \
  --max-concurrent 2 \
  --max-per-minute 60 \
  --max-per-day 600 \
  --api-key <write-only-secret>
```

Then inspect the optional model catalog and create a route. Catalog discovery
does not start inference. A normal `unavailable` response means that the
upstream did not provide `/models`. It does not permit capability assumptions.
A manual model ID remains valid.

```bash
canonry settings engine-models gateway:research

canonry settings engine-route route:research-gateway \
  --label "Research gateway" \
  --connection gateway:research \
  --model meta/llama-4

canonry settings engine-routes --format jsonl
```

`settings engine-routes` and `settings engine-models` are dependent response
documents, so `--format jsonl` emits one compact complete document rather than
dropping readiness or manual-model state. The route-list endpoint exposes safe
route summaries only. It does not expose credentials, connection endpoints, or
connection IDs.

### Presets

All presets use the `openai-compatible` protocol. They are endpoint defaults,
not provider implementations or evidence claims.

| Preset | Default endpoint | Notes |
| --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1` | Optional generic router preset. |
| `litellm` | `http://localhost:4000` | Useful for a local or self-hosted gateway. |
| `vercel-ai-gateway` | `https://ai-gateway.vercel.sh/v1` | Generic gateway preset. |
| `custom-openai-compatible` | none | Requires `--base-url <url>`. |

An explicit `--base-url` overrides a preset default. Changing a connection's
endpoint changes the policy for every attached route, so Canonry advances each
affected route revision.

## Text-only is not sweep-ready

Routes created with `settings engine-route` are **text-only**. They can serve
ad-hoc text work, but they cannot run `canonry run` or become answer-visibility
sweep providers. A generic gateway does not prove that Canonry can obtain all
of these from a real answer-engine response:

1. Retrieval evidence.
2. Final-answer citation evidence.
3. Location handling.
4. Served-model identity.

Only a native or server-owned verified adapter can be `measurement-ready`.
Configured routes remain `text-ready` even when a hand-edited config declares
otherwise. When a text-only route runs research, Canonry records the answer
text and its answer-text mentions. Canonry records no grounding sources, cited
domains, search queries, served model, or negative citation claim. Its citation
state is unavailable, not `not-cited`.

## Select a route for project research

`researchProvider` is separate from the project's sweep `providers`. It is
the default selected by `canonry research run <project> ...` when that command
does not pass `--provider`. An explicit `--provider` still wins.

```bash
canonry project update my-project \
  --research-provider route:research-gateway

# Remove the saved preference deliberately. Do not use an empty ID.
canonry project update my-project --clear-research-provider
```

The API validates an explicit selection against the configured API providers
and routes. This CLI command passes the value through unchanged. It does not
add a text route to the sweep provider set. Declarative project configuration
uses the same field:

```yaml
spec:
  researchProvider: route:research-gateway
```

## Evidence and identity boundaries

Route revisions are audit handles. Canonry fingerprints non-secret policy
material — connection ID, protocol, endpoint, route source, and evidence
capability — without serializing API keys. A model or connection policy change
can therefore be distinguished from a cosmetic label change, while credentials
remain outside run identity and all read DTOs.

Do not infer measurement evidence from a successful text completion, a model
catalog entry, or a preset name. Those facts only establish that the transport
can be usable for text work. Sweep-ready status is a server-owned evidence
contract, not a client-configurable flag.

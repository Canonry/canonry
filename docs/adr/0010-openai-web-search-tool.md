# ADR 0010: OpenAI Web Search Tool — `web_search` over `web_search_preview`

## Status

Accepted.

## Decision

Use OpenAI's GA `web_search` tool (type `web_search` / SDK alias `web_search_2025_08_26`) in `packages/provider-openai/src/normalize.ts` instead of the legacy `web_search_preview` tool.

Do **not** opt in to the new tool's additional controls:

- `filters.allowed_domains` — explicitly off. Canonry tracks who actually gets cited across the open web; allow-listing would defeat the point of the platform.
- `return_token_budget: 'unlimited'` — off. Deep-research mode is dramatically more expensive per call and is not needed for tracked-query sweeps, which run at scale across queries × providers × locations.
- `external_web_access` — leave at the API default. The tool is supposed to hit the live web; we have no reason to flip it.

## Why

### Historical context

The OpenAI provider was added in PR #5 (commit `d7c96d6f`, 2026-03-10) against `openai@^4.85.0`. At that SDK version only the preview tool was exposed (`WebSearchPreviewTool`, type `web_search_preview`). The Responses API later added a GA tool exported as `WebSearchTool` (type `web_search` / `web_search_2025_08_26`), and the SDK was bumped to `openai@^6.0.0`, but the call site was never updated. So the original choice was "the only tool the SDK exposed at the time" — not a deliberate preference for preview semantics.

### What `web_search` adds over `web_search_preview`

Per OpenAI's web-search guide (`developers.openai.com/api/docs/guides/tools-web-search`) and the SDK types in `openai@6.27`:

| Capability | `web_search_preview` | `web_search` |
|---|---|---|
| Domain filtering (`filters.allowed_domains`) | not supported | supported |
| `external_web_access` toggle | ignored | honored |
| `return_token_budget: 'unlimited'` (deep research) | not supported | supported |
| `user_location` (approximate city/region/country/timezone) | supported | supported |
| `search_context_size` (low/medium/high) | supported | supported |
| `search_content_types: 'image'` | supported (preview-only) | not supported |
| Output shape: `web_search_call.action.queries`, `output_text` annotations of type `url_citation` | identical | identical |

OpenAI's stated guidance: *"For new Responses API integrations, use `{ type: 'web_search' }`. The earlier `web_search_preview` tool remains available for legacy integrations, but it does not support newer controls."* Investment is going into `web_search`, so quality is likely to diverge in its favor over time.

### Why this migration is safe

The two tools share the same response shape — both emit `web_search_call` items with `action.queries`, and both attach `url_citation` annotations to `output_text` content blocks. The existing extractors `extractGroundingSourcesFromRaw` and `extractSearchQueriesFromRaw` work unchanged.

The `user_location` shape is compatible too. The new tool's `WebSearchTool.UserLocation` makes `type: 'approximate'` optional (the preview required it), but supplying it is still valid, so the existing call site needs no change beyond the type literal.

### Why the new tool's bells and whistles stay off

- **`filters.allowed_domains`**: would silently bias citation tracking toward a curated set, which is the opposite of what canonry exists to measure. The whole product depends on observing which domains naturally appear in answers.
- **`return_token_budget: 'unlimited'`**: deep-research mode runs many more sub-searches per call and is metered accordingly. At canonry's fan-out (queries × providers × locations × scheduled runs) this would be a budget bomb without changing the metric we care about — was-cited / was-mentioned remains binary, and a deeper answer doesn't change the binary outcome much.
- **`external_web_access`**: defaults to "on" and there's no reason to disable it.

## What this does **not** fix

The API tool, no matter which flavor, doesn't see the logged-in user's history, custom instructions, or personalization. Real ChatGPT users get different answers than the API does. That's a structural gap — switching from `web_search_preview` to `web_search` does not close it. The browser-based ChatGPT provider planned in `docs/roadmap.md` ("Browser Provider (ChatGPT UI)") is the deliberate fix for that gap.

## How this differs from PR #563

PR #563 ("Potential fixes for 3 code quality findings") was an AI-generated autofix that bundled three changes:

1. Switch `healthcheck` from the Responses API to Chat Completions — **regression**, throws away the side benefit of healthcheck exercising the same API surface the production query path uses. Dropped.
2. Retype `extractResponseText` to `OpenAI.Chat.Completions.ChatCompletion` without updating the body or the `generateText` call site — **broken build**, `.output` doesn't exist on `ChatCompletion`. Dropped.
3. Switch the tracked-query tool from `web_search_preview` to `web_search` — **sound in principle but unaudited**: PR shipped no doc updates, no ADR, no rationale for keeping the new tool's knobs off. This ADR is the audited version of that change.

## Related SDK upgrades considered (and not pursued)

Asked at PR review: should canonry also bump `openai`, `@anthropic-ai/sdk`, or `@google/genai` while touching this area?

**OpenAI (`openai@^6.0.0`, currently resolves to 6.27.x, latest 6.38.x):** No version bump required for this ADR — `web_search` is already in 6.27. Newer minor versions ship nice-to-haves but not blockers:
- v6.16 added `filters` (already explicitly off per this ADR).
- v6.35–v6.37 added the `web_search_call.results` include option, which surfaces the raw search-result list alongside the answer. That would let canonry see "domains the model searched but did not end up citing," which is a useful signal — but it's a separate enhancement, not part of this migration. Filed as a future opportunity, not a blocker.

**Anthropic (`@anthropic-ai/sdk@^0.78.0`, currently resolves to 0.78.x, latest 0.96.x):** SDK upgrade would not add anything canonry needs. The newer tool `web_search_20260209` is already exposed in 0.78, alongside the `web_search_20250305` we use today. The change is server-side: `web_search_20260209` adds **dynamic filtering** — Claude writes and executes code to post-process raw search results before they enter the context window. That's valuable for long deep-research workflows, but it does not match canonry's profile:
- canonry runs short tracked queries ("best CRM for SaaS"), not multi-document research; the context window isn't the bottleneck.
- Dynamic filtering **requires** the `code_execution` tool to also be enabled, doubling the server-tool surface per call and adding latency.
- The response shape (`text.citations` of type `web_search_result_location`, `server_tool_use`, `web_search_tool_result`) is identical, so a future switch is mechanically cheap if the cost-benefit changes.
- Model availability: `web_search_20260209` is restricted to Claude Opus 4.7 / 4.6 and Sonnet 4.6 (and not available on Amazon Bedrock or Claude Platform on AWS). Canonry's Claude provider is model-agnostic and Haiku is a legitimate target.
- Pricing is the same ($10 per 1,000 searches) regardless of tool version.

Decision: stay on `web_search_20250305` in `packages/provider-claude/src/normalize.ts`. Revisit only if we add a deep-research code path that would benefit from dynamic filtering.

**Gemini (`@google/genai@^1.46.0`, currently 1.46.0, latest 2.3.x):** SDK upgrade would not add anything canonry needs and could introduce breakage:
- v1.43 added Image Grounding to the `GoogleSearch` tool — not relevant to citation tracking, which is text-only.
- v1.50 added `enterprise_web_search` — Enterprise-plan feature, not part of the default tier we use.
- v1.46 already shipped Interactions-API breaking changes (`rendered_content` → `search_suggestions`, citation annotation refactor). v2.x is a major release and likely carries more of the same. Canonry uses `models.generateContent` with `googleSearch` grounding, which is on a different surface from Interactions, but verifying that across a major bump is its own scoped exercise.

Decision: stay on `@google/genai@^1.46.0`. A v2.x bump should be its own PR with a focused regression check (citation extraction, grounding-source domain extraction from base64 proxy URLs).

## Consequences

- `packages/provider-openai` now targets the GA web-search tool. Future quality improvements OpenAI ships to `web_search` reach canonry automatically; future regressions land on us automatically too.
- Documentation (`docs/providers/openai.md`, `docs/providers/README.md`, `packages/provider-openai/AGENTS.md`, `docs/adr/0006-location-aware-tracking.md`, `docs/roadmap.md`) now consistently says `web_search`.
- The location-handling description rendered in client reports (via `PROVIDER_LOCATION_HANDLING.openai.description` in `packages/contracts/src/provider.ts`) now reads "OpenAI's web_search tool."
- The "OpenAI returns fewer/different results than ChatGPT UI" caveat still applies — that's an API-vs-browser gap, not a preview-vs-GA gap.

## Explicit Non-Decisions

- Canonry does not opt in to `filters.allowed_domains`, `return_token_budget`, or `search_content_types: 'image'` at this time. A future need for any of these should be additive — for example, an opt-in "image visibility" sweep kind, not a flag added to the existing tracked-query path.
- Canonry does not currently parametrize `search_context_size`. The API default (`medium`) is what we get; if results quality becomes an issue, that's the first knob to try before considering deeper changes.

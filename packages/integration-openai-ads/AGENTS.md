# integration-openai-ads

## Purpose

OpenAI Advertiser API (ChatGPT ads) integration — typed client for ad account,
geo lookup, conversion setup reads, campaigns, ad groups, ads, insights, image
upload, and lifecycle mutations. The paid-surface counterpart
to the organic answer-visibility data: ads render only in the ChatGPT consumer
UI (never in API answers), so this client is the only window into the paid
layer. Public Canonry routes place lifecycle writes behind `ads.write`, force
creates paused, omit archive and activation, and record durable receipts. The
internal client implementation still mirrors the upstream activate primitives,
but the package root intentionally does not export them. Package consumers can
create paused entities, update non-lifecycle fields, and pause; a human
activates in Ads Manager.

## Key Files

| File | Role |
|------|------|
| `src/ads-client.ts` | API client — account, geo lookup, conversion setup, campaigns, ad groups, ads, insights, upload, and lifecycle actions |
| `src/types.ts` | Response types (live-captured unless explicitly documented otherwise) and `OpenAiAdsApiError` |
| `src/constants.ts` | API base URL, timeouts, pagination cap |
| `src/index.ts` | Re-exports public API |
| `test/fixtures.ts` | Sanitized copies of real captured responses — never invent shapes |

## Patterns

- **Bearer "SDK key" auth**: keys are minted in OpenAI Ads Manager and scoped
  to one ad account (platform `sk-` keys are a different credential system —
  they 401 unless granted ads scopes). Stored in `~/.canonry/config.yaml`.
- **List envelope**: every list returns `{ object: 'list', data, first_id,
  last_id, has_more }`. The client auto-paginates; the `after=` request param
  follows the OpenAI list convention but has not been exercised against a
  multi-page dataset yet — revisit if pagination misbehaves on large accounts.
- **Conversion setup fixtures**: the pixels and event-settings endpoints have
  been confirmed live only with empty list envelopes. Do not add a non-empty
  fixture or tighten list item fields until a real response is captured; that
  capture is a beta smoke-test gate.
- **`fields[]` selection**: insights default to impressions only; richer
  metrics require literal `fields[]=` query pairs with namespaced names
  (`campaign.clicks`, `ad_group.spend`, `metadata.readable_time`, …). A wrong
  field name returns a 400 whose message enumerates the valid catalog.
- **Money units are mixed upstream**: budgets/bids are integer micros
  (`daily_spend_limit_micros`, `max_bid_micros`) but insights `spend`/`cpc`
  are decimal dollars. Consumers must normalize at ingest — this client
  returns values as the API sends them.
- **Bidding and billing vocabularies are closed**: campaign `bidding_type` is
  `impressions` or `clicks`; ad-group `billing_event_type` is `impression` or
  `click`. A click campaign requires at least one unique
  `conversion_event_setting_id`, and its ad groups must use click billing.
  Omitted campaign bidding fields still use the provider's documented legacy
  `impressions` default. Canonry's route adapter materializes its own legacy
  defaults without changing the parsed operation payload.
- **Ad-group bid updates are full-object writes**: the provider requires both
  `billing_event_type` and `max_bid_micros` when `bidding_config` is updated.
  Preserve the existing billing event when changing only the maximum bid;
  never inject impression billing into a click campaign.
- **Provider writes are not idempotent by contract**: callers must establish a
  durable operation receipt before the network call and never blindly retry an
  ambiguous outcome. Canonry's route layer owns that receipt policy.
- **Activation and archive are policy decisions**: archive is irreversible;
  the beta public surface exposes neither archive nor activation. Creates are
  paused, updates require a paused entity, and a human activates in Ads Manager.
- **Vocabulary**: paid metrics are `paid` / `sponsored` — never reuse
  `mentioned` / `cited` (those mean answer-text and source-list presence).

## Common Mistakes

- **Storing API keys in the database** — credentials belong in `~/.canonry/config.yaml`.
- **Inventing fixture fields** — every fixture in `test/` mirrors a captured
  live response (sanitized identifiers). When the API surface grows, capture
  the real response first.
- **Treating insights `spend` as micros** — it is decimal dollars.
- **Retrying a timed-out mutation** — reconcile the entity in Ads Manager or
  through a fresh sync; the first request may already have succeeded.

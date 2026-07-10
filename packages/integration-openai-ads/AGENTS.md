# integration-openai-ads

## Purpose

OpenAI Advertiser API (ChatGPT ads) integration — typed read client for ad
account, campaigns, ad groups, ads, and insights. The paid-surface counterpart
to the organic answer-visibility data: ads render only in the ChatGPT consumer
UI (never in API answers), so this client is the only window into the paid
layer. The lane design lives in `docs/roadmap.md` ("Paid Surface (ChatGPT Ads)").

## Key Files

| File | Role |
|------|------|
| `src/ads-client.ts` | API client — account, campaigns, ad groups, ads, insights |
| `src/types.ts` | Response types (mirrored from captured live responses) and `OpenAiAdsApiError` |
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
- **`fields[]` selection**: insights default to impressions only; richer
  metrics require literal `fields[]=` query pairs with namespaced names
  (`campaign.clicks`, `ad_group.spend`, `metadata.readable_time`, …). A wrong
  field name returns a 400 whose message enumerates the valid catalog.
- **Money units are mixed upstream**: budgets/bids are integer micros
  (`daily_spend_limit_micros`, `max_bid_micros`) but insights `spend`/`cpc`
  are decimal dollars. Consumers must normalize at ingest — this client
  returns values as the API sends them.
- **Vocabulary**: paid metrics are `paid` / `sponsored` — never reuse
  `mentioned` / `cited` (those mean answer-text and source-list presence).

## Common Mistakes

- **Storing API keys in the database** — credentials belong in `~/.canonry/config.yaml`.
- **Inventing fixture fields** — every fixture in `test/` mirrors a captured
  live response (sanitized identifiers). When the API surface grows, capture
  the real response first.
- **Treating insights `spend` as micros** — it is decimal dollars.

## See Also

- `docs/roadmap.md` — "Paid Surface (ChatGPT Ads)" lane

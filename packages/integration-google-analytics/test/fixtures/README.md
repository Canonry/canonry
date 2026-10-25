# GA4 Data API fixtures

| File | Case |
|------|------|
| `ga4-search-console-landing-pages.json` | `runReport` for GA4's "Google organic search traffic: Landing page + query string" report (Search Console collection), last 28 days, on a property linked to Search Console. |
| `ga4-admin-key-events.json` | Admin API v1beta `properties/{id}/keyEvents` listing: GA4's default key events plus one custom event. |
| `ga4-ai-referrals-ai-assistant-channel.json` | The three `runReport` passes of `fetchAiReferrals` (session, first user, manual UTM), each request as sent, with GA4's `AI Assistant` channel in the session and first-user filters; plus a live 400 body for a request GA4 cannot combine. |

`ga4-search-console-landing-pages.json` keeps the **response shape of a live
capture** (GA4 Data API v1beta, 2026-10-08). Every metric value, the `totals`
row, `rowCount` and every landing-page path are **synthetic**. The value
formats are the live ones: metric values are strings, integers as integer
strings, CTR and average position as long float strings, and `totals` is the
`RESERVED_TOTAL` row. `metadata` and `kind` are kept as returned.
`_note` records this and the `checkCompatibility` result for the captured
property; `request` is the body that produced the captured response.

The file holds 14 rows while the request asked for 25 and `rowCount` is 87,
so, as in the live report, the row list is a subset and the rows do not add
up to the Total. Tests that need a complete page set `rowCount` to the rows
they serve.

Not captured: the response for a property with no Search Console link.

`ga4-ai-referrals-ai-assistant-channel.json` keeps the **request bodies and
response shape of live captures** (2026-10-20; request bodies re-run
2026-10-21 with the bounded source filters): header names as echoed,
metric values as integer strings, `metadata` and `kind`. Its rows and values
are **synthetic**, because no captured property had a grok, deepseek or
unrecognized source in the AI Assistant channel; `_note` records the
`checkCompatibility` result and the case-insensitive match.

`ga4-admin-key-events.json` keeps the **response shape of a live capture**
(GA4 Admin API v1beta, 2026-10-25): resource names, `countingMethod`, and a
default key event that omits the false-valued `deletable` and `custom`
fields. The property id, key event ids and `createTime` values are
**synthetic**.

Keep client and company data out of every file here.

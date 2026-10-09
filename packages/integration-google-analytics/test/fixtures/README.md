# GA4 Data API fixtures

| File | Case |
|------|------|
| `ga4-search-console-landing-pages.json` | `runReport` for GA4's "Google organic search traffic: Landing page + query string" report (Search Console collection), last 28 days, on a property linked to Search Console. |

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
Keep client and company data out of every file here.

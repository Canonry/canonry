# Advanced Measurement: Portfolio Pulse

Interactive prototype: [portfolio-scale-flows.html](./portfolio-scale-flows.html)

The prototype uses one deterministic synthetic dataset with 225 Properties in
15 Groups. All brand, domain, market, Property, count, and schedule details are
fictional.
It explores the selected Portfolio Pulse direction inside the existing project
shell; it is not a second dashboard or a four-view switcher.

## Product structure

```text
AI Visibility
  Portfolio Pulse → Group overview → Property overview → answer evidence

Queries
  Tracked | Discover | Test

Settings
  Measurement setup
  AI visibility sweep
```

Properties and Groups remain scopes inside one Project. The Project owns one
published measurement plan, one official sweep schedule, and one project-wide
visibility trend.

## Operator flow

1. Test free-form queries without changing official reporting.
2. Save a useful test and choose **Add to measurement**.
3. In Simple setup, track it project-wide immediately.
4. In Advanced setup, assign Properties, inspect the exact plan change, and
   publish a new revision.
5. Show the query as **Awaiting first sweep** until the next full sweep. The
   saved test never enters Portfolio Pulse or trends as official evidence.

## Accuracy rules

- Keep Non-brand and Branded denominators separate.
- Show `cited answers / measured answers` with each percentage.
- Render `Not measured` as unavailable, never as `0%`.
- Treat Groups as independent scopes. They can overlap, so Group Property
  counts must not be summed into a portfolio total.
- Reuse the current project-wide trend only at Portfolio scope.
- Do not infer Group or Property time series from project-wide analytics.
- Compare full sweeps only when plan revision, execution identity, provider,
  location, and scope are comparable.
- Keep spot checks and saved tests outside official reporting.

## Production boundary

This change ships the Portfolio Pulse rollup on the Advanced Measurement
Overview and reuses the current project-wide `VisibilityTrendSection`. It also
replaces vague “Review” status copy with **Ambiguous source match** when one
cited source matches multiple Properties.

The prototype also shows the intended Query Test → Tracked handoff and schedule
placement. Those interactions remain product direction until the browser has a
transactional Research-result-to-plan promotion flow. Existing typed reads
already support the shipped snapshot:

| Need | Existing read |
| --- | --- |
| Portfolio and Group rollups | `GET /projects/:name/measurement-portfolio-summary` |
| Paged Property results | `GET /projects/:name/measurement-overview` |
| Comparable current-versus-previous changes | `GET /projects/:name/measurement-changes` |
| Property investigation | Property questions, result, and evidence reads |
| Project-wide history | `GET /projects/:name/analytics/metrics` |

There is no multi-point Group or Property trend endpoint. Group and Property
views should use a current snapshot plus a comparable one-step change until a
bounded scoped-history read exists.

## Comparable product patterns

- Google Ads manager accounts use a cross-account overview, hierarchy,
  sortable tables, search, and labels:
  <https://support.google.com/google-ads/answer/6139225?hl=en>
- Datadog uses synchronized search, facets with counts, and saved views:
  <https://docs.datadoghq.com/monitors/manage/search/>
- New Relic Workloads groups entities by business meaning and makes rollup
  status explicit:
  <https://docs.newrelic.com/docs/new-relic-solutions/new-relic-one/workloads/use-workloads/>
- Grafana uses variable-driven views and bounded repeated panels:
  <https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/>

## Local preview

From the repository root:

```bash
python3 -m http.server 4821
```

Then open:

<http://127.0.0.1:4821/docs/mockups/advanced-measurement/portfolio-scale-flows.html#pulse>

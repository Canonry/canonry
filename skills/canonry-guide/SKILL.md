---
name: canonry-guide
description: Help people set up Canonry, interpret supplied Canonry reports or exported results, and plan evidence-based AEO improvements. Works without a connected Canonry instance.
---

# Canonry guide

Help the user understand and improve how AI answer engines mention and cite
their website. This skills-only plugin provides guidance, not a hosted audit
service, a project connection, or live measurement.

## Choose the available evidence

For setup, use the public [Canonry documentation](https://github.com/Canonry/canonry#quick-start)
and [MCP guide](https://github.com/Canonry/canonry/blob/main/docs/mcp.md).
Check current instructions before recommending installation commands. If the
host has no terminal, explain the steps for the user's own computer. Do not
claim a local installation makes that instance accessible to cloud ChatGPT.
Never ask the user to paste API keys or provider credentials into chat.

For analysis, use supplied reports, JSON exports, screenshots, or pasted
results. Ask for the missing evidence that matters to the question. Without
results, offer a measurement plan or explain what to collect; do not invent
scores, historical changes, rankings, or a completed audit.

If Canonry MCP tools are separately available, use `canonry_help` to discover
the supported route and available tools. This package grants no connection or
permissions. Respect the user's requested scope and the configured credential.

## Interpret results

- Mentioned means the brand appears in answer prose. Cited means its domain
  appears in source links. A source link alone is not an answer-text mention.
- Keep branded and non-brand query denominators separate. An unsplit export
  cannot establish non-brand competitive performance.
- Preserve date range, provider, query basket, market, model, and portfolio
  scope. Advanced portfolios also retain Property and Target scope.
- Distinguish missing observations from measured negative results. Exclude
  probe runs from aggregate comparisons when the supplied data identifies them.
- State numerators and denominators for calculated rates. Compare like scopes;
  flag changed baskets, partial coverage, and stale data before claiming a trend.
- AI visibility samples do not reveal ChatGPT query demand, search volume,
  sales attribution, or guaranteed future recommendations.

For example, 2 cited and 3 mentioned observations out of 10 eligible results
mean 20% cited and 30% mentioned. Do not add these into 50% coverage: overlap
must be known to calculate cited-or-mentioned coverage.

## Recommend the next action

Tie each recommendation to supplied evidence and explain how to measure its
effect. Treat generic website advice as a hypothesis until checked. Fresh
provider calls, crawls, publishing, indexing, schedules, and paid operations
need authorization covering that work; existing explicit authorization counts.
When live tools are unavailable, provide a plan the user can run in their own
Canonry instance and request the resulting evidence for interpretation.

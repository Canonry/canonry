# Journeys review evidence

Synthetic fixtures, captured on 2026-10-27. No client traffic or provider calls.
The before images show the initial Journeys layout before density reduction;
the after images show the final layout. Desktop is 1440 pixels wide; mobile is 390 pixels.

| View | Before | After |
| --- | --- | --- |
| Visitor journeys, desktop | [Initial layout](before-visitors-desktop.png) | [Default view](after-visitors-desktop.png) |
| Agent journeys, mobile | [Initial layout](before-agents-mobile.png) | [Default view](after-agents-mobile.png) |
| Visitor request history | — | [Expanded requests](after-visitor-requests-desktop.png) |
| Agent request history | — | [Expanded request details](after-agent-requests-mobile.png) |

Both tabs, filters, expanded histories and request details were checked in the
actual router and shell with synthetic API responses. The final mobile views
had no document overflow; no browser errors were recorded. Data and scope
labels distinguish visitor cohorts from retained history, and operator
verification from inferred agent sequences.

Keyboard smoke passed 22 desktop and 24 mobile checks, including filters,
disclosures and focus return. See [validation results](validation.md).

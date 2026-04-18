---
name: regression-playbook
description: Detection → triage → diagnosis → response for lost citations. Read when investigating why a keyword lost its citation.
---

# Regression Playbook

## Detection

A regression is detected when a citation is lost between consecutive completed runs for the same project. Specifically: a keyword+provider pair that was cited in run N is no longer cited in run N+1.

## Triage

Classify the regression by severity:

| Severity | Criteria |
|---|---|
| **Critical** | Branded term lost on any provider |
| **High** | Top-performing keyword lost on primary provider |
| **Medium** | Non-branded keyword lost on one provider |
| **Low** | Keyword lost that was only marginally cited |

## Diagnosis

For each regression, check causes in order:

1. **Competitor displacement** — Did a competitor domain appear in the citation for this keyword+provider? Check current run snapshots.
2. **Indexing loss** — Is the page still indexed? Check Google Search Console integration or HTTP status.
3. **Content change** — Did the page content change significantly? Compare content hashes if available.
4. **Provider behavior change** — Did the provider change its response pattern for this query type?
5. **Unknown** — No clear cause identified. Flag for manual investigation.

## Response

1. Alert the client with specific data (keyword, provider, dates, evidence)
2. Recommend diagnostic steps based on suspected cause
3. If actionable: generate fix (schema update, content suggestion, indexing resubmission)
4. Set monitoring flag to track if the regression resolves
5. Update memory with the regression event and diagnosis

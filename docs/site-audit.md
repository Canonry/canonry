# Site Audit Design

> **Deferred to Phase 3.** Not in scope for Phase 2. This document captures the future design for reference.

## Scope

Site audits are planned as sitemap-first crawls built on top of the existing root audit engine.

## Discovery Order

1. Explicit `sitemapUrl`, if provided
2. Site `/sitemap.xml`
3. Fallback to the start URL only if sitemap discovery fails

## Defaults

- `maxUrls = 500`
- `concurrency = 5`
- `siteRateLimitRps = 5`
- `retryLimit = 1`

`concurrency` limits active page analyses. `siteRateLimitRps` limits new request starts and is the final throttle.

## Auxiliary Resources

Fetch once per site audit on a best-effort basis:

- `robots.txt`
- `llms.txt`
- `llms-full.txt`
- `sitemap.xml`

Failure to fetch these resources should not abort the audit. The missing or unreachable state is recorded and surfaced in metadata and findings.

## Result Semantics

- `completed`: sitemap discovery succeeded and at least 98% of pages succeeded
- `partial`: fallback mode or 50% to 97% of pages succeeded
- `failed`: start URL inaccessible, zero pages succeeded, or fewer than 50% of pages succeeded

## Memory Model

Process pages through a bounded queue and release page parse state after each analysis. Never hold more than the configured concurrency in memory.

# ADR 0003: Use Conservative Provider Throttling and Quota Defaults

## Decision

Provider execution starts with conservative concurrency, per-minute, and per-day limits and marks runs partial when quotas are exhausted.

## Why

- avoids blowing through provider quotas during self-hosting
- gives predictable worker behavior on small deployments
- keeps failures observable without marking the whole system unhealthy

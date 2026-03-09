# ADR 0001: Consume `@ainyc/aeo-audit` as an External Dependency

## Decision

The monitoring application must consume the published `@ainyc/aeo-audit` npm package instead of sharing a repository with the audit package source.

## Why

- keeps repository responsibilities clear
- allows the audit package and monitoring app to release independently
- ensures the monitoring app uses the same public contract as external consumers

## Consequences

- worker integrations must go through explicit adapters
- test coverage should validate the published package integration boundary

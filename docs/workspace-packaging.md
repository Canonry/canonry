# Workspace Structure

## Purpose

This repository is a private workspace for the monitoring application. The shared technical audit engine is consumed from the published `@ainyc/aeo-audit` package.

## Boundary Rules

- Do not copy source files out of the audit package repo.
- Use the published npm package in application code.
- Keep package-specific logic in this repo focused on monitoring concerns.

## Workspace Layout

- `apps/*` contains runnable services
- `packages/*` contains shared internal libraries
- `docs/*` contains product and architecture documentation

## External Dependency

The worker should import technical audit functionality from:

```bash
@ainyc/aeo-audit
```

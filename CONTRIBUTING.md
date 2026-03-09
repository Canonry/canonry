# Contributing to Canonry

## Setup

```bash
git clone <repo-url>
cd canonry
pnpm install
pnpm run typecheck
pnpm run test
pnpm run lint
```

## Local Development

For working on the web dashboard:

```bash
pnpm run dev:web
```

For testing the full local stack (after Phase 2):

```bash
canonry init
canonry serve
```

## Repo Rules

- Keep this repo focused on the monitoring product.
- Do not vendor code from `@ainyc/aeo-audit`; use the published npm package.
- Put cross-service DTOs in `packages/contracts`.
- Keep API route plugins in `packages/api-routes` — no app-level concerns.
- `packages/canonry/` is the only publishable artifact.
- Keep API handlers thin and push orchestration into shared services as the backend grows.

## Config-as-Code

Projects can be managed declaratively via `canonry.yaml` files:

```yaml
apiVersion: canonry/v1
kind: Project
metadata:
  name: my-project
spec:
  canonicalDomain: example.com
  keywords:
    - keyword one
```

Apply with `canonry apply <file>` or `POST /api/v1/apply`.

## Validation

Before opening a PR:

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
```

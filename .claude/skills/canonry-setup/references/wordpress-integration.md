# WordPress Integration

Canonry integrates with WordPress through the core REST API plus Application Passwords.

## What Canonry Automates

- Read and write page content, titles, slugs, and status
- Audit pages for `noindex`, missing SEO title, missing meta description, missing schema, and thin content
- Compare live vs staging for a page with `canonry wordpress diff`
- Update SEO meta when the site exposes writable REST meta fields

## What Stays Manual

Canonry generates payloads and instructions for these workflows, but it does not apply them remotely:

- `canonry wordpress set-schema`
- `canonry wordpress set-llms-txt`
- `canonry wordpress staging push`

Expect those commands to return:

- `manualRequired: true`
- generated content
- target/admin URL when available
- next-step instructions

## Environment Model

Each project-scoped WordPress connection stores:

- live `url`
- optional `stagingUrl`
- `defaultEnv`
- `username`
- `appPassword`

Env-sensitive commands accept `--live` or `--staging`. If neither is provided, canonry uses `defaultEnv`.

## Typical Workflow

```bash
canonry wordpress connect mysite --url https://example.com --user admin --staging-url https://staging.example.com --default-env staging
canonry wordpress pages mysite --staging
canonry wordpress page mysite pricing --staging
canonry wordpress set-meta mysite pricing --title "SEO title" --description "Meta description" --staging
canonry wordpress audit mysite --staging
canonry wordpress diff mysite pricing
canonry wordpress staging push mysite
```

## Important Constraints

- WordPress auth is stored locally in `~/.canonry/config.yaml`
- Canonry does not use wp-admin automation or undocumented plugin APIs
- If SEO meta is not writable through REST, canonry returns an actionable error instead of guessing
- Duplicate slug matches are returned as explicit ambiguity errors with candidate page IDs/titles

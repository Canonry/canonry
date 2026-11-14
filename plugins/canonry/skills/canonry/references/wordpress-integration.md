# WordPress Integration

Canonry integrates with WordPress through the core REST API plus Application Passwords.

## What Canonry Automates

- Read and write page content, titles, slugs, and status
- Audit pages for `noindex`, missing SEO title, missing meta description, missing schema, and thin content
- Compare live vs staging for a page with `cnry wordpress diff`
- Update SEO meta when the site exposes writable REST meta fields
- Deploy a profile's JSON-LD with `cnry wordpress schema deploy <project> --profile <file>` when the site supports the write

## What Stays Manual

Canonry generates payloads and instructions for these workflows, but it does not apply them remotely:

- `cnry wordpress set-schema`
- `cnry wordpress set-llms-txt`
- `cnry wordpress staging push`

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

Have the operator set `WP_APP_PASSWORD` in their terminal and run the connection command. Obtain approval for the exact WordPress change before running `set-meta` or another write.

```bash
cnry wordpress connect mysite --url https://example.com --user admin \
  --app-password "$WP_APP_PASSWORD" --staging-url https://staging.example.com --default-env staging
cnry wordpress pages mysite --staging
cnry wordpress page mysite pricing --staging
cnry wordpress set-meta mysite pricing --title "SEO title" --description "Meta description" --staging
cnry wordpress audit mysite --staging
cnry wordpress diff mysite pricing
cnry wordpress staging push mysite
```

## Important Constraints

- WordPress auth is stored locally in `~/.canonry/config.yaml`
- Canonry does not use wp-admin automation or undocumented plugin APIs
- If SEO meta is not writable through REST, canonry returns an actionable error instead of guessing
- Duplicate slug matches are returned as explicit ambiguity errors with candidate page IDs/titles
- Authentication is verified on connect by calling `/wp/v2/users/me` — if that fails, canonry returns an actionable error message

## Related: Elementor MCP

If both skills are installed, read the [local Aero Elementor reference](../../aero/references/wordpress-elementor-mcp.md). If only the Canonry skill is installed, read the [Aero Elementor reference on GitHub](https://github.com/Canonry/canonry/blob/main/skills/aero/references/wordpress-elementor-mcp.md).

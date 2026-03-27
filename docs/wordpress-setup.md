# WordPress Setup

Canonry integrates with WordPress through the core REST API using **Application Passwords**. The integration is intentionally split into:

- **Automated via REST:** page reads and writes, title/slug/content updates, page audits, staging-vs-live diffs, and SEO meta updates when the site exposes writable REST meta fields.
- **Manual-assist only:** `llms.txt`, schema injection, and WP STAGING push-to-live. Canonry generates the content and next steps, but it does not click wp-admin buttons or write arbitrary files on the server.

There is currently **no WordPress web UI** in canonry. Use the CLI or API.

---

## Prerequisites

- A WordPress site with the REST API enabled
- A WordPress user account that can edit pages
- An [Application Password](https://wordpress.org/documentation/article/application-passwords/) for that user
- Optional: a staging site URL if you want `--staging`, `diff`, and staging status/push workflows

---

## What Canonry Can Automate

```bash
canonry wordpress pages <project>
canonry wordpress page <project> <slug>
canonry wordpress create-page <project> --title ... --slug ... --content-file ./page.html
canonry wordpress update-page <project> <slug> --title ... --content-file ./page.html
canonry wordpress set-meta <project> <slug> --title ... --description ...
canonry wordpress audit <project>
canonry wordpress diff <project> <slug>
```

### SEO meta support is capability-based

`canonry wordpress set-meta` only writes SEO fields when WordPress exposes them through REST. That usually means:

- the SEO plugin stores data in `meta`
- those meta keys are registered with `show_in_rest`

If the site does not expose writable SEO fields, canonry returns an actionable error instead of attempting undocumented plugin hacks.

---

## What Stays Manual

These commands generate content and instructions, but they do not apply the change remotely:

```bash
canonry wordpress set-schema <project> <slug> --json '{"@type":"FAQPage"}'
canonry wordpress set-llms-txt <project> --content "..."
canonry wordpress staging push <project>
```

Use them when you want canonry to generate the payload while leaving the final server or wp-admin action to an operator.

---

## Connect a Project

```bash
canonry wordpress connect mysite \
  --url https://example.com \
  --user admin \
  --staging-url https://staging.example.com \
  --default-env staging
```

If you omit `--app-password`, canonry prompts for it interactively.

Connection data is stored in `~/.canonry/config.yaml` under the WordPress section, not in the project database tables.
The Application Password is stored there in plain text with the config file’s existing `0600` permissions model, so do not commit or share that file.

### Environment model

- `url` is the live site
- `stagingUrl` is optional
- `defaultEnv` controls which site env-sensitive commands target when you do not pass a flag
- Use `--live` or `--staging` to override the default for a single command

Examples:

```bash
canonry wordpress pages mysite --staging
canonry wordpress page mysite about --live
canonry wordpress audit mysite --staging
```

---

## Common Workflows

### Review and edit content

```bash
canonry wordpress pages mysite --staging
canonry wordpress page mysite pricing --staging
canonry wordpress update-page mysite pricing --title "New title" --content-file ./pricing.html --staging
```

### Audit a site before publishing

```bash
canonry wordpress audit mysite --staging
canonry wordpress diff mysite pricing
```

`audit` prioritizes:

- published pages marked `noindex`
- missing SEO titles
- missing meta descriptions
- missing schema
- thin content

### Generate manual handoffs

```bash
canonry wordpress set-schema mysite pricing --type FAQPage --json '{"@type":"FAQPage"}'
canonry wordpress set-llms-txt mysite --content "User-agent: *"
canonry wordpress staging push mysite
```

Each command returns:

- `manualRequired: true`
- the generated content
- the target/admin URL when available
- concrete next steps

---

## Troubleshooting

### `WordPress credentials are invalid or lack permission`

The username or Application Password is wrong, or the account lacks page-edit permissions. Create a fresh Application Password in WordPress and reconnect.

### `No staging URL configured`

Reconnect the project with `--staging-url`, or use `--live` on the command.

### `Multiple pages matched slug`

WordPress returned duplicate slug matches. Canonry lists the candidate page IDs and titles; resolve the duplicate in WordPress, then rerun the command.

### `This WordPress site does not expose writable SEO meta fields through REST`

Canonry can read the rendered SEO state, but it cannot safely write plugin meta on that site. Update the SEO fields in WordPress directly or expose the needed meta keys via REST.

### `llms.txt` or schema was not applied

That is expected. `set-llms-txt` and `set-schema` are manual-assist commands only. Canonry returns the content to paste plus the next-step checklist.

# Aero Agent -- Operational Guidelines

## Data Access

All data access goes through the canonry CLI. Never read the SQLite database directly.

```bash
# Always use --format json for structured output
canonry <command> --format json
```

The canonry server must be running for most commands. Verify by hitting the health endpoint (`GET /health`) or by listing projects:

```bash
canonry project list --format json
```

If the server isn't running, start it with `canonry serve`.

## Key Commands

### Monitoring

| Command | Purpose |
|---------|---------|
| `canonry run <project>` | Trigger a visibility sweep across all configured providers |
| `canonry run <project> --provider gemini` | Single-provider sweep |
| `canonry status <project>` | Current project status and latest run summary |
| `canonry evidence <project>` | Raw citation evidence from sweeps |
| `canonry insights <project>` | AI-generated insights and findings |
| `canonry health <project>` | Health snapshot with visibility scores |
| `canonry timeline <project>` | Per-keyword citation history over time |
| `canonry export <project>` | Full project data export |

### Auditing

```bash
# Run a technical AEO audit on a URL
npx @ainyc/aeo-audit <url> --format json
```

### Project Management

| Command | Purpose |
|---------|---------|
| `canonry project list` | List all projects |
| `canonry project create <name> --domain <domain>` | Create a new project |
| `canonry keyword add <project> <keyword>...` | Add keywords to track |
| `canonry keyword list <project>` | List tracked keywords |

## Workflow Patterns

### Daily monitoring sweep

1. Check project status: `canonry status <project> --format json`
2. Run sweep if stale: `canonry run <project>`
3. Review insights: `canonry insights <project> --format json`
4. Escalate critical/high severity findings to the operator

### Investigation workflow

1. Identify affected keywords from insights
2. Pull evidence: `canonry evidence <project> --format json`
3. Check timeline for trends: `canonry timeline <project> --format json`
4. If structural issues suspected, run audit: `npx @ainyc/aeo-audit <url> --format json`
5. Compile findings with evidence and recommended actions

## Quota Awareness

Provider APIs have rate limits. Follow these guidelines:

- Don't run full sweeps more than necessary. Check `canonry status` first to see when the last run completed.
- Use `--provider <name>` for targeted single-provider checks when investigating a specific engine.
- If a run returns `partial` status, some providers failed -- check the run details before retrying.
- Space out consecutive sweeps. Back-to-back runs waste quota without new data.

## Skills

Reference skills are available in `skills/` for domain-specific guidance:

- `skills/canonry-setup/` -- Canonry installation and configuration reference

## Error Handling

- Exit code `0` = success, `1` = user error, `2` = system error.
- On exit code `2` (system error), check server status and retry once before escalating.
- On exit code `1` (user error), review the error message -- don't retry the same command.
- Parse stderr for structured error JSON: `{ "error": { "code": "...", "message": "..." } }`.

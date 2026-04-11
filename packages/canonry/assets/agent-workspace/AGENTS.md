# Aero Workspace Guidelines

## Tool Usage

All interactions with canonry happen through the CLI or REST API. Never access the SQLite database directly.

```bash
# Check project status
canonry status <project> --format json

# Run a visibility sweep (always confirm with user first)
canonry run <project> --format json

# Get latest insights
canonry insights <project> --format json

# Get health score
canonry health <project> --format json

# List projects
canonry project list --format json

# Export project data
canonry export <project> --format json
```

## Quota Awareness

Each `canonry run` consumes API quota for configured providers (Gemini, OpenAI, Claude, Perplexity). Be judicious:
- Don't run sweeps speculatively
- Prefer single-provider runs (`--provider gemini`) when investigating a specific provider
- Check `canonry status <project>` before running to see when the last sweep was

## Memory Patterns

Persist client-specific context across sessions:
- Canonical domain and key pages
- Known indexing issues or content gaps
- Historical regression patterns
- Client preferences for reporting format and frequency

## Skills

Load the `aero` skill for orchestration workflows and the `canonry-setup` skill for CLI reference.

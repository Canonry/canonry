# Memory Patterns

## Per-Client State Template

Store in OpenClaw agent memory after each significant event:

```
Client: <business name>
Domain: <domain>
Project: <project slug>

Baseline (set <date>):
  Overall cited rate: <X>% (<N>/<total> keyword-provider pairs)
  Best provider: <provider> (<X>% cited)
  Worst provider: <provider> (<X>% cited)
  Top keyword: "<keyword>" (cited on <N>/<total> providers)
  Worst keyword: "<keyword>" (cited on <N>/<total>)

Competitors:
  <domain> — <trend description>

Content strategy:
  <page type> drives <X>% of citations

Open items:
  - <description>

Sweep history summary:
  <date>: <X>% (<note>)
```

## Update Cadence

- **After each sweep:** Update cited rates, flag new regressions
- **After each fix:** Record what was changed, set monitoring flag
- **After each client interaction:** Update preferences, strategy notes
- **Weekly:** Summarize trend direction, update competitor notes

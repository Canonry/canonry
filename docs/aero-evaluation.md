# Aero analyst evaluation

The deterministic replay suite checks the native loop, evidence packing, tool
selection, and reporting invariants without calling a paid provider:

```sh
pnpm exec vitest run --project canonry agent-analyst-replay.test.ts agent-progressive-runtime.test.ts agent-turn-context.test.ts --project contracts agent-evidence.test.ts agent-evaluation.test.ts
```

Fixtures cover Simple and Advanced scope, branded versus non-brand denominators,
missing evidence, stale measurement dates, incompatible comparisons, selected
Site Health pages, permission downgrades, and bounded execution. Scripted replies
verify the harness and transport. They do **not** measure a model's reasoning
quality or establish that a prompt change improved it.

To evaluate a saved real-model turn, capture the normal JSON event output and
supply expected evidence for that exact project, run, and selection. A new capture
uses the configured provider and its normal costs; the evaluator itself is offline.

```sh
canonry agent ask demo "Explain this view" --scope read-only --context '{"view":"visibility","selection":{"queryClass":"non-brand","runId":"run-3"}}' --format json > /tmp/aero-events.jsonl
pnpm --filter @canonry/canonry exec tsx scripts/eval-aero.ts /tmp/aero-expectations.json /tmp/aero-events.jsonl
```

Example expectations (replace the values with independently verified evidence):

```json
{
  "requiredTools": ["aero_inspect_view"],
  "forbiddenTools": ["canonry_run_trigger"],
  "requiredText": ["0/10", "non-brand", "2026-08-01", "model-changed"],
  "forbiddenText": ["50% overall", "caused by"],
  "maxToolCalls": 5
}
```

Output includes each check, call counts, model rounds, elapsed time, and completion
state. Exit codes: 0 passes, 1 fails expectations or completion, 2 invalid input.
Incomplete/disconnected turns fail even when their partial text matches. Substring
checks are intentionally simple; review source links, scope, factual correctness,
unsupported causal claims, and the usefulness of the suggested next action by hand.
Compare repeated captures against the same evidence and provider/model before
claiming a quality or latency improvement. Do not compare a live changing basket
with an old baseline.

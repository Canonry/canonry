# Aero eval

Asks Aero, the analyst agent inside Canonry, a set of questions about one project and grades every answer. Each answer is checked twice:

- **Rule checks** (`checks.ts`) catch known failure modes: tool errors, turns that hit a limit, lists built from truncated results, numbers nothing supports, mixed-up labels, and a net figure that contradicts its own parts.
- **A Claude grader** (`grader.ts`) compares the answer with ground truth computed from the project's own data (`ground-truth.ts`).

The eval is a development tool. It is not in the npm package and runs from source with `tsx`.

## Safety

The eval never touches a live instance or its database.

- It runs on a **copy** of a database. It refuses a database that looks live:
  - the path a running pm2 process or any `~/.canonry*` config uses;
  - a hard link to one of those;
  - a path inside `~/.canonry*` that is not in a `tmp` or `scratch` folder;
  - a file another process has open, under this name or through a hard link, counting its `-wal` and `-shm` files. Linux reads `/proc`; macOS and other systems run `lsof`. When the check cannot run (`/proc` unreadable, `lsof` missing or failing), the eval refuses the database.

  A whole config dir copied into a temp or scratch folder, with its database inside it, is accepted as a copy. The open-file check still applies to it.
- It never uses the config directory in place. Only `config.yaml` is copied, into a private temp directory (0700, file 0600), which is deleted when the run ends. The copy drops `basePath`, `publicUrl` and `externalMcpServers`.
- It starts Canonry from this worktree's source, in-process, on `127.0.0.1` with no background work:
  - The listener is bound directly, so the scheduler, the site-liveness loop and research re-dispatch never start.
  - Aero is prompt-only, so it never wakes itself.
  - Telemetry and the update check are off.
  - Startup still marks every queued or running run in the copy as failed, as any Canonry restart does. `createServer` has no option to skip that, so the guards above are what keep it off a live database.
- A request guard in front of the router refuses every write except Aero's own prompt and reset routes. It also refuses reads that call a provider or outside service live: the ads account reads, Google Ads and Tag Manager lists, GA and Business Profile account lists, Search Console sitemaps, the doctor checks, the Common Crawl release probe and query harvest. Aero reads a refusal as a tool error, and the run's log lists every refused request.
- The only paid calls are Aero's own LLM turns and the Claude grader.
- Reports hold project data. They are written with 0600 permissions to `~/.canonry-evals/reports/<project>-<time>/` unless `--out` says otherwise. The eval refuses an `--out` inside this repository.

## Making a copy

Snapshot the live database with `VACUUM INTO` on a read-only connection. It reads one consistent view, write-ahead log included, and writes nothing to the live file:

```sh
mkdir -p /tmp/aero-eval
sqlite3 -readonly ~/.canonry/data.db "VACUUM INTO '/tmp/aero-eval/copy.db'"
```

Do not `cp` the `.db` file of a running instance. Recent writes sit in the `-wal` file until a checkpoint, so a plain copy misses them and can be torn. The CLI's `.backup` is consistent but restarts every time the live instance writes, so on a busy instance it may never finish.

Keep the copy outside `~/.canonry*`, or in a `tmp` or `scratch` folder inside one. The eval migrates the copy to this worktree's schema. It also writes to the copy: a throwaway viewer account, and Aero's transcript and usage rows. The viewer account is removed at the end.

## Running

From `packages/canonry`:

```sh
# The plan and the ground truth, no model calls
pnpm exec tsx eval/aero/run.ts --db /tmp/aero-eval/copy.db \
  --source-config-dir ~/.canonry --project <name> --dry-run

# A real run
pnpm exec tsx eval/aero/run.ts --db /tmp/aero-eval/copy.db \
  --source-config-dir ~/.canonry --project <name> \
  --attempts 3 --max-cost-usd 20
```

| Flag | Default | Meaning |
|---|---|---|
| `--db` | required | The database copy. |
| `--source-config-dir` (or `--config-dir`) | required | Config dir to read `config.yaml` from. Aero's provider key and model come from here. |
| `--project` | required | Project name in the copy. |
| `--set <file>` | generic set for the project kind | Question set JSON. Repeat the flag for several sets. |
| `--lanes` | `admin,viewer` | Who asks. The viewer lane needs `agent.allowViewers: true` in the config; without it the lane is skipped. |
| `--attempts` | 3 | Attempts per question and lane. Aero is not deterministic. |
| `--only <id,id>` | all | Only these question ids. |
| `--grader-model` | `claude-opus-5` | Claude model that grades. |
| `--no-grader` | off | Rule checks only. |
| `--max-cost-usd` | none | Stops starting turns once estimated Aero plus grader spend passes this. |
| `--turn-timeout-s` | 900 | Client-side ceiling per turn. The product's own turn limits still apply. |
| `--out <dir>` | `~/.canonry-evals/reports/...` | Where `report.json` and `report.md` go. |
| `--dry-run` | off | Prints questions × lanes × attempts and the ground-truth facts. It still serves the copy, because ground truth is read over HTTP, but asks Aero nothing. |

The grader key comes from `ANTHROPIC_API_KEY`. Without it, the grader uses the `providers.claude.apiKey` from the source config, then the Anthropic SDK's own credentials. The log names the source, never the key.

A turn passes when no rule check fails and the grader passes it. Warnings never fail a turn. When grading was on but produced no verdict (a refusal, `max_tokens`, an unreadable reply or an API error), the turn gets a failing `grader-error` check: an ungraded turn never passes on the rule checks alone. A tool call the eval's guard refused counts as a `tool-errors` warning, not a failure, because the harness refused it, not Aero. So does a misspelled tool name that Aero corrected later in the same turn (a later call within two edits of the name returned data). A misspelled name it never corrected still fails.

To ask some questions on one lane only, run twice with different `--lanes` and `--only`, or give those questions a `lanes` list in a private set.

## Cost

Two things cost money: Aero's own turns, billed to the provider in the source config, and the Claude grader. Nothing else calls a provider.

Measured on one advanced-project turn (Canonry 5.19.1):

| Part | Per turn | Notes |
|---|---|---|
| Aero, `deepseek-ai/DeepSeek-V4-Flash` on DeepInfra | about $0.002 | One tool call, two model calls. Read from the copy's `llm_usage_events`. A turn with more tool calls costs a few times more. |
| Grader, `claude-opus-5` | about $0.24 | About 12K chars of facts and 20K chars of tool results. The grader sees at most 60K chars of tool results, so a turn with many tool calls can cost up to about $0.40. |
| Wall time | about 35s per turn, about 60 to 90s per grading | Up to three gradings run beside the turns. Setup (migration, ground truth) adds about 30s. |

So the grader is nearly all of the bill when Aero runs on a cheap model. For a run of N turns, budget about $0.25 to $0.40 per turn with the grader and cents without it. Running Aero on a frontier model instead can cost as much per turn as the grader.

- Start with `--dry-run`. It costs nothing and shows every question, its lanes and its ground truth.
- Always pass `--max-cost-usd`. The cap is checked before each turn starts. Gradings still running are counted only when they finish, so a run can go past the cap by up to three gradings, about $1.
- `--no-grader` runs the rule checks alone for a few cents. It is useful for checking the harness, not for judging answers.
- Aero cost is `unknown` when the model has no price in pi-ai. The cost cap counts those turns as $0.
- The grader's price table is in `grader.ts` (Claude Opus 5: $5 input and $25 output per million tokens). Check it against Anthropic's pricing page before trusting the totals for another model. A model missing from the table reports its cost as unknown.

### Lanes

- **admin** asks as the operator: it sends the install API key from the config, and Aero runs with the dashboard's read-only tool scope. If that key is not a live wildcard key in the copy, the eval mints a throwaway key in the copy and says so.
- **viewer** asks as a signed-in view-only account. The eval creates the account and its session directly in the copy, then sends the session cookie with a matching `Origin`. It rotates accounts every 40 turns, below the product's 50 viewer turns per day.

Every ask starts from an empty conversation on its lane, so no attempt sees an earlier one. Turns run in attempt order: every question gets attempt 1 before any gets attempt 2. A run stopped by the cost cap or Ctrl+C still covers the set, and writes a partial report. A second Ctrl+C exits at once.

## Question sets

Generic sets live in `questions/`, one per project kind (`advanced`, `simple`, `legacy`). The kind is decided the same way `src/agent/project-shape.ts` decides it. Without `--set`, the eval uses every generic set that has questions for the project's kind.

Client question sets are **private** and never belong in this repository. Keep them outside it, for example `~/.canonry-evals/<client>.json`, and pass them with `--set`. `private-set.example.json` shows the shape:

```json
{
  "name": "example-client",
  "questions": [
    {
      "id": "unique-id",
      "kinds": ["advanced"],
      "prompt": "Why is {property} behind its metro?",
      "truth": "property-drilldown:<property-key>",
      "rubric": ["Extra line the grader checks."],
      "lanes": ["admin"]
    }
  ]
}
```

- `truth` names the ground-truth builder. Use `none` for how-it-works questions graded on the rubric alone.
- `{placeholders}` in the prompt and rubric are filled from the builder's output. A question whose placeholder has no value is skipped, and the log says why.
- Ids must be unique across every set in a run.

## How grading weighs the evidence

- **Evidence.** Numbers and claims are grounded against the tool results Aero saw, the ground-truth facts, the prompt, and the project-shape text Aero's system prompt carried for the turn (`src/agent/project-shape.ts`: plan revision, Property and group counts, per-class query counts). The target computes that text from the copy on every turn.
- **Arithmetic.** `numeric-grounding` also accepts an integer the answer derives in one step from two integers it states and grounds: a sum, a difference, or a count divided by a small count ("30 more" from 40 tied less 10 shown; 1,200 answers across 3 engines is 400 queries). The operands must be the answer's own figures, because a large tool result holds enough small integers to sum to almost any number.
- **The grader's tool text.** The grader sees at most 60K chars of tool results, shared fairly: results shorter than an equal share are shown whole, and the rest split what is left. Toolkit and doc catalogs and errored calls are short stubs outside the budget, a call that repeats an earlier one (same tool, arguments and result) points back to it, and JSON is compacted. A result cut for the grader is marked `shortened_for_grader`, and the rubric treats a claim that could come from the part it did not see as unverified, not unsupported.
- **Ground truth.** Facts use the tools' own fields and counts. The drill-down reports the API's `citedDomainsTotal` verbatim, with its own evidence recount beside it, and keeps the tool's `occurrences` label with its definition. Data quality reads both query classes, so unattributed answers and a fill show up whichever class they are in. The weakest-Properties facts list the metros worst mention first, as the API orders them, and a list that is a sample says so.
- **The rubric.** The grader judges only from what it is shown, never from outside knowledge (it does not place a Property in a metro unless the data does), and treats a fact list marked as a sample or trimmed as incomplete. A per-name count such as "(5x)" is a count of answers, not a multiple. The first N rows of a list sorted by the metric are a valid top or worst N; a name-ordered slice is not. A criterion fails only for its own concern.
- **Warnings.** `truncated-list` also reads truncation the API reports in its payload (`truncated: true`, or a total larger than the rows returned). `label-named-vs-cited` accepts a "cited instead" heading over a list of domains. `label-pooled-classes` warns when the lead rate never says its class, even if a class is named further down. `arithmetic-net` warns when a signed net figure contradicts the gained and lost counts beside it ("40 gained, 34 lost, net -6").

## What a turn records

`runner.ts` sends the prompt the way the dashboard does and reads the SSE stream back. Each turn records:

- the final answer text;
- every tool call: its arguments, the result text the model read, its size, and whether it was truncated, with a note on what the cut dropped;
- the turn status (`completed`, `tool-limit`, `time-limit`, `error`, `stopped`);
- the project context Aero's system prompt carried (`systemContext`);
- tool and model call counts, and duration;
- the Aero spend, read from the copy's `llm_usage_events` rows for the turn. The spend is `unknown` when the model has no price in pi-ai, so a cost cap cannot count those turns.

## Files

| File | Role |
|---|---|
| `types.ts` | Shared contract. |
| `target.ts` | Serves the copy, runs the guards, signs in both lanes, reads spend. |
| `runner.ts` | One ask: reset, prompt, SSE capture. |
| `ground-truth.ts` | Facts per builder, from the copy. |
| `checks.ts` | Deterministic rule checks. |
| `grader.ts` | Claude grader. |
| `report.ts` | Pass rates, failure modes, Markdown. |
| `run.ts` | CLI. |

## Checking the harness

From `packages/canonry`:

```sh
pnpm exec vitest run --config ../../vitest.package.config.ts test/aero-eval-   # every eval test, no model calls
pnpm exec tsc --noEmit -p eval/tsconfig.json                                   # also run by `pnpm typecheck`
pnpm exec eslint eval/ test/aero-eval-*.test.ts                                 # also run by `pnpm lint`
```

`eval/tsconfig.json` typechecks the eval and its tests only; it emits nothing. The package build (`tsup`, entries under `src/`) and the npm `files` list both leave `eval/` out.

| Test | Covers |
|---|---|
| `test/aero-eval-runner.test.ts` | The runner, the SSE capture, the guards and an in-process target on a throwaway database. |
| `test/aero-eval-ground-truth.test.ts` | Every ground-truth builder, on stubbed responses checked against the real response schemas. |
| `test/aero-eval-checks.test.ts` | The rule checks. |
| `test/aero-eval-grader.test.ts` | The grader request, parsing and cost, with a fake client. |
| `test/aero-eval-report.test.ts` | Pass rates, failure modes and the Markdown report. |

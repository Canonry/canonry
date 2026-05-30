/**
 * Emit a list of records as newline-delimited JSON (JSONL / NDJSON) on stdout —
 * one compact JSON object per line, no enclosing array, no pretty-printing.
 *
 * This is canonry's agent-friendly machine format. Instead of
 *
 *   canonry doctor ... --format json 2>/dev/null \
 *     | jq -r '(.checks // .results // [])[] | "\(.status)\t\(.id)\t\(.summary)"'
 *
 * an agent runs `canonry doctor ... --format jsonl` and reads complete,
 * self-contained records one per line. There is no envelope-key to guess
 * (`.checks` vs `.results` vs `.items`), nothing to flatten, and each line
 * stands alone for `grep`, `head`, or a per-line `jq`.
 *
 * Empty input prints nothing — the exit code still conveys success/failure, so
 * "no records" and "failure" stay distinguishable.
 */
export function emitJsonl(records: Iterable<unknown>): void {
  let out = ''
  for (const record of records) {
    out += `${JSON.stringify(record)}\n`
  }
  if (out) process.stdout.write(out)
}

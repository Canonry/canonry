/**
 * A Fastify `logger` option that keeps every line the app logs, parsed, so a
 * test reads what an operator would see where a route has no response to
 * report in (a scheduled sync, a background backfill).
 */
export function logCapture() {
  const lines: Array<Record<string, unknown>> = []
  return {
    lines,
    logger: { level: 'info', stream: { write: (line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>) } } },
    /** The logged lines that carry `field`. */
    withField: (field: string) => lines.filter(line => field in line),
  }
}

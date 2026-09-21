/**
 * Render one value as a single POSIX shell argument, for commands shown to a
 * person or an agent to copy and run.
 *
 * Plain values stay bare so the common command reads naturally
 * (`cnry traffic sources acme`). Anything else is single-quoted, with embedded
 * single quotes closed, escaped, and reopened, so a project named `Acme UK` or
 * `it's` stays one argument instead of splitting or breaking the line.
 */
export function shellQuote(value: string): string {
  if (value !== '' && /^[\w./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

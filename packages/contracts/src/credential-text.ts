import { z } from 'zod'

/**
 * Why a pasted credential cannot be sent as given, or null when it can.
 *
 * A token file written with `>>` instead of `>` ends up holding two tokens on
 * two lines. Sent as an `Authorization` header, that value makes `fetch` throw
 * an error that quotes the whole header, both tokens included, and the error
 * then travels into CLI output, API responses and stored sync errors. Checking
 * the text first stops it at the door with a message that names the problem
 * and never the value, so the message is safe to show, store or log.
 *
 * `allowSpaces` is for credentials that legitimately contain spaces, such as a
 * WordPress Application Password (`abcd efgh ijkl ...`). Line breaks and other
 * control characters are refused either way.
 */
export function credentialTextProblem(
  value: string,
  label: string,
  options: { allowSpaces?: boolean } = {},
): string | null {
  const lines = value.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return `The ${label} is empty.`
  if (lines.length > 1) {
    return `The ${label} has ${lines.length} lines; it must be a single line. `
      + 'If it came from a file, write the file with > (replace), not >> (append).'
  }
  const text = lines[0]!.trim()
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(text)) return `The ${label} contains a control character.`
  if (!options.allowSpaces && /\s/.test(text)) return `The ${label} contains a space; paste only the token.`
  return null
}

/**
 * The strings to redact for one credential: the value as held, trimmed, and
 * each whitespace-separated part, so a message quoting only one line of a
 * multi-line value is still covered. Pass the result to `redactKnownSecrets`.
 */
export function credentialRedactionValues(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  return [...new Set([value, value.trim(), ...value.split(/\s+/)].filter((part) => part.length > 0))]
}

/**
 * A request-body credential field: trimmed, required, and refused with a
 * value-free message when `credentialTextProblem` finds one.
 */
export function credentialTextSchema(label: string, options: { allowSpaces?: boolean } = {}) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.string().min(1, { message: `The ${label} is empty.` }).superRefine((value, ctx) => {
      const problem = credentialTextProblem(value, label, options)
      if (problem) ctx.addIssue({ code: 'custom', message: problem })
    }),
  )
}

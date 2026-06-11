/**
 * Escape the SQL `LIKE` metacharacters (`\`, `%`, `_`) in a user-supplied
 * search term so they match literally instead of acting as wildcards.
 *
 * The backslash is the escape character, so the query that uses the returned
 * pattern MUST declare it explicitly, e.g.:
 *
 * ```ts
 * sql`${col} LIKE ${'%' + escapeLikePattern(term) + '%'} ESCAPE '\\'`
 * ```
 *
 * Without escaping, a term like `100%` or `a_b` silently turns into a wildcard
 * search (wrong results) and a term of all `%` forces a full-table scan (a minor
 * DoS). This is a correctness/robustness helper — it is NOT an injection guard;
 * the term must still be passed as a bound parameter, never interpolated.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

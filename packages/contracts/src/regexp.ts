/**
 * Escape every RegExp metacharacter in `str`, so `new RegExp(escapeRegExp(str))`
 * matches `str` literally. Used to blank secrets in integration error bodies and
 * to build literal-match patterns from names and terms.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

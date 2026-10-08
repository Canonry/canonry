/**
 * Escape every RegExp metacharacter in `str`, so `new RegExp(escapeRegExp(str))`
 * matches `str` literally. The integrations use it to blank a secret wherever
 * it appears in an error body.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

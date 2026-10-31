/** UTM-tagged sources often use `+` for spaces. Decode for display while keeping the raw value for tooltips/sorting. */
export function decodeSocialSourceLabel(source: string): string {
  return source.replace(/\+/g, ' ')
}

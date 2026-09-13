/**
 * Strict SemVer 2.0.0 shape: numeric `major.minor.patch` without leading
 * zeros, optional dot-separated pre-release and build identifiers. Anything
 * else (whitespace, newlines, control characters) is rejected, so a version
 * string that passes can be embedded in operator- or agent-facing text.
 */
const STRICT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i

const MAX_SEMVER_LENGTH = 128

export function isStrictSemver(value: string): boolean {
  return value.length <= MAX_SEMVER_LENGTH && STRICT_SEMVER.test(value)
}

/**
 * Compare the `major.minor.patch` cores of two version strings, ignoring
 * pre-release and build metadata. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Anything unparseable compares as equal, so a malformed value can never
 * advertise a false upgrade.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] | null => {
    const parts = (v.split(/[-+]/)[0] ?? '').split('.')
    if (parts.length < 3) return null
    const nums = parts.slice(0, 3).map(Number)
    if (!nums.every((n) => Number.isInteger(n) && n >= 0)) return null
    return [nums[0]!, nums[1]!, nums[2]!]
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1
    if (pa[i]! < pb[i]!) return -1
  }
  return 0
}

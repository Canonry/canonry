import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGES_DIR = path.join(__dirname, '..', '..')

/**
 * Every integration that talks to a third party over HTTP should back off when
 * that service pushes back. `withRetry` in this package is the shared way to do
 * it, and `isRetryableHttpError` is the shared predicate.
 *
 * This is a ratchet, not a wish. `integration-bing` shipped without any retry
 * and nobody noticed until Bing's throttle turned a routine refresh into 229
 * hard failures over three days. Nothing in review catches an absence — so the
 * absences are enumerated below, and a NEW one fails this test.
 *
 * To REMOVE a package from the list: wrap its HTTP layer in `withRetry` (see
 * `packages/integration-bing/src/bing-client.ts` for the shape — one private
 * `fetchOnce`, one exported wrapper, so retry is the default rather than
 * something each call site remembers), add tests covering "retries the
 * transient failure" and "does NOT retry auth/validation", then delete the
 * entry. Never add one back.
 *
 * To ADD a package: don't. Wire up `withRetry` instead. If a service genuinely
 * cannot be retried (a non-idempotent write with no idempotency key, say), add
 * it here in the same PR with a comment saying why — so the exemption is a
 * visible decision rather than an oversight.
 */
const KNOWN_WITHOUT_RETRY = new Set([
  // Each of these predates the rule. They are exposed to exactly the failure
  // mode that motivated it, and are worth fixing in their own PRs.
  'integration-cloud-run',
  'integration-google', // Google Search Console — same dashboard refresh as Bing
  'integration-openai-ads',
  'integration-vercel',
  'integration-wordpress',
  'integration-wordpress-traffic',
  // These two call through an injected `fetchImpl`, which the scanner below
  // did not recognise until it matched that form too; they predate the rule
  // like the rest. Cloudflare Queue retries in its own bounded loop
  // (`withQueueRetry`) rather than `withRetry`; Common Crawl does not retry.
  'integration-cloudflare-queue',
  'integration-commoncrawl',
])

/**
 * An outbound call: global `fetch(`, an injected `fetchImpl(`, or a fallback
 * such as `(options.fetchImpl ?? fetch)(`. Integrations take the fetch as a
 * parameter so a host can guard their egress, and that must not hide them.
 */
const HTTP_CALL = /\bfetch(?:Impl)?\)?\s*\(/

/** Integration packages whose `src/` issues outbound HTTP calls. */
function integrationPackagesMakingHttpCalls(): string[] {
  const names: string[] = []

  for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('integration-')) continue
    const srcDir = path.join(PACKAGES_DIR, entry.name, 'src')
    if (!fs.existsSync(srcDir)) continue
    if (sourceFiles(srcDir).some((file) => HTTP_CALL.test(fs.readFileSync(file, 'utf8')))) {
      names.push(entry.name)
    }
  }

  return names.sort()
}

function usesWithRetry(pkg: string): boolean {
  return sourceFiles(path.join(PACKAGES_DIR, pkg, 'src')).some((file) =>
    fs.readFileSync(file, 'utf8').includes('withRetry'),
  )
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('integration retry coverage', () => {
  it('every HTTP-calling integration either retries or is a known, listed gap', () => {
    const unprotected = integrationPackagesMakingHttpCalls()
      .filter((pkg) => !usesWithRetry(pkg))
      .filter((pkg) => !KNOWN_WITHOUT_RETRY.has(pkg))

    expect(
      unprotected,
      `These integrations make HTTP calls but never use withRetry:\n` +
      `  ${unprotected.join('\n  ')}\n\n` +
      `A third party that rate-limits or blips will fail the call outright. Wrap the ` +
      `HTTP layer in withRetry from @ainyc/canonry-contracts (see ` +
      `packages/integration-bing/src/bing-client.ts), or, if it genuinely cannot be ` +
      `retried, add it to KNOWN_WITHOUT_RETRY in this file with a reason.`,
    ).toEqual([])
  })

  it('the known-gap list does not grow, and shrinks as packages are fixed', () => {
    const stillMissing = [...KNOWN_WITHOUT_RETRY].filter(
      (pkg) => fs.existsSync(path.join(PACKAGES_DIR, pkg, 'src')) && !usesWithRetry(pkg),
    )

    // A package that has since been fixed (or removed) must be deleted from the
    // list, so the list always names real, outstanding work.
    expect(
      [...KNOWN_WITHOUT_RETRY].filter((pkg) => !stillMissing.includes(pkg)),
      'These packages are in KNOWN_WITHOUT_RETRY but no longer need to be — remove them from the set.',
    ).toEqual([])
  })

  it('every known gap is still detected as an HTTP caller, so dropping it unfixed fails the first check', () => {
    const detected = integrationPackagesMakingHttpCalls()
    expect([...KNOWN_WITHOUT_RETRY].filter((pkg) => !detected.includes(pkg))).toEqual([])
  })

  it('integration-bing retries, since its outage is why this test exists', () => {
    expect(usesWithRetry('integration-bing')).toBe(true)
    expect(KNOWN_WITHOUT_RETRY.has('integration-bing')).toBe(false)
  })
})

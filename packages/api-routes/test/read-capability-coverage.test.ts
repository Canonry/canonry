import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { READ_CAPABILITY_EXEMPT_OPERATIONS } from '../src/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_ROUTES_SRC = path.join(__dirname, '..', 'src')
// The agent surface lives in packages/canonry but registers inside the
// api-routes auth scope (server.ts: `registerAuthenticatedRoutes`), so the
// same gate guards it and the same coverage rule applies.
const AGENT_ROUTES = path.join(__dirname, '..', '..', 'canonry', 'src', 'agent', 'agent-routes.ts')

const BUNDLE_CONSTANTS = new Set([
  'DASHBOARD_READ_CAPABILITY',
  'ANALYTICS_READ_CAPABILITY',
  'FULL_READ_CAPABILITY',
])

/**
 * Default-deny coverage guard (#817). A read route that declares no
 * `readCapability` refuses every narrow API key, so an untagged route is a
 * silent hole, not a harmless omission. Every `app.get` in the guarded
 * surface must be exactly one of:
 *
 * - tagged: `readCapability: <bundle>` in its route config;
 * - exempt: listed in `READ_CAPABILITY_EXEMPT_OPERATIONS` (a route whose own
 *   gate already binds an API key — see auth.ts);
 * - paidRead: `paidRead: true` in its config (its own paid-read gate);
 * - skip-auth: `skipInstanceAuth: true` in the route config — the route
 *   verifies its own credentials or is public by design, so the auth plugin
 *   returns before any capability gate (auth.ts `authPlugin` hook). The
 *   config may also come from a factory defined in the same file
 *   (`config: signInRouteConfig(...)` in chatgpt-routes.ts) — the scanner
 *   resolves that reference to the factory's definition.
 * - out-of-scope: a public OAuth route (`/oauth/authorize`, `.well-known/*`)
 *   that never reaches the auth plugin (registered on the root app).
 *
 * Add a route: tag it, or exempt it with a comment naming its gate. If this
 * test fails on a route you just added, that is the point — pick one.
 */
interface FoundGet {
  file: string
  line: number
  operation: string | null
  tagged: string | null
  paid: boolean
  skip: boolean
  isOauthPublic: boolean
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

/**
 * True when a route-config factory/variable defined in this file sets
 * `skipInstanceAuth: true` — e.g. `signInRouteConfig` in chatgpt-routes.ts.
 * The definition is short (one options object), so a 2000-char window past
 * its `const <name> =` covers it.
 */
function configFactoryHasSkipAuth(text: string, name: string): boolean {
  const at = text.indexOf(`const ${name} =`)
  if (at === -1) return false
  return /skipInstanceAuth:\s*true/.test(text.slice(at, at + 2000))
}

function skipGeneric(text: string, i: number): number {
  while (i < text.length && ' \t\n'.includes(text[i])) i++
  if (text[i] !== '<') return i
  let depth = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '<') depth++
    else if (ch === '>') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return i
}

function scanFile(file: string): FoundGet[] {
  const text = fs.readFileSync(file, 'utf8')
  const found: FoundGet[] = []
  const rel = path.relative(path.join(__dirname, '..', '..'), file)
  for (const match of text.matchAll(/\bapp\.get\b/g)) {
    const start = match.index
    const line = text.slice(0, start).split('\n').length
    const openParen = skipGeneric(text, start + 'app.get'.length)
    const handler = text.slice(openParen, openParen + 3000).search(/\basync\b|=>/)
    const end = handler === -1 ? openParen + 3000 : openParen + handler
    const segment = text.slice(start, end)
    const tag = segment.match(/readCapability:\s*([A-Z_]+)/)
    const paid = /paidRead:\s*true/.test(segment)
    const configRef = segment.match(/config:\s*([A-Za-z_$][\w$]*)/)
    const skip = /skipInstanceAuth:\s*true/.test(segment)
      || (configRef !== null && configFactoryHasSkipAuth(text, configRef[1]!))
    const literal = segment.includes('agentReadinessRoutes(')
      ? null
      : segment.match(/['"`](\/[^'"`$]*)['"`]/)
    let operation: string | null = null
    let isOauthPublic = false
    if (literal) {
      operation = `GET /api/v1${literal[1].replace(/:(\w+)/g, '{$1}')}`
      isOauthPublic = operation === 'GET /api/v1/oauth/authorize'
        || operation.startsWith('GET /api/v1/.well-known')
    } else if (file.endsWith(`${path.sep}oauth.ts`)) {
      // Variable / template paths in oauth.ts: the authorize redirect and the
      // .well-known discovery loops. Both are public by design (see auth.ts).
      isOauthPublic = true
    }
    found.push({ file: rel, line, operation, tagged: tag ? tag[1] : null, paid, skip, isOauthPublic })
  }
  return found
}

function collect(): FoundGet[] {
  return [...listSourceFiles(API_ROUTES_SRC), AGENT_ROUTES].flatMap(scanFile)
}

describe('read capability coverage', () => {
  it('every GET is tagged, exempt, paid-read, skip-auth, or out-of-scope', () => {
    const gets = collect()
    const uncovered: string[] = []
    for (const get of gets) {
      if (get.tagged) continue
      if (get.paid) continue
      if (get.isOauthPublic) continue
      if (get.operation && READ_CAPABILITY_EXEMPT_OPERATIONS.has(get.operation)) continue
      if (get.skip) continue
      uncovered.push(`${get.operation ?? `(loop/var) ${get.file}:${get.line}`} [${get.file}:${get.line}]`)
    }
    expect(
      uncovered,
      `Unclassified GET routes refuse every narrow key by default-deny, so each one ` +
      `must declare a readCapability, join READ_CAPABILITY_EXEMPT_OPERATIONS, or be ` +
      `paidRead / skip-auth / public OAuth. Uncovered (${uncovered.length} of ${gets.length}):\n` +
      uncovered.join('\n'),
    ).toEqual([])
  })

  it('every exemption names a real registered GET', () => {
    const operations = new Set(collect().map(get => get.operation).filter((op): op is string => op !== null))
    const stale = [...READ_CAPABILITY_EXEMPT_OPERATIONS].filter(op => !operations.has(op))
    expect(
      stale,
      `READ_CAPABILITY_EXEMPT_OPERATIONS entries with no matching GET route (stale ` +
      `exemptions hide real gaps — remove them):\n${stale.join('\n')}`,
    ).toEqual([])
  })

  it('readCapability tags use only the three bundle constants', () => {
    const unknown = collect()
      .map(get => get.tagged)
      .filter((tag): tag is string => tag !== null && !BUNDLE_CONSTANTS.has(tag))
    expect(unknown, `Unknown readCapability constant(s): ${[...new Set(unknown)].join(', ')}`).toEqual([])
  })
})

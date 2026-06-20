import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Hard cap on the number of `rawJsonResponse(..., looseObjectSchema)` call sites
 * across the OpenAPI spec. Locking the count forces new endpoints to ship with a
 * registered Zod schema instead of silently widening the loose-object surface
 * the SDK has to fall back to `Record<string, unknown>` on.
 *
 * To LOWER the cap: type an existing loose endpoint (add a Zod schema in
 * `packages/contracts`, register it in `openapi-schemas.ts`, flip the route to
 * `jsonResponse('...', 'YourDto')`), regenerate the SDK, then bump this number
 * DOWN by the count you eliminated.
 *
 * To RAISE the cap: don't. Add a typed DTO instead. If you genuinely need to
 * defer typing (e.g. the response shape is in flux), update this cap in the
 * same PR with a comment naming the endpoint and a linked issue / TODO. The
 * cap exists so deferring is a deliberate, visible decision, not a default.
 */
const MAX_LOOSE_RESPONSE_SITES = 36

/**
 * Hard cap on the number of `looseObjectSchema` array-wrapped responses
 * (`{ type: 'array', items: looseObjectSchema }`). Same intent as above —
 * forces typed array element schemas on new array-returning endpoints.
 */
const MAX_LOOSE_ARRAY_RESPONSE_SITES = 2

describe('openapi loose-response cap', () => {
  it('does not exceed the locked looseObjectSchema allowlist size', () => {
    const openapi = fs.readFileSync(path.join(__dirname, '..', 'src', 'openapi.ts'), 'utf8')

    // Match `rawJsonResponse(..., looseObjectSchema)` — the bare object form.
    // Array-wrapped uses (`items: looseObjectSchema`) are counted separately
    // below so the two intents are independently locked.
    const bareLoose = openapi.match(/rawJsonResponse\([^)]*,\s*looseObjectSchema\s*\)/g) ?? []
    const arrayLoose = openapi.match(/items:\s*looseObjectSchema/g) ?? []

    expect(
      bareLoose.length,
      `looseObjectSchema response count rose above the lock (${MAX_LOOSE_RESPONSE_SITES}). ` +
      `New endpoints must register a Zod DTO in contracts and flip the route to ` +
      `jsonResponse('...', 'YourDto'). See packages/api-routes/AGENTS.md "Typed responses".`,
    ).toBeLessThanOrEqual(MAX_LOOSE_RESPONSE_SITES)

    expect(
      arrayLoose.length,
      `Array-wrapped looseObjectSchema count rose above the lock (${MAX_LOOSE_ARRAY_RESPONSE_SITES}). ` +
      `Use jsonArrayResponse('...', 'YourDto') with a registered Zod schema.`,
    ).toBeLessThanOrEqual(MAX_LOOSE_ARRAY_RESPONSE_SITES)
  })

  it('does not introduce TODO markers for new "Add `XDto` Zod schema in contracts" placeholders', () => {
    const openapi = fs.readFileSync(path.join(__dirname, '..', 'src', 'openapi.ts'), 'utf8')
    // Match the legacy `// TODO: Add `XxxDto` Zod schema in contracts.` placeholder
    // pattern that paired with rawJsonResponse callsites. Every flip to
    // jsonResponse removes one; new endpoints must register a schema before
    // adding the route, so this should trend strictly downward.
    const todos = openapi.match(/TODO:\s+Add\s+`\w+Dto`\s+Zod schema/g) ?? []
    const LOCKED = 21
    expect(
      todos.length,
      `Outstanding "TODO: Add XxxDto Zod schema" placeholders rose above the lock (${LOCKED}). ` +
      `If you're flipping a route to a typed response, the count should go DOWN. ` +
      `If you're adding a new route, register the Zod schema instead of leaving a TODO.`,
    ).toBeLessThanOrEqual(LOCKED)
  })
})

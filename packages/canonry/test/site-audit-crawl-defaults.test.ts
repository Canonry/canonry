import { DEFAULT_SITE_CRAWL_LIMITS } from '@canonry/aeo-audit'
import { SITE_AUDIT_DEFAULT_MAX_DEPTH, siteAuditRunRequestSchema } from '@ainyc/canonry-contracts'
import { expect, test } from 'vitest'

test('the named default crawl depth is the one the crawler actually applies', () => {
  // The dashboard labels an unset depth with this number. If the crawler's
  // default moves and this does not, that label lies.
  expect(SITE_AUDIT_DEFAULT_MAX_DEPTH).toBe(DEFAULT_SITE_CRAWL_LIMITS.maxDepth)
})

test('the deepest dashboard choice is a depth the run request accepts', () => {
  expect(siteAuditRunRequestSchema.safeParse({ maxDepth: 100 }).success).toBe(true)
  expect(siteAuditRunRequestSchema.safeParse({ maxDepth: 101 }).success).toBe(false)
})

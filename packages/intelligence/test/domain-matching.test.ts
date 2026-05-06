import { describe, expect, it } from 'vitest'
import { citedDomainBelongsToProject } from '../src/domain-matching.js'

describe('citedDomainBelongsToProject', () => {
  it('returns true for an exact domain match', () => {
    expect(citedDomainBelongsToProject('example.com', ['example.com'])).toBe(true)
  })

  it('returns true for a subdomain of a project domain', () => {
    expect(citedDomainBelongsToProject('blog.example.com', ['example.com'])).toBe(true)
  })

  it('returns false for an unrelated domain', () => {
    expect(citedDomainBelongsToProject('competitor.com', ['example.com'])).toBe(false)
  })

  it('returns false when the cited domain is a parent of the project domain', () => {
    expect(citedDomainBelongsToProject('com', ['example.com'])).toBe(false)
  })

  it('does not match a domain that contains the project domain as a substring', () => {
    expect(citedDomainBelongsToProject('notexample.com', ['example.com'])).toBe(false)
    expect(citedDomainBelongsToProject('example.com.evil.com', ['example.com'])).toBe(false)
  })

  it('matches across multiple project domains', () => {
    expect(citedDomainBelongsToProject('shop.alt.com', ['example.com', 'alt.com'])).toBe(true)
  })

  it('normalizes protocol and www for both inputs', () => {
    expect(citedDomainBelongsToProject('https://www.example.com', ['example.com'])).toBe(true)
    expect(citedDomainBelongsToProject('example.com', ['https://www.example.com'])).toBe(true)
  })

  it('returns false for an empty project list', () => {
    expect(citedDomainBelongsToProject('example.com', [])).toBe(false)
  })
})

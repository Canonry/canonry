import { describe, expect, it } from 'vitest'
import {
  classifyLocalBlock,
  hasMetaNoindex,
  hasXRobotsNoindex,
  isDisallowedByRobots,
  parseRobotsTxt,
} from '../src/discoverability.js'

describe('parseRobotsTxt / isDisallowedByRobots', () => {
  it('applies the longest matching rule, with Allow winning a tie', () => {
    const groups = parseRobotsTxt([
      'User-agent: *',
      'Disallow: /private/',
      'Allow: /private/public/',
      'Disallow: /tmp',
    ].join('\n'))
    expect(isDisallowedByRobots(groups, 'https://example.com/private/page', ['googlebot'])).toBe(true)
    expect(isDisallowedByRobots(groups, 'https://example.com/private/public/page', ['googlebot'])).toBe(false)
    expect(isDisallowedByRobots(groups, 'https://example.com/tmp', ['googlebot'])).toBe(true)
    expect(isDisallowedByRobots(groups, 'https://example.com/other', ['googlebot'])).toBe(false)
  })

  it('matches the named agent group before the wildcard group, and a wildcard group for any agent', () => {
    const groups = parseRobotsTxt([
      'User-agent: googlebot',
      'Disallow: /google-only',
      'User-agent: *',
      'Disallow: /all',
    ].join('\n'))
    expect(isDisallowedByRobots(groups, 'https://example.com/google-only', ['googlebot'])).toBe(true)
    expect(isDisallowedByRobots(groups, 'https://example.com/google-only', ['bingbot'])).toBe(false)
    expect(isDisallowedByRobots(groups, 'https://example.com/all', ['bingbot'])).toBe(true)
    expect(isDisallowedByRobots(groups, 'https://example.com/all', ['googlebot'])).toBe(true)
  })

  it('honours * wildcards and a trailing $ end anchor, and ignores an empty Disallow', () => {
    const groups = parseRobotsTxt([
      'User-agent: *',
      'Disallow: /search?*',
      'Disallow: /exact$',
      'Disallow:',
    ].join('\n'))
    expect(isDisallowedByRobots(groups, 'https://example.com/search?q=x', ['googlebot'])).toBe(true)
    expect(isDisallowedByRobots(groups, 'https://example.com/search', ['googlebot'])).toBe(false)
    expect(isDisallowedByRobots(groups, 'https://example.com/exact', ['googlebot'])).toBe(true)
    expect(isDisallowedByRobots(groups, 'https://example.com/exact/more', ['googlebot'])).toBe(false)
  })

  it('ignores comments, unknown directives, and rules before any User-agent line', () => {
    const groups = parseRobotsTxt([
      '# a comment',
      'Sitemap: https://example.com/sitemap.xml',
      'User-agent: * # trailing comment',
      'Disallow: /hidden/ # do not index',
    ].join('\n'))
    expect(groups).toHaveLength(1)
    expect(isDisallowedByRobots(groups, 'https://example.com/hidden/page', ['bingbot'])).toBe(true)
    expect(isDisallowedByRobots(groups, 'https://example.com/hidden/page', ['Googlebot'])).toBe(true)
  })

  it('treats an unparseable URL as allowed rather than inventing a block', () => {
    expect(isDisallowedByRobots(parseRobotsTxt('User-agent: *\nDisallow: /'), 'not a url', ['googlebot'])).toBe(false)
  })
})

describe('hasMetaNoindex', () => {
  const agents = ['googlebot']

  it('reads noindex in either attribute order, for robots and for the named agent', () => {
    expect(hasMetaNoindex('<meta name="robots" content="noindex, follow">', agents)).toBe(true)
    expect(hasMetaNoindex('<meta content="noindex" name="googlebot">', agents)).toBe(true)
    expect(hasMetaNoindex('<meta name="bingbot" content="noindex">', agents)).toBe(false)
    expect(hasMetaNoindex('<meta name="robots" content="index, follow">', agents)).toBe(false)
    expect(hasMetaNoindex('<meta name="robots" content="none">', agents)).toBe(true)
  })

  it('ignores a commented-out noindex tag', () => {
    expect(hasMetaNoindex('<!-- <meta name="robots" content="noindex"> -->', agents)).toBe(false)
    expect(
      hasMetaNoindex('<!-- <meta name="robots" content="noindex"> --><meta name="robots" content="index">', agents),
    ).toBe(false)
  })
})

describe('hasXRobotsNoindex', () => {
  it('reads a bare noindex and a per-agent noindex, and ignores other agents', () => {
    expect(hasXRobotsNoindex('noindex', ['googlebot'])).toBe(true)
    expect(hasXRobotsNoindex('googlebot: noindex, nofollow', ['googlebot'])).toBe(true)
    expect(hasXRobotsNoindex('bingbot: noindex', ['googlebot'])).toBe(false)
    expect(hasXRobotsNoindex('googlebot: nofollow', ['googlebot'])).toBe(false)
    expect(hasXRobotsNoindex('none', ['bingbot'])).toBe(true)
    expect(hasXRobotsNoindex(null, ['googlebot'])).toBe(false)
    expect(hasXRobotsNoindex('', ['googlebot'])).toBe(false)
  })
})

describe('classifyLocalBlock', () => {
  it('names the strongest signal first: robots, then meta, then header', () => {
    expect(classifyLocalBlock({ robotsDisallowed: true, metaNoindex: true, xRobotsNoindex: true })).toEqual({
      localBlocked: true,
      localBlockReason: 'robots-disallow',
    })
    expect(classifyLocalBlock({ robotsDisallowed: false, metaNoindex: true, xRobotsNoindex: true })).toEqual({
      localBlocked: true,
      localBlockReason: 'meta-noindex',
    })
    expect(classifyLocalBlock({ robotsDisallowed: false, metaNoindex: false, xRobotsNoindex: true })).toEqual({
      localBlocked: true,
      localBlockReason: 'x-robots-tag-noindex',
    })
    expect(classifyLocalBlock({ robotsDisallowed: false, metaNoindex: false, xRobotsNoindex: false })).toEqual({
      localBlocked: false,
      localBlockReason: null,
    })
  })
})

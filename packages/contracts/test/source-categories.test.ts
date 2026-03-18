import { describe, it, expect } from 'vitest'
import { categorizeSource, categoryLabel } from '../src/source-categories.js'

describe('categorizeSource', () => {
  it('categorizes Reddit as forum', () => {
    const result = categorizeSource('https://www.reddit.com/r/programming/comments/abc')
    expect(result.category).toBe('forum')
    expect(result.label).toBe('Reddit')
    expect(result.domain).toBe('reddit.com')
  })

  it('categorizes LinkedIn as social', () => {
    const result = categorizeSource('https://linkedin.com/in/someone')
    expect(result.category).toBe('social')
    expect(result.label).toBe('LinkedIn')
  })

  it('categorizes Wikipedia as reference', () => {
    const result = categorizeSource('https://en.wikipedia.org/wiki/Test')
    expect(result.category).toBe('reference')
    expect(result.label).toBe('Wikipedia')
  })

  it('categorizes YouTube as video', () => {
    const result = categorizeSource('https://youtube.com/watch?v=abc123')
    expect(result.category).toBe('video')
    expect(result.label).toBe('YouTube')
  })

  it('categorizes youtu.be as video', () => {
    const result = categorizeSource('https://youtu.be/abc123')
    expect(result.category).toBe('video')
  })

  it('categorizes Medium as blog', () => {
    const result = categorizeSource('https://medium.com/@user/article')
    expect(result.category).toBe('blog')
    expect(result.label).toBe('Medium')
  })

  it('categorizes Forbes as news', () => {
    const result = categorizeSource('https://www.forbes.com/article')
    expect(result.category).toBe('news')
  })

  it('categorizes Amazon as ecommerce', () => {
    const result = categorizeSource('https://amazon.com/dp/B123')
    expect(result.category).toBe('ecommerce')
  })

  it('categorizes .edu domains as academic', () => {
    const result = categorizeSource('https://cs.stanford.edu/research')
    expect(result.category).toBe('academic')
    expect(result.label).toBe('Academic (.edu)')
  })

  it('categorizes arxiv as academic', () => {
    const result = categorizeSource('https://arxiv.org/abs/2301.00001')
    expect(result.category).toBe('academic')
  })

  it('falls back to other for unknown domains', () => {
    const result = categorizeSource('https://my-random-site.io/page')
    expect(result.category).toBe('other')
    expect(result.label).toBe('Other')
    expect(result.domain).toBe('my-random-site.io')
  })

  it('handles URIs without protocol', () => {
    const result = categorizeSource('reddit.com/r/test')
    expect(result.category).toBe('forum')
  })

  it('strips www prefix from domain', () => {
    const result = categorizeSource('https://www.stackoverflow.com/questions/123')
    expect(result.domain).toBe('stackoverflow.com')
    expect(result.category).toBe('forum')
  })

  it('handles subdomains correctly', () => {
    const result = categorizeSource('https://old.reddit.com/r/test')
    expect(result.category).toBe('forum')
  })

  it('handles malformed URIs', () => {
    const result = categorizeSource('')
    expect(result.category).toBe('other')
  })
})

describe('categoryLabel', () => {
  it('returns human-readable labels', () => {
    expect(categoryLabel('forum')).toBe('Forums & Q&A')
    expect(categoryLabel('social')).toBe('Social Media')
    expect(categoryLabel('other')).toBe('Other')
  })
})

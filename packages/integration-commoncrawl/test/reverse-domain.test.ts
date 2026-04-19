import { describe, expect, test } from 'vitest'
import { forwardDomain, reverseDomain } from '../src/reverse-domain.js'

describe('reverseDomain', () => {
  test('reverses label order', () => {
    expect(reverseDomain('roots.io')).toBe('io.roots')
    expect(reverseDomain('www.example.com')).toBe('com.example.www')
    expect(reverseDomain('a.b.c.d')).toBe('d.c.b.a')
  })

  test('handles single label', () => {
    expect(reverseDomain('localhost')).toBe('localhost')
  })
})

describe('forwardDomain', () => {
  test('is the inverse of reverseDomain', () => {
    const inputs = ['roots.io', 'www.example.com', 'a.b.c.d', 'localhost']
    for (const input of inputs) {
      expect(forwardDomain(reverseDomain(input))).toBe(input)
    }
  })

  test('converts rev-form to forward-form', () => {
    expect(forwardDomain('io.roots')).toBe('roots.io')
    expect(forwardDomain('com.example.www')).toBe('www.example.com')
  })
})

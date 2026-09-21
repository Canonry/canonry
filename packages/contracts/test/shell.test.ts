import { describe, expect, it } from 'vitest'
import { shellQuote } from '../src/shell.js'

describe('shellQuote', () => {
  it('leaves plain values bare so the common command reads naturally', () => {
    expect(shellQuote('acme')).toBe('acme')
    expect(shellQuote('acme-co_2.0')).toBe('acme-co_2.0')
    expect(shellQuote('https://example.com/blog')).toBe('https://example.com/blog')
  })

  it('keeps a value with spaces as one argument', () => {
    expect(shellQuote('Acme UK')).toBe("'Acme UK'")
  })

  it('survives embedded single quotes and shell metacharacters', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('a; rm -rf ~')).toBe("'a; rm -rf ~'")
    expect(shellQuote('$HOME')).toBe("'$HOME'")
    expect(shellQuote('')).toBe("''")
  })
})

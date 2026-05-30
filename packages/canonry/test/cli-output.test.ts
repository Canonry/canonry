import { describe, it, expect, afterEach, vi } from 'vitest'
import { emitJsonl } from '../src/cli-output.js'

function captureStdout(fn: () => void): string {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return buf
}

describe('emitJsonl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes one compact JSON object per line, newline-terminated', () => {
    const out = captureStdout(() => emitJsonl([{ a: 1 }, { b: 'two' }]))
    expect(out).toBe('{"a":1}\n{"b":"two"}\n')
  })

  it('produces lines that each parse independently', () => {
    const records = [
      { id: 'x', status: 'ok' },
      { id: 'y', status: 'fail', nested: { deep: [1, 2] } },
    ]
    const out = captureStdout(() => emitJsonl(records))
    const lines = out.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines.map(l => JSON.parse(l))).toEqual(records)
  })

  it('never pretty-prints — no line contains a newline-indented object', () => {
    const out = captureStdout(() => emitJsonl([{ a: { b: { c: 1 } } }]))
    // A single line plus the trailing newline — nothing multi-line.
    expect(out.split('\n').filter(Boolean)).toHaveLength(1)
    expect(out).toBe('{"a":{"b":{"c":1}}}\n')
  })

  it('prints nothing for empty input (so "no records" stays distinct from failure)', () => {
    const out = captureStdout(() => emitJsonl([]))
    expect(out).toBe('')
  })

  it('accepts any iterable, not just arrays', () => {
    function* gen() {
      yield { n: 1 }
      yield { n: 2 }
    }
    const out = captureStdout(() => emitJsonl(gen()))
    expect(out).toBe('{"n":1}\n{"n":2}\n')
  })
})

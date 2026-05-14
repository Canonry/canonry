import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)
const pkg = _require('../package.json') as { bin: Record<string, string> }

describe('cnry bin alias', () => {
  it('exposes both canonry and cnry pointing at the same CLI shim', () => {
    expect(pkg.bin.canonry).toBe('./bin/canonry.mjs')
    expect(pkg.bin.cnry).toBe('./bin/canonry.mjs')
    // cnry is an alias, not a separate entrypoint — it must resolve to the same shim.
    expect(pkg.bin.cnry).toBe(pkg.bin.canonry)
  })

  it('leaves the canonry-mcp bin under its full name', () => {
    expect(pkg.bin['canonry-mcp']).toBe('./bin/canonry-mcp.mjs')
    expect(pkg.bin['cnry-mcp']).toBeUndefined()
  })
})

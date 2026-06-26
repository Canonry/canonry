import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendSystemPromptExtras } from '../src/agent/session.js'

const tmpFiles: string[] = []
function writeTmp(contents: string): string {
  const p = path.join(os.tmpdir(), `aero-append-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(p, contents, 'utf-8')
  tmpFiles.push(p)
  return p
}
afterEach(() => {
  for (const p of tmpFiles.splice(0)) fs.rmSync(p, { force: true })
})

describe('appendSystemPromptExtras (OSS-D)', () => {
  it('is byte-identical to the base when no append env is set', () => {
    expect(appendSystemPromptExtras('BASE', {})).toBe('BASE')
    // An all-whitespace inline value collapses to empty => base unchanged.
    expect(appendSystemPromptExtras('BASE  ', { AERO_SYSTEM_PROMPT_APPEND: '   ' })).toBe('BASE  ')
  })

  it('appends the inline AERO_SYSTEM_PROMPT_APPEND after a divider', () => {
    expect(appendSystemPromptExtras('BASE', { AERO_SYSTEM_PROMPT_APPEND: 'ADS RULES' })).toBe(
      'BASE\n\n---\n\nADS RULES',
    )
  })

  it('appends the contents of AERO_SYSTEM_PROMPT_FILE', () => {
    const file = writeTmp('FILE RULES')
    expect(appendSystemPromptExtras('BASE', { AERO_SYSTEM_PROMPT_FILE: file })).toBe(
      'BASE\n\n---\n\nFILE RULES',
    )
  })

  it('appends inline then file when both are set', () => {
    const file = writeTmp('FROM FILE')
    expect(
      appendSystemPromptExtras('BASE', { AERO_SYSTEM_PROMPT_APPEND: 'INLINE', AERO_SYSTEM_PROMPT_FILE: file }),
    ).toBe('BASE\n\n---\n\nINLINE\n\nFROM FILE')
  })

  it('skips a missing file without throwing (delivery never breaks on a bad path)', () => {
    expect(appendSystemPromptExtras('BASE', { AERO_SYSTEM_PROMPT_FILE: '/no/such/aero/append/file.md' })).toBe(
      'BASE',
    )
  })

  it('trims the base trailing whitespace only when an append is present', () => {
    expect(appendSystemPromptExtras('BASE\n\n', { AERO_SYSTEM_PROMPT_APPEND: 'X' })).toBe('BASE\n\n---\n\nX')
  })
})

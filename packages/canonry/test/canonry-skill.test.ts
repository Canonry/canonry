import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('canonry skill metadata', () => {
  it('requires the global package and keeps initialization in the operator terminal', () => {
    const skillPath = fileURLToPath(new URL('../../../skills/canonry/SKILL.md', import.meta.url))
    const body = fs.readFileSync(skillPath, 'utf-8')

    expect(body).toContain('"package": "@canonry/canonry"')
    expect(body).toContain('"command": "npm install -g @canonry/canonry"')
    expect(body).not.toContain('"command": "npx @canonry/canonry@latest init"')
    expect(body).toContain('cnry init --skip-skills --skip-mcp')
    expect(body).not.toContain('"package": "canonry"')
  })
})

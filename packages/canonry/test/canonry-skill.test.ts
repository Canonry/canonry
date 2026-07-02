import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('canonry skill metadata', () => {
  it('points install metadata at the published canonry package', () => {
    const skillPath = fileURLToPath(new URL('../../../skills/canonry/SKILL.md', import.meta.url))
    const body = fs.readFileSync(skillPath, 'utf-8')

    expect(body).toContain('"package": "@canonry/canonry"')
    expect(body).toContain('"command": "npm install -g @canonry/canonry"')
    expect(body).toContain('"command": "npx @canonry/canonry@latest init"')
    expect(body).not.toContain('"package": "canonry"')
  })
})

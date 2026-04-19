import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('canonry setup skill metadata', () => {
  it('points install metadata at the published canonry package', () => {
    const skillPath = fileURLToPath(new URL('../../../skills/canonry-setup/SKILL.md', import.meta.url))
    const body = fs.readFileSync(skillPath, 'utf-8')

    expect(body).toContain('"package": "@ainyc/canonry"')
    expect(body).toContain('"command": "npm install -g @ainyc/canonry"')
    expect(body).toContain('"command": "npx @ainyc/canonry@latest init"')
    expect(body).not.toContain('"package": "canonry"')
  })
})

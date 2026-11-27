/**
 * A control that changes something must not be offered to an account that
 * cannot use it.
 *
 * `viewer-write-controls.test.tsx` proves `WriteButton` behaves correctly. It
 * cannot prove the SECTIONS use it, and four of them did not: Discovery, GBP,
 * Research queries and Agent Readiness each rendered a plain `Button` wired to a
 * mutation, so a viewer got an enabled control that the server was always going
 * to refuse with a 403. "Find queries" looked broken rather than forbidden.
 *
 * This is the structural check: any project section that fires a mutation must
 * route its action through `WriteButton`. It fails on the NEXT one too, which
 * is the point — the per-control test only ever covers controls someone
 * remembered to add to it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test } from 'vitest'

const SECTION_DIR = resolve(import.meta.dirname, '../src/components/project')

/**
 * Files that fire a mutation but legitimately need no gated button, with the
 * reason. Keep this list SHRINKING; an entry is a debt, not a pattern.
 */
const EXEMPT = new Map<string, string>()

function sectionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sectionFiles(full)
    return entry.name.endsWith('.tsx') ? [full] : []
  })
}

test('every project section with a mutation gates its action behind WriteButton', () => {
  const offenders: string[] = []

  for (const file of sectionFiles(SECTION_DIR)) {
    const source = readFileSync(file, 'utf8')
    const name = file.slice(SECTION_DIR.length + 1)
    if (EXEMPT.has(name)) continue

    // `.mutate(` is what actually reaches the server; useMutation alone may be
    // a definition a child component triggers.
    if (!source.includes('.mutate(')) continue
    if (source.includes('WriteButton')) continue

    offenders.push(name)
  }

  expect(offenders).toEqual([])
})

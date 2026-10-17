import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse as parseYaml } from 'yaml'

/**
 * This repository defines its workspace in `pnpm-workspace.yaml`, and ONLY
 * there. A `workspaces` array in the root `package.json` is a second, silent
 * definition, and it breaks the Vals.
 *
 * The failure is worth spelling out, because nothing about it points at the
 * cause. Running any `deno` command from the repository root makes Deno notice
 * `pnpm-workspace.yaml`, announce that it "migrated its workspace configuration
 * into package.json", and WRITE the key. From then on Deno resolves the repo as
 * an npm workspace, so every Val's dev graph pulls in each `@canonry/canonry-*`
 * package and its transitive deps — none of which are in the Val's
 * `deno.dev.lock`. `deno check --frozen` then fails with a lockfile diff
 * hundreds of lines long, in a job that never touched the Val.
 *
 * There is no reliable way to avoid it. Deno walks UP for npm resolution, so it
 * finds `pnpm-workspace.yaml` even when invoked from a Val directory that has
 * its own `deno.json`, and `--no-lock` does not stop it either — both verified.
 * The remedy is therefore to NOTICE, which is what this guard is for: the key is
 * easy to sweep into an unrelated `git add` and expensive to diagnose from its
 * symptom. If `git status` shows `package.json` after any `deno` command, revert
 * it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readRoot<T>(file: string, parse: (raw: string) => T): T {
  return parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'))
}

test('pnpm-workspace.yaml is the only workspace definition', () => {
  const pkg = readRoot('package.json', (raw) => JSON.parse(raw) as { workspaces?: unknown })

  expect(
    pkg.workspaces,
    'Root package.json declares "workspaces". Delete it: pnpm-workspace.yaml owns the workspace, and this key ' +
      'makes Deno resolve every Val against the whole monorepo, failing `deno check --frozen` on a lockfile diff.',
  ).toBeUndefined()
})

test('pnpm-workspace.yaml still covers the packages and apps trees', () => {
  const workspace = readRoot('pnpm-workspace.yaml', (raw) => parseYaml(raw) as { packages?: string[] })

  // Guards the other direction: deleting the key above is only correct while
  // this file is what actually defines the workspace.
  expect(workspace.packages).toEqual(expect.arrayContaining(['packages/*']))
})

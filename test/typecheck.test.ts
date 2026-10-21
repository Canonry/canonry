import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse as parseYaml } from 'yaml'

/**
 * `scripts/typecheck.mjs` is the one place that decides which compiler checks
 * the workspace: tsrs by default (its WebAssembly build where no native binary
 * is installed) or the `typescript` package's tsc with CANONRY_TYPECHECKER=tsc.
 * These tests run the real script against a fixture with one type error, so a
 * tsrs or TypeScript upgrade that moves a bin, or a change that swallows the
 * compiler's exit status, fails here instead of letting type errors pass CI.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dispatcher = path.join(repoRoot, 'scripts/typecheck.mjs')
const require = createRequire(import.meta.url)
const manifestOf = (pkg: string) =>
  JSON.parse(fs.readFileSync(require.resolve(`${pkg}/package.json`), 'utf8')) as {
    version: string
    optionalDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }
const tsrs = manifestOf('tsrs')
const typescript = manifestOf('typescript')
const TYPE_ERROR = "index.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'."
const WASM_NOTICE = 'running its WebAssembly build'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-typecheck-'))
  tempDirs.push(dir)
  return dir
}

function brokenProject() {
  const dir = tempDir()
  const compilerOptions = { strict: true, noEmit: true, types: [], module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022' }
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: ['index.ts'] }))
  fs.writeFileSync(path.join(dir, 'index.ts'), "export const count: number = 'one'\n")
  return dir
}

function typecheck(script: string, args: string[], cwd: string, choice?: string) {
  const env = { ...process.env }
  delete env.CANONRY_TYPECHECKER
  // pnpm's bin shims export NODE_PATH at its virtual store, where every installed
  // package resolves, including the native tsrs package the fallback install omits.
  delete env.NODE_PATH
  if (choice !== undefined) env.CANONRY_TYPECHECKER = choice
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' })
}

test.each([
  { label: 'unset (tsrs)', choice: undefined, version: `(tsrs ${tsrs.version},`, exitCode: 2 },
  { label: 'tsc', choice: 'tsc', version: `Version ${typescript.version}`, exitCode: 1 },
])('CANONRY_TYPECHECKER=$label runs the selected compiler and fails on a type error', ({ choice, version, exitCode }) => {
  const project = brokenProject()
  expect(typecheck(dispatcher, ['--version'], project, choice).stdout).toContain(version)

  const result = typecheck(dispatcher, ['--pretty', 'false', '-p', 'tsconfig.json'], project, choice)
  expect(result.stdout).toContain(TYPE_ERROR)
  expect(result.status).toBe(exitCode)
})

test('tsrs runs its native binary wherever tsrs publishes one for the platform', () => {
  const native = Object.keys(tsrs.optionalDependencies ?? {}).some((name) =>
    new RegExp(`/${process.platform}-${process.arch}(-|$)`).test(name),
  )
  const result = typecheck(dispatcher, ['--version'], repoRoot)
  expect(result.status).toBe(0)
  if (native) expect(result.stderr).not.toContain(WASM_NOTICE)
  else expect(result.stderr).toContain(WASM_NOTICE)
})

test('without a native tsrs package the WebAssembly build checks and fails the same way', () => {
  // An install where tsrs has none of its per-platform optional dependencies,
  // as on Intel macOS: only tsrs's manifest and the WebAssembly package exist.
  const install = tempDir()
  fs.mkdirSync(path.join(install, 'scripts'))
  fs.copyFileSync(dispatcher, path.join(install, 'scripts/typecheck.mjs'))
  fs.mkdirSync(path.join(install, 'node_modules/tsrs'), { recursive: true })
  fs.copyFileSync(require.resolve('tsrs/package.json'), path.join(install, 'node_modules/tsrs/package.json'))
  fs.mkdirSync(path.join(install, 'node_modules/@tsrs'))
  fs.symlinkSync(path.dirname(require.resolve('@tsrs/wasm/package.json')), path.join(install, 'node_modules/@tsrs/wasm'), 'dir')
  const script = path.join(install, 'scripts/typecheck.mjs')

  const project = brokenProject()
  const version = typecheck(script, ['--version'], project)
  expect(version.stderr).toContain(WASM_NOTICE)
  expect(version.stdout).toContain(`(tsrs ${tsrs.version},`)

  const result = typecheck(script, ['--pretty', 'false', '-p', 'tsconfig.json'], project)
  expect(result.stdout).toContain(TYPE_ERROR)
  expect(result.status).toBe(2)
})

test('an unknown CANONRY_TYPECHECKER is refused instead of falling back to a default', () => {
  const result = typecheck(dispatcher, ['--version'], repoRoot, 'tsgo')
  expect(result.stderr).toContain('CANONRY_TYPECHECKER must be "tsrs" or "tsc", got "tsgo"')
  expect(result.stdout).toBe('')
  expect(result.status).toBe(1)
})

test('every workspace typecheck script goes through scripts/typecheck.mjs, never bare tsc', () => {
  const workspace = parseYaml(fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const dirs = ['.']
  for (const glob of workspace.packages) {
    expect(glob, 'this guard only expands `<dir>/*` workspace globs').toMatch(/^[\w-]+\/\*$/)
    const base = glob.slice(0, -2)
    for (const name of fs.readdirSync(path.join(repoRoot, base))) {
      if (fs.existsSync(path.join(repoRoot, base, name, 'package.json'))) dirs.push(path.join(base, name))
    }
  }

  const checked = dirs.flatMap((dir) => {
    const script = (JSON.parse(fs.readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> })
      .scripts?.typecheck
    return script ? [{ dir, script }] : []
  })
  expect(checked.map(({ dir }) => dir)).toEqual(expect.arrayContaining(['.', 'apps/web', 'packages/canonry']))
  for (const { dir, script } of checked) {
    expect(script, `${dir}: call scripts/typecheck.mjs instead of tsc`).not.toMatch(/(^|[\s&;|])tsc(\s|$)/)
    for (const [, target] of script.matchAll(/node (\S*typecheck\.mjs)/g)) {
      expect(path.resolve(repoRoot, dir, target), `${dir}: typecheck script path`).toBe(dispatcher)
    }
  }
})

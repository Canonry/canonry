#!/usr/bin/env node
// Fast lint of changed JS/TS files (`pnpm check`) or, with --staged, of the
// exact staged blobs a commit will contain (the pre-commit hook). It runs every
// oxlint rule except the type-aware ones, which need whole programs and run in
// `pnpm lint`. A change to the lint configuration or a custom rule can affect
// any file, so it runs that full lint instead.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const started = performance.now()
const args = process.argv.slice(2)
const staged = args.includes('--staged')
const CONFIG = '.oxlintrc.json'

function git(args, cwd = process.cwd()) {
  // Preserve GIT_INDEX_FILE: Git uses an alternate index for `git commit <path>`.
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function oxlintBin(cwd) {
  const require = createRequire(path.join(cwd, 'package.json'))
  const manifestPath = require.resolve('oxlint/package.json')
  const { bin } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  return path.join(path.dirname(manifestPath), typeof bin === 'string' ? bin : bin.oxlint)
}

// oxlint reads files from disk, so staged content is written at its repository
// path under a temporary root. The config copy resolves its globs against that
// root and loads plugins through links back to this checkout.
function stageTree(cwd, blobs) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-lint-staged-')))
  fs.copyFileSync(path.join(cwd, CONFIG), path.join(root, CONFIG))
  for (const link of ['node_modules', 'eslint-rules']) {
    if (fs.existsSync(path.join(cwd, link))) fs.symlinkSync(path.join(cwd, link), path.join(root, link))
  }
  for (const [file, blob] of blobs) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, execFileSync('git', ['cat-file', 'blob', blob], { cwd, maxBuffer: 32 * 1024 * 1024 }))
  }
  return root
}

function main() {
  if (args.some(arg => arg !== '--staged')) throw new Error('Usage: node scripts/lint-changed.mjs [--staged]')
  const cwd = git(['rev-parse', '--show-toplevel']).trim()
  const isCode = file => /\.(?:[cm]?js|tsx?)$/.test(file)
  const isLintConfig = file => file === CONFIG || file.startsWith('eslint-rules/')
  // Include deleted configuration/rules: removing a guard can change the whole tree.
  const changedPaths = staged
    ? git(['diff', '--cached', '--name-only', '--no-renames', '-z', '--'], cwd).split('\0')
    : [
        git(['diff', '--name-only', '--no-renames', '-z', '--'], cwd),
        git(['diff', '--cached', '--name-only', '--no-renames', '-z', '--'], cwd),
        git(['ls-files', '--others', '--exclude-standard', '-z'], cwd),
      ].flatMap(output => output.split('\0'))
  const blobs = new Map()
  let files

  if (staged) {
    // Raw, NUL-delimited records preserve unusual filenames and pin the exact
    // index blobs. Treat renames as delete/add so only destination files matter.
    const records = git(['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '--diff-filter=ACMR', '-z', '--'], cwd).split('\0')
    for (let i = 0; i + 1 < records.length; i += 2) {
      const [, mode, , blob] = records[i].split(' ')
      const file = records[i + 1]
      if (isCode(file) && (mode === '100644' || mode === '100755')) blobs.set(file, blob)
    }
    files = [...blobs.keys()]
  } else {
    const changed = [
      git(['diff', '--name-only', '--no-renames', '--diff-filter=ACMR', '-z', '--'], cwd),
      git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMR', '-z', '--'], cwd),
      git(['ls-files', '--others', '--exclude-standard', '-z'], cwd),
    ].flatMap(output => output.split('\0')).filter(isCode)
    files = [...new Set(changed)].filter(file => fs.lstatSync(path.join(cwd, file), { throwIfNoEntry: false })?.isFile())
  }

  // Documentation-only commits need neither installed dependencies nor a linter.
  if (files.length === 0 && !changedPaths.some(isLintConfig)) return
  const unstagedPaths = git(['diff', '--name-only', '--no-renames', '-z', '--'], cwd).split('\0').filter(Boolean)
  const untrackedPaths = staged ? git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).split('\0') : []
  if ([...changedPaths, ...unstagedPaths, ...untrackedPaths].some(isLintConfig)) {
    // Typed lint reads the project from disk. Refuse a different staged program
    // instead of reporting a green result for source/config that is not committed.
    if (staged && [...unstagedPaths, ...untrackedPaths].some(file => isCode(file) || /\.json$/.test(file) || isLintConfig(file))) {
      throw new Error('Full typed lint needs source and configuration to match the Git index. Stage the intended code/configuration changes first.')
    }
    console.log('lint: configuration or rules changed; running full repository type-aware lint')
    const result = spawnSync('pnpm', ['run', 'lint'], { cwd, stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
    return
  }

  console.log(`lint: checking ${files.length} ${staged ? 'staged' : 'changed'} file(s)`)
  const bin = oxlintBin(cwd)
  const root = staged ? stageTree(cwd, blobs) : cwd
  try {
    // The config is passed relative to the working directory: oxlint 1.89 silently
    // skips JS plugin rules (every repository guard) when `-c` is an absolute path
    // through a symlink, such as macOS's /tmp -> /private/tmp.
    const result = spawnSync(process.execPath, [bin, '-c', CONFIG, '--format', 'json', ...files], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error) throw result.error
    let report
    try {
      // A notice (such as "No files found to lint") can precede the JSON report.
      report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
    } catch {
      throw new Error(`oxlint failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`)
    }
    // Every named file is ignored (generated code): oxlint exits 1, but nothing failed.
    const nothingToLint = report.number_of_files === 0 && /No files found to lint/.test(result.stdout + result.stderr)
    for (const diagnostic of report.diagnostics) {
      const span = diagnostic.labels?.[0]?.span
      const at = span ? `:${span.line}:${span.column}` : ''
      const help = diagnostic.help ? ` (${diagnostic.help})` : ''
      console.log(`${diagnostic.filename}${at}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${help}`)
    }
    const failed = !nothingToLint && (result.status !== 0 || report.diagnostics.some(diagnostic => diagnostic.severity === 'error'))
    console.log(`lint: ${failed ? 'FAILED' : 'passed'} (${report.number_of_files} files, ${((performance.now() - started) / 1000).toFixed(2)}s)`)
    process.exitCode = failed ? 1 : 0
  } finally {
    if (root !== cwd) fs.rmSync(root, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(`lint: ${error.code === 'MODULE_NOT_FOUND' ? 'Dependencies are missing. Run pnpm install.' : error.message}`)
  process.exitCode = 1
}

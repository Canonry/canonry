#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createLintCache } from './lint-cache.mjs'

const started = performance.now()
const args = process.argv.slice(2)
const staged = args.includes('--staged')

function git(args, cwd = process.cwd()) {
  // Preserve GIT_INDEX_FILE: Git uses an alternate index for `git commit <path>`.
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

async function main() {
  if (args.some(arg => !['--staged', '--no-cache'].includes(arg))) throw new Error('Usage: node scripts/lint-changed.mjs [--staged] [--no-cache]')
  const cwd = git(['rev-parse', '--show-toplevel']).trim()
  const isCode = file => /\.(?:[cm]?js|tsx?)$/.test(file)
  const isLintConfig = file => /(?:^|\/)eslint\.config\.[^/]+$/.test(file) || file.startsWith('eslint-rules/')
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

  // Documentation-only commits need neither installed dependencies nor ESLint startup.
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
  const [{ ESLint }, { default: tseslint }] = await Promise.all([import('eslint'), import('typescript-eslint')])
  const eslint = new ESLint({
    cwd,
    // Keep syntax and repository guards, without loading TypeScript projects.
    // The regular lint command and CI retain every type-aware rule.
    overrideConfig: [{ files: ['**/*.ts', '**/*.tsx'], ...tseslint.configs.disableTypeChecked }],
    globInputPaths: false,
  })
  const included = []
  for (const file of files) {
    if (!await eslint.isPathIgnored(path.join(cwd, file))) included.push(file)
  }

  const cache = args.includes('--no-cache') ? undefined : createLintCache(cwd, git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd).trim())
  const results = []
  let cached = 0
  for (const file of included) {
    const filePath = path.join(cwd, file)
    // Hash and lint the same snapshot, including partially staged content.
    const source = staged ? git(['cat-file', 'blob', blobs.get(file)], cwd) : fs.readFileSync(filePath, 'utf8')
    const key = cache?.key(file, source, await eslint.calculateConfigForFile(filePath))
    if (cache?.has(key)) {
      cached++
      continue
    }
    const linted = await eslint.lintText(source, { filePath })
    results.push(...linted)
    // Keep warnings and suppressed diagnostics visible on every invocation.
    if (linted.length > 0 && linted.every(result => result.messages.length === 0 && result.suppressedMessages.length === 0)) cache?.put(key)
  }
  const output = (await eslint.loadFormatter('stylish')).format(results)
  if (output) console.log(output)
  const failed = results.some(result => result.errorCount > 0)
  console.log(`lint: ${failed ? 'FAILED' : 'passed'} (${included.length} files, ${cached} cached, ${((performance.now() - started) / 1000).toFixed(2)}s)`)
  process.exitCode = failed ? 1 : 0
}

main().catch(error => {
  console.error(`lint: ${error.code === 'ERR_MODULE_NOT_FOUND' ? 'Dependencies are missing. Run pnpm install.' : error.message}`)
  process.exitCode = 1
})

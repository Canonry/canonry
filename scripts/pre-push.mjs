import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

// Do not let Git's hook environment redirect checks to a different index/repository.
const env = { ...process.env }
for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n')) delete env[name]
const git = args => execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// Codegen imports the workspace package graph. The other gates read skill/plugin
// mirrors, manifests, and the codemap. WIP outside these paths can stay untouched.
const inputs = [
  'packages', 'skills', 'plugins/canonry', 'scripts',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json',
  'docs/CODEMAP.md', 'docs/GUARDS.md', 'docs/DOC_UPDATE.md',
]

function main() {
  const updates = fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)
  const commits = new Set()
  for (const update of updates) {
    const [, sha] = update.split(/\s+/)
    if (!sha || !/^[\da-f]{40,64}$/.test(sha)) throw new Error('Invalid pre-push ref update')
    if (/^0+$/.test(sha)) continue // Deletions publish no source.
    commits.add(git(['rev-parse', '--verify', `${sha}^{commit}`]).trim())
  }
  if (commits.size === 0) return

  const assertPushInputs = () => {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...inputs])
    for (const commit of commits) {
      const changed = git(['diff', '--no-ext-diff', '--name-only', '-z', commit, '--', ...inputs])
      const files = [...new Set(`${changed}${untracked}`.split('\0').filter(Boolean))]
      if (files.length > 0) {
        throw new Error(`Drift-check inputs differ from pushed commit ${commit.slice(0, 12)}:\n${files.slice(0, 20).join('\n')}\nCommit these changes, or run the push from a checkout of the intended commit.`)
      }
    }
  }
  assertPushInputs()
  const started = performance.now()
  for (const args of [['gen:check', '--committed'], ['plugin:check'], ['val:skills:check']]) {
    console.log(`pre-push: pnpm ${args.join(' ')}`)
    const result = spawnSync('pnpm', args, { env, stdio: ['ignore', 'inherit', 'inherit'] })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed${result.signal ? ` (${result.signal})` : ''}`)
  }
  assertPushInputs()
  console.log(`pre-push: drift checks passed (${((performance.now() - started) / 1000).toFixed(2)}s)`)
}

try { main() } catch (error) {
  console.error(`pre-push: ${error.message}`)
  process.exitCode = 1
}

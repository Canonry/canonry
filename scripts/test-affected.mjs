#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const WORKSPACE_PROJECTS = [
  ['packages/api-client-generated', 'api-client-generated'],
  ['packages/api-routes', 'api-routes'],
  ['packages/canonry', 'canonry'],
  ['packages/config', 'config'],
  ['packages/contracts', 'contracts'],
  ['packages/db', 'db'],
  ['packages/integration-bing', 'integration-bing'],
  ['packages/integration-cloud-run', 'integration-cloud-run'],
  ['packages/integration-commoncrawl', 'integration-commoncrawl'],
  ['packages/integration-google', 'integration-google'],
  ['packages/integration-google-analytics', 'integration-google-analytics'],
  ['packages/integration-google-business-profile', 'integration-google-business-profile'],
  ['packages/integration-google-places', 'integration-google-places'],
  ['packages/integration-openai-ads', 'integration-openai-ads'],
  ['packages/integration-traffic', 'integration-traffic'],
  ['packages/integration-vercel', 'integration-vercel'],
  ['packages/integration-wordpress', 'integration-wordpress'],
  ['packages/integration-wordpress-traffic', 'integration-wordpress-traffic'],
  ['packages/intelligence', 'intelligence'],
  ['packages/provider-cdp', 'provider-cdp'],
  ['packages/provider-claude', 'provider-claude'],
  ['packages/provider-gemini', 'provider-gemini'],
  ['packages/provider-local', 'provider-local'],
  ['packages/provider-openai', 'provider-openai'],
  ['packages/provider-perplexity', 'provider-perplexity'],
  ['apps/api', 'api'],
  ['apps/worker', 'worker'],
  ['apps/web', 'web'],
  // The native PHP plugin is covered by the dedicated WordPress job.
  ['packages/wordpress-traffic-logger-plugin', null],
]

const FULL_SUITE_FILES = new Set([
  '.npmrc',
  '.nvmrc',
  'eslint.config.js',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'vitest.config.ts',
  'vitest.package.config.ts',
])

const FULL_SUITE_PREFIXES = ['.github/', 'scripts/', 'test-setup/']
const NO_VITEST_PREFIXES = ['.agents/', '.claude-plugin/', 'docker/', 'docs/', 'plugins/', 'skills/']
const NO_VITEST_FILES = new Set(['.dockerignore', 'AGENTS.md', 'CLAUDE.md', 'Dockerfile', 'Dockerfile.api', 'Dockerfile.web', 'Dockerfile.worker', 'Makefile', 'README.md'])

function dependencyNames(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
}

export function loadWorkspaces(root = repoRoot) {
  return WORKSPACE_PROJECTS.map(([directory, project]) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'))
    return {
      dependencies: dependencyNames(manifest),
      directory,
      name: manifest.name,
      project,
    }
  })
}

function fullSuite(reason) {
  return { mode: 'full', reason }
}

function isFullSuitePath(file) {
  return FULL_SUITE_FILES.has(file) || FULL_SUITE_PREFIXES.some((prefix) => file.startsWith(prefix))
}

function isNoVitestPath(file) {
  return NO_VITEST_FILES.has(file) || NO_VITEST_PREFIXES.some((prefix) => file.startsWith(prefix))
}

function workspaceForPath(file, workspaces) {
  return workspaces.find(({ directory }) => file === directory || file.startsWith(`${directory}/`))
}

export function planAffectedTestProjects(changedPaths, workspaces) {
  const changedNames = new Set()

  for (const file of changedPaths) {
    if (isFullSuitePath(file)) return fullSuite(`${file} changes shared test or runtime configuration`)
    if (isNoVitestPath(file)) continue

    const workspace = workspaceForPath(file, workspaces)
    if (!workspace) return fullSuite(`${file} is outside a known workspace test boundary`)
    changedNames.add(workspace.name)
  }

  if (changedNames.size === 0) return { mode: 'none' }

  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))
  const dependents = new Map(workspaces.map((workspace) => [workspace.name, new Set()]))

  for (const workspace of workspaces) {
    for (const dependency of workspace.dependencies) {
      if (workspaceByName.has(dependency)) dependents.get(dependency).add(workspace.name)
    }
  }

  const selectedNames = new Set(changedNames)
  const pending = [...changedNames]
  while (pending.length > 0) {
    const dependency = pending.shift()
    for (const dependent of dependents.get(dependency) ?? []) {
      if (selectedNames.has(dependent)) continue
      selectedNames.add(dependent)
      pending.push(dependent)
    }
  }

  const projects = new Set()
  for (const name of selectedNames) {
    const workspace = workspaceByName.get(name)
    if (!workspace) return fullSuite(`workspace ${name} is not mapped to a test project`)
    if (workspace.project) projects.add(workspace.project)
  }

  return projects.size === 0 ? { mode: 'none' } : { mode: 'projects', projects: [...projects].sort() }
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'an unknown status'}`)
  return result.stdout ?? ''
}

function changedPathsSince(baseRef) {
  const mergeBase = run('git', ['merge-base', baseRef, 'HEAD'], { capture: true }).trim()
  if (!mergeBase) throw new Error(`Could not resolve a merge base for ${baseRef}`)

  return run('git', ['diff', '--name-only', '-z', '--diff-filter=ACMRD', mergeBase, 'HEAD'], { capture: true })
    .split('\0')
    .filter(Boolean)
}

function baseRefFromArgs(args) {
  const index = args.indexOf('--base-ref')
  const baseRef = index === -1 ? undefined : args[index + 1]
  if (!baseRef) throw new Error('Usage: node scripts/test-affected.mjs --base-ref <git-ref>')
  return baseRef
}

function runFullSuite(reason) {
  console.log(`Running the full serial suite: ${reason}`)
  run('pnpm', ['run', 'test:ci'])
}

export function main(args = process.argv.slice(2)) {
  const baseRef = baseRefFromArgs(args)
  let plan

  try {
    plan = planAffectedTestProjects(changedPathsSince(baseRef), loadWorkspaces())
  } catch (error) {
    runFullSuite(`the affected-project selector could not resolve its scope (${error.message})`)
    return
  }

  if (plan.mode === 'full') {
    runFullSuite(plan.reason)
    return
  }

  if (plan.mode === 'none') {
    console.log('No TypeScript Vitest projects are affected by this change.')
    return
  }

  console.log(`Running affected serial Vitest projects: ${plan.projects.join(', ')}`)
  run('pnpm', [
    'exec',
    'vitest',
    'run',
    '--passWithNoTests',
    ...plan.projects.flatMap((project) => ['--project', project]),
    '--maxWorkers=1',
    '--maxConcurrency=1',
    '--no-file-parallelism',
  ])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}

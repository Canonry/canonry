import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, test } from 'vitest'
import { parse } from 'yaml'

interface Job {
  uses?: string
  needs?: string | string[]
  if?: string
  permissions?: Record<string, string>
  strategy?: { matrix: { include: { node: string; shard: string }[] } }
  steps?: { name?: string; run?: string }[]
}
interface Workflow {
  on: Record<string, { paths?: string[]; branches?: string[] } | null>
  jobs: Record<string, Job>
}
const read = (name: string) => parse(fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')) as Workflow
const ci = read('ci.yml')
const fullJobs = ['typecheck', 'test_shards', 'test', 'lint', 'wp-plugin-tests', 'ts-prune', 'codegen-drift', 'plugin-drift', 'version-guard', 'build', 'publish-smoke-test', 'validate', 'docker-build']
const needs = (job: Job) => typeof job.needs === 'string' ? [job.needs] : job.needs ?? []
function enabled(job: Job, ownerOnly: string | undefined, { event = 'pull_request', policyResult = 'success', buildResult = 'success', cancelled = false } = {}) {
  if (!job.if) throw new Error('Full job has no policy condition')
  const expression = job.if.startsWith('${{') ? job.if.slice(3, -2).trim() : job.if
  const upstreamSucceeded = policyResult === 'success' && (!needs(job).includes('build') || buildResult === 'success')
  // GitHub adds success() implicitly unless a status function is present.
  if (!upstreamSucceeded && !/\b(?:always|cancelled|success|failure)\(/.test(expression)) return false
  return runInNewContext(`Boolean(${expression})`, {
    needs: { policy: { result: policyResult, outputs: { owner_only: ownerOnly } }, build: { result: buildResult } },
    github: { event_name: event },
    always: () => true,
    cancelled: () => cancelled,
  }) as boolean
}

test('every existing CI job depends on the shared read-only policy, with no conflict-check job', () => {
  expect(Object.keys(ci.jobs).sort()).toEqual(['policy', ...fullJobs].sort())
  expect(ci.jobs.policy).toEqual({ uses: './.github/workflows/change-policy.yml', permissions: { contents: 'read', 'pull-requests': 'read' } })
  for (const name of fullJobs) expect(needs(ci.jobs[name]!), name).toContain('policy')
  expect(ci.on.push).toEqual({ branches: ['main'] })
  expect(ci.on.pull_request).toBeNull()
  expect(Object.keys(read('change-policy.yml').on)).toEqual(['workflow_call'])
})

test.each(['push', 'pull_request'])('owner-only %s skips all full CI jobs, including always aggregators', event => {
  for (const name of fullJobs) expect(enabled(ci.jobs[name]!, 'true', { event }), name).toBe(false)
})

test.each(['false', undefined, '', 'unknown'])('outsider or unknown output %s retains full CI and PR-only version validation', output => {
  for (const name of fullJobs) {
    expect(enabled(ci.jobs[name]!, output), name).toBe(true)
    expect(enabled(ci.jobs[name]!, output, { event: 'push' }), name).toBe(name !== 'version-guard')
  }
})

test.each(['failure', 'timed_out', 'skipped'])('metadata policy %s retains independent full checks for unknown provenance', policyResult => {
  for (const name of fullJobs) {
    expect(enabled(ci.jobs[name]!, undefined, { policyResult }), name).toBe(true)
    expect(enabled(ci.jobs[name]!, 'true', { policyResult }), name).toBe(false)
  }
})

test('the packaged scenario needs a successful build and ordinary full jobs stop on cancellation', () => {
  for (const buildResult of ['failure', 'cancelled', 'skipped']) {
    expect(enabled(ci.jobs['publish-smoke-test']!, undefined, { policyResult: 'failure', buildResult })).toBe(false)
  }
  for (const name of fullJobs.filter(name => name !== 'test' && name !== 'validate')) {
    expect(enabled(ci.jobs[name]!, 'false', { cancelled: true }), name).toBe(false)
  }
})

test('full CI retains all validation dependencies and the complete supported-node test matrix', () => {
  for (const name of ['test', 'validate']) {
    expect(enabled(ci.jobs[name]!, 'false', { policyResult: 'failure' }), name).toBe(true)
    expect(enabled(ci.jobs[name]!, 'true', { policyResult: 'failure' }), name).toBe(false)
  }
  expect(needs(ci.jobs.test!)).toEqual(['policy', 'test_shards'])
  expect(needs(ci.jobs['publish-smoke-test']!)).toEqual(['policy', 'build'])
  expect(needs(ci.jobs.validate!)).toEqual(['policy', 'typecheck', 'test', 'lint', 'codegen-drift', 'plugin-drift', 'build', 'publish-smoke-test', 'wp-plugin-tests'])
  expect(ci.jobs.test_shards!.strategy!.matrix.include).toEqual(['22', '26'].flatMap(node => Array.from({ length: 6 }, (_, index) => ({ node, shard: `${index + 1}/6` }))))
  const testGate = ci.jobs.test!.steps!.find(step => step.name === 'Verify all test shards succeeded')!.run!
  const validateGate = ci.jobs.validate!.steps!.find(step => step.name === 'Verify all validate jobs succeeded')!.run!
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    const expected = result === 'success' ? 0 : 1
    expect(spawnSync('bash', ['-e', '-o', 'pipefail', '-c', testGate], { env: { ...process.env, SHARD_RESULT: result } }).status).toBe(expected)
    const script = validateGate.replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, name: string) => name === 'test' ? result : 'success')
    expect(spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script]).status).toBe(expected)
  }
})

test('WordPress publication shares the owner gate and keeps publication permissions on the release job', () => {
  const wordpress = read('wp-plugin-release.yml')
  expect(wordpress.jobs.policy).toEqual(ci.jobs.policy)
  expect(needs(wordpress.jobs.release!)).toContain('policy')
  expect(enabled(wordpress.jobs.release!, 'true', { event: 'push' })).toBe(false)
  for (const output of ['false', undefined]) expect(enabled(wordpress.jobs.release!, output, { event: 'push' })).toBe(true)
  expect(enabled(wordpress.jobs.release!, undefined, { event: 'push', policyResult: 'failure' })).toBe(false)
  expect(wordpress.jobs.release!.permissions?.contents).toBe('write')
})

import fs from 'node:fs'
import { Script } from 'node:vm'
import { expect, test, vi } from 'vitest'
import { parse } from 'yaml'

interface WorkflowStep {
  id?: string
  name?: string
  uses?: string
  run?: string
  with?: Record<string, string>
}

interface WorkflowJobDefinition {
  needs?: string | string[]
  if?: string
  uses?: string
  outputs?: Record<string, string>
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
}

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')) as {
  on: { push: { paths: string[] } }
  jobs: Record<string, WorkflowJobDefinition>
}
const ciWorkflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
  jobs: Record<string, { name?: string; needs?: string[] }>
}
const source = workflow.jobs.ci?.steps?.find(step => step.name === 'Require successful CI for the release commit')?.with?.script
if (!source) throw new Error('Missing publish CI gate')
const script = new Script(`(async () => { ${source} })()`)

type JobResult = 'success' | 'failure' | 'skipped' | 'cancelled'
interface JobNeed {
  result: JobResult
  outputs: Record<string, string>
}

function releaseContext(options: {
  ownerOnly?: string
  results?: Record<string, JobResult>
  versionChanged?: string
  ciRunId?: string
  eventName?: string
  refName?: string
  cancelled?: boolean
} = {}) {
  const ownerOnly = options.ownerOnly ?? 'true'
  const needs: Record<string, JobNeed> = {
    policy: { result: 'success', outputs: { owner_only: ownerOnly } },
    version: {
      result: 'success',
      outputs: { version_changed: options.versionChanged ?? 'true', canonry_skill_changed: 'true', docker_changed: 'true' },
    },
    'plugin-drift': { result: ownerOnly === 'false' ? 'success' : 'skipped', outputs: {} },
    ci: { result: ownerOnly === 'false' ? 'success' : 'skipped', outputs: { run_id: options.ciRunId ?? '10' } },
    'owner-build': { result: ownerOnly === 'true' ? 'success' : 'skipped', outputs: {} },
    'publish-npm': { result: 'success', outputs: {} },
  }
  for (const [name, result] of Object.entries(options.results ?? {})) needs[name]!.result = result
  return {
    needs,
    github: {
      repository: {},
      event: { repository: { default_branch: 'main' } },
      ref_name: options.refName ?? 'main',
      event_name: options.eventName ?? 'push',
      run_id: 42,
      token: 'test-token',
    },
    cancelled: () => options.cancelled ?? false,
  }
}

// These workflow expressions use JavaScript-compatible operators and context
// access. Model Actions' implicit success() gate as well as explicit status calls.
function jobEnabled(name: string, context: ReturnType<typeof releaseContext>): boolean {
  const definition = workflow.jobs[name]!
  const dependencies = typeof definition.needs === 'string' ? [definition.needs] : definition.needs ?? []
  const success = () => dependencies.every(dependency => context.needs[dependency]?.result === 'success')
  const expression = definition.if ?? 'success()'
  if (!/\b(?:success|failure|cancelled|always)\s*\(/.test(expression) && !success()) return false
  return Boolean(new Script(`(${expression})`).runInNewContext({ ...context, success }))
}

function selectedArtifactRun(context: ReturnType<typeof releaseContext>): unknown {
  const download = workflow.jobs['publish-npm']!.steps!.find(step => step.uses?.startsWith('actions/download-artifact@'))!
  const expression = download.with!['run-id']!.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  return new Script(`(${expression})`).runInNewContext(context)
}

interface WorkflowRun {
  id: number
  head_sha: string
  head_branch: string
  event: string
  status: string
  conclusion: string | null
  html_url: string
}

interface WorkflowJob {
  name: string
  status: string
  conclusion: string | null
}

const sha = 'a'.repeat(40)
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 10, head_sha: sha, head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success', html_url: 'https://github.com/Canonry/canonry/actions/runs/10',
  ...overrides,
})
const job = (overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
  name: 'validate', status: 'completed', conclusion: 'success', ...overrides,
})

function execute(responses: (WorkflowRun[] | Error)[], jobResponses: (WorkflowJob[] | Error)[] = [[job()]]) {
  let now = 0
  let calls = 0
  let jobCalls = 0
  const listWorkflowRuns = vi.fn(async () => {
    const response = responses[Math.min(calls++, responses.length - 1)]
    if (response instanceof Error) throw response
    return { data: { workflow_runs: response } }
  })
  const listJobsForWorkflowRun = vi.fn(async (_params: { run_id: number }) => {
    const response = jobResponses[Math.min(jobCalls++, jobResponses.length - 1)]
    if (response instanceof Error) throw response
    return { data: { jobs: response } }
  })
  const info = vi.fn()
  const setOutput = vi.fn()
  const result = script.runInNewContext({
    github: { rest: { actions: { listWorkflowRuns, listJobsForWorkflowRun } } },
    context: { repo: { owner: 'Canonry', repo: 'canonry' }, sha, ref: 'refs/heads/main' },
    core: { info, setOutput },
    Date: { now: () => now },
    setTimeout: (resolve: () => void, delay: number) => { now += delay; resolve() },
  }) as Promise<void>
  return { result, listWorkflowRuns, listJobsForWorkflowRun, info, setOutput }
}

test('npm publication requires the CI gate, which queries the exact push commit and workflow', async () => {
  expect(workflow.jobs['publish-npm']?.needs).toContain('ci')
  const gate = execute([[run()]])
  await expect(gate.result).resolves.toBeUndefined()
  expect(gate.listWorkflowRuns).toHaveBeenCalledExactlyOnceWith({
    owner: 'Canonry', repo: 'canonry', workflow_id: 'ci.yml', head_sha: sha,
    branch: 'main', event: 'push', per_page: 100,
  })
  expect(gate.listJobsForWorkflowRun).toHaveBeenCalledExactlyOnceWith({
    owner: 'Canonry', repo: 'canonry', run_id: 10, filter: 'latest', per_page: 100,
  })
  expect(gate.info).toHaveBeenCalledWith(expect.stringContaining(`CI validate passed for ${sha}`))
  expect(gate.setOutput).toHaveBeenCalledExactlyOnceWith('run_id', '10')
})

test('the gate job in ci.yml covers the release checks and the artifact that npm publishes', () => {
  const validate = ciWorkflow.jobs.validate
  expect(validate).toBeDefined()
  // Actions reports a job without `name:` under its key, which the gate matches.
  expect(validate?.name).toBeUndefined()
  expect(validate?.needs).toEqual(expect.arrayContaining(['typecheck', 'test', 'lint', 'build', 'publish-smoke-test']))
  expect(validate?.needs).not.toContain('docker-build')
})

test('publication downloads the smoke-tested artifact from the authorized CI run', () => {
  const ci = workflow.jobs.ci!
  const gate = ci.steps!.find(step => step.name === 'Require successful CI for the release commit')!
  expect(gate.id).toBeTruthy()
  expect(ci.outputs?.run_id).toBe(`\${{ steps.${gate.id}.outputs.run_id }}`)
  const publish = workflow.jobs['publish-npm']!
  const download = publish.steps!.find(step => step.uses?.startsWith('actions/download-artifact@'))!
  expect(publish.permissions?.actions).toBe('read')
  expect(selectedArtifactRun(releaseContext({ ownerOnly: 'false', ciRunId: '12345' }))).toBe('12345')
  expect(download.with?.['github-token']).toBe('${{ github.token }}')
  expect(download.with?.name).toBe('canonry-package')
})

test('publication uses the shared owner policy with read-only classification permissions', () => {
  expect(workflow.jobs.policy?.uses).toBe('./.github/workflows/change-policy.yml')
  expect(workflow.jobs.policy?.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
  expect(workflow.on.push.paths).toContain('.github/workflows/change-policy.yml')
})

test('owner releases build and publish without validation or non-npm publication jobs', () => {
  const context = releaseContext()
  expect(jobEnabled('owner-build', context)).toBe(true)
  expect(jobEnabled('publish-npm', context)).toBe(true)
  expect(jobEnabled('publish-homebrew', context)).toBe(true)
  expect(selectedArtifactRun(context)).toBe(context.github.run_id)
  for (const name of ['plugin-drift', 'ci', 'publish-docker', 'publish-clawhub']) expect(jobEnabled(name, context)).toBe(false)

  const build = workflow.jobs['owner-build']!
  expect(build.needs).toEqual(['policy', 'version'])
  expect(build.steps?.some(step => step.uses === './.github/actions/setup')).toBe(true)
  expect(build.steps?.some(step => step.run === 'pnpm run build')).toBe(true)
  const commands = build.steps?.map(step => step.run ?? '').join('\n') ?? ''
  expect(commands).toContain('pnpm pack --pack-destination "$RUNNER_TEMP/canonry-package"')
  expect(commands).not.toMatch(/pnpm\s+(?:run\s+)?(?:test|lint|typecheck|verify|\S+:check)\b/)
  const upload = build.steps?.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  expect(upload?.with?.name).toBe('canonry-package')
  expect(upload?.with?.['if-no-files-found']).toBe('error')
})

test('outside contributions retain validation and publish the CI artifact with the owner build skipped', () => {
  const context = releaseContext({ ownerOnly: 'false' })
  for (const name of ['plugin-drift', 'ci', 'publish-npm', 'publish-homebrew', 'publish-docker', 'publish-clawhub']) {
    expect(jobEnabled(name, context), name).toBe(true)
  }
  expect(jobEnabled('owner-build', context)).toBe(false)
  expect(selectedArtifactRun(context)).toBe('10')
})

test.each(['failure', 'skipped', 'cancelled'] as const)('a %s owner package build cannot authorize npm', (result) => {
  expect(jobEnabled('publish-npm', releaseContext({ results: { 'owner-build': result } }))).toBe(false)
})

test.each(['plugin-drift', 'ci'])("outside publication cannot bypass a failed or missing %s gate", (name) => {
  for (const result of ['failure', 'skipped', 'cancelled'] as const) {
    const context = releaseContext({ ownerOnly: 'false', results: { [name]: result, 'owner-build': 'success' } })
    expect(jobEnabled('publish-npm', context), result).toBe(false)
  }
})

test('a successful outside CI gate without an artifact run id cannot authorize npm', () => {
  expect(jobEnabled('publish-npm', releaseContext({ ownerOnly: 'false', ciRunId: '' }))).toBe(false)
})

test.each(['true', 'false'])('publication fails closed for %s changes with failed classification or version metadata', (ownerOnly) => {
  for (const name of ['policy', 'version']) {
    for (const result of ['failure', 'skipped', 'cancelled'] as const) {
      expect(jobEnabled('publish-npm', releaseContext({ ownerOnly, results: { [name]: result } })), `${name}: ${result}`).toBe(false)
    }
  }
})

test.each(['', 'unknown'])('an unclassified owner_only output %j cannot authorize publication', (ownerOnly) => {
  const context = releaseContext({ ownerOnly, results: { 'owner-build': 'success', ci: 'success', 'plugin-drift': 'success' } })
  for (const name of ['owner-build', 'ci', 'publish-npm', 'publish-docker', 'publish-clawhub']) expect(jobEnabled(name, context)).toBe(false)
})

test.each(['true', 'false'])('npm and Brew only publish version-changing default-branch pushes for %s changes', (ownerOnly) => {
  for (const options of [{ versionChanged: 'false' }, { eventName: 'workflow_dispatch' }, { refName: 'feature' }, { cancelled: true }]) {
    const context = releaseContext({ ownerOnly, ...options })
    expect(jobEnabled('publish-npm', context)).toBe(false)
    expect(jobEnabled('publish-homebrew', context)).toBe(false)
  }
})

test.each(['failure', 'skipped', 'cancelled'] as const)('Brew cannot publish after a %s npm job', (result) => {
  expect(jobEnabled('publish-homebrew', releaseContext({ results: { 'publish-npm': result } }))).toBe(false)
})

test('manual Docker publication remains available only to outside contributions', () => {
  expect(jobEnabled('publish-docker', releaseContext({ ownerOnly: 'false', eventName: 'workflow_dispatch' }))).toBe(true)
  expect(jobEnabled('publish-docker', releaseContext({ eventName: 'workflow_dispatch' }))).toBe(false)
})

test('the gate waits for CI to appear and validate to complete', async () => {
  const inProgress = run({ status: 'in_progress', conclusion: null })
  const gate = execute([[], [inProgress], [inProgress]], [[], [job({ status: 'in_progress', conclusion: null })], [job()]])
  await expect(gate.result).resolves.toBeUndefined()
  expect(gate.listWorkflowRuns).toHaveBeenCalledTimes(4)
  expect(gate.setOutput).toHaveBeenCalledExactlyOnceWith('run_id', '10')
})

test('a failed Docker image build does not block npm when validate passed', async () => {
  const gate = execute([[run({ conclusion: 'failure' })]], [[job({ name: 'docker-build', conclusion: 'failure' }), job()]])
  await expect(gate.result).resolves.toBeUndefined()
  expect(gate.setOutput).toHaveBeenCalledExactlyOnceWith('run_id', '10')
})

test('the gate does not wait for jobs outside validate', async () => {
  const gate = execute(
    [[run({ status: 'in_progress', conclusion: null })]],
    [[job({ name: 'docker-build', status: 'in_progress', conclusion: null }), job()]],
  )
  await expect(gate.result).resolves.toBeUndefined()
  expect(gate.listWorkflowRuns).toHaveBeenCalledOnce()
})

test.each(['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', null])(
  'validate with conclusion %s cannot authorize publication', async (conclusion) => {
    const gate = execute([[run()]], [[job({ conclusion })]])
    await expect(gate.result).rejects.toThrow(`validate ended with ${conclusion}`)
    expect(gate.setOutput).not.toHaveBeenCalled()
  },
)

test('a completed CI run without a validate result fails without waiting', async () => {
  const gate = execute([[run({ conclusion: 'cancelled' })]], [[job({ name: 'typecheck', conclusion: 'cancelled' })]])
  await expect(gate.result).rejects.toThrow('CI 10 ended with cancelled and no completed validate job')
  expect(gate.listWorkflowRuns).toHaveBeenCalledOnce()
  expect(gate.setOutput).not.toHaveBeenCalled()
})

test.each([
  { head_sha: 'b'.repeat(40) },
  { head_branch: 'feature' },
  { event: 'pull_request' },
])('success for unrelated CI is refused: %j', async (overrides) => {
  const gate = execute([[run(overrides)]])
  await expect(gate.result).rejects.toThrow('Timed out')
  expect(gate.listJobsForWorkflowRun).not.toHaveBeenCalled()
})

test('an older success cannot override a newer failed CI run', async () => {
  const gate = execute([[run(), run({ id: 11, conclusion: 'failure' })]], [[job({ conclusion: 'failure' })]])
  await expect(gate.result).rejects.toThrow('CI 11 validate ended with failure')
  expect(gate.listJobsForWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 11 }))
})

test('missing CI times out and API errors fail publication', async () => {
  const missing = execute([[]])
  await expect(missing.result).rejects.toThrow('Timed out')
  expect(missing.listWorkflowRuns).toHaveBeenCalledTimes(100)
  await expect(execute([new Error('GitHub API unavailable')]).result).rejects.toThrow('GitHub API unavailable')
  await expect(execute([[run()]], [new Error('GitHub API unavailable')]).result).rejects.toThrow('GitHub API unavailable')
})

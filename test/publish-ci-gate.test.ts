import fs from 'node:fs'
import { Script } from 'node:vm'
import { expect, test, vi } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')) as {
  jobs: Record<string, {
    needs?: string[]
    outputs?: Record<string, string>
    permissions?: Record<string, string>
    steps?: { id?: string; name?: string; uses?: string; with?: Record<string, string> }[]
  }>
}
const ciWorkflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
  jobs: Record<string, { name?: string; needs?: string[] }>
}
const source = workflow.jobs.ci?.steps?.find(step => step.name === 'Require successful CI for the release commit')?.with?.script
if (!source) throw new Error('Missing publish CI gate')
const script = new Script(`(async () => { ${source} })()`)

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
  expect(download.with?.['run-id']).toBe('${{ needs.ci.outputs.run_id }}')
  expect(download.with?.['github-token']).toBe('${{ github.token }}')
  expect(download.with?.name).toBe('canonry-package')
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

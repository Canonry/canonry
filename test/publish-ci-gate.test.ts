import fs from 'node:fs'
import { Script } from 'node:vm'
import { expect, test, vi } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')) as {
  jobs: Record<string, { needs?: string[]; steps?: { name?: string; with?: { script?: string } }[] }>
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

const sha = 'a'.repeat(40)
const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 10, head_sha: sha, head_branch: 'main', event: 'push',
  status: 'completed', conclusion: 'success', html_url: 'https://github.com/Canonry/canonry/actions/runs/10',
  ...overrides,
})

function execute(responses: (WorkflowRun[] | Error)[]) {
  let now = 0
  let calls = 0
  const listWorkflowRuns = vi.fn(async () => {
    const response = responses[Math.min(calls++, responses.length - 1)]
    if (response instanceof Error) throw response
    return { data: { workflow_runs: response } }
  })
  const info = vi.fn()
  const result = script.runInNewContext({
    github: { rest: { actions: { listWorkflowRuns } } },
    context: { repo: { owner: 'Canonry', repo: 'canonry' }, sha, ref: 'refs/heads/main' },
    core: { info },
    Date: { now: () => now },
    setTimeout: (resolve: () => void, delay: number) => { now += delay; resolve() },
  }) as Promise<void>
  return { result, listWorkflowRuns, info }
}

test('npm publication requires the CI gate, which queries the exact push commit and workflow', async () => {
  expect(workflow.jobs['publish-npm']?.needs).toContain('ci')
  const gate = execute([[run()]])
  await expect(gate.result).resolves.toBeUndefined()
  expect(gate.listWorkflowRuns).toHaveBeenCalledExactlyOnceWith({
    owner: 'Canonry', repo: 'canonry', workflow_id: 'ci.yml', head_sha: sha,
    branch: 'main', event: 'push', per_page: 100,
  })
  expect(gate.info).toHaveBeenCalledWith(expect.stringContaining(`CI passed for ${sha}`))
})

test('the gate waits for CI to appear and complete', async () => {
  const gate = execute([[], [run({ status: 'in_progress', conclusion: null })], [run()]])
  await expect(gate.result).resolves.toBeUndefined()
  expect(gate.listWorkflowRuns).toHaveBeenCalledTimes(3)
})

test.each(['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', null])(
  'completed CI with conclusion %s cannot authorize publication', async (conclusion) => {
    await expect(execute([[run({ conclusion })]]).result).rejects.toThrow(`ended with ${conclusion}`)
  },
)

test.each([
  { head_sha: 'b'.repeat(40) },
  { head_branch: 'feature' },
  { event: 'pull_request' },
])('success for unrelated CI is refused: %j', async (overrides) => {
  await expect(execute([[run(overrides)]]).result).rejects.toThrow('Timed out')
})

test('an older success cannot override a newer failed CI run', async () => {
  await expect(execute([[run(), run({ id: 11, conclusion: 'failure' })]]).result).rejects.toThrow('CI 11 ended with failure')
})

test('missing CI times out and API errors fail publication', async () => {
  const missing = execute([[]])
  await expect(missing.result).rejects.toThrow('Timed out')
  expect(missing.listWorkflowRuns).toHaveBeenCalledTimes(100)
  await expect(execute([new Error('GitHub API unavailable')]).result).rejects.toThrow('GitHub API unavailable')
})

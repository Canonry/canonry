import fs from 'node:fs'
import { Script } from 'node:vm'
import { expect, test, vi } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/change-policy.yml', import.meta.url), 'utf8')) as {
  on: { workflow_call: { outputs: Record<string, { value: string }> } }
  jobs: Record<string, {
    permissions: Record<string, string>
    outputs: Record<string, string>
    steps: { id?: string; uses?: string; with?: { script?: string } }[]
  }>
}
const source = workflow.jobs.classify?.steps.find(step => step.id === 'policy')?.with?.script
if (!source) throw new Error('Missing change classification script')
const script = new Script(`(async () => { ${source} })()`)
const sha = 'a'.repeat(40)
const before = 'b'.repeat(40)
const second = 'c'.repeat(40)
const owner = { id: 14798762, type: 'User' }
const external = { id: 42, type: 'User' }
const repository = { id: 123, full_name: 'Canonry/canonry' }

interface Commit {
  sha: string
  author: { id: number; type: string } | null
}

interface Pull {
  number: number
  user: { id: number; type: string }
  commits: number
  head: { sha: string; repo: { id: number; full_name: string } }
  base: { repo: { id: number; full_name: string } }
}

const commit = (commitSha = sha, author: Commit['author'] = owner): Commit => ({ sha: commitSha, author })
const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 1, user: owner, commits: 1, head: { sha, repo: repository }, base: { repo: repository }, ...overrides,
})
const comparison = (commits = [commit()]) => ({
  status: 'ahead', base_commit: { sha: before }, merge_base_commit: { sha: before },
  total_commits: commits.length, commits,
})

interface Options {
  eventName?: string
  payload?: Record<string, unknown>
  comparison?: Record<string, unknown> | Error
  pulls?: (Pull | Error)[]
  commits?: Commit[] | Error
  associated?: Record<string, (Pull[] | Error)>
  exactCommit?: Commit | Error
}

function execute(options: Options = {}) {
  const eventName = options.eventName ?? 'push'
  const eventPull = pull()
  const payload = {
    repository, sender: owner, before, after: sha, forced: false, deleted: false,
    ...(eventName === 'pull_request' ? { pull_request: eventPull } : {}),
    ...options.payload,
  }
  const pullResponses = options.pulls
  let reads = 0
  const get = vi.fn(async (params: { pull_number: number }) => {
    const response = pullResponses?.[Math.min(reads++, pullResponses.length - 1)] ?? pull({ number: params.pull_number })
    if (response instanceof Error) throw response
    return { data: response }
  })
  const listCommits = vi.fn(async () => {
    const response = options.commits ?? [commit()]
    if (response instanceof Error) throw response
    return { data: response }
  })
  const compareCommitsWithBasehead = vi.fn(async () => {
    const response = options.comparison ?? comparison()
    if (response instanceof Error) throw response
    return { data: response }
  })
  const listPullRequestsAssociatedWithCommit = vi.fn(async (params: { commit_sha: string }) => {
    const response = options.associated?.[params.commit_sha] ?? []
    if (response instanceof Error) throw response
    return { data: response }
  })
  const getCommit = vi.fn(async () => {
    const response = options.exactCommit ?? commit()
    if (response instanceof Error) throw response
    return { data: response }
  })
  const info = vi.fn()
  const setOutput = vi.fn()
  const result = script.runInNewContext({
    github: { rest: { pulls: { get, listCommits }, repos: { compareCommitsWithBasehead, listPullRequestsAssociatedWithCommit, getCommit } } },
    context: { eventName, payload, sha, repo: { owner: 'Canonry', repo: 'canonry' }, actor: 'arberx', triggering_actor: 'arberx' },
    core: { info, setOutput },
  }) as Promise<void>
  return { result, info, setOutput, get, listCommits, compareCommitsWithBasehead, listPullRequestsAssociatedWithCommit, getCommit }
}

async function classified(options: Options, expected: boolean) {
  const execution = execute(options)
  await expect(execution.result).resolves.toBeUndefined()
  expect(execution.setOutput).toHaveBeenCalledExactlyOnceWith('owner_only', String(expected))
  return execution
}

test('the reusable policy exposes owner_only and reads metadata without contributor checkout or write permissions', () => {
  const job = workflow.jobs.classify!
  expect(workflow.on.workflow_call.outputs.owner_only?.value).toBe('${{ jobs.classify.outputs.owner_only }}')
  expect(job.outputs.owner_only).toBe('${{ steps.policy.outputs.owner_only }}')
  expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
  expect(job.steps).toHaveLength(1)
  expect(job.steps[0]?.uses).toBe('actions/github-script@v8')
})

test('an owner direct push skips CI only after inspecting the complete exact commit range and provenance', async () => {
  const execution = await classified({}, true)
  expect(execution.compareCommitsWithBasehead).toHaveBeenCalledExactlyOnceWith({
    owner: 'Canonry', repo: 'canonry', basehead: `${before}...${sha}`, per_page: 100, page: 1,
  })
  expect(execution.listPullRequestsAssociatedWithCommit).toHaveBeenCalledExactlyOnceWith({
    owner: 'Canonry', repo: 'canonry', commit_sha: sha, per_page: 100, page: 1,
  })
})

test('a same-repository owner PR skips only with its exact head and complete exclusively owner-authored commits', async () => {
  const execution = await classified({ eventName: 'pull_request' }, true)
  expect(execution.get).toHaveBeenCalledTimes(2)
  expect(execution.listCommits).toHaveBeenCalledExactlyOnceWith({ owner: 'Canonry', repo: 'canonry', pull_number: 1, per_page: 100, page: 1 })
})

test('owner squash merges retain source-PR commit inspection', async () => {
  const sourcePull = pull({ head: { sha: second, repo: repository }, commits: 2 })
  const execution = await classified({
    associated: { [sha]: [sourcePull] }, pulls: [sourcePull], commits: [commit(before), commit(second)],
  }, true)
  expect(execution.listCommits).toHaveBeenCalledOnce()
})

test.each([
  ['merge', [commit(second, external), commit()]],
  ['squash', [commit()]],
  ['rebase', [commit(sha, external)]],
] as const)('an owner %s of an outside PR still runs full CI', async (_strategy, commits) => {
  const outside = pull({ user: external })
  const execution = await classified({ comparison: comparison([...commits]), associated: { [sha]: [outside] }, pulls: [outside] }, false)
  expect(execution.compareCommitsWithBasehead).toHaveBeenCalledOnce()
  expect(execution.listCommits).not.toHaveBeenCalled()
})

test('an outside PR remains external when the owner synchronizes or reruns its workflow', async () => {
  const execution = await classified({ eventName: 'pull_request', payload: { pull_request: pull({ user: external }) } }, false)
  expect(execution.get).not.toHaveBeenCalled()
})

test.each([external, { ...owner, type: 'Bot' }, null])('an owner PR synchronized by an outside or bot sender runs full CI: %j', async (sender) => {
  const execution = await classified({ eventName: 'pull_request', payload: { sender } }, false)
  expect(execution.get).not.toHaveBeenCalled()
})

test.each([external, null])('owner PRs containing outside or unknown commit authors run full CI: %j', async (author) => {
  await classified({ eventName: 'pull_request', commits: [commit(sha, author)] }, false)
})

test('an owner squash of their mixed-author PR runs full CI even when the squash commit author is the owner', async () => {
  const mixed = pull({ commits: 2 })
  await classified({ associated: { [sha]: [mixed] }, pulls: [mixed], commits: [commit(second, external), commit()] }, false)
})

test('every pushed commit is inspected; an earlier outside origin cannot hide behind an owner head', async () => {
  await classified({ comparison: comparison([commit(second, external), commit()]) }, false)
  const outside = pull({ user: external })
  const execution = await classified({
    comparison: comparison([commit(second), commit()]), associated: { [second]: [outside] }, pulls: [outside],
  }, false)
  expect(execution.listPullRequestsAssociatedWithCommit).toHaveBeenCalledWith(expect.objectContaining({ commit_sha: second }))
})

test.each([external, { ...owner, type: 'Bot' }, { ...external, login: 'arberx' }, null])(
  'an outside, bot, spoofed-login or missing push sender cannot bypass CI: %j', async (sender) => {
    const execution = await classified({ payload: { sender } }, false)
    expect(execution.compareCommitsWithBasehead).not.toHaveBeenCalled()
  },
)

test.each([
  { forced: true }, { deleted: true }, { forced: undefined }, { deleted: undefined }, { before: '0'.repeat(40) },
  { before: 'main' }, { after: second },
])('unknown, forced or stale push ranges run full CI: %j', async (payload) => {
  await classified({ payload }, false)
})

test.each([
  { status: 'diverged' }, { merge_base_commit: { sha: second } }, { base_commit: { sha: second } },
  { total_commits: 2 }, { total_commits: 101 }, { total_commits: 0 }, { commits: [commit(second)] },
])('incomplete or unrelated compare metadata runs full CI: %j', async (override) => {
  await classified({ comparison: { ...comparison(), ...override } }, false)
})

test('a full associated-PR page cannot silently hide outside provenance', async () => {
  await classified({ associated: { [sha]: Array.from({ length: 100 }, () => pull()) } }, false)
})

test('the same introducing owner PR is verified once for a multi-commit push', async () => {
  const sourcePull = pull()
  const execution = await classified({
    comparison: comparison([commit(second), commit()]), associated: { [second]: [sourcePull], [sha]: [sourcePull] },
  }, true)
  expect(execution.get).toHaveBeenCalledTimes(2)
  expect(execution.listCommits).toHaveBeenCalledOnce()
  expect(execution.listPullRequestsAssociatedWithCommit).toHaveBeenCalledTimes(2)
})

test('the metadata request budget is bounded and exhaustion retains full CI', async () => {
  const commits = Array.from({ length: 100 }, (_, index) => commit(index === 99 ? sha : index.toString(16).padStart(40, '0')))
  const associated = Object.fromEntries(commits.map((entry, index) => [entry.sha, [pull({ number: index + 1 })]]))
  const execution = await classified({ comparison: comparison(commits), associated }, false)
  const requests = execution.compareCommitsWithBasehead.mock.calls.length + execution.get.mock.calls.length +
    execution.listCommits.mock.calls.length + execution.listPullRequestsAssociatedWithCommit.mock.calls.length
  expect(requests).toBe(120)
  expect(execution.info).toHaveBeenCalledWith(expect.stringContaining('Metadata request limit reached'))
})

test.each([
  pull({ commits: 2 }), pull({ commits: 101 }), pull({ head: { sha: second, repo: repository } }),
  pull({ head: { sha, repo: { ...repository, id: 456 } } }),
  pull({ head: { sha, repo: { ...repository, full_name: 'arberx/canonry' } } }),
  pull({ user: external }),
])('incomplete, stale, forked or changed PR metadata runs full CI: %j', async (current) => {
  await classified({ eventName: 'pull_request', pulls: [current] }, false)
})

test('a PR head change while metadata is read cannot reuse an owner classification', async () => {
  await classified({ eventName: 'pull_request', pulls: [pull(), pull({ head: { sha: second, repo: repository } })] }, false)
})

test.each([
  { comparison: new Error('compare unavailable') },
  { associated: { [sha]: new Error('provenance unavailable') } },
  { eventName: 'pull_request', pulls: [new Error('pull unavailable')] },
  { eventName: 'pull_request', commits: new Error('commits unavailable') },
])('API failures conservatively run full CI: %j', async (options) => {
  const execution = await classified(options, false)
  expect(execution.info).toHaveBeenCalledWith(expect.stringContaining('full contributor checks apply'))
})

test('manual owner dispatch uses the exact dispatched SHA and introducing PR provenance', async () => {
  const execution = await classified({ eventName: 'workflow_dispatch' }, true)
  expect(execution.getCommit).toHaveBeenCalledExactlyOnceWith({ owner: 'Canonry', repo: 'canonry', ref: sha })
  const outside = pull({ user: external })
  await classified({ eventName: 'workflow_dispatch', associated: { [sha]: [outside] }, pulls: [outside] }, false)
  await classified({ eventName: 'workflow_dispatch', payload: { sender: external } }, false)
  await classified({ eventName: 'workflow_dispatch', exactCommit: commit(second) }, false)
})

test('unsupported events retain full contributor behavior', async () => {
  await classified({ eventName: 'schedule' }, false)
})

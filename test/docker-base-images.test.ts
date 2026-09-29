import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pullScript = path.join(repoRoot, 'scripts/pull-docker-base-images.sh')
const ecrNode = 'public.ecr.aws/docker/library/node:22-bookworm-slim'
const hubNode = 'docker.io/library/node:22-bookworm-slim'

// Records every call and fails `docker pull <ref>` as many times as the state
// file for <ref> says ("always" never succeeds). `sleep` only records.
const fakeDocker = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
if [ "$1" = pull ]; then
  state="$FAKE_STATE/$(printf %s "\${!#}" | tr '/:@' '___')"
  failures=$(cat "$state" 2>/dev/null || echo 0)
  if [ "$failures" = always ]; then echo "429 Too Many Requests" >&2; exit 1; fi
  if [ "$failures" -gt 0 ]; then echo $((failures - 1)) > "$state"; echo "429 Too Many Requests" >&2; exit 1; fi
fi
`
const fakeSleep = `#!/usr/bin/env bash
echo "sleep $*" >> "$FAKE_LOG"
`

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function pull(dockerfile: string, failures: Record<string, number | 'always'> = {}, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-base-images-'))
  tempDirs.push(dir)
  const bin = path.join(dir, 'bin')
  const state = path.join(dir, 'state')
  const log = path.join(dir, 'calls.log')
  fs.mkdirSync(bin)
  fs.mkdirSync(state)
  fs.writeFileSync(path.join(bin, 'docker'), fakeDocker, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'sleep'), fakeSleep, { mode: 0o755 })
  for (const [ref, count] of Object.entries(failures)) {
    fs.writeFileSync(path.join(state, ref.replace(/[/:@]/g, '_')), String(count))
  }
  fs.writeFileSync(path.join(dir, 'Dockerfile'), dockerfile)
  const result = spawnSync('bash', [pullScript, path.join(dir, 'Dockerfile')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: log, FAKE_STATE: state, ...env },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
  return { status: result.status, stdout: result.stdout, calls }
}

test('every workflow image build pulls its base images first and keeps using the local copies', () => {
  let builds = 0
  for (const name of ['ci.yml', 'publish.yml']) {
    const workflow = parse(fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8')) as {
      jobs: Record<string, { steps?: { run?: string; uses?: string; with?: Record<string, unknown> }[] }>
    }
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? []
      steps.forEach((step, index) => {
        if (!step.uses?.startsWith('docker/build-push-action@')) return
        builds++
        const dockerfile = path.normalize(String(step.with?.file ?? 'Dockerfile'))
        const prePull = steps.slice(0, index).find(earlier => earlier.run?.trim() === `bash scripts/pull-docker-base-images.sh ${dockerfile}`)
        expect(prePull, `${name} ${jobName}`).toBeDefined()
        // `pull: true` would re-resolve FROM against the registry and bypass the pulled copy.
        expect(step.with?.pull, `${name} ${jobName}`).toBeFalsy()
      })
    }
  }
  expect(builds).toBe(2)
})

test('the repository Dockerfile pulls its ECR base image once', () => {
  const result = pull(fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8'))
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([`docker pull --quiet ${ecrNode}`])
})

test('stages, scratch, flags, and repeated images are not pulled', () => {
  const result = pull([
    `FROM --platform=$BUILDPLATFORM ${ecrNode} AS build`,
    'FROM build AS test',
    'from nginx:alpine as web',
    'FROM scratch',
    `FROM ${ecrNode}`,
    'COPY --from=build /app /app',
  ].join('\n'))
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([`docker pull --quiet ${ecrNode}`, 'docker pull --quiet nginx:alpine'])
})

test('an ECR 429 falls back to the same Docker Official Image on Docker Hub', () => {
  const result = pull(`FROM ${ecrNode}`, { [ecrNode]: 1 })
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([
    `docker pull --quiet ${ecrNode}`,
    `docker pull --quiet ${hubNode}`,
    `docker tag ${hubNode} ${ecrNode}`,
  ])
  expect(result.stdout).toContain(`Pulled ${hubNode} and tagged it ${ecrNode}`)
})

test('retries with exponential backoff until a pull succeeds', () => {
  const result = pull(`FROM ${ecrNode}`, { [ecrNode]: 2, [hubNode]: 'always' })
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([
    `docker pull --quiet ${ecrNode}`, `docker pull --quiet ${hubNode}`, 'sleep 10',
    `docker pull --quiet ${ecrNode}`, `docker pull --quiet ${hubNode}`, 'sleep 20',
    `docker pull --quiet ${ecrNode}`,
  ])
})

test('gives up with an error after the attempt limit', () => {
  const result = pull(`FROM ${ecrNode}`, { [ecrNode]: 'always', [hubNode]: 'always' }, { PULL_ATTEMPTS: '2' })
  expect(result.status).toBe(1)
  expect(result.calls).toEqual([
    `docker pull --quiet ${ecrNode}`, `docker pull --quiet ${hubNode}`, 'sleep 10',
    `docker pull --quiet ${ecrNode}`, `docker pull --quiet ${hubNode}`,
  ])
  expect(result.stdout).toContain(`::error::Could not pull ${ecrNode} or ${hubNode} after 2 attempts`)
})

test('images outside ECR Public\'s Docker library retry without a fallback', () => {
  const result = pull('FROM nginx:alpine', { 'nginx:alpine': 1 })
  expect(result.status).toBe(0)
  expect(result.calls).toEqual(['docker pull --quiet nginx:alpine', 'sleep 10', 'docker pull --quiet nginx:alpine'])
})

test('a base image chosen by a build argument fails before any pull', () => {
  const result = pull('ARG BASE\nFROM ${BASE}')
  expect(result.status).toBe(1)
  expect(result.calls).toEqual([])
  expect(result.stdout).toContain('::error::Cannot pull ${BASE} before the build')
})

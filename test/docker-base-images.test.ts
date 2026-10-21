import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pullScript = path.join(repoRoot, 'scripts/pull-docker-base-images.sh')
const ecrNode = 'public.ecr.aws/docker/library/node:26.12.1-bookworm-slim@sha256:1e96b01216cab31612cd1f9480e83413472dee8686d423cb4c1ec62bf8a26e9e'
const hubNode = 'docker.io/library/node:26.12.1-bookworm-slim@sha256:1e96b01216cab31612cd1f9480e83413472dee8686d423cb4c1ec62bf8a26e9e'

// Records every call and fails `docker pull <ref>` as many times as the state
// file for <ref> says ("always" never succeeds). Like Docker, `docker tag`
// refuses a target that contains a digest. `sleep` only records.
const fakeDocker = `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
if [ "$1" = tag ] && [[ "\${!#}" == *@* ]]; then echo "refusing to create a tag with a digest reference" >&2; exit 1; fi
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
  const file = path.join(dir, 'Dockerfile')
  fs.writeFileSync(file, dockerfile)
  const result = spawnSync('bash', [pullScript, file], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: log, FAKE_STATE: state, ...env },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
  return { status: result.status, stdout: result.stdout, calls, dockerfile: fs.readFileSync(file, 'utf8') }
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

test('the repository Dockerfile pulls its ECR base image once and stays unchanged', () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')
  const result = pull(dockerfile)
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([`docker pull --quiet ${ecrNode}`])
  expect(result.dockerfile).toBe(dockerfile)
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

test('an ECR failure points every FROM of that image at the same Docker Official Image on Docker Hub', () => {
  const ecrNginx = 'public.ecr.aws/docker/library/nginx:alpine'
  const hubNginx = 'docker.io/library/nginx:alpine'
  const result = pull([
    '# syntax=docker/dockerfile:1',
    `FROM --platform=$BUILDPLATFORM ${ecrNode} AS build`,
    `RUN echo ${ecrNode}`,
    `FROM ${ecrNginx} AS web`,
    `FROM ${ecrNode}`,
    'COPY --from=build /app /app',
    '',
  ].join('\n'), { [ecrNode]: 1, [ecrNginx]: 1 })
  expect(result.status, result.stdout).toBe(0)
  expect(result.calls).toEqual([
    `docker pull --quiet ${ecrNode}`, `docker pull --quiet ${hubNode}`,
    `docker pull --quiet ${ecrNginx}`, `docker pull --quiet ${hubNginx}`,
  ])
  // A digest-pinned FROM cannot be retagged, so the build reads the Docker Hub
  // reference itself, for tagged images too. Lines other than FROM are unchanged.
  expect(result.dockerfile).toBe([
    '# syntax=docker/dockerfile:1',
    `FROM --platform=$BUILDPLATFORM ${hubNode} AS build`,
    `RUN echo ${ecrNode}`,
    `FROM ${hubNginx} AS web`,
    `FROM ${hubNode}`,
    'COPY --from=build /app /app',
    '',
  ].join('\n'))
  expect(result.stdout).toContain(`Pulled ${hubNode};`)
})

test('retries with exponential backoff until a pull succeeds', () => {
  const result = pull(`FROM ${ecrNode}`, { [ecrNode]: 2, [hubNode]: 'always' })
  expect(result.status).toBe(0)
  expect(result.calls).toEqual([
    `docker pull --quiet ${ecrNode}`, `docker pull --quiet ${hubNode}`, 'sleep 10',
    `docker pull --quiet ${ecrNode}`, `docker pull --quiet ${hubNode}`, 'sleep 20',
    `docker pull --quiet ${ecrNode}`,
  ])
  expect(result.dockerfile).toBe(`FROM ${ecrNode}`)
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

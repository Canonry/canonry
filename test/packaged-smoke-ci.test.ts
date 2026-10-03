import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

interface Step {
  name?: string
  id?: string
  run?: string
  uses?: string
  if?: string
  'continue-on-error'?: boolean
  env?: Record<string, string>
  with?: Record<string, string>
}
const workflow = parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
  jobs: Record<string, { needs?: string | string[]; steps: Step[] }>
}
const smokeJob = workflow.jobs['publish-smoke-test']!
const install = smokeJob.steps.find(step => step.name === 'Install canonry from tarball into scratch project')!
const smoke = smokeJob.steps.find(step => step.name === 'Run synthetic packaged sentiment scenario')!
const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function fixture(tarballs = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-smoke-ci-'))
  temporary.push(root)
  const cwd = path.join(root, 'source checkout')
  const runner = path.join(root, 'runner temp')
  const bin = path.join(root, 'bin')
  for (const dir of [cwd, bin, path.join(runner, 'canonry-package')]) fs.mkdirSync(dir, { recursive: true })
  for (let index = 0; index < tarballs; index++) fs.writeFileSync(path.join(runner, 'canonry-package', `candidate-${index}.tgz`), '')
  const writeCommand = (name: string, script: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${script}`, { mode: 0o755 })
  writeCommand('npm', `printf '%s\\n' "$PWD|$*" >> "$NPM_LOG"
if [ "$1" = install ]; then
  mkdir -p node_modules/.bin node_modules/@canonry/canonry
  printf '#!/bin/bash\\necho 0.0.0\\n' > node_modules/.bin/canonry
  chmod +x node_modules/.bin/canonry
fi`)
  writeCommand('pnpm', 'printf \'%s\\n\' "$@" > "$SMOKE_ARGS"\nexit "${SMOKE_EXIT:-0}"')
  const output = path.join(root, 'output')
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: runner, GITHUB_OUTPUT: output, NPM_LOG: path.join(root, 'npm.log'), SMOKE_ARGS: path.join(root, 'args') }
  const run = (script: string, overrides: Record<string, string> = {}) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' })
  return { cwd, runner, env, output, run }
}

test('packaged scenario consumes the build artifact installed outside the checkout', () => {
  expect(smokeJob.needs).toBe('build')
  const uploaded = workflow.jobs.build!.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))!
  const downloaded = smokeJob.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))!
  expect(downloaded.with?.name).toBe(uploaded.with?.name)
  const context = fixture()
  const result = context.run(install.run!)
  expect(result.status, result.stderr).toBe(0)
  const packageRoot = fs.readFileSync(context.output, 'utf8').trim().split('=')[1]!
  expect(packageRoot.startsWith(`${context.runner}/`)).toBe(true)
  expect(packageRoot.startsWith(`${context.cwd}/`)).toBe(false)
  expect(fs.readFileSync(context.env.NPM_LOG, 'utf8')).toContain(`|install ${context.runner}/canonry-package/candidate-0.tgz`)
  expect(smoke.env?.CANONRY_SMOKE_PACKAGE_ROOT).toBe(`\${{ steps.${install.id}.outputs.package_root }}`)
  expect(smoke.env?.TMPDIR).toBe('${{ runner.temp }}')
  expect(context.run(smoke.run!, { CANONRY_SMOKE_PACKAGE_ROOT: packageRoot, TMPDIR: context.runner }).status).toBe(0)
  expect(fs.readFileSync(context.env.SMOKE_ARGS, 'utf8').trim().split('\n')).toEqual(['exec', 'tsx', 'scripts/smoke-sentiment.mjs', '--package-root', packageRoot])
})

test.each([0, 2])('installation refuses %i candidate tarballs', count => {
  const context = fixture(count)
  const result = context.run(install.run!)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Expected exactly one Canonry package tarball')
  expect(fs.existsSync(context.env.NPM_LOG)).toBe(false)
  expect(fs.existsSync(context.output)).toBe(false)
})

test('a scenario failure fails validate, including cancelled or skipped smoke jobs', () => {
  expect(smoke.if).toBeUndefined()
  expect(smoke['continue-on-error']).toBeUndefined()
  expect(workflow.jobs.validate!.needs).toContain('publish-smoke-test')
  const context = fixture()
  expect(context.run(smoke.run!, { SMOKE_EXIT: '9', CANONRY_SMOKE_PACKAGE_ROOT: '/candidate' }).status).toBe(9)
  const gate = workflow.jobs.validate!.steps.find(step => step.name === 'Verify all validate jobs succeeded')!.run!
  for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
    const script = gate.replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, job: string) => job === 'publish-smoke-test' ? result : 'success')
    expect(context.run(script).status).toBe(result === 'success' ? 0 : 1)
  }
})

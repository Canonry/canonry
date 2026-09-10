/**
 * Build-time helper: the git commit the bundle is built from.
 *
 * `packages/canonry/tsup.config.ts` stamps the result into the bundle as
 * `__CANONRY_BUILD_COMMIT__` so a running engine can report it at GET /health
 * (`commit`). Resolution must never fail the build: a machine without a git
 * binary, a build from an npm tarball, or a vendored copy outside any
 * repository all yield `undefined`, and the server then falls back to the
 * `CANONRY_COMMIT` env var at runtime (see `src/instance-identity.ts`).
 */
import { execFileSync } from 'node:child_process'

/** sha1 (40 hex) today; sha256 repositories produce 64. */
const SHA_PATTERN = /^[0-9a-f]{40,64}$/

export interface ReadGitCommitOptions {
  /** Directory to resolve HEAD from. Defaults to the process cwd. */
  cwd?: string
  /** Environment for the git child process (PATH lookup included). Defaults to the process env. */
  env?: NodeJS.ProcessEnv
}

export function readGitCommit(opts: ReadGitCommitOptions = {}): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: opts.cwd,
      env: opts.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim()
    return SHA_PATTERN.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

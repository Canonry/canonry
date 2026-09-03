/**
 * Self-identification for a running engine, surfaced by GET /health.
 *
 * `commit`: the git sha the bundle was built from. tsup stamps it in at build
 * time as `__CANONRY_BUILD_COMMIT__` (see `../tsup.config.ts` and
 * `../scripts/build-commit.ts`). The identifier is undefined when the build
 * ran without git or when the source runs unbundled (tsx, vitest); the
 * runtime then falls back to `CANONRY_COMMIT`, and omits the field when that
 * is unset too.
 *
 * `instance`: which deployment this is, purely from the runtime environment.
 * `CANONRY_INSTANCE` names it; `CANONRY_INSTANCE_ROLE` says what kind it is.
 * Role is free text so an operator can tag a one-off without a code change;
 * the convention is `internal | client-demo | client-trial | preview`
 * (documented in AGENTS.md under "Health endpoint").
 */
declare const __CANONRY_BUILD_COMMIT__: string | undefined

export interface InstanceIdentity {
  name: string
  role?: string
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** Build-time stamp first, `CANONRY_COMMIT` second, otherwise undefined. */
export function resolveBuildCommit(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // `typeof` on an undeclared global is safe; a bare read would throw when
  // the define is absent.
  const embedded = typeof __CANONRY_BUILD_COMMIT__ === 'string' ? __CANONRY_BUILD_COMMIT__ : undefined
  return nonBlank(embedded) ?? nonBlank(env.CANONRY_COMMIT)
}

/** Undefined when `CANONRY_INSTANCE` is unset or blank, so /health omits the field entirely. */
export function resolveInstanceIdentity(env: NodeJS.ProcessEnv = process.env): InstanceIdentity | undefined {
  const name = nonBlank(env.CANONRY_INSTANCE)
  if (!name) return undefined
  const role = nonBlank(env.CANONRY_INSTANCE_ROLE)
  return role ? { name, role } : { name }
}

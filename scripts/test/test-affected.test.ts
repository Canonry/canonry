import { describe, expect, it } from 'vitest'

import { planAffectedTestProjects } from '../test-affected.mjs'

const workspaces = [
  { dependencies: [], directory: 'packages/contracts', name: '@canonry/contracts', project: 'contracts' },
  { dependencies: ['@canonry/contracts'], directory: 'packages/db', name: '@canonry/db', project: 'db' },
  { dependencies: ['@canonry/db'], directory: 'apps/api', name: '@canonry/api', project: 'api' },
  { dependencies: [], directory: 'packages/wordpress-traffic-logger-plugin', name: '@canonry/wordpress', project: null },
]

describe('planAffectedTestProjects', () => {
  it('includes changed or deleted workspaces and their downstream dependents', () => {
    expect(planAffectedTestProjects(['packages/contracts/src/index.ts'], workspaces)).toEqual({
      mode: 'projects',
      projects: ['api', 'contracts', 'db'],
    })
  })

  it('falls back to the full suite for shared runtime and test configuration', () => {
    expect(planAffectedTestProjects(['vitest.config.ts'], workspaces)).toMatchObject({ mode: 'full' })
    expect(planAffectedTestProjects(['scripts/check-node.mjs'], workspaces)).toMatchObject({ mode: 'full' })
  })

  it('does not run Vitest for docs or the separately validated PHP plugin', () => {
    expect(planAffectedTestProjects(['docs/testing.md'], workspaces)).toEqual({ mode: 'none' })
    expect(planAffectedTestProjects(['packages/wordpress-traffic-logger-plugin/plugin/logger.php'], workspaces)).toEqual({ mode: 'none' })
  })

  it('fails closed for an unclassified path', () => {
    expect(planAffectedTestProjects(['unknown-source/file.ts'], workspaces)).toMatchObject({ mode: 'full' })
  })
})

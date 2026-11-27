import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Guard: every component reachable as the `/setup` route must emit onboarding
 * telemetry.
 *
 * This is the check that was missing. A redesign repointed `/setup` from the
 * instrumented `SetupPage` to a new `OnboardingSetupPage` with zero emit call
 * sites, and because the new surface took every install with NO projects, the
 * flow went blind for exactly the first-run user onboarding exists to measure. Every suite stayed green: nothing asserted
 * that the route's component was instrumented, and the only coverage naming a
 * run-step event was a schema-shape check in the contracts package.
 *
 * Source-level rather than behavioural on purpose. The failure mode is "a page
 * emits nothing", which a render test can only catch for the surfaces someone
 * remembered to render.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

function read(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf8')
}

const TELEMETRY_MODULE = 'onboarding-telemetry'

describe('onboarding surfaces are instrumented', () => {
  it('routes /setup to a component that emits onboarding telemetry', () => {
    const routes = read('router/routes.tsx')
    const setupRoute = /path:\s*'\/setup',\s*component:\s*(\w+)/.exec(routes)

    expect(setupRoute, 'the /setup route should declare a component').not.toBeNull()
    const componentName = setupRoute![1]!

    const importLine = new RegExp(
      `import\\s*\\{[^}]*\\b${componentName}\\b[^}]*\\}\\s*from\\s*'([^']+)'`,
    ).exec(routes)
    expect(importLine, `${componentName} should be imported in routes.tsx`).not.toBeNull()

    const modulePath = importLine![1]!
      .replace(/^\.\.\//, '')
      .replace(/\.js$/, '.tsx')
    expect(read(modulePath)).toContain(TELEMETRY_MODULE)
  })

  it('instruments every onboarding surface the setup page can render', () => {
    // A surface that renders no telemetry is invisible in the funnel, and the
    // funnel then describes only the surfaces that do — which reads as data
    // rather than as a gap.
    for (const page of ['pages/OnboardingSetupPage.tsx', 'pages/ProjectSetupTracker.tsx', 'pages/SetupPage.tsx', 'components/setup/AiVisibilitySetupPanel.tsx']) {
      expect(read(page), `${page} should emit onboarding telemetry`).toContain(TELEMETRY_MODULE)
    }
  })

  it('tags each surface so two different funnels never pool into one number', () => {
    // The rescue wizard is its own funnel; the website form and the project's
    // tracker it opens are one first-run funnel.
    expect(read('pages/SetupPage.tsx')).toContain("surface: 'wizard'")
    expect(read('pages/OnboardingSetupPage.tsx')).toContain("useOnboardingTelemetry('platform')")
    expect(read('pages/ProjectSetupTracker.tsx')).toContain("useOnboardingTelemetry('platform')")
    // The tracker's AI Visibility panel reports where the check's outcome lands: the wizard funnel.
    expect(read('components/setup/AiVisibilitySetupPanel.tsx')).toContain("useOnboardingTelemetry('wizard')")
  })

  it('keeps the run step recordable after a reload, and scoped to one project', () => {
    // The success branch needs the component mounted when the run lands; the
    // failure branch does not. Persisting the launched run is what stops the
    // funnel from being able to record only failures. The marker is read BY
    // PROJECT so a run launched for one project is never reported against
    // another's onboarding, and marked handled so a remount cannot re-report it.
    const setup = read('pages/SetupPage.tsx')
    expect(setup).toContain("markOnboardingRunLaunched(createdProjectName, run.id, RunKinds['answer-visibility'])")
    expect(setup).toContain('readOnboardingLaunchedRun(resumeProjectName)')
    expect(setup).toContain('markOnboardingRunHandled')
  })
})

import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { UiTelemetryEvent } from '@canonry/canonry-contracts'
import { GraphRenderBoundary } from '../src/components/project/SiteGraphSigma.js'
import { configureUiTelemetry, resetUiTelemetryForTests, setUiPageFromRoute } from '../src/lib/ui-telemetry.js'

afterEach(() => {
  cleanup()
  resetUiTelemetryForTests()
  vi.restoreAllMocks()
})

function Exploding(): never {
  throw new RangeError('WebGL context lost while drawing https://acme-secret.example/page')
}

test('a site-graph render failure reports ui.error with the boundary slug and class name only', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const sent: UiTelemetryEvent[] = []
  configureUiTelemetry({ send: async (event) => { sent.push(event); return { accepted: true } } })
  setUiPageFromRoute('/projects/$projectName/agent-readiness')

  render(
    <GraphRenderBoundary fallback={<p>Map unavailable</p>} resetToken={0}>
      <Exploding />
    </GraphRenderBoundary>,
  )

  expect(screen.getByText('Map unavailable')).toBeTruthy()
  const errors = sent.filter(e => e.event === 'ui.error')
  expect(errors).toEqual([expect.objectContaining({
    event: 'ui.error',
    kind: 'render',
    component: 'site-graph',
    errorName: 'RangeError',
    page: '/projects/:projectName/agent-readiness',
    tab: 'agent-readiness',
  })])
  expect(JSON.stringify(sent)).not.toContain('acme-secret')
  expect(JSON.stringify(sent)).not.toContain('WebGL')
})

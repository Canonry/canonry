import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'

import { SiteGraphSigma } from '../src/components/project/SiteGraphSigma.js'

test('imports and server-renders without evaluating Sigma WebGL', () => {
  const markup = renderToString(
    <SiteGraphSigma
      ariaLabel="Website link graph"
      nodes={[{
        nodeKey: 'home',
        url: 'https://example.com/',
        path: '/',
        depth: 0,
        indexabilityState: 'indexable',
        fetchState: 'html',
        linkScoreNormalized: 100,
        x: 0,
        y: 0,
      }]}
      edges={[]}
    />,
  )

  expect(markup).toContain('Website link graph')
  expect(markup).toContain('Preparing the interactive site map')
})

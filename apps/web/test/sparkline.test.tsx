import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { Sparkline } from '../src/components/shared/Sparkline.js'

/** Geometry the component is built on; asserted against, not imported from it. */
const HEIGHT = 42
const PADDING = 5
const GUIDE_Y = HEIGHT - PADDING

function pointsOf(html: string): Array<{ x: number; y: number }> {
  const match = html.match(/<polyline[^>]*points="([^"]+)"/)
  if (!match) return []
  return match[1]!.split(' ').map(pair => {
    const [x, y] = pair.split(',')
    return { x: Number(x), y: Number(y) }
  })
}

describe('Sparkline', () => {
  it('renders one baseline measurement as a visible point, not a trend line', () => {
    const html = renderToStaticMarkup(<Sparkline points={[73]} tone="positive" />)

    expect(html).toContain('sparkline-provisional')
    expect(html).toContain('<circle')
    expect(html).toContain('class="sparkline-point"')
    expect(html).not.toMatch(/<circle[^>]*clip-path=/)
    expect(html).not.toContain('<polyline')
  })

  it('still draws the line below the sample floor, but marks it provisional', () => {
    // The real series that prompted this: three runs, 11 of 16 queries mentioned
    // becoming 10. Suppressing the line entirely was the first attempt and it
    // took the graph off the portfolio row, which is the wrong trade — a reader
    // scans that row FOR the shape. The sample size shows in the mark instead.
    const html = renderToStaticMarkup(<Sparkline points={[69, 69, 63]} tone="caution" />)

    expect(html).toContain('<polyline')
    expect(pointsOf(html)).toHaveLength(3)
    expect(html).toContain('sparkline-provisional')
  })

  it('does not mark a full-sample series provisional', () => {
    const html = renderToStaticMarkup(<Sparkline points={[69, 69, 63, 64]} tone="caution" />)

    expect(html).toContain('<polyline')
    expect(html).not.toContain('sparkline-provisional')
  })

  it('never lets the lowest point sit on the guide line, which reads as zero', () => {
    // Both used to resolve to the same y, so every sparkline's low point looked
    // like it had bottomed out whatever its actual value was.
    //
    // The series must be WIDER than the minimum span, or centring keeps it away
    // from the bottom on its own and the gap is never exercised. 90 points of
    // spread pins the low point to the floor of the plot band, which is exactly
    // where the collision used to happen.
    const html = renderToStaticMarkup(<Sparkline points={[95, 70, 40, 5]} tone="negative" />)
    const lowest = Math.max(...pointsOf(html).map(point => point.y))

    expect(pointsOf(html)).toHaveLength(4)
    expect(lowest).toBeLessThan(GUIDE_Y)
  })

  it('scales a small change to a small movement rather than the full height', () => {
    // 6 points of movement on a 0-100 metric. Under min/max normalization this
    // filled the box, making one query out of sixteen look like a collapse.
    const small = pointsOf(renderToStaticMarkup(<Sparkline points={[69, 69, 63, 64]} tone="caution" />))
    const smallSwing = Math.max(...small.map(p => p.y)) - Math.min(...small.map(p => p.y))

    const large = pointsOf(renderToStaticMarkup(<Sparkline points={[95, 70, 40, 5]} tone="negative" />))
    const largeSwing = Math.max(...large.map(p => p.y)) - Math.min(...large.map(p => p.y))

    expect(smallSwing).toBeGreaterThan(0)
    // A 6-point move must read as materially smaller than a 90-point one. Under
    // the old normalization these were identical.
    expect(smallSwing).toBeLessThan(largeSwing / 2)
  })

  it('renders nothing at all for an empty series', () => {
    expect(renderToStaticMarkup(<Sparkline points={[]} tone="neutral" />)).toBe('')
  })
})

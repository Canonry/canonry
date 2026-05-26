import { afterEach, describe, expect, it } from 'vitest'
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useChatScroll, type UseChatScrollResult } from '../src/lib/use-chat-scroll.js'

afterEach(() => cleanup())

// JSDOM doesn't compute layout, so scrollHeight/clientHeight/scrollTop are all
// zero by default. We install per-element accessors so the hook's distance
// math has values to work against. Returns a small handle for the test to
// mutate content height and read the latest scrollTop.
function stubScrollMetrics(
  el: HTMLElement,
  init: { scrollHeight: number; clientHeight: number; scrollTop?: number },
): { setHeight: (h: number) => void; getScrollTop: () => number; scrollTo: (top: number) => void } {
  let scrollHeight = init.scrollHeight
  let scrollTop = init.scrollTop ?? 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => init.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v
    },
  })
  return {
    setHeight: (h: number) => {
      scrollHeight = h
    },
    getScrollTop: () => scrollTop,
    scrollTo: (top: number) => {
      scrollTop = top
      fireEvent.scroll(el)
    },
  }
}

function Harness({
  deps,
  onApi,
}: {
  deps: ReadonlyArray<unknown>
  onApi: (api: UseChatScrollResult<HTMLDivElement>) => void
}): JSX.Element {
  const api = useChatScroll<HTMLDivElement>(deps)
  useEffect(() => {
    onApi(api)
  })
  return <div ref={api.ref} data-testid="scroller" />
}

describe('useChatScroll', () => {
  it('pins to the new bottom when content grows and the user was at end', () => {
    let api: UseChatScrollResult<HTMLDivElement> | null = null
    const { rerender, getByTestId } = render(<Harness deps={[0]} onApi={(a) => (api = a)} />)
    const el = getByTestId('scroller')
    // 200px tall content in a 200px viewport — at the bottom by default.
    const ctrl = stubScrollMetrics(el, { scrollHeight: 200, clientHeight: 200 })

    // Trigger a deps-driven re-render that "grows" the transcript.
    ctrl.setHeight(600)
    act(() => {
      rerender(<Harness deps={[1]} onApi={(a) => (api = a)} />)
    })

    expect(ctrl.getScrollTop()).toBe(600)
    expect(api?.isAtEnd()).toBe(true)
  })

  it('does NOT follow when the user has scrolled up past the threshold', () => {
    let api: UseChatScrollResult<HTMLDivElement> | null = null
    const { rerender, getByTestId } = render(<Harness deps={[0]} onApi={(a) => (api = a)} />)
    const el = getByTestId('scroller')
    const ctrl = stubScrollMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 })
    // Distance from end = 500 - 300 - 200 = 0 → at end. Scroll up well past threshold.
    ctrl.scrollTo(0)

    ctrl.setHeight(900)
    act(() => {
      rerender(<Harness deps={[1]} onApi={(a) => (api = a)} />)
    })

    expect(ctrl.getScrollTop()).toBe(0)
    expect(api?.isAtEnd()).toBe(false)
  })

  it('resumes following after the user scrolls back to the bottom', () => {
    const noop = (): void => {}
    const { rerender, getByTestId } = render(<Harness deps={[0]} onApi={noop} />)
    const el = getByTestId('scroller')
    const ctrl = stubScrollMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 })

    // Scroll up, grow once — no follow.
    ctrl.scrollTo(0)
    ctrl.setHeight(700)
    act(() => {
      rerender(<Harness deps={[1]} onApi={noop} />)
    })
    expect(ctrl.getScrollTop()).toBe(0)

    // Scroll back to the bottom, grow again — should follow.
    ctrl.scrollTo(500)
    ctrl.setHeight(1100)
    act(() => {
      rerender(<Harness deps={[2]} onApi={noop} />)
    })
    expect(ctrl.getScrollTop()).toBe(1100)
  })

  it('treats values within the threshold as "at end"', () => {
    let api: UseChatScrollResult<HTMLDivElement> | null = null
    const { getByTestId } = render(<Harness deps={[0]} onApi={(a) => (api = a)} />)
    const el = getByTestId('scroller')
    // Distance from end = 500 - 250 - 200 = 50, which is within the default 80px threshold.
    const ctrl = stubScrollMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 250 })
    ctrl.scrollTo(250)

    expect(api?.isAtEnd()).toBe(true)
  })

  it('scrollToEnd pins to the bottom regardless of prior position', () => {
    let api: UseChatScrollResult<HTMLDivElement> | null = null
    const { getByTestId } = render(<Harness deps={[0]} onApi={(a) => (api = a)} />)
    const el = getByTestId('scroller')
    const ctrl = stubScrollMetrics(el, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 })

    act(() => {
      api?.scrollToEnd()
    })

    expect(ctrl.getScrollTop()).toBe(1000)
  })
})

import { describe, expect, it } from 'vitest'
import { createSseParser, parseSseText } from '../src/sse.js'

describe('SSE parser', () => {
  it('joins data lines, keeps event types and ids, and skips comments', () => {
    const { events, unterminated } = parseSseText(': keep-alive\nevent: delta\nid: 7\ndata: {"a":\ndata: 1}\n\ndata: plain\n\n')
    expect(events).toEqual([
      { event: 'delta', data: '{"a":\n1}', id: '7' },
      { event: null, data: 'plain', id: '7' },
    ])
    expect(unterminated).toBe(false)
  })

  it('handles CRLF and CR line ends split across chunks', () => {
    const parser = createSseParser()
    expect(parser.push('data: one\r')).toEqual([])
    expect(parser.push('\n\r\ndata: two\r\r')).toEqual([
      { event: null, data: 'one', id: null },
      { event: null, data: 'two', id: null },
    ])
    expect(parser.end()).toEqual({ unterminated: false })
  })

  it('reports an event still open at end of stream instead of dispatching it', () => {
    const { events, unterminated } = parseSseText('data: done\n\ndata: cut off')
    expect(events.map(event => event.data)).toEqual(['done'])
    expect(unterminated).toBe(true)
  })

  it('dispatches nothing for an event with no data lines', () => {
    expect(parseSseText('event: ping\n\n').events).toEqual([])
  })
})

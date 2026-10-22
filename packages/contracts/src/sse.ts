/**
 * A pure Server-Sent Events parser (WHATWG HTML, "Parsing an event stream").
 * Feed it decoded text in any chunking; it returns each event once its
 * terminating blank line arrives. An event still open when the stream ends is
 * reported separately, because a stream cut mid-event is not a clean end.
 */
export interface SseEvent {
  /** The `event:` field, or null for the default `message` type. */
  event: string | null
  /** Every `data:` line of the event, joined with `\n`. */
  data: string
  /** The last `id:` field seen, if any. */
  id: string | null
}

export interface SseParser {
  /** Parse the next chunk of decoded text and return the events it completed. */
  push(chunk: string): SseEvent[]
  /**
   * Close the stream. Returns whether an event was left unterminated (data
   * lines with no closing blank line), which the spec discards.
   */
  end(): { unterminated: boolean }
}

export function createSseParser(): SseParser {
  let buffer = ''
  let pendingCarriageReturn = false
  let data: string[] = []
  let event: string | null = null
  let lastId: string | null = null
  let hasFields = false

  const processLine = (line: string, out: SseEvent[]): void => {
    if (line === '') {
      if (data.length > 0) out.push({ event, data: data.join('\n'), id: lastId })
      data = []
      event = null
      hasFields = false
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'data':
        data.push(value)
        hasFields = true
        break
      case 'event':
        event = value
        hasFields = true
        break
      case 'id':
        if (!value.includes('\u0000')) lastId = value
        break
      default:
        // `retry` and unknown fields carry nothing an answer parser reads.
        break
    }
  }

  return {
    push(chunk: string): SseEvent[] {
      const out: SseEvent[] = []
      let text = chunk
      if (pendingCarriageReturn) {
        pendingCarriageReturn = false
        if (text.startsWith('\n')) text = text.slice(1)
      }
      buffer += text
      let start = 0
      for (let index = 0; index < buffer.length; index++) {
        const char = buffer[index]
        if (char !== '\n' && char !== '\r') continue
        processLine(buffer.slice(start, index), out)
        if (char === '\r') {
          if (index + 1 === buffer.length) pendingCarriageReturn = true
          else if (buffer[index + 1] === '\n') index++
        }
        start = index + 1
      }
      buffer = buffer.slice(start)
      return out
    },
    end(): { unterminated: boolean } {
      const unterminated = hasFields || buffer.length > 0
      buffer = ''
      data = []
      event = null
      hasFields = false
      return { unterminated }
    },
  }
}

/** Parse a complete stream body. */
export function parseSseText(text: string): { events: SseEvent[]; unterminated: boolean } {
  const parser = createSseParser()
  const events = parser.push(text)
  return { events, ...parser.end() }
}

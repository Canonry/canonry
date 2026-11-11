import { chatGptSignInErrorSchema, type ChatGptSignInError } from '@canonry/canonry-contracts'

/**
 * What OpenAI's redirect back carried, read once per page load.
 *
 * The server returns to the dashboard with `chatgpt_error=<code>` when a
 * ChatGPT sign-in or connect did not complete, or `chatgpt=connected|linked`
 * when a connect did. The sign-in screen and the Aero bar both want to know,
 * and only one of them is on screen, so the first to ask reads the address
 * bar, strips both parameters (a reload must not repeat the message), and
 * every later caller gets the same answer.
 */
export interface ChatGptReturn {
  error: ChatGptSignInError | null
  result: 'connected' | 'linked' | null
}

let consumed: ChatGptReturn | undefined

export function consumeChatGptReturn(): ChatGptReturn {
  if (consumed) return consumed
  consumed = { error: null, result: null }
  if (typeof window === 'undefined' || !window.location) return consumed
  let url: URL
  try {
    url = new URL(window.location.href)
  } catch {
    return consumed
  }
  const error = url.searchParams.get('chatgpt_error')
  const result = url.searchParams.get('chatgpt')
  if (error === null && result === null) return consumed
  const parsedError = chatGptSignInErrorSchema.safeParse(error)
  consumed = {
    error: error === null ? null : parsedError.success ? parsedError.data : 'failed',
    result: result === 'connected' || result === 'linked' ? result : null,
  }
  url.searchParams.delete('chatgpt_error')
  url.searchParams.delete('chatgpt')
  try {
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // A blocked history write leaves the parameters visible; nothing else changes.
  }
  return consumed
}

/** Where a sign-in or connect should come back to: this page, without the return parameters. */
export function currentReturnPath(): string {
  if (typeof window === 'undefined' || !window.location) return '/'
  const url = new URL(window.location.href)
  url.searchParams.delete('chatgpt_error')
  url.searchParams.delete('chatgpt')
  return `${url.pathname}${url.search}`
}

/** Test seam: forget what was read, so the next call reads the address bar again. */
export function resetChatGptReturnForTests(): void {
  consumed = undefined
}

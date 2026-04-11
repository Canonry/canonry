import type CDP from 'chrome-remote-interface'
import type { GroundingSource } from '@ainyc/canonry-contracts'
import type { CDPTarget } from './types.js'
import { CDPProviderError } from './types.js'
import { waitForStabilization } from '../connection.js'

/**
 * ChatGPT web UI extraction target.
 *
 * Query flow:
 * 1. Navigate to chatgpt.com (fresh conversation)
 * 2. Find message input, type keyword with realistic delays
 * 3. Submit via Enter
 * 4. Wait for response: stop button disappears + text stable for 500ms
 * 5. Extract answer text from last assistant message
 * 6. Extract citation links from source pills
 */
export const chatgptTarget: CDPTarget = {
  name: 'chatgpt',
  baseUrl: 'https://chatgpt.com',
  newConversationUrl: 'https://chatgpt.com/?model=auto',
  responseSelector: '[data-testid="conversation-turn-3"], article:last-of-type, .agent-turn:last-of-type',

  async submitQuery(client: CDP.Client, keyword: string): Promise<void> {
    // Wait for the input area to appear
    const inputReady = await waitForElement(
      client,
      '#prompt-textarea, [contenteditable="true"][data-placeholder]',
      10000,
    )
    if (!inputReady) {
      // Check if we need to log in
      const needsAuth = await checkAuthState(client)
      if (needsAuth) {
        throw new CDPProviderError('CDP_AUTH_REQUIRED', 'Not logged in to ChatGPT — please log in via Chrome')
      }
      throw new CDPProviderError('CDP_TARGET_SELECTOR_FAILED', 'ChatGPT input area not found')
    }

    // Focus the input and type with realistic delays
    await client.Runtime.evaluate({
      expression: `(document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"][data-placeholder]')).focus()`,
    })
    await sleep(200)

    // Type the query character by character with small random delays
    for (const char of keyword) {
      await client.Input.dispatchKeyEvent({
        type: 'keyDown',
        key: char,
        text: char,
      })
      await client.Input.dispatchKeyEvent({
        type: 'keyUp',
        key: char,
      })
      await sleep(30 + Math.random() * 50)
    }

    await sleep(300)

    // Submit with Enter
    await client.Input.dispatchKeyEvent({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
    await client.Input.dispatchKeyEvent({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
  },

  async waitForResponse(client: CDP.Client): Promise<void> {
    // Wait a moment for the response to start streaming
    await sleep(2000)

    // Primary strategy: wait for the stop button to disappear (streaming complete)
    // + text to stabilize for 500ms
    const startTime = Date.now()
    const timeout = 60000

    while (Date.now() - startTime < timeout) {
      // Check if stop button is gone (streaming finished)
      const { result: stopBtnResult } = await client.Runtime.evaluate({
        expression: `!!document.querySelector('[data-testid="stop-button"], button[aria-label="Stop streaming"]')`,
        returnByValue: true,
      })

      if (!stopBtnResult.value) {
        // Stop button is gone — now wait for text to stabilize briefly
        await sleep(500)

        // Verify text hasn't changed in the last 500ms
        const { result: text1 } = await client.Runtime.evaluate({
          expression: `(document.querySelector('[data-testid="conversation-turn-3"]') || document.querySelector('article:last-of-type') || document.querySelector('.agent-turn:last-of-type'))?.textContent ?? ''`,
          returnByValue: true,
        })
        await sleep(500)
        const { result: text2 } = await client.Runtime.evaluate({
          expression: `(document.querySelector('[data-testid="conversation-turn-3"]') || document.querySelector('article:last-of-type') || document.querySelector('.agent-turn:last-of-type'))?.textContent ?? ''`,
          returnByValue: true,
        })

        if (text1.value && text1.value === text2.value) {
          return // Response is complete and stable
        }
      }

      await sleep(500)
    }

    // Fallback: use generic text stabilization
    await waitForStabilization(
      client,
      '[data-testid="conversation-turn-3"], article:last-of-type, .agent-turn:last-of-type',
      { pollIntervalMs: 500, stableMs: 2000, timeoutMs: 10000 },
    )
  },

  async extractAnswer(client: CDP.Client): Promise<string> {
    const { result } = await client.Runtime.evaluate({
      expression: `(() => {
        // Get the last assistant message. Clone it and strip <a> elements
        // so inline citation badges ("pbjmarketing.com+1") don't bleed
        // into the prose. innerText alone is not enough — the link text
        // is visible and therefore included by innerText too.
        const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (turns.length === 0) return '';
        const last = turns[turns.length - 1];
        const md = last.querySelector('.markdown');
        const clone = (md ?? last).cloneNode(true);
        clone.querySelectorAll('a').forEach(a => a.remove());
        return clone.innerText?.trim() ?? '';
      })()`,
      returnByValue: true,
    })

    const text = String(result.value ?? '')
    if (!text) {
      throw new CDPProviderError('CDP_TARGET_SELECTOR_FAILED', 'Could not extract ChatGPT answer text')
    }
    return text
  },

  extractCitations(client: CDP.Client): Promise<GroundingSource[]> {
    return (async () => {
      const { result } = await client.Runtime.evaluate({
        expression: `(() => {
          const sources = [];
          const seen = new Set();
          const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
          const last = turns.length ? turns[turns.length - 1] : null;
          if (!last) return [];

          const links = last.querySelectorAll('a[href]');
          for (const link of links) {
            const href = link.getAttribute('href');
            if (!href) continue;
            let hostname = '';
            try {
              const url = new URL(href);
              hostname = url.hostname.replace(/^www\\./, '');
            } catch {
              // Check for relative links or weird protocols
              if (href.startsWith('/') || href.startsWith('http')) {
                 hostname = href;
              } else {
                 continue;
              }
            }

            if (!seen.has(href) && hostname !== 'chatgpt.com' && hostname !== 'openai.com') {
              seen.add(href);
              sources.push({
                uri: href,
                title: hostname || href,
              });
            }
          }

          // Also check for citation superscripts that may reference sources
          const citeButtons = last.querySelectorAll('[data-testid="citation-button"], .citation-button');
          for (const btn of citeButtons) {
            const href = btn.getAttribute('data-href') || btn.closest('a')?.getAttribute('href');
            const title = btn.getAttribute('data-title') || btn.textContent?.trim();
            if (href && !seen.has(href)) {
              let hostname = '';
              try { hostname = new URL(href).hostname.replace(/^www\\./, ''); } catch {}
              if (hostname !== 'chatgpt.com' && hostname !== 'openai.com') {
                seen.add(href);
                sources.push({ uri: href, title: title || hostname || href });
              }
            }
          }

          return sources;
        })()`,
        returnByValue: true,
      })

      return (result.value as GroundingSource[]) ?? []
    })()
  },
}

/** Wait for a CSS selector to appear in the DOM */
async function waitForElement(
  client: CDP.Client,
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { result } = await client.Runtime.evaluate({
      expression: `!!document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: true,
    })
    if (result.value) return true
    await sleep(500)
  }
  return false
}

/** Check if ChatGPT requires authentication */
async function checkAuthState(client: CDP.Client): Promise<boolean> {
  const { result } = await client.Runtime.evaluate({
    // :contains() is not a valid CSS pseudo-class — use JS textContent check instead
    expression: `!!(document.querySelector('[data-testid="login-button"], a[href*="auth"]') || Array.from(document.querySelectorAll('button')).some(b => b.textContent?.trim() === 'Log in'))`,
    returnByValue: true,
  })
  return !!result.value
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

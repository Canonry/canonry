import CDP from 'chrome-remote-interface'
import type { CDPTarget } from './targets/types.js'
import { CDPProviderError } from './targets/types.js'

interface TabEntry {
  client: CDP.Client
  targetId: string
  alive: boolean
  lastUsed: Date
}

export interface CDPHealthResult {
  connected: boolean
  version?: string
  browserVersion?: string
}

export interface TabStatus {
  name: string
  alive: boolean
  lastUsed: Date | null
}

/**
 * Manages a persistent CDP connection to Chrome with a pool of reusable tabs.
 *
 * Design: one persistent tab per CDPTarget (e.g. one for ChatGPT).
 * Tabs stay open to preserve login sessions. On each query, we navigate
 * to the target's newConversationUrl rather than closing/reopening.
 */
export class CDPConnectionManager {
  private host: string
  private port: number
  private tabs = new Map<string, TabEntry>()

  constructor(host: string, port: number) {
    this.host = host
    this.port = port
  }

  get endpoint(): string {
    return `${this.host}:${this.port}`
  }

  /** Check if Chrome is reachable via CDP */
  async healthcheck(): Promise<CDPHealthResult> {
    try {
      const info = await CDP.Version({ host: this.host, port: this.port })
      return {
        connected: true,
        version: info['Protocol-Version'],
        browserVersion: info.Browser,
      }
    } catch {
      return { connected: false }
    }
  }

  /**
   * Ensure a persistent tab exists for the given target.
   * Creates a new tab if one doesn't exist or if the previous one died.
   */
  async ensureTab(target: CDPTarget): Promise<CDP.Client> {
    const existing = this.tabs.get(target.name)
    if (existing?.alive) {
      return existing.client
    }

    // Clean up dead tab entry if needed
    if (existing) {
      try { await existing.client.close() } catch { /* ignore */ }
      this.tabs.delete(target.name)
    }

    try {
      // Create a new tab via the CDP Target API
      const newTarget = await CDP.New({
        host: this.host,
        port: this.port,
        url: target.baseUrl,
      })

      const client = await CDP({
        host: this.host,
        port: this.port,
        target: newTarget,
      })

      // Enable required domains
      await Promise.all([
        client.Page.enable(),
        client.DOM.enable(),
        client.Runtime.enable(),
      ])

      const entry: TabEntry = {
        client,
        targetId: newTarget.id,
        alive: true,
        lastUsed: new Date(),
      }

      // Mark as dead on disconnect
      client.on('disconnect', () => {
        entry.alive = false
      })

      this.tabs.set(target.name, entry)
      return client
    } catch (err) {
      throw new CDPProviderError(
        'CDP_CONNECTION_REFUSED',
        `Failed to connect to Chrome at ${this.host}:${this.port}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Prepare a tab for a new query by navigating to the target's
   * new conversation URL. This gives a clean slate without losing
   * the login session.
   */
  async prepareForQuery(target: CDPTarget): Promise<CDP.Client> {
    const client = await this.ensureTab(target)

    try {
      await client.Page.navigate({ url: target.newConversationUrl })
      await client.Page.loadEventFired()
      // Brief pause for page JS to initialize
      await sleep(1500)
    } catch (err) {
      throw new CDPProviderError(
        'CDP_TARGET_SELECTOR_FAILED',
        `Failed to navigate to ${target.newConversationUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Update last used
    const entry = this.tabs.get(target.name)
    if (entry) entry.lastUsed = new Date()

    return client
  }

  /** Get status of all tracked tabs */
  getTabStatus(): TabStatus[] {
    const result: TabStatus[] = []
    for (const [name, entry] of this.tabs) {
      result.push({
        name,
        alive: entry.alive,
        lastUsed: entry.lastUsed,
      })
    }
    return result
  }

  /** Close all tabs and disconnect */
  async disconnect(): Promise<void> {
    for (const [name, entry] of this.tabs) {
      try {
        await CDP.Close({
          host: this.host,
          port: this.port,
          id: entry.targetId,
        })
      } catch { /* ignore cleanup errors */ }
      try { await entry.client.close() } catch { /* ignore */ }
      this.tabs.delete(name)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Poll DOM text content until it stabilizes (unchanged for `stableMs`).
 * This is the resilient fallback when target-specific selectors break.
 */
export async function waitForStabilization(
  client: CDP.Client,
  selector: string,
  opts: { pollIntervalMs?: number; stableMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollInterval = opts.pollIntervalMs ?? 500
  const stableThreshold = opts.stableMs ?? 2000
  const timeout = opts.timeoutMs ?? 60000
  const start = Date.now()
  let lastText = ''
  let lastChangeTime = start

  while (Date.now() - start < timeout) {
    try {
      const { result } = await client.Runtime.evaluate({
        expression: `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
        returnByValue: true,
      })
      const currentText = String(result.value ?? '')

      if (currentText !== lastText) {
        lastText = currentText
        lastChangeTime = Date.now()
      } else if (currentText.length > 0 && Date.now() - lastChangeTime >= stableThreshold) {
        return // Text has been stable long enough
      }
    } catch {
      // DOM query failed — keep polling
    }

    await sleep(pollInterval)
  }

  throw new CDPProviderError(
    'CDP_RESPONSE_TIMEOUT',
    `Response did not stabilize within ${timeout}ms (selector: ${selector})`,
  )
}

import path from 'node:path'
import os from 'node:os'
import type {
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  TrackedQueryInput,
  RawQueryResult,
  NormalizedQueryResult,
} from '@ainyc/canonry-contracts'
import { CDPConnectionManager } from './connection.js'
import { chatgptTarget } from './targets/chatgpt.js'
import { captureElementScreenshot } from './screenshot.js'
import { normalizeResult as cdpNormalizeResult } from './normalize.js'
import { CDPProviderError } from './targets/types.js'

// Shared connection manager singleton (one Chrome instance, multiple targets)
let sharedConnection: CDPConnectionManager | null = null

function getConnection(config: ProviderConfig): CDPConnectionManager {
  if (!config.cdpEndpoint) {
    throw new CDPProviderError('CDP_CONNECTION_REFUSED', 'CDP endpoint not configured')
  }

  // Parse endpoint: "ws://host:port" or "host:port" or just "host"
  let host = 'localhost'
  let port = 9222
  const endpoint = config.cdpEndpoint.replace(/^wss?:\/\//, '')
  const parts = endpoint.split(':')
  if (parts.length >= 1 && parts[0]) host = parts[0]
  if (parts.length >= 2 && parts[1]) port = parseInt(parts[1], 10) || 9222

  // Reuse or create connection
  if (!sharedConnection || sharedConnection.endpoint !== `${host}:${port}`) {
    sharedConnection = new CDPConnectionManager(host, port)
  }
  return sharedConnection
}

function getScreenshotDir(): string {
  return path.join(os.homedir(), '.canonry', 'screenshots')
}

export const cdpChatgptAdapter: ProviderAdapter = {
  name: 'cdp:chatgpt',
  displayName: 'ChatGPT (Browser)',
  mode: 'browser',
  modelRegistry: {
    defaultModel: 'chatgpt-web',
    validationPattern: /./,
    validationHint: 'model is detected from the ChatGPT web UI',
    knownModels: [
      { id: 'chatgpt-web', displayName: 'ChatGPT (Web UI)', tier: 'standard' },
    ],
  },

  validateConfig(config: ProviderConfig): ProviderHealthcheckResult {
    if (!config.cdpEndpoint) {
      return {
        ok: false,
        provider: 'cdp:chatgpt',
        message: 'CDP endpoint not configured — run "canonry cdp connect --host <host> --port <port>"',
      }
    }
    return {
      ok: true,
      provider: 'cdp:chatgpt',
      message: `CDP endpoint: ${config.cdpEndpoint}`,
    }
  },

  async healthcheck(config: ProviderConfig): Promise<ProviderHealthcheckResult> {
    try {
      const conn = getConnection(config)
      const health = await conn.healthcheck()
      if (!health.connected) {
        return {
          ok: false,
          provider: 'cdp:chatgpt',
          message: `Chrome not reachable at ${config.cdpEndpoint}`,
        }
      }
      return {
        ok: true,
        provider: 'cdp:chatgpt',
        message: `Connected to ${health.browserVersion ?? 'Chrome'} via CDP`,
        model: 'chatgpt-web',
      }
    } catch (err) {
      return {
        ok: false,
        provider: 'cdp:chatgpt',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async executeTrackedQuery(input: TrackedQueryInput, config: ProviderConfig): Promise<RawQueryResult> {
    const conn = getConnection(config)
    const target = chatgptTarget

    // Navigate to a fresh conversation
    const client = await conn.prepareForQuery(target)

    // Submit the query
    await target.submitQuery(client, input.keyword)

    // Wait for the response to complete
    await target.waitForResponse(client)

    // Extract answer text
    const answerText = await target.extractAnswer(client)

    // Extract citations
    const groundingSources = await target.extractCitations(client)

    // Capture cropped screenshot of the response area
    const screenshotId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const screenshotPath = path.join(getScreenshotDir(), `${screenshotId}.png`)
    let capturedScreenshotPath: string | undefined
    try {
      capturedScreenshotPath = await captureElementScreenshot(
        client,
        target.responseSelector,
        screenshotPath,
      )
    } catch {
      // Screenshot failure is non-fatal — we still have the text data
    }

    return {
      provider: 'cdp:chatgpt',
      rawResponse: {
        answerText,
        groundingSources,
        extractedAt: new Date().toISOString(),
        targetUrl: target.newConversationUrl,
      },
      model: 'chatgpt-web',
      groundingSources,
      searchQueries: [input.keyword],
      screenshotPath: capturedScreenshotPath,
    }
  },

  normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
    return cdpNormalizeResult(raw)
  },

  async generateText(): Promise<string> {
    throw new Error('generateText is not supported for browser-based CDP providers')
  },
}

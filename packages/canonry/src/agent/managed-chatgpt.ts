import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { ManagedInferenceTurnGrant } from './managed-inference.js'
import { asRecord } from '@ainyc/canonry-contracts'

const TOOL_NAMESPACE = 'canonry'
const FAILURE = 'ChatGPT could not finish this Aero turn. Reconnect your account or try again.'
const AUTH_FAILURE = 'CHATGPT_AUTH_REQUIRED: Reconnect your ChatGPT account before sending another Aero turn.'
const QUOTA_FAILURE = 'CHATGPT_RATE_LIMITED: Your ChatGPT account is temporarily rate limited. Wait before sending another Aero turn.'

/** Account-granted model identity; no API-key catalog or environment proxy decides it. */
export function managedChatGptModel(id: string): Model<'openai-responses'> {
  return {
    id, name: id, api: 'openai-responses', provider: 'openai',
    baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text'],
    contextWindow: 128_000, maxTokens: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsMaxOutputTokens: false },
  }
}

/** Public SIWC Responses permits namespaced functions and a deliberately narrow request shape. */
function accountPayload(value: unknown): Record<string, unknown> {
  const payload = asRecord(value) ?? {}
  const input = Array.isArray(payload.input) ? payload.input.map(value => {
    const item = asRecord(value) ?? {}
    if (item.role === 'system') return { ...item, role: 'developer' }
    return item.type === 'function_call' || item.type === 'custom_tool_call'
      ? { ...item, namespace: TOOL_NAMESPACE }
      : item
  }) : []
  const tools = Array.isArray(payload.tools) ? payload.tools : []
  return {
    model: payload.model, input, store: false, stream: true,
    include: ['reasoning.encrypted_content'],
    ...(tools.length ? { tools: [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Authorized Canonry Aero tools for this turn.', tools }] } : {}),
  }
}

function normalizeMessage(message: AssistantMessage, failed = false, responseStatus?: number): void {
  for (const block of message.content) {
    if (block.type !== 'toolCall') continue
    if (block.namespace !== undefined && block.namespace !== TOOL_NAMESPACE) {
      block.name = 'unavailable_tool_namespace'
    } else if (block.name.startsWith(`${TOOL_NAMESPACE}.`)) {
      block.name = block.name.slice(TOOL_NAMESPACE.length + 1)
    }
  }
  if (failed || message.errorMessage) {
    message.errorMessage = responseStatus === 401 || responseStatus === 403 ? AUTH_FAILURE : responseStatus === 429 ? QUOTA_FAILURE : FAILURE
    // A provider failure may reflect request material; none of it is user evidence.
    message.content = []
  }
}

/** A fresh credential closure per turn, actively erased on release even if an Agent is retained. */
export function managedChatGptStream(grant: ManagedInferenceTurnGrant, transport?: typeof globalThis.fetch): { stream: StreamFn; release: () => void } {
  let token = grant.accessToken
  const expiresAt = grant.expiresAt
  const stream: StreamFn = (model, context, options) => {
    if (!token || Date.now() >= expiresAt) throw new Error(FAILURE)
    const output = createAssistantMessageEventStream()
    let responseStatus: number | undefined
    const publicFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await (transport ?? globalThis.fetch)(input, init)
      responseStatus = response.status
      return response
    }
    const source = streamResponses(managedChatGptModel(model.id), context, {
      apiKey: token,
      signal: options?.signal,
      fetch: publicFetch,
      maxRetries: 2,
      maxRetryDelayMs: 10_000,
      timeoutMs: 60_000,
      headers: {
        'User-Agent': 'canonry',
        'X-Stainless-OS': null,
        'X-Stainless-Arch': null,
        'X-Stainless-Runtime-Version': null,
      },
      onPayload: accountPayload,
    })
    void (async () => {
      for await (const event of source) {
        if ('partial' in event) normalizeMessage(event.partial, false, responseStatus)
        if (event.type === 'done') normalizeMessage(event.message, false, responseStatus)
        if (event.type === 'error') normalizeMessage(event.error, true, responseStatus)
        if (event.type === 'toolcall_end') {
          // The stream and final transcript hold the same normalized tool object.
          normalizeMessage(event.partial)
        }
        output.push(event)
      }
      output.end(await source.result())
    })()
    return output
  }
  return { stream, release: () => { token = '' } }
}

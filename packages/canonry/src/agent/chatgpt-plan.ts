/**
 * Aero on a person's own ChatGPT plan.
 *
 * A viewer who connected their ChatGPT plan gets Aero turns funded by that
 * plan instead of the install's provider key. The agent is the same viewer
 * agent (same read-only tools, same prompt, same limits); only its model, its
 * credential and its request shape change:
 *
 * - The model is pinned to `https://api.openai.com/v1`, the only host a
 *   ChatGPT plan token is ever sent to. A configured OpenAI proxy or base URL
 *   never sees it, and the model costs the install nothing.
 * - The credential is fetched per request from the person's stored grant,
 *   refreshed when close to expiry, and never stored on the agent.
 * - OpenAI's plan route wants function tools grouped in a namespace and no
 *   `system`-role items, so the payload is reshaped on the way out. pi-ai
 *   already drops the request fields that route rejects (it recognises a plan
 *   token by its shape).
 * - Every failure becomes one of the plain CHATGPT_AERO_ERRORS messages, which
 *   tell the viewer what to do. Provider text never reaches them.
 *
 * A failed plan turn never falls back to the install's key.
 */
import type { Agent, StreamFn } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import { ChatGptPlanError, type ChatGptAccounts } from '@canonry/canonry-api-routes'
import { CHATGPT_AERO_ERRORS, CHATGPT_RESOURCE, type ChatGptAeroError } from '@canonry/canonry-contracts'
import { AgentProviderIds } from '@canonry/canonry-contracts'
import type { CanonryConfig } from '../config.js'
import { resolveAgentReasoning } from '../agent-config.js'
import { aeroModels, aeroStreamFn } from './pi-models.js'
import { PROVIDER_MODELS } from './providers.js'
import { resolveSessionProviderAndModel } from './session.js'

/** The namespace Aero's tools are grouped under on the plan route. */
export const CHATGPT_TOOL_NAMESPACE = 'canonry'

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * The model for a plan turn: the catalog entry when pi-ai knows the ID (so
 * reasoning settings are right), else a conservative non-reasoning entry.
 * Either way pinned to OpenAI's own endpoint and free to the install.
 */
export function chatGptPlanModel(modelId: string): Model<Api> {
  const known = aeroModels.getModel('openai', modelId) as Model<Api> | undefined
  const base: Model<Api> = known ?? {
    id: modelId,
    name: modelId,
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: CHATGPT_RESOURCE,
    reasoning: false,
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 32_000,
    cost: ZERO_COST,
  }
  return { ...base, api: 'openai-responses', provider: 'openai', baseUrl: CHATGPT_RESOURCE, cost: ZERO_COST }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Reshape a Responses request for the plan route: tools grouped in Aero's
 * namespace, earlier tool calls carrying that namespace, and instructions in
 * the `developer` role. Everything else passes through as pi-ai built it.
 */
export function namespaceChatGptPayload(payload: unknown): unknown {
  const params = asRecord(payload)
  if (!params) return undefined
  const input = Array.isArray(params.input)
    ? (params.input as unknown[]).map((item: unknown): unknown => {
        const record = asRecord(item)
        if (!record) return item
        if (record.role === 'system') return { ...record, role: 'developer' }
        if ((record.type === 'function_call' || record.type === 'custom_tool_call') && record.namespace === undefined) {
          return { ...record, namespace: CHATGPT_TOOL_NAMESPACE }
        }
        return item
      })
    : params.input
  const tools: unknown[] = Array.isArray(params.tools) ? (params.tools as unknown[]) : []
  return {
    ...params,
    input,
    ...(tools.length > 0
      ? { tools: [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE, description: 'Canonry tools Aero may use for this answer.', tools }] }
      : {}),
  }
}

/**
 * The plain message for a failed plan request. Status first, then OpenAI's
 * documented error codes when the body named one.
 */
export function chatGptPlanFailure(status: number | undefined, detail: string | undefined): ChatGptAeroError {
  const text = detail ?? ''
  if (status === 401 || text.includes('subscription_sharing_invalid_user')) return CHATGPT_AERO_ERRORS.reconnect
  if (text.includes('subscription_sharing_usage_limit_exceeded') || status === 429) return CHATGPT_AERO_ERRORS.usageLimit
  if (text.includes('subscription_sharing_user_not_eligible')) return CHATGPT_AERO_ERRORS.notEligible
  if (text.includes('chatpass_v2_scope_not_authorized') || text.includes('chatpass_v2_invalid_authorization_context')) return CHATGPT_AERO_ERRORS.reconnect
  if (status === 403) return CHATGPT_AERO_ERRORS.notEligible
  if (status === 503 || text.includes('subscription_sharing_usage_unavailable') || text.includes('subscription_sharing_user_unavailable')) {
    return CHATGPT_AERO_ERRORS.unavailable
  }
  return CHATGPT_AERO_ERRORS.failed
}

/**
 * Wrap the Aero stream so a failed plan request ends with a plain message and
 * no partial content (a failure can echo request material). `onReconnect` runs
 * when OpenAI refused the credential, so the person is asked to connect again.
 */
export function chatGptPlanStreamFn(onReconnect: () => void): StreamFn {
  return (model, context, options) => {
    let status: number | undefined
    const output = createAssistantMessageEventStream()
    const rewrite = (message: AssistantMessage) => {
      const failure = chatGptPlanFailure(status, message.errorMessage)
      if (failure === CHATGPT_AERO_ERRORS.reconnect) onReconnect()
      message.errorMessage = failure
      message.content = []
    }
    void (async () => {
      try {
        const source = await aeroStreamFn(model, context, {
          ...options,
          // Observe every HTTP response, failures included: pi-ai calls
          // onResponse only for a successful one, and its error text is not a
          // contract to parse a status out of.
          fetch: async (input, init) => {
            const response = await (options?.fetch ?? globalThis.fetch)(input, init)
            status = response.status
            return response
          },
        })
        for await (const event of source) {
          if (event.type === 'error') rewrite(event.error)
          output.push(event)
        }
        const result = await source.result()
        if (result.stopReason === 'error' && !Object.values(CHATGPT_AERO_ERRORS).includes(result.errorMessage as ChatGptAeroError)) {
          rewrite(result)
        }
        output.end(result)
      } catch (error) {
        const message = error instanceof ChatGptPlanError ? error.message : CHATGPT_AERO_ERRORS.failed
        output.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } },
            stopReason: 'error',
            errorMessage: message,
            timestamp: Date.now(),
          },
        })
        output.end()
      }
    })()
    return output
  }
}

/**
 * The install's own OpenAI Aero model, offered first on a person's plan when
 * their plan lists it. Without an install provider, OpenAI's Aero default.
 */
export function preferredChatGptModel(config: CanonryConfig): string {
  try {
    const { provider, modelId } = resolveSessionProviderAndModel(config)
    if (provider === AgentProviderIds.openai) return modelId
  } catch {
    // No install provider at all: plan funding does not need one.
  }
  return PROVIDER_MODELS[AgentProviderIds.openai].agent
}

/** What a viewer's turn runs on. `install` is the install's own Aero provider. */
export type ViewerFunding =
  | { kind: 'install' }
  | { kind: 'plan'; connectionId: string; modelId: string }

/** A stable label for the funding, so a change of funding starts a fresh conversation. */
export function fundingKey(funding: ViewerFunding): string {
  return funding.kind === 'install' ? 'install' : `plan:${funding.connectionId}`
}

/**
 * Point a plan-funded viewer agent at the person's plan for this turn: model,
 * reasoning level, credential and payload shape. Idempotent, so it runs on
 * every turn and a newly chosen plan model applies to the next answer.
 *
 * The stream function is NOT set here. It has to be given to
 * `createAeroSession` (`chatGptPlanStreamFn`), because Aero's runtime wraps
 * the stream once when the agent is built; replacing it afterwards would drop
 * the turn clock, tool-name correction and wrap-up handling that wrapper adds.
 */
export function applyChatGptPlanTurn(
  agent: Agent,
  input: { accounts: ChatGptAccounts; userId: string; modelId: string; config: CanonryConfig },
): void {
  agent.state.model = chatGptPlanModel(input.modelId)
  agent.state.thinkingLevel = resolveAgentReasoning(process.env, input.config, AgentProviderIds.openai, input.modelId)
  agent.getApiKey = async (provider: string) => {
    if (provider !== 'openai') return undefined
    const access = await input.accounts.planAccess(input.userId)
    return access.accessToken
  }
  agent.onPayload = payload => namespaceChatGptPayload(payload)
}

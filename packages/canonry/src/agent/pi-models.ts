import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { StreamFn } from '@earendil-works/pi-agent-core'

/**
 * The one pi-ai model collection Canonry streams through: every built-in
 * catalog provider. pi-ai 0.80 made the root entry side-effect free, so a model
 * is only streamable through a collection that owns its provider.
 *
 * Canonry always resolves the API key itself and passes it as `apiKey`, which
 * wins over provider auth.
 */
export const aeroModels = builtinModels()

/**
 * Request defaults Canonry sets itself instead of taking pi's:
 *  - two SDK retries, as before pi-ai 0.76 made provider retries default to 0
 *    (one transient 429/5xx then ended a turn);
 *  - an output cap of min(model.maxTokens, 32000), the streaming default before
 *    pi-ai 0.74 raised it to the model's maximum (up to 128K). One-shot calls
 *    get the same cap; before, each API applied its own default there;
 *  - a `canonry` User-Agent, where pi-ai 0.84 sends the host OS, kernel
 *    release and CPU architecture to every provider, and none of the other
 *    headers the provider SDKs fill with the host OS, CPU architecture or
 *    Node version (`HOST_HEADERS`).
 * A caller's explicit value always wins.
 */
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000
const CANONRY_USER_AGENT = 'canonry'

/**
 * The SDK headers that still name the host once the User-Agent is replaced, by
 * the API that sends them:
 *  - the Anthropic and OpenAI SDKs (zai's openai-completions included) send
 *    X-Stainless-OS, -Arch and -Runtime-Version. A null header drops an SDK
 *    default there;
 *  - @google/genai sends the Node version in `x-goog-api-client`. pi drops a
 *    null header before that SDK sees it, so the value is replaced instead,
 *    under the SDK's own lower-case name (another spelling sends both values).
 */
const STAINLESS_HOST_HEADERS: ProviderHeaders = {
  'X-Stainless-OS': null,
  'X-Stainless-Arch': null,
  'X-Stainless-Runtime-Version': null,
}
const HOST_HEADERS: Partial<Record<Api, ProviderHeaders>> = {
  'anthropic-messages': STAINLESS_HOST_HEADERS,
  'openai-responses': STAINLESS_HOST_HEADERS,
  'openai-completions': STAINLESS_HOST_HEADERS,
  'google-generative-ai': { 'x-goog-api-client': CANONRY_USER_AGENT },
}

function outputCap(model: Model<Api>): number {
  return Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS)
}

function canonryDefaults(model: Model<Api>, options: SimpleStreamOptions | undefined): SimpleStreamOptions {
  return {
    ...options,
    maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
    maxTokens: options?.maxTokens ?? outputCap(model),
    headers: { 'User-Agent': CANONRY_USER_AGENT, ...HOST_HEADERS[model.api], ...options?.headers },
  }
}

/** The Agent's stream function. pi-agent-core 0.81 no longer supplies a default. */
export const aeroStreamFn: StreamFn = (model, context, options) =>
  aeroModels.streamSimple(model, context, canonryDefaults(model, options))

/** One-shot, non-streaming call (compaction summaries, recommendation explanations). */
export function completeOnce(
  model: Model<Api>,
  context: Context,
  options: { apiKey?: string } = {},
): Promise<AssistantMessage> {
  return aeroModels.complete(model, context, canonryDefaults(model, options))
}

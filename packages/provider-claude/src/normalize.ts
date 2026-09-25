import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  WebSearchTool20250305,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  AI_ENGINE_SELF_DOMAINS,
  hostMatchesAnyDomain,
  hostOf,
  normalizeServedModel,
  registrableDomain,
  describeError,
  usageCount,
} from "@ainyc/canonry-contracts";
import type { ProviderUsage, TrackedQueryRequest } from "@ainyc/canonry-contracts";
import { withRetry } from "./utils.js";
import type {
  ClaudeConfig,
  RetrievalContract,
  RetrievalStatus,
  ClaudeHealthcheckResult,
  ClaudeNormalizedResult,
  ClaudeRawResult,
  ClaudeTrackedQueryInput,
  GroundingSource,
} from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const VALIDATION_PATTERN = /^claude-/;

/**
 * The measurement contract this provider executes, recorded alongside every
 * result so trends cannot silently mix methods.
 *
 * `search-required-v1` means: the unmodified user query, no system prompt, and
 * `tool_choice` pinned to `web_search` so retrieval is guaranteed by an API
 * control rather than coaxed. It measures a search-grounded answer. It is NOT a
 * reproduction of Claude.ai, whose system instructions, routing, and search
 * policy are not public and cannot be replicated through this API.
 *
 * Why the contract has to be explicit at all: Claude decides for itself whether
 * a query warrants a search, and Sonnet 5 decides far more conservatively than
 * Sonnet 4.6. Over a 60-day window Sonnet 4.6 searched on all 136 tracked
 * answers; Sonnet 5 on 84 of 119. All 35 unsearched answers stored zero cited
 * domains and zero mentions, indistinguishable at rest from an answer that
 * searched and did not mention the brand, while sitting in the denominator of
 * every visibility rate.
 *
 * Why `tool_choice` and not a system prompt: a system prompt is probabilistic
 * and steers persona, tone, and source policy as well as retrieval, which
 * contaminates the substance being measured. `tool_choice` is the documented
 * API control for requiring a tool invocation and changes nothing else.
 * `max_uses` is a ceiling and cannot raise the retrieval floor.
 *
 * Measured on the five queries that lost retrieval in production
 * (claude-sonnet-5, n=5 per mode): native 1/5 retrieval, 1.4 cited domains,
 * 2920 answer chars; this contract 5/5, 5.0 cited domains, 4520 answer chars,
 * `end_turn` on every response. Forcing prefills the assistant turn, so no
 * preamble is emitted before the tool call, but the final answer we parse is
 * unaffected.
 *
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */
export const CLAUDE_RETRIEVAL_CONTRACT: RetrievalContract = "search-required-v1";

/**
 * Resolve the effective model name, validating that it is a recognised Claude
 * model identifier (must start with "claude-"). If an invalid name is stored
 * the default is used and a warning is logged.
 */
function resolveModel(config: ClaudeConfig): string {
  const m = config.model;
  if (!m) return DEFAULT_MODEL;
  if (VALIDATION_PATTERN.test(m)) return m;
  console.warn(
    `[provider-claude] Invalid model name "${m}" — this provider uses the Anthropic API ` +
      `which only accepts "claude-*" model names. ` +
      `Falling back to ${DEFAULT_MODEL}.`,
  );
  return DEFAULT_MODEL;
}

export function validateConfig(config: ClaudeConfig): ClaudeHealthcheckResult {
  if (!config.apiKey || config.apiKey.length === 0) {
    return { ok: false, provider: "claude", message: "missing api key" };
  }
  const model = resolveModel(config);
  const warning =
    config.model && !VALIDATION_PATTERN.test(config.model)
      ? ` (invalid model "${config.model}" replaced with default)`
      : "";
  return {
    ok: true,
    provider: "claude",
    message: `config valid${warning}`,
    model,
  };
}

export async function healthcheck(
  config: ClaudeConfig,
): Promise<ClaudeHealthcheckResult> {
  const validation = validateConfig(config);
  if (!validation.ok) return validation;

  try {
    const model = resolveModel(config);
    const client = new Anthropic({ apiKey: config.apiKey });
    const response = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 32,
        messages: [{ role: "user", content: 'Say "ok"' }],
      }),
    );
    const text = extractTextFromResponse(response);
    return {
      ok: text.length > 0,
      provider: "claude",
      message:
        text.length > 0
          ? "claude api key verified"
          : "empty response from claude",
      model,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      provider: "claude",
      message: describeError(err),
      model: resolveModel(config),
    };
  }
}

/** The Messages API path a tracked query is sent to, synchronously or as a batch line. */
export const CLAUDE_MESSAGES_ENDPOINT = "/v1/messages";

/**
 * The first half of `executeTrackedQuery`: the exact Messages API request it
 * sends. A batch line is built from the same body, so both dispatch modes ask
 * Claude the identical question.
 */
export function buildTrackedQueryRequest(
  input: ClaudeTrackedQueryInput,
): TrackedQueryRequest {
  const webSearchTool: Record<string, unknown> = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 5,
  };
  if (input.location) {
    webSearchTool.user_location = {
      type: "approximate",
      city: input.location.city,
      region: input.location.region,
      country: input.location.country,
      ...(input.location.timezone ? { timezone: input.location.timezone } : {}),
    };
  }

  const body = {
    model: resolveModel(input.config),
    max_tokens: 4096,
    tools: [webSearchTool as unknown as WebSearchTool20250305],
    // search-required-v1: retrieval is guaranteed by the API control, so the
    // query text and answer substance stay untouched. See the contract note.
    tool_choice: { type: "tool", name: "web_search" },
    messages: [{ role: "user", content: input.query }],
  } satisfies MessageCreateParamsNonStreaming;

  return { endpoint: CLAUDE_MESSAGES_ENDPOINT, body };
}

export async function executeTrackedQuery(
  input: ClaudeTrackedQueryInput,
): Promise<ClaudeRawResult> {
  const params = buildTrackedQueryRequest(input)
    .body as unknown as MessageCreateParamsNonStreaming;
  const client = new Anthropic({ apiKey: input.config.apiKey });

  let response: Anthropic.Message;
  try {
    response = await withRetry(() => client.messages.create(params));
  } catch (err: unknown) {
    const msg = describeError(err);
    throw new Error(`[provider-claude] ${msg}`);
  }
  return parseTrackedQueryResponse(response, params.model);
}

/**
 * The second half of `executeTrackedQuery`: read one Messages API response
 * into a result. `body` is the SDK's `Message` or the same message as JSON (a
 * batch line's `result.message`); `model` is the model the request asked for.
 *
 * Anthropic can report a failed web search inside a successful response, as a
 * `web_search_tool_result_error` block. That throws here, so a batch line
 * fails exactly where the sync call always has.
 */
export function parseTrackedQueryResponse(
  body: object,
  model: string,
): ClaudeRawResult {
  const rawResponse = responseToRecord(body);
  const parsed = reparseStoredResult(rawResponse);
  if (parsed.providerError) {
    throw new Error(`[provider-claude] ${parsed.providerError}`);
  }

  return {
    provider: "claude",
    rawResponse,
    model,
    servedModel: extractServedModel(rawResponse),
    groundingSources: parsed.groundingSources,
    searchQueries: parsed.searchQueries,
    retrievalStatus: parsed.retrievalStatus,
    retrievalContract: CLAUDE_RETRIEVAL_CONTRACT,
    usage: extractUsageFromRaw(rawResponse),
    stopReason: extractStopReasonFromRaw(rawResponse),
  };
}

export function normalizeResult(raw: ClaudeRawResult): ClaudeNormalizedResult {
  const parsed = reparseStoredResult(raw.rawResponse);
  const useParsed = hasParsedResponseContent(raw.rawResponse);
  const groundingSources = useParsed
    ? parsed.groundingSources
    : raw.groundingSources;
  const searchQueries = useParsed ? parsed.searchQueries : raw.searchQueries;
  const citedDomains = extractCitedDomainsFromSources(groundingSources);

  return {
    provider: "claude",
    answerText: parsed.answerText,
    citedDomains,
    groundingSources,
    searchQueries,
    retrievalStatus: useParsed ? parsed.retrievalStatus : raw.retrievalStatus,
  };
}

function hasParsedResponseContent(
  rawResponse: Record<string, unknown>,
): boolean {
  return Array.isArray(rawResponse.content) && rawResponse.content.length > 0;
}

/**
 * Read the model Claude reported serving off a stored raw response. A response that
 * omits `model` yields undefined rather than the configured model.
 */
export function extractServedModel(
  rawResponse: Record<string, unknown>,
): string | undefined {
  return normalizeServedModel(rawResponse.model);
}

export function reparseStoredResult(
  rawResponse: Record<string, unknown>,
): ClaudeNormalizedResult & { providerError?: string } {
  const groundingSources = extractGroundingSourcesFromRaw(rawResponse);
  const searchQueries = extractSearchQueriesFromRaw(rawResponse);

  const providerErrors = extractWebSearchToolErrors(rawResponse);

  return {
    provider: "claude",
    answerText: extractAnswerTextFromRaw(rawResponse),
    citedDomains: extractCitedDomainsFromSources(groundingSources),
    groundingSources,
    searchQueries,
    retrievalStatus: extractRetrievalStatusFromRaw(rawResponse),
    ...(providerErrors.length > 0
      ? { providerError: `web_search tool error: ${providerErrors.join(", ")}` }
      : {}),
  };
}

// --- Internal helpers ---

function extractTextFromResponse(response: Anthropic.Message): string {
  try {
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        parts.push(block.text);
      }
    }
    return parts.join("");
  } catch {
    return "";
  }
}

function extractGroundingSourcesFromRaw(
  rawResponse: Record<string, unknown>,
): GroundingSource[] {
  const sources: GroundingSource[] = [];
  const seen = new Set<string>();
  try {
    // Anthropic distinguishes retrieved `web_search_result` entries from final citations on
    // `text.citations` entries with `type: "web_search_result_location"`, so we only count
    // the latter as citation evidence.
    // Docs: https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
    // SDK: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
    const content = rawResponse.content as
      | Array<{
          type?: string;
          citations?: Array<{
            type?: string;
            url?: string;
            title?: string | null;
          }> | null;
        }>
      | undefined;
    if (!content) return [];

    for (const block of content) {
      if (block.type === "text" && Array.isArray(block.citations)) {
        for (const citation of block.citations) {
          if (
            citation.type === "web_search_result_location" &&
            typeof citation.url === "string" &&
            !seen.has(citation.url)
          ) {
            seen.add(citation.url);
            sources.push({
              uri: citation.url,
              title: citation.title ?? "",
            });
          }
        }
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return sources;
}

/**
 * Read retrieval from the presence of a `server_tool_use` block rather than from
 * `searchQueries`. A search whose query string is absent or unparseable still
 * counts: retrieval is the denominator question, the query text is only
 * telemetry.
 *
 * A response with no usable content array yields `unknown`, never `not-used`.
 * Collapsing the two would assert an absence we never observed, which is exactly
 * the unmarked-snapshot failure this field exists to prevent.
 */
function extractRetrievalStatusFromRaw(
  rawResponse: Record<string, unknown>,
): RetrievalStatus {
  try {
    const content = rawResponse.content as
      | Array<{ type?: string; name?: string }>
      | undefined;
    if (!Array.isArray(content) || content.length === 0) return "unknown";
    return content.some(
      (block) =>
        block.type === "server_tool_use" && block.name === "web_search",
    )
      ? "used"
      : "not-used";
  } catch {
    return "unknown";
  }
}

function extractSearchQueriesFromRaw(
  rawResponse: Record<string, unknown>,
): string[] {
  const queries = new Set<string>();
  try {
    // Anthropic's web-search response examples show the executed search on the preceding
    // `server_tool_use.input.query` block, so we recover telemetry from that block instead
    // of from `web_search_tool_result`.
    // Docs: https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
    const content = rawResponse.content as
      | Array<{
          type?: string;
          name?: string;
          input?: {
            query?: unknown;
            queries?: unknown;
          };
        }>
      | undefined;
    if (!content) return [];

    for (const block of content) {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        if (
          typeof block.input?.query === "string" &&
          block.input.query.length > 0
        ) {
          queries.add(block.input.query);
        }
        if (Array.isArray(block.input?.queries)) {
          for (const query of block.input.queries) {
            if (typeof query === "string" && query.length > 0) {
              queries.add(query);
            }
          }
        }
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return [...queries];
}

function extractAnswerTextFromRaw(
  rawResponse: Record<string, unknown>,
): string {
  try {
    const content = rawResponse.content as
      | Array<{
          type: string;
          text?: string;
        }>
      | undefined;

    if (!content) return "";

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      }
    }
    return parts.join("");
  } catch {
    return "";
  }
}

function extractWebSearchToolErrors(
  rawResponse: Record<string, unknown>,
): string[] {
  const errors = new Set<string>();
  try {
    // Anthropic documents that web-search failures can still arrive in a successful message
    // response as `web_search_tool_result` blocks whose `content` is a
    // `web_search_tool_result_error`.
    // Docs: https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool
    // SDK: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
    const content = rawResponse.content as
      | Array<{
          type?: string;
          content?: unknown;
        }>
      | undefined;
    if (!content) return [];

    for (const block of content) {
      if (block.type !== "web_search_tool_result") continue;
      if (
        block.content === null ||
        typeof block.content !== "object" ||
        Array.isArray(block.content)
      )
        continue;
      const errorCode = (block.content as { error_code?: unknown }).error_code;
      if (typeof errorCode === "string" && errorCode.length > 0) {
        errors.add(errorCode);
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return [...errors];
}

/**
 * Billable usage off a Messages API response. `input_tokens` already excludes
 * cache reads and writes, which Anthropic reports separately, and
 * `server_tool_use.web_search_requests` counts the searches billed per call.
 * A response with no usage block yields undefined, never a zero-cost answer.
 * Docs: https://platform.claude.com/docs/en/api/messages
 */
function extractUsageFromRaw(
  rawResponse: Record<string, unknown>,
): ProviderUsage | undefined {
  const usage = rawResponse.usage as
    | {
        input_tokens?: unknown;
        cache_read_input_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
        output_tokens?: unknown;
        server_tool_use?: { web_search_requests?: unknown } | null;
      }
    | null
    | undefined;
  if (usage === null || typeof usage !== "object") return undefined;

  return {
    inputTokens: usageCount(usage.input_tokens),
    cachedInputTokens: usageCount(usage.cache_read_input_tokens),
    cacheWriteTokens: usageCount(usage.cache_creation_input_tokens),
    outputTokens: usageCount(usage.output_tokens),
    searchCount: usageCount(usage.server_tool_use?.web_search_requests),
  };
}

/** `stop_reason` verbatim (`end_turn`, `max_tokens`, `pause_turn`, …). */
function extractStopReasonFromRaw(
  rawResponse: Record<string, unknown>,
): string | undefined {
  const stopReason = rawResponse.stop_reason;
  return typeof stopReason === "string" && stopReason.length > 0
    ? stopReason
    : undefined;
}

function extractCitedDomainsFromSources(
  groundingSources: GroundingSource[],
): string[] {
  const domains = new Set<string>();

  for (const source of groundingSources) {
    const domain = extractDomainFromUri(source.uri);
    if (domain) domains.add(domain);
  }

  return [...domains];
}

function extractDomainFromUri(uri: string): string | null {
  const hostname = hostOf(uri);
  if (
    !hostname ||
    !registrableDomain(hostname) ||
    hostMatchesAnyDomain(hostname, AI_ENGINE_SELF_DOMAINS.chatgpt)
  ) {
    return null;
  }
  return hostname;
}

export async function generateText(
  prompt: string,
  config: ClaudeConfig,
): Promise<string> {
  const model = resolveModel(config);
  const client = new Anthropic({ apiKey: config.apiKey });
  const response = await withRetry(() =>
    client.messages.create({
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  );
  return extractTextFromResponse(response);
}

/**
 * Detach a response into plain JSON, the shape stored as `apiResponse`. Both
 * the SDK's `Message` and a batch line's `result.message` go through it, so a
 * sync row and a batch row are stored identically.
 */
export function responseToRecord(response: object): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
  } catch {
    return { error: "failed to serialize response" };
  }
}

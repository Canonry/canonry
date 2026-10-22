// The `canonry-guards` plugin: drift and boundary guards, loaded by oxlint as a
// JS plugin (`.oxlintrc.json` → `jsPlugins`). The rules use the ESLint rule
// format, which oxlint runs. Their scopes and exemptions live in
// `.oxlintrc.json`; every guard has its own rule id (see docs/GUARDS.md).
import { noInlinePercentRule } from './no-inline-percent.js'
import { noSecondQueryClassifierRule } from './no-second-query-classifier.js'
import { createRestrictedSyntaxRule } from './restricted-syntax.js'

// Drift guard: GA4 dimension/metric names must come from `GA4_DIMENSIONS` /
// `GA4_METRICS` in `packages/integration-google-analytics/src/constants.ts`.
// CI broke once when source and test drifted on `sessionDefaultChannelGroup`
// vs `…Grouping`; the constant makes that class of failure impossible.
const inlineGa4DimensionRule = createRestrictedSyntaxRule({
  description: 'Disallow inline GA4 dimension/metric name literals outside constants.ts.',
  restrictions: [{
    selector: "Literal[value=/^(sessionSource|sessionMedium|sessionManualSource|sessionManualMedium|firstUserSource|firstUserMedium|firstUserDefaultChannelGroup|sessionDefaultChannelGroup|sessionDefaultChannelGrouping|landingPagePlusQueryString)$/]",
    message: 'Use GA4_DIMENSIONS from ./constants.ts — never inline raw dimension names. See packages/integration-google-analytics/src/constants.ts.',
  }],
})

// Drift guard: AI-engine hostnames in production code must come from
// `AI_ENGINE_DOMAINS` in `packages/contracts/src/ai-engines.ts`. Tests are
// exempt because fixtures are local to their assertions and don't drift
// across files.
const inlineAiHostnameRule = createRestrictedSyntaxRule({
  description: 'Disallow raw AI-provider hostname literals in production code.',
  restrictions: [{
    selector: "Literal[value=/^(openai\\.com|chatgpt\\.com|chat\\.openai\\.com|claude\\.ai|perplexity\\.ai|gemini\\.google\\.com|bard\\.google\\.com|copilot\\.microsoft\\.com|copilot\\.com|deepseek\\.com|meta\\.ai|grok\\.com|you\\.com|phind\\.com|anthropic\\.com|googleapis\\.com|vertexaisearch\\.cloud\\.google\\.com)$/]",
    message: 'Use AI_ENGINE_DOMAINS / AI_PROVIDER_INFRA_DOMAINS / ANTHROPIC_API_DOMAIN / GOOGLE_APIS_DOMAIN / VERTEX_AI_SEARCH_PROXY_DOMAIN from @canonry/canonry-contracts — never inline raw AI-provider hostnames in production code.',
  }],
})

// SDK enforcement (web): every web call into the canonry API must flow through
// the generated `@canonry/canonry-api-client` SDK (raw call or TanStack helper),
// with auth + 401/403 handling provided by the shared `heyClient` from
// `apps/web/src/api.ts`. Raw `fetch()` to API URLs bypasses every spec-derived
// contract and the auth interceptor.
const rawHttpWebRule = createRestrictedSyntaxRule({
  description: 'Disallow raw fetch() / XMLHttpRequest in web code — call the generated SDK.',
  restrictions: [{
    selector: "CallExpression[callee.name='fetch']",
    message: 'Use the generated `@canonry/canonry-api-client` SDK (via `heyClient` from `apps/web/src/api.ts`) instead of raw `fetch()`. Spec drift + auth interceptor bypass is silent and pernicious. For an endpoint missing a typed DTO, add a Zod schema in `packages/contracts` and flip the route to `jsonResponse(...)` first.',
  }, {
    selector: "NewExpression[callee.name='XMLHttpRequest']",
    message: 'Use the generated `@canonry/canonry-api-client` SDK (via `heyClient` from `apps/web/src/api.ts`) instead of `XMLHttpRequest`.',
  }],
})

// Analog of the web SDK enforcement, for the CLI. Every CLI / job runner /
// server-internal call into the canonry API must go through `ApiClient` (which
// delegates to the generated SDK via `invoke()`), not raw `fetch()`.
const rawHttpCliRule = createRestrictedSyntaxRule({
  description: 'Disallow raw fetch() in CLI code — call the canonry API through ApiClient.',
  restrictions: [{
    selector: "CallExpression[callee.name='fetch']",
    message: 'Use the generated `@canonry/canonry-api-client` SDK via `ApiClient` / `createApiClient()` (which routes through `invoke()` for tracing, CliError mapping, and the base-path probe) instead of raw `fetch()`. If you genuinely need raw `fetch()` for an external (non-canonry) HTTP call, add the file to the `no-raw-http-cli` exemption override in `.oxlintrc.json` with a one-line comment naming the external service.',
  }],
})

export default {
  meta: { name: 'canonry-guards' },
  rules: {
    'no-inline-ga4-dimension': inlineGa4DimensionRule,
    'no-inline-ai-hostname': inlineAiHostnameRule,
    'no-raw-http-web': rawHttpWebRule,
    'no-raw-http-cli': rawHttpCliRule,
    'no-inline-percent': noInlinePercentRule,
    'no-second-query-classifier': noSecondQueryClassifierRule,
  },
}

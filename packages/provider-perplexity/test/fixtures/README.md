# Perplexity Agent API fixtures

These are **not live captures.** No Perplexity API key was available when the
provider moved from Sonar to the Agent API, so each file here is written to the
response schema in Perplexity's official TypeScript SDK
(`@perplexity-ai/perplexity_ai@0.38.5`, `src/generated/api.ts`:
`ResponsesResponseOutput`, `SearchResultsOutputItemOutput`,
`MessageOutputItemOutput`) and to Perplexity's migration guide. Field names and
nesting follow that schema exactly; the values are made up.

Replace them with real captures when a key is available. The request shapes and
`curl` commands are in `docs/providers/perplexity.md` → "Capturing fixtures".
Keep the file names, then update the exact values the tests assert.

| File | Case |
|------|------|
| `agent-fast-cited.json` | `fast` preset, forced web search, sources and an answer with `[n]` citations |
| `agent-search-no-results.json` | the search ran and returned no results |
| `agent-no-search.json` | an answer with no retrieval item |
| `agent-failed.json` | a failed run, which the API returns as HTTP 200 |
| `agent-error-400.json` | the error envelope for a rejected request body |

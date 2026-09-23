# provider-muse

Implements the Meta Model API Muse Spark provider using the Responses API at `https://api.meta.ai/v1`. Keep the tracked query unchanged and let Muse decide whether to invoke `web_search`; record `native-auto-v1`. Search activity comes from completed `web_search_call` items, while cited sources come only from `url_citation` annotations on message `output_text` blocks. Raw search results are retrieval evidence, never citation evidence.

The default `muse-spark-1.3` and model discovery use Standard Muse Spark text models. Contributor variants permit training on prompts and completions, so they must not be suggested by default; an explicitly configured Contributor model is allowed. The healthcheck and `generateText` omit the search tool. Preserve the response's own `model` as `servedModel`, with no fallback to the configured model.

When changing parsing, keep `reparseStoredResult` aligned with live normalization and test malformed/partial stored responses. Meta's search guide: https://dev.meta.ai/docs/search-grounding; model catalog: https://dev.meta.ai/docs/models.

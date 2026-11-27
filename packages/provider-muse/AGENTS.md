# provider-muse

The Muse Spark adapter uses the Meta Model API at `https://api.meta.ai/v1`. Send the unchanged query and let Muse decide whether to call `web_search`. Record `native-auto-v1`.

The adapter records search use when the response has answer text and a completed `web_search_call`. Keep `include: ['web_search_call.results']` for retrieved-page evidence in `retrievedSources`. Only `url_citation` annotations on final message `output_text` blocks feed citations. Keep `meta.ai` in the adapter's own self-domain list.

Store observations from intact `completed` and `incomplete` responses, including a refusal. Other response statuses fail the query.

The default `muse-spark-1.3` and model discovery use Standard Muse Spark text models. Contributor variants permit training on prompts and completions, so they must not be suggested by default; an explicitly configured Contributor model is allowed. The healthcheck and `generateText` omit the search tool. Preserve the response's own `model` as `servedModel`, with no fallback to the configured model.

When changing parsing, keep `reparseStoredResult` aligned with live normalization and test malformed/partial stored responses. Meta's search guide: https://dev.meta.ai/docs/search-grounding; model catalog: https://dev.meta.ai/docs/models.

## Test ownership

`test/muse.test.ts` owns native SDK request/response behavior through fake HTTP,
including distinct requested/served models, explicit Contributor dispatch and
actual nonzero Retry-After deadlines. Keep SDK construction and config conversion
private; test their behavior through `museAdapter`. Stored parsing remains a
separate durable-read contract. `packages/canonry/test/job-runner-muse.test.ts`
owns Simple/Advanced persistence and requested versus applied location. Synthetic
Meta bodies are fixtures, not live provider captures.

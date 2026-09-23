# Muse Spark provider

Canonry calls the [Meta Model API](https://dev.meta.ai/docs/overview) through its Responses API at `https://api.meta.ai/v1`. The default model is `muse-spark-1.3` on Meta's Standard tier.

## Configure

Get a key from the [Meta Model API dashboard](https://dev.meta.ai/). Configure it with one of these methods:

```bash
cnry settings provider muse --api-key <key>
cnry init --muse-key <key>
```

You can set `MUSE_API_KEY` before `cnry bootstrap` or `cnry init`. These commands store it in the local configuration.

`MUSE_MODEL` and `MUSE_BASE_URL` set the model and endpoint during setup. Change quota limits with `cnry settings provider muse --max-concurrent <n> --max-per-minute <n> --max-per-day <n>`. `cnry serve` reads the stored configuration at `~/.canonry/config.yaml`.

```yaml
providers:
  muse:
    apiKey: <key>
    model: muse-spark-1.3
    baseUrl: https://api.meta.ai/v1
    quota:
      maxConcurrency: 2
      maxRequestsPerMinute: 10
      maxRequestsPerDay: 1000
```

Select Muse for a project or one run:

```bash
cnry project update my-site --provider muse
cnry run my-site --provider muse --wait
```

`--provider` on `project update` replaces that project's selected provider list. Use it with every provider you want to retain. A run override applies to that run only. Each provider call consumes Meta Model API quota.

Meta also offers Contributor tier models. Meta [states](https://dev.meta.ai/docs/models) that this tier permits training on prompts and completions. Canonry's default and automatic model suggestions use Standard tier. An operator can opt in by setting an exact Contributor model ID with `--model` or `--provider-model muse=<model-id>`.

## Search and evidence

Canonry sends the tracked query to the Responses API with `web_search` available. Muse decides whether to search. Canonry does not force `tool_choice`. When a run has a location, the adapter passes an approximate `user_location` on the search tool. If Muse does not search, Simple and Advanced Measurement store no applied location. Both preserve the requested location and mark it as ignored.

Report location filters describe the requested measurement scope. They do not prove that an answer used location-based search.

Search use is `used` only when a response with a usable answer contains a completed `web_search_call`. It is `not-used` when the response establishes that no search ran. It is `unknown` when the response cannot establish that fact. The retrieval contract is `native-auto-v1`.

Canonry counts only `url_citation` annotations on final `message` → `output_text` blocks as cited sources; `commentary` messages are not part of the answer. Canonry does not request `web_search_call.results`: retrieved pages do not prove that the answer cited them. A search can run without a citation, and an answer can have no search call. The separate mention signal comes from the answer text.

A refused or truncated (`incomplete`) answer is stored as an observation, with the text and citations it carries. A `failed` response fails the query with Meta's error code; rate-limit and server errors are retried first.

This measures Meta Model API responses. It makes no claim about citations or behavior in Meta's consumer interfaces. See Meta's [search grounding guide](https://dev.meta.ai/docs/search-grounding) and [model list](https://dev.meta.ai/docs/models).

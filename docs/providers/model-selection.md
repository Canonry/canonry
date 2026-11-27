# How Canonry selects models and measures answers

Canonry measures how AI answers mention your brand and cite your website.
API sweeps can use direct providers and explicitly selected OpenRouter routes.
Each adapter defines its request policy and records the evidence that the service
returns.

## The measurement is more than the model

A visibility observation depends on the model, search tool, request policy,
location treatment, and returned evidence. The same model name through a
different API does not prove equivalent behavior.

Canonry keeps answer mentions separate from source citations. A model can name
a brand without citing its website. Retrieved pages are also distinct from
sources that support the final answer.

Direct adapters preserve evidence that their provider returns. For example,
the Gemini adapter retains grounding chunks, answer-support mappings, and
issued search queries. These fields help explain a visibility change.
Available evidence varies by provider. See the
[provider guides](README.md#provider-specific-documentation) for the fields that
each adapter records.

## Direct APIs and OpenRouter routes

Each direct adapter uses its provider's search controls and citation format.
An [OpenRouter route](openrouter.md) pins a model with an
`openrouter:<publisher>/<model>` provider ID. Routes share one OpenRouter
connection and its quota. Select each route explicitly for a sweep.

The OpenRouter adapter requests web search and disables provider fallback. It
records the requested model and any served model the response identifies. Its
`url_citation` annotations supply source links. The adapter records a requested
location as ignored.

The direct and OpenRouter versions of a model have separate results and
history. Use the route identity and its evidence rules when you compare results.

## How we choose a model

The selection criteria cover the complete provider request, not general
reasoning scores alone:

1. **Answer capture:** the adapter preserves final answer text for separate
   brand and competitor mention measurement.
2. **Search support:** the model supports the adapter's retrieval tool and
   request controls.
3. **Citation evidence:** the response distinguishes final-answer citations
   from retrieved sources and links written in plain text.
4. **Diagnostic evidence:** the adapter retains available search queries,
   source metadata, and model identity, with explicit limits for absent fields.
5. **Location treatment:** the adapter documents whether location uses a
   structured request field, prompt context, or no supported control.
6. **Operating cost:** token cost, search cost, latency, and quotas permit
   repeated measurements at the intended scale.
7. **Regression coverage:** request and parser tests cover answer mentions,
   source citations, missing evidence, and provider errors.

Provider defaults and known-model lists remain explicit in each adapter.
Some adapters also accept custom model IDs. An accepted ID or successful text
completion does not certify the full measurement contract. Model changes need
a review of the evidence contract and historical comparability.

## Evidence limits

Answers can vary between API runs. Browser measurements use a separate adapter
for consumer chat applications. [Local models](local.md) measure mentions and
report citations as unmeasured.

## The same rules for both portfolio types

Simple portfolios and Advanced Measurement portfolios use the same provider
evidence rules. Advanced Measurement retains Property, Target, market,
provider, and query-class scope. An aggregate does not upgrade missing evidence
or make different measurement methods interchangeable.

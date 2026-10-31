# Search answer services

A search answer service is a hosted service that searches the web and returns a grounded answer with sources (for example an answer endpoint from a search company). Canonry treats every such service through one shared layer in `packages/provider-answer-services/`. A vendor is a thin adapter: a descriptor, a request builder, a response parser, documentation-derived test fixtures and its own docs page. This page describes the shared behavior every vendor inherits; each registered vendor's page covers only what is specific to it.

## Registered services

The registered services come from `ANSWER_SERVICES` in `packages/provider-answer-services/src/services/index.ts`, and every surface reads them from there: `cnry settings` (and `GET /api/v1/settings`, the `canonry_settings_get` MCP tool and the dashboard) lists each service with its key variable, its profile routes and the workflows each profile allows. Each service's own page lives in [`answer-services/`](./answer-services/) and is linked from its descriptor (`docsPath`); this page never lists them, so adding a service does not edit it.

## Connections and profiles

Each service is one connection with one API key, stored in `~/.canonry/config.yaml` under `providers.<service>.apiKey`. The connection alone runs nothing. Projects, runs and research pick a profile route, `<service>:<profile>`, for example `<service>:standard`. A profile freezes the request knobs the vendor offers (a tier, an effort or a search depth) and is part of the stored identity, so two profiles never share history.

```bash
cnry settings provider <service> --api-key <key>
cnry settings                       # lists each service's profiles and the workflows they allow
cnry project update my-site --provider gemini --provider <service>:<profile>
cnry research run my-site --provider <service>:<profile> --query "best roofer in springfield"
```

The endpoint is fixed by the descriptor: a base URL or a connection model is refused, so a key can never be sent elsewhere. A key is checked with a metadata request when the vendor documents a free one; otherwise it is saved and marked "not verified" until the first real request.

## Never selected implicitly

Connecting a service never changes what existing projects measure:

- An empty project provider list ("All configured engines"), schedules without providers, snapshots and research without a provider, setup readiness and discovery defaults never include an answer service.
- Query generation, snapshot profiling and assessment, classification, Aero and sentiment need plain text generation, which no answer service offers. A snapshot with only answer services runs its manual queries and uses the fallback assessment.
- Choosing a profile that is not yet saved on the project needs `settings.write`, like choosing an OpenRouter model.

Each profile lists the workflows it may run (`research`, `snapshot`, `visibility-sweep`). A profile can join visibility sweeps only when its sources are tied to the answer (cited in the text or documented as used for the answer) and it answers synchronously. Job-based products (deep research that runs in the background) are declared but not run in this release; a pending upstream job is never stored as an answer.

## Evidence

Every answer stores vendor-neutral evidence alongside the usual columns (`evidence` on research queries, run snapshots and prospect snapshot results):

| Field | Meaning |
|---|---|
| `sources[].relationship` | `explicit-citation` (referenced from the answer), `answer-support` (documented as used for the answer), `search-result` (returned by a search, not tied to the answer), `page-read` (a page the service opened) |
| `completion.status` | `complete`, `partial`, `failed` or `pending`, with the upstream finish reason, request id and job id |
| `identity` | service, product, profile, frozen settings, the requested service model, and the disclosed model with its kind (`foundation-model`, `service-tier`, `unknown`) |
| `usage` | token, search and page-read counts with their basis (`reported`, `approximate`, `derived-from-evidence`, `unknown`) and cost with its basis (`reported`, `estimated`, `unknown`) |
| `location` | what was requested, what was sent, and whether it was `applied`, `partial` or `ignored` |
| `retrievalStatus`, `citationBasis`, `citationMeasurable`, `rawTruncated` | see below |

Rules the shared layer enforces for every vendor:

- Only `explicit-citation` and `answer-support` sources feed `citedDomains`, `groundingSources` and citation states. Search results and page reads are kept as evidence and never counted as citations.
- A profile whose sources are search results only records no citation state (`citationMeasured: false`); mentions are still measured from the answer text.
- Only a complete answer is measured. A partial, failed or pending answer is stored as a failed query with its evidence and any partial text, and its metrics stay empty.
- A served model is recorded only when the response discloses a foundation model. A product tier or nothing stays out of `servedModel`.
- Unknown counts and costs stay unknown. Snapshot `usage` is empty unless tokens are reported and the search count is known, never a zero nobody measured. A cost estimate names who made it (`estimatedBy`), and every surface labels it that way.
- A prospect snapshot counts an answer whose citation was not measured in its mentions only: `citationComparisons` is the citation denominator, and the report says "not measured" rather than "not cited".
- Retrieval is `used` when any source, search event or reported search exists, `not-used` only when a service that reports every search as an event returned a complete answer with none, and `unknown` otherwise.
- Queries are sent unmodified with no added instructions (`retrievalContract: service-native-v1`). A query longer than the profile accepts is refused before any request, never truncated.
- A location is sent only as far as the profile's granularity allows, and the stored treatment comes from what the request builder reports it actually sent. A country-only service records a city context as `partial`; a builder that leaves out a value its vendor cannot take (a country outside a documented list) records the location as `ignored`; neither row claims it was measured from that place.
- Source excerpts are stored one passage per item, at most 20 per source and 2,000 characters each; the shared layer enforces the bounds and marks a shortened source `excerptsTruncated`. The raw response keeps the full text.
- Source URLs are stored as cited page URLs only when the profile declares them direct (`evidence.directUrls`); redirect or tracking links leave `citedUrls` empty with capture status `unsupported`.
- A pending upstream job from a synchronous request cannot be followed, so the query fails and keeps the job id in its evidence. A job the adapter can follow (a job profile, once a job executor runs them) leaves the research query `waiting-upstream` with its `upstreamJobId`, counted as neither completed nor failed, and the run `waiting-upstream` until it resumes; it is never submitted again.

## Requests, retries and limits

All requests go through one HTTP layer: the descriptor's auth header, a per-profile deadline, a response size cap (a raw payload over 1 MB is replaced by a marker and `rawTruncated` is set), and the shared execution gate and daily quota of the connection. Retries happen only for statuses the vendor documents as safe (throttles and declared server errors), honour `Retry-After`, and never happen once a response body began or after a dropped connection, because the paid request may already have been billed. Streamed answers that end before the vendor's final event are partial.

## Adding a vendor

1. Create `packages/provider-answer-services/src/services/<vendor>/` with `descriptor.ts` (an `AnswerServiceDescriptor`), `request.ts` (a pure `buildRequest` that returns the request and the location it actually carries) and `parse.ts` (a pure `parseResponse`, or `parseEvents` plus `isTerminalEvent` for streams), exported as one `AnswerServiceDefinition`.
2. Add it to `ANSWER_SERVICES` in `src/services/index.ts`.
3. Add documentation-derived fixtures under `test/services/<vendor>/` and one entry in `test/services/index.ts`. Each fixture follows the vendor's documented response shape exactly, including fields the parser ignores, and says which documentation page it comes from. Cover every case in the shared matrix or declare it not applicable with the documented reason.
4. Write `docs/providers/answer-services/<vendor>.md` and point the descriptor's `docsPath` at it.

Nothing else changes: settings, routes, eligibility, the dashboard pickers, the CLI and MCP, this page and the agent skill reference all read the descriptor or point at it. The shared conformance test runs the descriptor rules and the case matrix over every registered vendor and over a test-only fake service.

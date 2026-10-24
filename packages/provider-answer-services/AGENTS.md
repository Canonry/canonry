# provider-answer-services

One shared layer for hosted web-search answer services (a service that
searches the web and returns a grounded answer with sources). Behavior and the
vendor checklist: `docs/providers/answer-services.md`.

- `src/core/` is vendor-neutral: `createAnswerServiceAdapter` (connection plus
  one route per profile, `forRoute`), the HTTP layer (`http.ts`: auth from the
  descriptor, per-profile deadline, size cap, retries only for the descriptor's
  statuses and never after a body began or a dropped connection), the SSE
  runner, and evidence assembly (`evidence.ts`). Nothing in `core/` may name a
  vendor or read a vendor field.
- A vendor is `src/services/<vendor>/` (descriptor, pure request builder, pure
  parser), one entry in `src/services/index.ts`, fixtures and its own page in
  `docs/providers/answer-services/`. A vendor never edits `core/`, contracts,
  api-routes, canonry, the web app, the shared docs page or the agent skill
  reference (they read the descriptor or point at it). If it seems to need
  one, the shared contract is missing a concept: change it for every vendor.
- The request builder returns the request and the location it actually
  carries (`sentLocation`); the factory records the location treatment from
  that, so leave out any value the vendor does not document accepting.
- Definition members are function-typed properties (`buildRequest: (...) =>`),
  never methods: the factory passes them on detached.
- Parsers return relationships the vendor documents. Never label a search
  result a citation, never invent a model, count or cost, and map every
  upstream status to `complete`, `partial`, `failed` or `pending`.
- Fixtures under `test/services/<vendor>/` follow the documented response
  exactly, including ignored fields, and say which documentation page they come
  from and that they are documentation-derived, not captured. The shared matrix
  in `test/conformance.test.ts` runs them; a vendor adds fixtures, not test logic.
- `test/fake-service.ts` (exported as `./testing`) is a test-only service used by
  other packages' end-to-end tests. It is not a vendor and must never be
  registered.
- No test or health check may call a vendor API. Live calls need the owner's approval.

Read root AGENTS.md and the test-audit skill before changing tests.

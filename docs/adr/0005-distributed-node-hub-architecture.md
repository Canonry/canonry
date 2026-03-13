# ADR 0005: Distributed Node + Hub Architecture with Persona-Framed Queries

## Decision

Canonry adopts a hub-and-spoke architecture where local installations act as sensing nodes that sync observation snapshots to a central hub for cross-location, cross-audience analytics. Persona-framed queries are a first-class concept, allowing the same keywords to be tracked across multiple simulated audience segments.

The observation matrix becomes: `keyword × provider × node × persona`.

## Why

- every existing AEO monitoring tool queries LLMs from cloud data centers, producing a single decontextualized perspective that diverges from what real users see as LLM search becomes hyper-localized and personalized
- Canonry's local-first architecture is uniquely positioned: each installation is already on a real user's machine with real location, real browser profile, and real personalization signals
- even if LLM providers eventually ship brand visibility APIs, they will report aggregate statistics — not per-location, per-audience breakdowns; the dimensions captured by distributed nodes + personas are structurally inaccessible to cloud-only tools
- persona-framed queries work with all existing API providers today (system instructions in Gemini, OpenAI, Claude) and require no new infrastructure — immediate differentiation at low cost
- cross-provider, cross-location, cross-audience analytics is a moat that compounds with each additional node in the network

## Consequences

- snapshots gain node identity metadata (`nodeId`, `nodeLocation`, `nodeContext`) and a `personaId` column; existing data stays valid with defaults (`nodeId = 'local'`, `personaId = null`)
- a new `personas` table stores per-project persona definitions with `systemInstruction` (preferred) and `queryPrefix` (fallback) fields
- the job runner fans out across personas: `keyword × provider × persona` per run; `null` persona preserves existing behavior
- each provider adapter applies persona context as a system instruction where the API supports it, falling back to query text modification for providers that don't
- hub mode is a flag on the same binary (`canonry serve --mode hub`), not a separate artifact
- sync protocol is append-only and cursor-based: nodes push snapshots, hub pushes config; nodes are authoritative for their snapshots, hub is authoritative for config
- sync triggers automatically on run completion when a hub is configured, with `canonry sync` as a manual fallback
- sync scope is configurable: normalized summary by default, opt-in to full raw responses
- a browser provider (Chrome MCP first, CDP fallback) will capture the highest-signal localized data from real ChatGPT/Perplexity sessions
- the architecture is additive and backward compatible: single-node installs are unaffected, sync is opt-in, no existing API endpoints change
- the architecture supports open-core monetization (free nodes, paid hub) but no licensing decision is made yet

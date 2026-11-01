# @canonry/val-kit

The host-agnostic core shared by Canonry's public [Val Town](https://val.town) samples.

Each val is its own product with its own surface — its own name, pages, MCP tools, and copy. What they have in
common is everything underneath: the AI-visibility engine, the admission and lease machinery that bounds what an
anonymous visitor can spend, the check stores, the MCP wire format, and the design tokens. That is this package,
so there is one source of truth instead of one per val.

It is pure and portable: no HTTP framework, no crawler, no `Deno` global, no `esm.town` import. Everything that
touches a host — the request handler, the SQLite binding, the environment — is passed in.

## Install

```sh
npm install @canonry/val-kit
```

A Val Town val ignores import maps, so import it by fully-qualified specifier:

```ts
import { runVisibilityProbe } from 'npm:@canonry/val-kit@0.2.0/visibility'
```

## Subpaths

| Subpath | What it holds |
| --- | --- |
| `@canonry/val-kit` | Everything below, in one import |
| `@canonry/val-kit/visibility` | Probe contracts, brand/citation matching, the evidence runner, share of voice, and the Gemini adapter |
| `@canonry/val-kit/perception` | Branded query planning, verdict extraction with verbatim-evidence verification, source typing, and aggregation |
| `@canonry/val-kit/security` | Public-domain normalization (the SSRF input boundary) and Turnstile human verification |
| `@canonry/val-kit/storage` | `MemoryCheckStore` and `ValSqliteCheckStore` (over a `ValSqliteClient` the host supplies) |
| `@canonry/val-kit/jobs` | Check record and store contracts, record identity and expiry, and the admission/lease machinery |
| `@canonry/val-kit/mcp` | Model Context Protocol framing |
| `@canonry/val-kit/ui` | Design tokens and the Canonry mark |
| `@canonry/val-kit/config` | Host environment parsing |

Requires Node 22 or newer, or any runtime with the same web standards (`fetch`, `AbortSignal`, `crypto`).
`@google/genai` is a peer of the visibility subpath and is installed with the package.

---

Powered by [Canonry](https://github.com/Canonry/canonry), the open-source AEO operating platform.

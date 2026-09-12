---
name: canonry
description: "Navigate Canonry through connected MCP tools or the `cnry` CLI to inspect evidence, diagnose changes, plan measurement, review integrations, and report results. Use this optional host-native skill for CLI workflows and detailed references; connected MCP users can operate through canonry_help without installing a local runtime or skill."
---

<!-- Generated from docs/agent-operations/v1.md by pnpm guide:sync. Do not edit. -->

# Canonry Operations Guide v1

Canonry is an agent-first AI visibility platform. MCP is the universal entry
point for connected agents. Host-native skills are optional upgrades, not a
prerequisite or a permission mechanism.

## Connect and choose a route

Read the initialization guidance, then call `canonry_help` with an `intent`:
`status`, `diagnose`, `operations`, `prospecting`, `measurement`, `integrations`,
`reports`, or a short task
description. Select an accessible project with `canonry_projects_list` before
using its exact name in project tools. Inspect each listed tool's input schema;
help suggests tool names, not invented arguments or authorization.

Help returns a versioned, compact route: connection `mode`, available `next`
tools, workflow guidance, approval boundaries, and this guide's URL. It performs
no provider calls, reads no project data, and changes no permissions.
`next` lists stored reads. Optional `actions` lists loaded tools for work that
requires approval; listing an action does not authorize or execute it.
`includeCatalog: true` additionally returns toolkit details when needed.

Hosted connections use a fixed catalog. Help only suggests tools offered by that
connection; it never tells a hosted agent to dynamically load a toolkit. A
progressive local stdio connection may return `loadToolkits`: call
`canonry_load_toolkit` with one returned name, await it, then call help again.
Loading only changes local tool discovery, never server authority.

The optional `canonry://agent-operations/v1` MCP resource contains this same
guide. If the host cannot read resources or open links, continue through help.
Do not install a plugin, local runtime, or skill merely to use connected MCP.
An installed Codex or Claude Canonry skill contains a generated copy of this
guide plus links to host-native references. It does not replace runtime help.

## Vocabulary and evidence

- **Mentioned** means the brand appears in answer text. **Cited** means its
  domain appears in source links. Either, both, or neither can occur; never
  compute one signal from the other.
- `answerMentioned: null` means not checked, not false. Missing runs and empty
  populations mean no measurement, not zero visibility.
- Preserve project, time window, provider, requested/served model, location,
  sample size, and query class when comparing evidence. Use server-returned
  metrics; do not invent a score from incompatible populations.
- Simple projects and Advanced portfolios share the workflow. For Advanced
  results, preserve Property, Target, market, plan revision, and class scope.
  Groups organize navigation; do not infer an unrequested fan-out.
- Research is isolated evidence, not tracked measurement. A probe still spends
  quota and persists evidence but is excluded from normal tracking metrics.

## Workflows

**Status:** read the stored overview and freshness first. Say when evidence is
missing instead of silently creating it.

**Diagnose:** inspect stored history and comparable evidence. Explain what
changed separately from why it might have changed. A hypothesis is not a
measured cause. Propose bounded verification if stored evidence is insufficient.

**Prospecting:** generate a one-shot company snapshot without creating a project.
Inspect stored provider settings first. Agree on the company, domain, selected
providers, and queries before starting the quota-spending snapshot action.
Browser-only selection requires manual queries. Progressive stdio help offers
the discovery toolkit when this connection permits snapshots; load it, then
call help again. Fixed catalogs offer only already available actions. Read-only
and restricted connections must not bypass missing snapshot access.

**Measurement:** inspect the existing setup and results before proposing edits.
Keep research, query tracking, plan publication, and sweep execution separate.
For direct research, submit the final editable query text in one context. For a
reviewed batch, submit each explicit destination with its final text and one
idempotency key. Pattern substitution happens in the client before either
request; choosing a market or Property records a destination only and never
rewrites a query or creates an automatic fan-out. `research.run` does not
authorize saving patterns, changing tracking, publishing plans, or settings.
Use a supported preview where available, inspect its exact destination and
revision, then seek approval for the actual change. A preview may itself require
write permission; never treat a dry-run flag as a universal safety guarantee.

**Integrations:** inspect stored connection state and snapshot freshness first.
Provider configuration evidence does not prove a browser event fired or a
conversion was recorded. Connection, resource selection, refresh/sync, and live
reads are separate actions. Credentials belong in the operator's secure setup
flow, never in chat, tool arguments, reports, or public guidance.

**Reports:** use saved evidence for the requested period and scope. Keep mention
and citation signals separate, include dates and sample sizes, and state missing
or stale inputs. For Advanced Property mention rankings, use
`canonry_measurement_portfolio_summary` and its `mentionRanking.strongest`,
`.weakest`, and `.excluded` lists. It defaults to non-brand questions; state the
returned class and report branded results separately. An unavailable portfolio
aggregate does not invalidate available Property mention rates. Flag excluded
Properties individually; do not silently replace mention ranking with citation
ranking. Keep sample sizes and ties visible. Preparing a report does not
authorize new measurement.

**Instance access:** administrators can use setup tools to list people and
invitations, change roles/status, replace or revoke invitations, and revoke
user-bound access. These changes apply to the whole install, not one project.
Use `canonry_user_list` and `canonry_user_invitation_list` to inspect existing
state before an authorized change. Scope the change to the exact person and
role. Password bootstrap and Google client secrets use the trusted CLI or
settings flow; browser Google linking is not an agent operation.

## Authority and approval

### Agent operations

Use `canonry_key_self` to inspect the current credential's scopes and project
boundary without exposing its token. `canonry_settings_get` and
`canonry_telemetry_get` describe the connected server, not the agent's local
machine. Telemetry reports configured preference, effective state, and any
environment override; inspecting status never creates an anonymous identifier.
After approval, `canonry_telemetry_update` changes that preference and
`canonry_provider_settings_update` changes an already-configured provider's
model/quota. Both require `settings.write`; neither accepts credentials.

`canonry_logs_list` reads bounded, redacted runtime events from both the
application logger and Fastify request/error logging. It requires an
instance-wide `logs.read` grant (or wildcard), and
admin role for signed-in users. Project-scoped keys cannot use it, even with a
project filter. A `logs.read`-only key is read-only automatically, without a
second `read` marker. Named `*.read` scopes cannot grant mutations; an explicit
write grant is needed and remains subject to its route gates. Returned messages
are sanitized and bounded; raw request or response bodies, headers, cookies,
provider payloads, and stacks are not
part of the queryable surface. The same secret-redaction policy runs before
console output and storage. Do not deliberately log secrets: redaction is a
defense in depth, not permission to put credentials into diagnostic strings.
Opaque escaped payloads containing secret assignments are omitted when safe
partial masking cannot be guaranteed; correlate their retained error codes and IDs.

File-backed hosts retain runtime logs in SQLite across restarts, bounded to
10,000 events and seven days. In-memory hosts report `retention: "process"`.
Filter by `actor`, `requestId`, `runId`, `projectId`, `module`, `level`, or an
inclusive `since`/`until` interval. Keep filters unchanged when resuming an
opaque cursor; retention eviction can invalidate it. Inspect `retentionPolicy`,
`captureErrors`, `dropped`, `truncated`, and `retention` before drawing
conclusions. Missing logs are not proof that an action did not happen. Use
`canonry_project_history` or `canonry_history_global` for persistent audit events;
offset pages have deterministic ordering but are not snapshots of concurrent writes.

Audit `actor` comes from authenticated identity (`user:<id>` or `api-key:<id>`),
not a caller-supplied header. A delegated MCP credential records its originating
user as actor and the actual credential in `credentialId`. `requestId` correlates
HTTP events; `userAgent` and `actorSession` are bounded, untrusted client hints,
never identity or permission grants. Older audit rows are not backfilled with
identities the server cannot prove.

Both shipped HTTP hosts issue restart-safe UUID request IDs and return them in
`x-request-id`. Use that value to correlate a CLI/API failure with log entries;
HTTP diagnostics retain the method and route template, not raw URL parameters.
Request-bound loggers retain completion attribution, while generic background
continuations stop inheriting caller identity after the response completes.
Capture covers the owning server process after initialization, not arbitrary
console output, other worker processes, or host/container logs. Run one server
instance per process and database, as required by the single-tenant deployment
model; this is not a cross-tenant or distributed log collector.

For CLI use, settings reads are remote. Google setup and telemetry retain their
local defaults: pass `--target server` explicitly to configure the connected
server. `schedule list <project>` lists all schedule kinds, and
`notify events --target server` discovers the server's event catalog.

MCP returns legacy text JSON plus structured results. Objects keep their shape;
arrays use `{items: [...]}` in `structuredContent`, and scalars use `{value: ...}`.
Errors preserve the existing envelope and CLI exit codes: HTTP 4xx (including
429 policy limits) use exit 1; HTTP 5xx use exit 2. Server-provided `Retry-After`
and request IDs are exposed as `retryAfterMs` and `requestId` when available;
clients do not infer retryability from HTTP 429 or retry automatically.
For a write with an ambiguous outcome, inspect saved state or its receipt before
retrying; a retry hint is not proof that repeating a write is safe.

### Action boundaries

Start with stored evidence. Before a live provider read, sweep, probe, research
run, sync, write, or externally visible action, obtain approval covering its
exact target, action, and bounded work. Approval already given for that exact
operation need not be asked for again, but does not extend to more projects,
larger batches, retries with new identities, or recurring work.

HTTP GET and MCP `readOnlyHint` describe aspects of an operation, not its cost
or permission. Provider discovery, account reads, and live diagnostics may
consume quota even when labeled read-only. If the tool's effect is unclear,
inspect its description and request direction before calling it.

Authentication, role/scope checks, project restrictions, quotas, and guarded
approval receipts are enforced by the server. Help, skills, resources, and tool
visibility cannot grant authority. Never change credentials, endpoints, or
project identifiers to work around a missing tool or a `403` response.

For guarded ads writes, inspect unresolved operation receipts before retrying.
Use the receipt's supported recovery action; do not replay a mutation under a
new identity. An executor cannot create or widen its own human approval grant.
On ambiguous results, exhausted bounds, or refusal, stop and report what is
known and what permission or operator action is needed.

## Version and source

This public, versioned document is the source for initialization guidance,
intent routes, the optional resource, and generated Canonry `SKILL.md` files.
Guide v1 may receive compatible clarifications; incompatible routing contracts
require a new guide version. The running server's help describes its actual
catalog and remains usable without fetching this document.

## Optional host-native references

Read only references relevant to the requested task. They are not required for MCP operation.

- [CLI commands and JSON return shapes](references/canonry-cli.md)
- [Interpreting stored evidence and regressions](references/aeo-analysis.md)
- [Indexing workflow after inspection and approval](references/indexing.md)
- [Approved WordPress workflow](references/wordpress-integration.md)
- [Server-side traffic setup and diagnosis](references/server-side-traffic.md)
- [Google Business Profile prerequisites](references/google-business-profile.md)
- [Google Ads and GTM evidence boundaries](references/google-marketing.md)

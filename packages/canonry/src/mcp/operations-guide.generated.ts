// Generated from docs/agent-operations/v1.md by pnpm guide:sync. Do not edit.
export const OPERATIONS_GUIDE = {
  "guideVersion": "v1",
  "operationsGuideUrl": "https://github.com/Canonry/canonry/blob/main/docs/agent-operations/v1.md",
  "resourceUri": "canonry://agent-operations/v1",
  "initialize": "Canonry tracks how AI answer engines mention brands and cite domains.\nStart with canonry_help({intent:\"status\"}), or name your intended workflow. It returns a small route of currently available tools and approval boundaries. Follow its stored-evidence reads before proposing action. No skill, resource reader, plugin installation, or local CLI is required for connected MCP clients. A host-native Canonry skill, if installed, is optional additional guidance.\nmentioned = brand in answer TEXT; cited = domain in SOURCE links. Never compute one from the other. A null answerMentioned means not checked, not false. No recorded sweep means no measured figure.\nGet explicit approval for live provider reads, sweeps, probes, research, syncs, and writes, bounded to the target and requested work. A readOnlyHint or GET is not proof of a free operation. Live ads reads include canonry_ads_account, canonry_ads_geo_search, canonry_ads_live_delivery, canonry_ads_conversion_pixels, canonry_ads_conversion_event_settings. Google live reads/syncs include canonry_google_ads_customers, canonry_gtm_accounts, canonry_gtm_containers, canonry_gtm_workspaces, canonry_google_ads_sync, canonry_gtm_sync.\nHelp and skills grant no permissions. The server enforces authority. On missing tools or 403, report the boundary; do not switch credentials or endpoints to bypass it. Hosted catalogs are fixed; only use canonry_load_toolkit when help explicitly offers it.\n",
  "approvalBoundary": [
    "provider reads",
    "sweeps",
    "writes"
  ],
  "approvalRule": "Get explicit approval for the exact target, action, and bounded provider work before crossing a boundary. Existing approval covers only its stated scope; stop on refusal or ambiguous results.",
  "authority": "Guidance and tool visibility are not permission grants. Server-side roles, scopes, project boundaries, quotas, and approval receipts remain authoritative. Never bypass a refusal with different credentials or endpoints.",
  "workflows": {
    "operations": {
      "keywords": [
        "operations",
        "permissions",
        "settings",
        "telemetry",
        "logs",
        "configuration"
      ],
      "next": [
        "canonry_key_self",
        "canonry_settings_get",
        "canonry_telemetry_get",
        "canonry_logs_list"
      ],
      "guidance": "Inspect current credential and server state before proposing changes. Runtime logs require instance-wide logs.read; inspect retention, dropped, and captureErrors before drawing conclusions. File-backed hosts retain bounded redacted logs across restarts. Logs are separate from audit history. Respect a 403; never substitute credentials to bypass it. Settings writes require settings.write and explicit approval."
    },
    "status": {
      "keywords": [
        "status",
        "overview",
        "health"
      ],
      "next": [
        "canonry_projects_list",
        "canonry_project_overview"
      ],
      "guidance": "Select an accessible project, then read its stored overview. Report freshness and missing evidence; do not start a sweep to fill a gap."
    },
    "diagnose": {
      "keywords": [
        "diagnose",
        "diagnosis",
        "regression",
        "changed",
        "change",
        "troubleshoot"
      ],
      "next": [
        "canonry_projects_list",
        "canonry_project_overview",
        "canonry_project_history"
      ],
      "guidance": "Compare stored history in the same project, period, provider/model, location, and query-class scope. Separate observed changes from possible causes; propose any live verification for approval."
    },
    "prospecting": {
      "keywords": [
        "prospect",
        "prospects",
        "prospecting",
        "snapshot"
      ],
      "next": [
        "canonry_settings_get"
      ],
      "actions": [
        "canonry_snapshot"
      ],
      "guidance": "Inspect stored provider settings, then agree on the company, domain, providers, and queries. Snapshot generation spends quota and fetches the site; approval must cover that work. No project is required. Use the snapshot action only when offered by this connection; its absence does not grant permission to bypass access restrictions."
    },
    "measurement": {
      "keywords": [
        "measurement",
        "measure",
        "portfolio",
        "property",
        "target",
        "query",
        "queries",
        "research"
      ],
      "next": [
        "canonry_projects_list",
        "canonry_measurement_overview",
        "canonry_measurement_setup",
        "canonry_research_runs_list"
      ],
      "guidance": "Inspect existing measurement before editing it. Preserve Simple versus Advanced scope, Property/Target identity, market, provider/model, and query class. Direct research submits final queries in one context; reviewed batches submit explicit destinations under one retry key. Expand patterns client-side: scope records a destination and never rewrites queries or fans out a group. Research is separate from tracking; publication does not authorize a sweep."
    },
    "integrations": {
      "keywords": [
        "integrations",
        "integration",
        "connect",
        "connection",
        "traffic",
        "gsc",
        "ga4",
        "ads",
        "gtm"
      ],
      "next": [
        "canonry_projects_list",
        "canonry_project_get",
        "canonry_ga_status",
        "canonry_google_ads_status"
      ],
      "guidance": "Inspect stored connection status and snapshot freshness. Use the currently listed specialist tools for stored evidence. Connecting, selecting resources, syncing, and live provider reads require scoped approval; never request credentials in chat."
    },
    "reports": {
      "keywords": [
        "reports",
        "report",
        "reporting",
        "summary"
      ],
      "next": [
        "canonry_projects_list",
        "canonry_report"
      ],
      "guidance": "Read the stored report for the selected project and period. Retain evidence dates, scope, sample sizes, missing data, and separate mention/citation signals; do not generate fresh runs implicitly."
    }
  },
  "markdown": "# Canonry Operations Guide v1\n\nCanonry is an agent-first AI visibility platform. MCP is the universal entry\npoint for connected agents. Host-native skills are optional upgrades, not a\nprerequisite or a permission mechanism.\n\n## Connect and choose a route\n\nRead the initialization guidance, then call `canonry_help` with an `intent`:\n`status`, `diagnose`, `operations`, `prospecting`, `measurement`, `integrations`,\n`reports`, or a short task\ndescription. Select an accessible project with `canonry_projects_list` before\nusing its exact name in project tools. Inspect each listed tool's input schema;\nhelp suggests tool names, not invented arguments or authorization.\n\nHelp returns a versioned, compact route: connection `mode`, available `next`\ntools, workflow guidance, approval boundaries, and this guide's URL. It performs\nno provider calls, reads no project data, and changes no permissions.\n`next` lists stored reads. Optional `actions` lists loaded tools for work that\nrequires approval; listing an action does not authorize or execute it.\n`includeCatalog: true` additionally returns toolkit details when needed.\n\nHosted connections use a fixed catalog. Help only suggests tools offered by that\nconnection; it never tells a hosted agent to dynamically load a toolkit. A\nprogressive local stdio connection may return `loadToolkits`: call\n`canonry_load_toolkit` with one returned name, await it, then call help again.\nLoading only changes local tool discovery, never server authority.\n\nThe optional `canonry://agent-operations/v1` MCP resource contains this same\nguide. If the host cannot read resources or open links, continue through help.\nDo not install a plugin, local runtime, or skill merely to use connected MCP.\nAn installed Codex or Claude Canonry skill contains a generated copy of this\nguide plus links to host-native references. It does not replace runtime help.\n\nBuilt-in Aero already receives its available `canonry_*` tools and can read\nthis guide through `read_skill_doc` with slug `agent-operations`. Its catalog\ndoes not include `canonry_help` or `canonry_load_toolkit`; those navigation\nsteps are for external MCP hosts. Aero's project-scoped tools use the current\nsession's project. Dashboard selections are not automatically passed to chat:\nresolve the requested Property, market, filters, or page before making a\nscoped claim. The `portfolio-analysis` and `site-health` skill docs cover the\ncorresponding investigations for both Simple and Advanced portfolios.\n\n## Vocabulary and evidence\n\n- **Mentioned** means the brand appears in answer text. **Cited** means its\n  domain appears in source links. Either, both, or neither can occur; never\n  compute one signal from the other.\n- `answerMentioned: null` means not checked, not false. Missing runs and empty\n  populations mean no measurement, not zero visibility.\n- Preserve project, time window, provider, requested/served model, location,\n  sample size, and query class when comparing evidence. Use server-returned\n  metrics; do not invent a score from incompatible populations.\n- Simple projects and Advanced portfolios share the workflow. For Advanced\n  results, preserve Property, Target, market, plan revision, and class scope.\n  Groups organize navigation; do not infer an unrequested fan-out.\n- Research is isolated evidence, not tracked measurement. A probe still spends\n  quota and persists evidence but is excluded from normal tracking metrics.\n\n## Workflows\n\n**Status:** read the stored overview and freshness first. Say when evidence is\nmissing instead of silently creating it.\n\n**Diagnose:** inspect stored history and comparable evidence. Explain what\nchanged separately from why it might have changed. A hypothesis is not a\nmeasured cause. Propose bounded verification if stored evidence is insufficient.\n\n**Prospecting:** generate a one-shot company snapshot without creating a project.\nInspect stored provider settings first. Agree on the company, domain, selected\nproviders, and queries before starting the quota-spending snapshot action.\nBrowser-only selection requires manual queries. Progressive stdio help offers\nthe discovery toolkit when this connection permits snapshots; load it, then\ncall help again. Fixed catalogs offer only already available actions. Read-only\nand restricted connections must not bypass missing snapshot access.\n\n**Measurement:** inspect the existing setup and results before proposing edits.\nKeep research, query tracking, plan publication, and sweep execution separate.\nFor direct research, submit the final editable query text in one context. For a\nreviewed batch, submit each explicit destination with its final text and one\nidempotency key. Pattern substitution happens in the client before either\nrequest; choosing a market or Property records a destination only and never\nrewrites a query or creates an automatic fan-out. `research.run` does not\nauthorize saving patterns, changing tracking, publishing plans, or settings.\nUse a supported preview where available, inspect its exact destination and\nrevision, then seek approval for the actual change. A preview may itself require\nwrite permission; never treat a dry-run flag as a universal safety guarantee.\n\n**Integrations:** inspect stored connection state and snapshot freshness first.\nProvider configuration evidence does not prove a browser event fired or a\nconversion was recorded. Connection, resource selection, refresh/sync, and live\nreads are separate actions. Credentials belong in the operator's secure setup\nflow, never in chat, tool arguments, reports, or public guidance.\n\n**Reports:** use saved evidence for the requested period and scope. Keep mention\nand citation signals separate, include dates and sample sizes, and state missing\nor stale inputs. For Advanced Property mention rankings, use\n`canonry_measurement_portfolio_summary` and its `mentionRanking.strongest`,\n`.weakest`, and `.excluded` lists. It defaults to non-brand questions; state the\nreturned class and report branded results separately. An unavailable portfolio\naggregate does not invalidate available Property mention rates. Flag excluded\nProperties individually; do not silently replace mention ranking with citation\nranking. Keep sample sizes and ties visible. Preparing a report does not\nauthorize new measurement.\n\n## Authority and approval\n\n### Agent operations\n\nUse `canonry_key_self` (CLI `canonry key whoami --format json`) to inspect the\ncurrent credential's scopes, project boundary, and host-derived `operator`\nauthority without exposing its token. Missing `operator` means unapproved.\n`canonry_settings_get` and\n`canonry_telemetry_get` describe the connected server, not the agent's local\nmachine. Telemetry reports configured preference, effective state, and any\nenvironment override; inspecting status never creates an anonymous identifier.\nAfter approval, `canonry_telemetry_update` changes that preference and\n`canonry_provider_settings_update` changes an already-configured provider's\nmodel/quota. Both require `settings.write`; neither accepts credentials.\nServer telemetry reads and updates additionally require operator authority.\nOrdinary audit-history reads omit internal telemetry events and their state.\n\nOperator authority is deny-by-default and separate from customer admin roles.\nThe deployment owner must approve a dedicated, instance-wide API key's ID in\nthe server environment variable `CANONRY_OPERATOR_KEY_IDS` (comma-separated IDs),\nthen restart the server. Empty/unset approves nobody; wildcards are invalid.\nKeep the bearer private to internal operators; never approve a customer-held or\nshared proxy/bootstrap key. Use `logs.read` for read-only diagnostics, adding\n`settings.write` only when telemetry control is required. Ordinary key creation,\naccount roles, OAuth consent, and caller headers cannot grant operator status.\nRevoking an approved key invalidates it immediately. Host enrollment is a trust\nbootstrap step, intentionally unavailable through customer-facing APIs.\nAPI, CLI, and MCP enforce the same boundary; MCP hides internal tools unless\nthe server confirms operator authority, including in explicit read-only mode.\nProject analytics, research, and normal project permissions are unchanged.\n\n`canonry_logs_list` reads bounded, redacted runtime events from both the\napplication logger and Fastify request/error logging. It requires an\ninstance-wide `logs.read` grant (or wildcard) and a host-approved direct bearer.\nBrowser sessions, OAuth/delegated credentials, customer admins, and project-scoped\nkeys cannot use it, even with a project filter or a matching allowlist ID.\nA `logs.read`-only key is read-only automatically, without a\nsecond `read` marker. Named `*.read` scopes cannot grant mutations; an explicit\nwrite grant is needed and remains subject to its route gates. Returned messages\nare sanitized and bounded; raw request or response bodies, headers, cookies,\nprovider payloads, and stacks are not\npart of the queryable surface. The same secret-redaction policy runs before\nconsole output and storage. Do not deliberately log secrets: redaction is a\ndefense in depth, not permission to put credentials into diagnostic strings.\nOpaque escaped payloads containing secret assignments are omitted when safe\npartial masking cannot be guaranteed; correlate their retained error codes and IDs.\n\nFile-backed hosts retain runtime logs in SQLite across restarts, bounded to\n10,000 events and seven days. In-memory hosts report `retention: \"process\"`.\nFilter by `actor`, `requestId`, `runId`, `projectId`, `module`, `level`, or an\ninclusive `since`/`until` interval. Keep filters unchanged when resuming an\nopaque cursor; retention eviction can invalidate it. Inspect `retentionPolicy`,\n`captureErrors`, `dropped`, `truncated`, and `retention` before drawing\nconclusions. Missing logs are not proof that an action did not happen. Use\n`canonry_project_history` or `canonry_history_global` for persistent audit events;\noffset pages have deterministic ordering but are not snapshots of concurrent writes.\n\nAudit `actor` comes from authenticated identity (`user:<id>` or `api-key:<id>`),\nnot a caller-supplied header. A delegated MCP credential records its originating\nuser as actor and the actual credential in `credentialId`. `requestId` correlates\nHTTP events; `userAgent` and `actorSession` are bounded, untrusted client hints,\nnever identity or permission grants. Older audit rows are not backfilled with\nidentities the server cannot prove.\n\nBoth shipped HTTP hosts issue restart-safe UUID request IDs and return them in\n`x-request-id`. Use that value to correlate a CLI/API failure with log entries;\nHTTP diagnostics retain the method and route template, not raw URL parameters.\nRequest-bound loggers retain completion attribution, while generic background\ncontinuations stop inheriting caller identity after the response completes.\nCapture covers the owning server process after initialization, not arbitrary\nconsole output, other worker processes, or host/container logs. Run one server\ninstance per process and database, as required by the single-tenant deployment\nmodel; this is not a cross-tenant or distributed log collector.\n\nFor CLI use, settings reads are remote. Google setup and telemetry retain their\nlocal defaults: pass `--target server` explicitly to configure the connected\nserver. `schedule list <project>` lists all schedule kinds, and\n`notify events --target server` discovers the server's event catalog.\n\nMCP returns legacy text JSON plus structured results. Objects keep their shape;\narrays use `{items: [...]}` in `structuredContent`, and scalars use `{value: ...}`.\nErrors preserve the existing envelope and CLI exit codes: HTTP 4xx (including\n429 policy limits) use exit 1; HTTP 5xx use exit 2. Server-provided `Retry-After`\nand request IDs are exposed as `retryAfterMs` and `requestId` when available;\nclients do not infer retryability from HTTP 429 or retry automatically.\nFor a write with an ambiguous outcome, inspect saved state or its receipt before\nretrying; a retry hint is not proof that repeating a write is safe.\n\n### Action boundaries\n\nStart with stored evidence. Before a live provider read, sweep, probe, research\nrun, sync, write, or externally visible action, obtain approval covering its\nexact target, action, and bounded work. Approval already given for that exact\noperation need not be asked for again, but does not extend to more projects,\nlarger batches, retries with new identities, or recurring work.\n\nHTTP GET and MCP `readOnlyHint` describe aspects of an operation, not its cost\nor permission. Provider discovery, account reads, and live diagnostics may\nconsume quota even when labeled read-only. If the tool's effect is unclear,\ninspect its description and request direction before calling it.\n\nAuthentication, role/scope checks, project restrictions, quotas, and guarded\napproval receipts are enforced by the server. Help, skills, resources, and tool\nvisibility cannot grant authority. Never change credentials, endpoints, or\nproject identifiers to work around a missing tool or a `403` response.\n\nFor guarded ads writes, inspect unresolved operation receipts before retrying.\nUse the receipt's supported recovery action; do not replay a mutation under a\nnew identity. An executor cannot create or widen its own human approval grant.\nOn ambiguous results, exhausted bounds, or refusal, stop and report what is\nknown and what permission or operator action is needed.\n\n## Version and source\n\nThis public, versioned document is the source for initialization guidance,\nintent routes, the optional resource, and generated Canonry `SKILL.md` files.\nGuide v1 may receive compatible clarifications; incompatible routing contracts\nrequire a new guide version. The running server's help describes its actual\ncatalog and remains usable without fetching this document.\n"
} as const

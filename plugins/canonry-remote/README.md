# Canonry remote plugin

This source package is configured to connect to `https://mcp.canonry.ai/mcp` with OAuth. It is
separate from `plugins/canonry`, which continues to launch the local stdio
server. It adds no local runtime, skills, credentials, hooks, or scheduled work.

The gateway forwards the selected instance's complete supported read-only
catalog, including stored reads for Simple and Advanced Measurement portfolios.
Use runtime `canonry_help` and tool schemas for the available operations. The
connection cannot start research or sweeps, change data, administer an instance,
or switch workspaces through chat. Each authorization binds one user from one
registered instance. Matching email addresses do not join identities.

Each upstream must implement the [hardened engine contract](../../docs/mcp-gateway-contract.md),
including grant-wide revocation, refresh replay protection and current user
authority. Support for legacy MCP wire protocols does not permit pre-hardening
engine versions. The operator must validate the contract before onboarding.

`mcp.json` selects the pre-registered public client `canonry-chatgpt` with S256
PKCE and requests `read` plus `offline_access`. Provision that exact client ID
with the portal's exact callback URI before connecting. The user must consent. No client secret or bearer belongs in this package. Tool
annotations and OAuth security requirements come from the server's catalog,
not from this manifest. The gateway and engine must enforce those restrictions.

## Preparation status

This package is listed in the Codex marketplace as `canonry-remote`. It is not yet
submitted to the OpenAI plugin directory. The proposed production hostname is not evidence of a
working deployment. The five positive and three negative cases in `plugin.json`
are review instructions, not recorded test results. Live ChatGPT/Codex import,
OAuth and tool validation remain **not run**. Local tests against real synthetic
engines and container build/smoke results are separate evidence; they do not
prove public reachability, host compatibility or reviewer access.

Before making a public-upload ZIP:

1. Deploy and validate a reachable staging gateway, then the explicitly approved
   public endpoint. Use the same code/catalog for reviewers and customers.
2. Prepare a synthetic reviewer instance and verify its existing login. Follow
   the [gateway runbook](../../apps/mcp-gateway/README.md#reviewer-walkthrough).
3. Supply verified listing, support, privacy-policy and terms URLs; verified
   publisher identity; country targeting; and the applicable commerce statement.
   These unknown declarations are omitted from the manifest.
4. Export and inspect square PNG listing/composer icons from the included
   Canonry artwork for public review. The SVG assets are valid portable assets;
   they do not complete the public submission's PNG requirement.
5. Run and record the review walkthrough in ChatGPT/Codex against the reachable
   deployment. Verify the recording's playback and reviewer access, then add
   its actual URL to `review.demo_recording_url`.
6. Package this directory alone, excluding secrets and access instructions.
   Upload, connect, verify the domain, scan the actual catalog and submit only
   after separate authorization. Complete attestations in the intended account.

Reviewer credentials and login instructions go in the portal's secure access
fields, never this directory, an archive, the listing, or a PR. Keep their
account and synthetic data available for future reviews. No reviewer bypass or
reduced tool catalog is permitted.

The gateway adds one authentication-only tool, `canonry_gateway_profile`, marked
with `_meta["openai/profile"]: true`. It returns the current authorized profile
using a durable opaque ID, plus available name/workspace labels. It does not
expose raw instance user IDs or accept a user/workspace argument. Business tools
continue to come from the selected instance. The full catalog carries the
gateway's `read` OAuth requirement in both descriptor and compatibility metadata.

Current official references:
[OAuth](https://developers.openai.com/plugins/build/auth),
[submission](https://developers.openai.com/plugins/deploy/submission), and
[submission validation](https://developers.openai.com/plugins/deploy/submission-errors).

The OpenAI authentication extension follows the current
[OpenAI package format](https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication).
The generic Agent Plugins 1.0.0 MCP JSON schema currently omits per-server
`extensions`; a generic-schema-only validator therefore cannot validate these
OpenAI connection options. Validate the target OpenAI import as part of staging
and portal review; JSON parsing alone does not establish host compatibility.

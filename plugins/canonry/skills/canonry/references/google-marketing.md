# Google Ads and Google Tag Manager

Use this reference to inspect Google Ads and Google Tag Manager (GTM) as one
conversion-tracking system.

## Scope

Canonry treats `google-ads` and `gtm` as separate, project-scoped providers.
`ads` remains the OpenAI/ChatGPT Ads namespace. Version 1 reads provider data
and assesses evidence. It does not mutate a Google provider.

## Shared integrity chain

```text
declared conversion contract
        |
        +--> Google Ads action -> effective campaign goals -> bounded metrics
        |
        +--> GTM live tag -> triggers + variables
                         \                 /
                          \               /
                           static assessment

website event -> GTM firing -> Google Ads conversion receipt
                         |
                   runtime observation
```

The contract names the application event, Google Ads conversion action, campaign
goals, GTM tag, triggers, variables, and required runtime evidence.
An action marked primary is not necessarily an effective, biddable campaign goal.

| Evidence | It establishes | It does not establish |
| --- | --- | --- |
| Contract plus Ads and GTM snapshots | Whether static configuration agrees with the declared conversion | A browser event occurred, a tag fired, or Google Ads recorded a conversion |
| Runtime observation | Required event, GTM, and Ads evidence was observed | A mismatched static configuration is correct |

An observed runtime signal never repairs an unproven static graph. Opaque custom
HTML and templates stay `unknown` or `needs-review`.

## Integrity status

- `configured`: A contract exists, but the static graph is unproved or inconsistent.
- `statically-consistent`: Static checks pass and runtime verification is not required.
- `runtime-unverified`: Static checks pass, but required runtime evidence is absent.
- `observed`: Static checks pass and trusted runtime evidence is present.

Inspect findings with the status. `configured` is not a pass state.

The default Canonry runtime does not store runtime observations in version 1.
A runtime-required contract therefore stops at `runtime-unverified`.

## Operator setup

The operator completes setup in the dashboard:

1. Configure the Web application OAuth client in **Settings → Google OAuth**.
2. Register the exact Google Ads and Tag Manager redirect URI.
3. Open **Project → Conversions**.
4. Connect Google Ads and enter the developer token.
5. Select the Ads manager and customer context.
6. Connect Tag Manager.
7. Select the account and container.
8. If stored draft evidence is required, select a draft workspace.
9. Sync both providers.
10. Declare the conversion contract.

Use the
[Google Marketing setup guide](https://github.com/Canonry/canonry/blob/main/docs/google-marketing.md)
for Google Cloud requirements, a contract example, Doctor commands, and
troubleshooting.

The operator must not give an agent OAuth credentials or a developer token.
OAuth starts and finishes in the same signed-in dashboard browser.

## Agent procedure

1. Call `canonry_load_toolkit` with `{ "name": "google-ads" }`.
2. Wait for the call to return.
3. Load `gtm`, `conversion-tracking`, and `monitoring` in the same way.
4. Read provider status and stored snapshots.
5. Read the declared contracts.
6. Assess each contract with `canonry_conversion_tracking_integrity`.
7. Report static failures separately from unknown runtime evidence.

Use stored evidence first. Before a live provider discovery or sync, get
explicit approval.

For a signed-in user, live discovery and sync require the administrator role.
With API credentials, live discovery needs a full-instance key with
`google-marketing.read-live`. Sync also needs `google-marketing.write` and can
use a project-scoped key. A sync queues a run.
Poll `canonry_run_get` with the returned run ID until its status is `completed`,
`failed`, or `cancelled`. Assess new evidence only after `completed`. If the run
fails or is cancelled, report that result instead.

MCP does not expose OAuth, resource selection, disconnect, or contract writes.
Those actions remain in the operator dashboard and CLI.

If organic performance is in scope, call `canonry_organic_evidence` from the
loaded `monitoring` toolkit. Use integrity as a measurement-confidence gate.
Do not attribute one organic question or citation to one paid conversion.

## Read authority

Stored snapshot reads are local, redacted evidence. They do not call a provider.
`google-marketing.read-live` is the explicit Canonry capability for a bounded,
quota-consuming Google Ads or GTM provider read. It does not grant
`google-marketing.write` authority, but it also does not narrow Google's OAuth
token: Google Ads has one broad `adwords` scope. Use a Google Ads user with the
Read-only account role and a developer token approved for Reporting permissible
use. GTM uses its read-only OAuth scope.

Live queries use bounded account, date, row, page, and retry inputs. GTM uses
GETs; Google Ads also uses the non-mutating SearchStream POST endpoint. Agents do not
expose OAuth tokens, OAuth client secrets, or the Google Ads developer token.
OAuth, resource selection, and disconnect remain explicit operator actions.
OAuth must start and be confirmed in the same signed-in dashboard browser; CLI
and MCP never print or transfer authorization URLs.

The OAuth web client must register the exact callback
`<canonry-public-url>/api/v1/google-marketing/callback` (default local install:
`http://localhost:4100/api/v1/google-marketing/callback`). Pending authorization
is process-local, expires after 15 minutes, and must be restarted after a server
restart, browser change, or expiry.

## Version 1 safety boundary

Version 1 has no Google Ads create, update, or delete path. It has no GTM create,
edit, version, or publish path. A live read never changes either boundary.

A selected draft workspace produces a sanitized draft snapshot. The integrity
assessment uses the live graph and does not assess the draft graph.

The manual browser procedure is external evidence. It does not change the
Canonry status in version 1.

## Future write boundary

Any future provider write must be proposal-bound. Google Ads needs a reviewable
plan and explicit approval. GTM workspace edit approval and GTM publish approval
are separate events. Approval to edit a draft never authorizes publishing it.

# Google Marketing: first-class Google Ads and Tag Manager

Canonry treats Google Ads and Google Tag Manager (GTM) as separate, project-scoped
integrations joined by one conversion-tracking contract. Canonry's first-release
code path is read-only: it can authorize, discover, select, snapshot, compare,
and audit. It does not mutate Google Ads or create, update, version, or publish
GTM resources.

## Supported host

This guide applies to `cnry serve`. This host supplies the private credential
store, OAuth adapter, provider readers, sync workers, and integrity evaluator.

The standalone `apps/api` entry point is unsupported for this integration in
version 1. It does not supply the OAuth, credential-store, provider-reader,
sync, or integrity adapters that complete the workflow.

## Before you start

You need these items:

- A running `cnry serve` instance and an existing Canonry project.
- An administrator account for the Canonry dashboard.
- A Google Cloud project with the Google Ads API and Tag Manager API enabled.
- A Web application OAuth client in that Google Cloud project.
- A Google Ads developer token from a Google Ads manager account.
- A Google user with Read-only access to the required Google Ads accounts.
- A Google user with access to the required Tag Manager account and container.

Use these Google guides:

- [Configure a Google Cloud project for the Google Ads API](https://developers.google.com/google-ads/api/docs/oauth/cloud-project).
- [Get a Google Ads developer token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token).
- [Review developer-token access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels).
- [Configure Tag Manager API authorization](https://developers.google.com/tag-platform/tag-manager/api/v2/authorization).

## Configure Google Cloud

1. Select the Google Cloud project that owns your OAuth client.
2. Enable the Google Ads API.
3. Enable the Tag Manager API.
4. Configure the OAuth consent screen.
5. Add these scopes:
   - `https://www.googleapis.com/auth/adwords`
   - `https://www.googleapis.com/auth/tagmanager.readonly`
6. If the OAuth application is in Testing, add the authorizing Google account
   as a test user.
7. Create an OAuth client of type **Web application**.
8. Add Canonry's exact callback to the client's authorized redirect URIs.

The default local redirect URI is:

```text
http://localhost:4100/api/v1/google-marketing/callback
```

For the default OAuth flow, open the dashboard at `http://localhost:4100`.
The dashboard origin and callback origin must match for the browser-binding
cookie.

A remote installation uses this pattern:

```text
<public-url>/api/v1/google-marketing/callback
```

Set a stable `publicUrl` in `config.yaml` for a remote installation. Include
the mount path once in that URL. For example:

```yaml
publicUrl: https://canonry.example.com/canonry
```

Register `https://canonry.example.com/canonry/api/v1/google-marketing/callback`
for that example. The dashboard displays the callback automatically only for
the default local host.

If you also use Search Console or Business Profile, add the separate redirect
URI that Canonry displays for those integrations.

## Connect the providers

1. In **Settings → Google OAuth**, enter the OAuth client ID and client secret.
2. Save the Google OAuth application.
3. Open **Project → Conversions**.
4. Select **Connect Google Ads**.
5. If Canonry does not have the developer token, enter it. Alternatively, set
   `GOOGLE_ADS_DEVELOPER_TOKEN` on the local server.
6. Complete Google consent in the new browser window.
7. Confirm the connection in the same signed-in browser.
8. Select the Google Ads customer.
9. If the customer uses a manager hierarchy, select the manager account.
10. Select **Connect Google Tag Manager**.
11. Complete Google consent and confirm the connection.
12. Select the Tag Manager account and container.
13. If you need stored draft evidence, select a draft workspace.

The developer token is private installation-wide configuration. OAuth
connections and selected resources are project-scoped.

Canonry stores a selected draft graph for review. The integrity assessment uses
the live container graph. It does not assess unpublished draft changes.

## Capture evidence

1. In **Project → Conversions**, sync Google Ads.
2. Wait for the Google Ads sync run to finish.
3. Sync Tag Manager.
4. Wait for the Tag Manager sync run to finish.
5. Review the latest sanitized snapshots.

The Google Ads sync stores conversion actions, effective campaign goals, and
bounded metrics. The Tag Manager sync stores sanitized live and selected-draft
graphs.

## Declare a conversion

Use **Project → Conversions → Declare conversion** for the normal setup flow.
Enter the website event, Google Ads action ID, and Tag Manager tag ID.

Additional rules can require these items:

- Specific campaign, trigger, and variable IDs.
- A Google conversion ID and conversion label.
- A production hostname.
- A primary Ads action and a biddable goal.
- Transaction ID, value, and currency mappings.

Use canonical IDs from the current snapshots. Use the Ads customer ID without
dashes, the conversion-action `id`, and each GTM resource `id`. Do not use a
GTM resource path or the public `GTM-...` container ID.

The CLI accepts the same contract as JSON. This purchase example enables all
runtime field requirements:

```json
{
  "name": "Purchase completed",
  "eventName": "purchase",
  "googleAds": {
    "customerId": "1234567890",
    "conversionActionId": "987654321",
    "conversionId": "AW-1234567890",
    "conversionLabel": "purchase_label",
    "campaignIds": [],
    "requireBiddableGoal": true,
    "requirePrimaryAction": true
  },
  "gtm": {
    "accountId": "123456",
    "containerId": "654321",
    "tagId": "42",
    "triggerIds": ["17"],
    "variableIds": ["21", "22", "23"]
  },
  "runtime": {
    "verificationRequired": true,
    "requireTransactionId": true,
    "requireValue": true,
    "requireCurrency": true,
    "productionHosts": ["example.com"]
  }
}
```

Save the file as `contract.json`. Then create and assess the contract:

```bash
cnry conversion-tracking contracts create my-site --input contract.json
cnry conversion-tracking contracts my-site --format jsonl
cnry conversion-tracking contracts integrity my-site <contract-id> --format jsonl
```

Empty `campaignIds`, `triggerIds`, and `variableIds` arrays disable their
corresponding assertions. Canonry checks `requireBiddableGoal` only for listed
campaigns. If you do not know the exact GTM-facing values, omit `conversionId`
and `conversionLabel`. Do not supply server-owned IDs or timestamps.

```text
website event
    |
    v
GTM live tag -> trigger + variables ----+
                                        |
                                        v
declared conversion contract -> static integrity assessment
                                        ^
                                        |
Google Ads conversion action -> effective campaign goals -> bounded metrics

static integrity assessment + trusted runtime observation -> observed status
                                                  (reserved: no v1 recorder)
```

## Truth model

An Ads conversion action being primary is not the same as an effective campaign
goal being biddable. Canonry therefore retains customer goals, campaign goals,
custom goals, and campaign goal configuration as distinct evidence before
deriving an effective per-campaign goal graph.

A GTM API snapshot proves configuration only. It does not prove that a browser
event occurred, that a tag fired, or that Google Ads recorded a conversion. An
assessment reports one of these evidence states:

1. `configured` — a contract exists, but its static graph is missing or inconsistent.
2. `statically-consistent` — the stored Ads and GTM graphs agree with the contract.
3. `runtime-unverified` — static configuration is consistent, but required runtime evidence is absent.
4. `observed` — both static and trusted runtime evidence are present.

Opaque custom HTML and custom templates are always `unknown` / `needs-review`.
They are never inferred as passing.

The contract model reserves `observed` for trusted runtime evidence. The
default Canonry runtime does not store that evidence in version 1.

A runtime-required contract therefore stops at `runtime-unverified`, even
after an operator completes the manual runtime procedure.

## Make sure that setup is complete

Run the offline Doctor checks:

```bash
cnry doctor --project my-site --check 'google-ads.*' --format json
cnry doctor --project my-site --check 'gtm.*' --format json
```

Doctor reports credential metadata, OAuth scopes, selected resources, snapshot
age, and repeated sync failures from stored run rows (the latest run error and
the last successful sync). Doctor does not call Google or prove browser tag
firing.

Then review each integrity assessment. Inspect every `fail` or `unknown`
finding and its evidence IDs.

## Manual runtime procedure

1. Start a controlled browser session on a declared production host.
2. Complete the action that emits the declared website event.
3. In Tag Manager Preview, make sure that the declared tag fires.
4. Make sure that the tag includes every required runtime field.
5. Make sure that Google Ads records the matching conversion action.

Use recognizable test values and a production-host guard. Preview traffic can
send a real Google Ads conversion.

This procedure does not change the Canonry status in version 1. Keep the
runtime result in the operator's external evidence record.

## Agent workflow

The operator must complete OAuth, resource selection, and contract creation.
An agent must not request OAuth credentials or a developer token.

For MCP, call `canonry_load_toolkit` with each input below. Wait for each call
to return before you call a newly enabled tool.

- `{ "name": "google-ads" }`
- `{ "name": "gtm" }`
- `{ "name": "conversion-tracking" }`
- `{ "name": "monitoring" }`

Use these Google Ads tools:

- `canonry_google_ads_status`
- `canonry_google_ads_customers`
- `canonry_google_ads_snapshots`
- `canonry_google_ads_snapshot_get`
- `canonry_google_ads_sync`

Use these GTM tools:

- `canonry_gtm_status`
- `canonry_gtm_accounts`
- `canonry_gtm_containers`
- `canonry_gtm_workspaces`
- `canonry_gtm_snapshots`
- `canonry_gtm_snapshot_get`
- `canonry_gtm_sync`

Use these contract tools:

- `canonry_conversion_tracking_contracts`
- `canonry_conversion_tracking_contract_get`
- `canonry_conversion_tracking_integrity`

Use stored snapshots first. Stored reads are local, redacted, and quota-free.

Before a live provider discovery or sync, get explicit approval. Live discovery
needs a full-instance key with `google-marketing.read-live`.

A sync needs `google-marketing.read-live` and `google-marketing.write`. It can
use a project-scoped key. It queues a run and writes only Canonry runs and
sanitized snapshots.

Read the returned run ID. Call `canonry_run_get` with
`{ "runId": "<run-id>" }` until the run reaches `completed`, `failed`, or
`cancelled`. Assess new evidence only after `completed`. If the run fails or is
cancelled, report that result instead.

Use `canonry_conversion_tracking_integrity` to assess one contract. Do not
treat `runtime-unverified` as a static failure.

## Use conversion integrity with organic evidence

After the `monitoring` toolkit loads, call `canonry_organic_evidence`. This
result combines AEO visibility, GSC, GA4, and server evidence.

Use conversion integrity as a measurement-confidence gate:

- If static integrity fails, correct measurement before you claim organic ROI.
- If organic sessions increase and static integrity passes, inspect landing-page intent and conversion trends.
- If runtime proof is absent, report an association and not conversion attribution.

Canonry does not join one organic question or citation to one Google Ads
conversion. Keep organic evidence and paid attribution separate.

## Live-read authority

Stored snapshots are the default. They are local, redacted evidence and do not
call a Google provider. The explicit capability for a bounded, quota-consuming
provider refresh is `google-marketing.read-live`. This is a Canonry capability,
not a restriction on the Google-issued OAuth token. Google Ads exposes the broad
`adwords` OAuth scope, so connect a Google Ads user with the **Read-only** account
role and use a developer token approved for Reporting permissible use. GTM uses
its read-only OAuth scope.

## Data and credential boundaries

- OAuth access/refresh tokens, OAuth client secrets, and the Google Ads developer
  token live only in the private Canonry config.
- SQLite stores project-scoped selection metadata and append-only redacted
  snapshots. It never stores provider credentials or raw GTM template bodies.
- Provider request IDs, checksums, capture times, and bounded redacted DTOs make
  observations traceable without retaining secret-bearing provider payloads.
- All provider queries have explicit account, date, row, page, and retry bounds.
  GTM uses GETs; Google Ads also uses its read-only SearchStream POST endpoint.

## Agent surface

The public namespaces are `google-ads` and `gtm`; `ads` remains reserved for
OpenAI/ChatGPT Ads. API, generated SDK, CLI, MCP toolkits, doctor checks, and the
project UI must preserve that separation. Agents may inspect stored evidence.
They need `google-marketing.read-live` for a live read. OAuth, resource selection,
disconnect, and any future provider mutation remain explicit operator actions.
OAuth starts and completes in the same signed-in browser, with an explicit
confirmation before credentials are persisted. CLI and MCP do not print or
transfer OAuth URLs.

Register the exact shared callback on the Google OAuth web client:
`<canonry-public-url>/api/v1/google-marketing/callback` (for a default local
install: `http://localhost:4100/api/v1/google-marketing/callback`). A pending
flow is process-local and expires after 15 minutes; restart it after a server
restart, browser change, or expiry.

## Troubleshooting

### Google reports `redirect_uri_mismatch`

Open **Settings → Google OAuth**. Copy the exact Google Ads and Tag Manager
redirect URI into the Web application OAuth client.

### Canonry lists no Ads customers

Make sure that the OAuth user has access to the target customer. If you use a
manager account, select the correct manager and customer pair.

Make sure that the developer token can access the target account type. A
test-only token cannot read a production account.

### Canonry lists no Tag Manager resources

Make sure that the OAuth user has access to the required account and container.
After you change its Google permissions, reconnect Tag Manager.

### OAuth stops after seven days

An external OAuth application in Google testing mode can issue a refresh token
that expires after seven days. Use production status for scheduled operation.

### Integrity remains `runtime-unverified`

This status is expected when the contract requires runtime proof. Version 1
does not store the result of the manual runtime procedure.

### A draft workspace looks correct, but integrity fails

The assessment uses the live container graph. Inspect the stored draft snapshot
separately, then publish through the normal Tag Manager approval process.

### A deployed `apps/api` instance reports unavailable routes

Use `cnry serve` for this integration. The standalone Cloud API entry point is
unsupported because it lacks the required host adapters in version 1.

## v1 provider boundary

Version 1 has no Google Ads mutation path. It has no GTM workspace edit, version,
or publish path. A live read never changes that boundary.

## Future write support

Write support must be proposal-bound. Google Ads mutations require a reviewable
plan and explicit approval. GTM workspace edits and GTM publish are separate
approval events; approval to edit a draft never implies approval to publish it.

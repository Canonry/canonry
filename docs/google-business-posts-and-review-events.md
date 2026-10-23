# Google Business Profile posts and review events

This change is opt-in. It creates no Google posts, review replies, subscriptions,
credentials, schedules or enabled notification destinations. Existing Google
connections and selected account/location mappings are reused. Existing clients'
publication and social holds remain authoritative.

## Local Posts transport

The engine exposes project-bound Local Posts list/get and an audited create
transport. Reads require an explicit `gbp.read` (or full-instance) key; creates
require `gbp.posts.write`. That write scope cannot be used for unrelated writes.
The low-level create endpoint is intentionally excluded from MCP: the approved
social outbox owns exact content review and publication authority.

Supported content is deliberately limited to English STANDARD editorial article
updates, one PHOTO source URL and a LEARN_MORE article link. Offers, events and
scheduledTime are rejected. Every linked article is checked for promotional copy
and links, even when location category metadata is missing or localized. This
conservative policy protects hotel locations, including Gjelina, and can refuse
an editorial page whose shared navigation advertises an offer. It is not a
semantic policy classifier and does not add promotional posting support.

Commands (machine-readable JSON):

- `cnry gbp posts list PROJECT --account accounts/ID --location locations/ID`
- `cnry gbp posts get PROJECT --post accounts/ID/locations/ID/localPosts/ID`
- `cnry gbp posts attempt PROJECT --attempt UUID --package SHA256`
- `cnry gbp posts create PROJECT --request APPROVED_REQUEST.json`
- `cnry gbp reviews live PROJECT --account accounts/ID --location locations/ID`

Create requests bind account, selected location, attempt UUID, package SHA256 and
strict content. A durable audit claim precedes the single Google POST; a repeated
identity cannot change content or issue another POST. A lost response remains
uncertain. The attempt GET can recover a saved accepted result without posting.
An interrupted claim without a provider identity requires explicit investigation;
it is never silently reset. List pagination retains the next token. Unknown
states, malformed media and incomplete live review coverage fail closed.

The orchestrator companion change performs live source/image preflight, exact
owner Discord approval, duplicate scans, final hold/configuration checks, durable
submission and LIVE readback. `PROCESSING` is not success. Verification requires
the exact caption, article, PHOTO source, account/location and a supported Google
live link. The original source image is hash-checked; Google may transform its
rendered image, so this proves the returned source identity rather than pixel
identity of Google's final presentation. No live write was used to validate this
change; production write eligibility remains untested.

## Engine-owned review events

Review observation/baselines already belong to the engine's GBP sync. Reuse an
existing configurable hourly `gbp-sync` schedule rather than adding an
orchestrator poller. The existing negative-review setting defaults to three
stars; notification subscriptions and schedules are independently configurable
per project. A first successful sync silently baselines historical reviews.
New material rating/comment changes can emit `review.negative`; timestamp-only
and owner-reply changes do not generate another alert. The existing 30-day alert
window remains. Alerts never reply to, delete or alter Google reviews.

Each material revision has an immutable `evt_…` ID. The new delivery table is
empty on migration, has a unique project/destination/event key, and preserves
per-destination debt across restarts. One accepted destination cannot acknowledge
another failed destination. Acknowledgement compares the exact observed rating,
comment and material revision, so an older send cannot hide a concurrent edit.
Each sync also drains up to 100 due delivery records independently of the current
review queue. Future retry deadlines do not consume that budget; never-attempted
and oldest-due ready work goes first. Failed DNS/preflight reads receive a bounded
retry deadline without incrementing provider attempts, so unavailable targets do
not monopolize later batches. An older still-negative
material event retains its original payload and can finish after a newer event
succeeds, without repeating destinations that already accepted it.

Before a retry and again after DNS resolution, the engine checks the current
project, selected account/location, destination subscription and review rating.
Pending debt is canceled when its review was removed, became nonnegative under
the current threshold, expired outside the 30-day window, or lost its selected
location/destination authority. A silent/suppressed review or Places review now
covered by Business Profile is canceled too. Cancellation preserves the immutable
event and records one `notification.review-canceled` audit entry with a bounded
reason and exact event/destination identity. It never claims delivery or
reactivates old debt when settings later change. Already attempting or uncertain
outcomes retain their evidence and remain held when authority is revoked;
cancellation cannot erase an ambiguous send. No historical baseline is replayed.

Native Discord/Slack rendering reuses engine adapters, with bounded excerpts,
validated Google review/profile links and disabled Discord mentions. No
orchestrator dependency is involved.

Generic receivers use existing HMAC credentials. Events retain the legacy
signature and add `X-Canonry-Event-Id`, `Idempotency-Key`,
`X-Canonry-Timestamp`, and `X-Canonry-Signature-V2`.
`verifyCanonryWebhook` validates freshness (five minutes by default), event ID
and an HMAC over `timestamp.body`. Consumers must atomically deduplicate the
stable event ID before effects; signature verification alone does not stop a
replay within the freshness window. No secrets are created by migration.

A definitive failed delivery retries only notification delivery. A lost generic
webhook acknowledgement can retry with the same deduplicated event ID. A lost
Discord/Slack acknowledgement is held as uncertain, since those endpoints do not
provide an idempotency guarantee; operator reconciliation is required rather
than risking repeated alerts. No historical backlog is dumped into channels.

Google Pub/Sub NEW_REVIEW/UPDATED_REVIEW notifications could later replace the
upstream polling wake-up. That requires separately approved cloud topic/IAM and
account notification settings; no such resources or permissions are provisioned
here. The outgoing engine webhook contract remains the same.

## Activation checklist (not performed)

1. Confirm each selected account/location and project credential scopes.
2. Confirm each client's engine notification destination. Orchestrator manifest
   targets are not proof of engine webhook routing. The currently observed AZ
   and Gjelina manifest targets match, so Gjelina routing needs owner confirmation.
3. Approve deployment/migration, then configure hourly sync and the intended
   `review.negative` subscriptions with the existing settings. Preserve a silent
   baseline and verify routing before enabling alerts.
4. Enable GBP social delivery separately per client in the companion outbox.
   Gjelina's existing social hold must remain until separately authorized.

On October 23, authorized read-only Google requests returned HTTP 200 for both
clients' Local Posts and Reviews. The review samples reported AZ 25 reviews and
Gjelina 150; these were access checks, not complete scans or claims that no
negative reviews exist. No live notifications, previews or posts were sent.

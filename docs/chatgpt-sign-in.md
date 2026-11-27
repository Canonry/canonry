# Sign in with ChatGPT

An install can let invited people sign in to the dashboard with their ChatGPT
account, and run their Aero answers on their own ChatGPT plan instead of the
install's provider key. The two are switched on separately:

| Switch | What it does | What OpenAI must have approved |
|---|---|---|
| `chatgpt.signIn` | "Continue with ChatGPT" on the sign-in screen, for invited email addresses | A hosted OAuth client (identity scopes) |
| `chatgpt.planUsage` | A signed-in viewer's Aero runs on their ChatGPT plan once they connect it | The same client with the plan scopes (`resource.invoke`, `chatgpt.tokens.use.direct`) |
| `chatgpt.requirePlan` | Viewers must connect their plan to use Aero; the install's key never pays for viewer Aero | Same as `planUsage` |

Both are off unless configured. Name and password sign-in, API keys and the
operator's own Aero are unchanged.

## Before you start

- **An OAuth client from OpenAI.** Sign in with ChatGPT for a hosted site is
  offered to approved partners. Plan usage for a hosted site is a separate
  approval. Check which scopes your client may request before turning
  `planUsage` on.
- **The callback, registered exactly.** OpenAI redirects to
  `<publicUrl>/api/v1/auth/chatgpt/callback`, e.g.
  `https://dash.example.com/api/v1/auth/chatgpt/callback`. Each install's
  callback must be registered with the client. `publicUrl` must be HTTPS (a
  loopback `http://localhost` URL works for local testing only).
- **Eligible plans.** OpenAI documents plan usage for ChatGPT Plus and Pro.
  A person whose plan cannot be used gets a plain message saying so; their
  turns are never moved onto the install's key.

## Configure

In `config.yaml`:

```yaml
publicUrl: https://dash.example.com
chatgpt:
  clientId: <client ID from OpenAI>
  clientSecret: <only for a confidential client>
  signIn: true
  planUsage: true
  requirePlan: true   # optional: no viewer Aero without the viewer's own plan
  tokenKey: <64 hex characters: openssl rand -hex 32>
```

- `tokenKey` encrypts each person's plan tokens in the database (AES-256-GCM,
  bound to the row). It is required with `planUsage`. `CANONRY_CHATGPT_TOKEN_KEY`
  overrides it. Changing it asks every connected person to connect again; it
  does not sign anyone out.
- Viewer Aero must be on (`agent.allowViewers: true`) for viewers to use Aero
  at all.
- Behind a reverse proxy, declare it with `CANONRY_TRUST_PROXY` (as for name
  and password sign-in): the ChatGPT routes budget each caller by their real
  address, and an undeclared proxy makes everyone share one budget.
- Restart the server after changing the block. A block that is switched on but
  missing a client ID or an HTTPS `publicUrl` stays off and logs
  `chatgpt.disabled`.

## Invite people

Sign in with ChatGPT admits only invited email addresses and accounts that
already linked ChatGPT.

```bash
cnry user invite jordan@example.com --role viewer
cnry user invitations
cnry user uninvite <invitation-id>
```

Nothing is emailed. Tell the person to open the dashboard and choose
**Continue with ChatGPT** with the ChatGPT account that uses that address. If
ChatGPT reports the address as verified, their account is created with the
invited role and their ChatGPT identity is linked to it. From then on the
identity, not the email, signs them in.

- Invitations expire after 14 days and are used once. Inviting an address
  again replaces its pending invitation.
- An invitation never attaches to an existing account. An existing account
  links ChatGPT itself while signed in (`/api/v1/auth/chatgpt/start?intent=connect`).
- The first account on an install must be an administrator, so only an
  administrator can be invited before any account exists.
- Accounts created this way have no password. The password form treats their
  names like unknown names.
- Deleting an account also revokes its ChatGPT plan grant at OpenAI.

API: `GET|POST /api/v1/users/invitations`, `DELETE /api/v1/users/invitations/{id}`
(administrators or a full-instance key, `users.read` / `users.write`).

## What people see

- **Sign-in screen.** With `signIn` on, **Continue with ChatGPT** is the main
  action and name and password sit behind **Sign in with a password** for
  administrators. A refused ChatGPT sign-in comes back with one plain sentence
  (see Troubleshooting).
- **Aero bar, for viewers.** One line under the composer says the answers use
  their ChatGPT plan and which model; its menu changes the model or
  disconnects, and **Manage usage** opens ChatGPT's usage page. With
  `requirePlan`, a viewer without a working plan sees **Connect ChatGPT to use
  Aero** and a connect step in place of the conversation. Without it, a quiet
  **Use your ChatGPT plan** link sits under the composer.
- A failed answer shows the plan's problem with its one fix: **Check usage**
  for a usage limit, **Continue with ChatGPT** to connect again.
- Administrators' own Aero is unchanged.
- **MCP consent page.** Its sign-in step offers Continue with ChatGPT too and
  comes back to the same request, so people whose account has no password can
  approve MCP clients.

The button uses OpenAI's black and white formats through the dashboard's
primary button. OpenAI's guidelines also call for their logo on it: add the
official asset from OpenAI before a public launch.

## Aero on a person's plan

With `planUsage` on, signing in with ChatGPT also asks the person to let the
dashboard use their plan. Once granted:

- Their Aero turns run on their plan, on the install's Aero model when their
  plan lists it, otherwise the first model it lists. They can choose another
  (`GET /api/v1/auth/chatgpt/models`, `PUT /api/v1/auth/chatgpt/model`).
- Everything else about a viewer's Aero is unchanged: read-only tools with
  their own authority, no operator memory or conversations.
- Plan-funded turns have their own daily ceiling (200 per project), because
  the install no longer pays for the model; OpenAI applies the plan's limits
  on top.
- Requests go only to `https://api.openai.com/v1`, never through a configured
  OpenAI proxy, with `store: false`.
- Connecting or disconnecting a plan starts a fresh conversation.

When the plan cannot answer, the person sees one of: connect again, usage
limit reached (with a link to <https://chatgpt.com/settings/usage>), plan not
eligible, or ChatGPT unavailable. A plan that needs connecting again is
refused, not charged to the install. A viewer with no plan connected uses the
install's Aero as before, unless `requirePlan` is on: then Aero asks them to
connect their plan first (`409`, reason `chatgpt-connect-required`), and
`GET /api/v1/auth/chatgpt/status` reports `planRequired: true` so the
dashboard can offer the connect step up front.

`POST /api/v1/auth/chatgpt/disconnect` deletes the stored grant, then revokes
it at OpenAI; `revoked: false` means OpenAI did not confirm, and the person
can also remove the app in ChatGPT settings. The ChatGPT link stays, so they
can still sign in with it.

## How it is protected

- Authorization code flow with S256 PKCE, `state` and `nonce`. The PKCE
  verifier and a browser-binding secret live in a ten-minute HttpOnly cookie
  on the browser that started the sign-in; the database holds only digests. A
  callback opened in another browser, replayed, or late is refused.
- ID tokens are verified against OpenAI's published keys: RS256 only, issuer
  `https://auth.openai.com`, this client as audience, expiry, and the nonce.
- An identity is keyed by issuer, client ID and subject. A new client ID
  starts new links.
- Granted scopes are authoritative. A grant without both plan scopes stores
  no plan; a refresh that drops them ends it.
- Refreshes are compare-and-swap on a row revision, and are never retried
  blindly: OpenAI rotates refresh tokens.
- Plan tokens are the one kind of credential kept in the database rather than
  `config.yaml`: they are per person and rotate hourly. They are stored only
  as ciphertext under `tokenKey`, which lives in `config.yaml`.

## Troubleshooting

The sign-in screen reports `chatgpt_error` codes after a failed callback:

| Code | Meaning |
|---|---|
| `not-invited` | No linked identity and no pending invitation for that verified email |
| `unverified-email` | ChatGPT has not verified the account's email |
| `already-linked` | That ChatGPT account is linked to another account here |
| `expired` | Took longer than ten minutes, opened in another browser, or replayed |
| `denied` | The person cancelled at OpenAI |
| `disabled` | Sign-in is off, or the block is incomplete |
| `failed` | OpenAI refused the code, or the ID token did not verify |

`GET /api/v1/auth/chatgpt/status` shows what the install offers and the
signed-in person's link and plan.

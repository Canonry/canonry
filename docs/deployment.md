# Deployment Guide

Canonry runs as a self-hosted server. This guide covers common deployment patterns.

## Tenancy model (read this first)

**Canonry is single-tenant.** Every deployment — local `canonry serve` or the
Cloud Run `apps/api` shape — is designed to host exactly one trust boundary:
one operator's projects, or one team's projects. There is no per-tenant
isolation inside an instance.

What this means:
- Every valid `cnry_…` API key can read and write every project on the
  instance. Treat each key like a root credential.
- Two projects on the same instance that track the same `canonicalDomain`
  share their Google Search Console / Bing OAuth connections by design.
- `PUT /api/v1/settings/*` rewrites global provider keys and OAuth client
  secrets — anyone with any key can flip them.

If you need to host multiple unrelated teams, deploy one Cloud Run service
per team, with separate databases and OAuth clients. Multi-tenancy as a
schema feature is **not** on the current roadmap — see root `AGENTS.md`
→ "Deployment Posture" for what it would take to build it.

## Local (default)

```bash
canonry bootstrap
canonry serve
```

Opens at [http://127.0.0.1:4100](http://127.0.0.1:4100). No provider credential is needed for Page Health.

Local state defaults to `~/.canonry/config.yaml` and `~/.canonry/data.db`.
Set `CANONRY_CONFIG_DIR=/private/path` consistently for `canonry bootstrap`,
the server, and all CLI/MCP clients to isolate an install in another directory.
Provider credentials are optional for bootstrap and Page Health.

> **Use `127.0.0.1`, not `localhost`.** `canonry serve` binds the IPv4 loopback
> `127.0.0.1` (override with `CANONRY_HOST`). On machines where `localhost`
> resolves to the IPv6 loopback `::1` first, `http://localhost:4100` returns
> *connection refused* even though the server is up — browse to
> `http://127.0.0.1:4100` instead, or set `CANONRY_HOST=::1` to bind IPv6.

### First-run dashboard password

The first time you open the dashboard, it asks you to create a dashboard
password. Every password sign-in uses the install's root API key (`apiKey` in
`config.yaml`), so setting the password gives full access to every project.

- **On this machine:** with the default loopback bind, open
  `http://127.0.0.1:4100` and create the password. No API key is needed,
  unless the configuration names another way in (see the next item).
- **From another machine or through a proxy:** the dashboard also asks for the
  root API key. This applies to every request when Canonry binds a non-loopback
  address (`--host 0.0.0.0`, Docker), and to any request that comes through a
  reverse proxy or Tailscale Serve, also when Canonry binds loopback. When
  `publicUrl` or `apiUrl` names a host other than `localhost` or a loopback
  address, a base path is set (`basePath`, `--base-path`, or
  `CANONRY_BASE_PATH`), or `CANONRY_TRUST_PROXY` is set, it applies to every
  request, also on this machine. The dashboard sends the key with that one
  setup request and does not store it. Other API keys, including full-access
  keys from `canonry key create`, are refused.

> **Create the password before you forward the port.** Without the root API
> key, Canonry accepts the setup from any process that can connect to its
> loopback port. A TCP forwarder on the same machine (`ssh -R`, `socat`,
> `kubectl port-forward`, `tailscale serve --tcp`, `ngrok tcp`) adds no header,
> so Canonry cannot tell its remote clients from local ones. Create the
> password before you start the forwarder.

To find the root API key, read `apiKey` in the config file:

```bash
grep '^apiKey:' "${CANONRY_CONFIG_DIR:-$HOME/.canonry}/config.yaml"
```

The same rule applies to `POST /api/v1/session/setup` with
`Authorization: Bearer <root API key>`. Without the key, the request gets
`401 AUTH_REQUIRED` and Canonry writes nothing. If the root API key in
`config.yaml` was revoked or deleted, a request with that key gets
`401 AUTH_INVALID`, which tells you to run `canonry bootstrap`.

Dashboard sessions persist in the database and survive server restarts. Shared-password
and API-key logins expire twelve hours after sign-in; logout and key revocation
still end access. Rotating an API key ends its browser sessions, even when bootstrap
retains the key's ID. Changing the dashboard password hash and restarting ends
password-derived sessions; API-key sign-ins are independent of that password.
Restoring previous credentials does not revive ended sessions. Named-account
sessions renew during use, up to thirty days.
Cookies are HttpOnly, so page JavaScript cannot read them; inspect them in the
browser's cookie storage. Sessions created before durable storage was introduced
need one new sign-in after upgrading. Upgrading sessions without credential
bindings also requires a new sign-in.

> **Only disable the dashboard password behind upstream auth.** `dashboard:
> { requirePassword: false }` (or `CANONRY_DASHBOARD_REQUIRE_PASSWORD=0`) skips
> Canonry's browser password gate while leaving API bearer-key auth intact. Set
> it false only when an upstream layer enforces auth, such as the Canonry Embed
> proxy. Never expose an engine with `requirePassword: false` directly to the
> internet.

To remove optional dashboard chrome, set either option to false:

```yaml
dashboard:
  showResourceLinks: false
  showUpdateNotification: false
```

`showResourceLinks` removes the GitHub, documentation, and changelog icons
from the sidebar and page footer. `showUpdateNotification` removes the
available-version badge from the sidebar but keeps update checks and CLI
notices active.

For container deployments, set `CANONRY_DASHBOARD_SHOW_RESOURCE_LINKS=0` or
`CANONRY_DASHBOARD_SHOW_UPDATE_NOTIFICATION=0`.

### Reset a forgotten dashboard password

An operator with access to the server's config file can reset the shared
dashboard password. The old password cannot be recovered. This procedure does
not reset named-account passwords; installs with named accounts keep using
their account sign-in screen.

1. Stop Canonry and any TCP port forwarders to it. For a foreground
   `canonry serve`, press Ctrl+C. For a daemon, container, or managed service,
   stop it through the tool that started it.
2. Locate the server's `config.yaml`: `~/.canonry/config.yaml` by default, or
   `config.yaml` in its `CANONRY_CONFIG_DIR`. For a container, edit the file in
   its persistent config volume.
3. Keep a private backup, then remove only the top-level
   `dashboardPasswordHash` entry and save the file. Keep the rest of the config,
   including `apiKey`, and the database intact. The config and its backup
   contain credentials; do not share them.
4. Restart Canonry with the same config directory. Open the dashboard and
   create a new password. Setup through a proxy, on a network bind, or with an
   external URL or base path still requires the root API key, as described in
   [First-run dashboard password](#first-run-dashboard-password).
5. Re-enable any TCP port forwarders only after the new password is set.

The restart is required: the running server holds the configured password hash
in memory. Removing the hash and restarting ends password-derived sessions;
API-key sign-ins remain independent. Do not disable `dashboard.requirePassword`
to recover access.

### Managed run kinds

Use `dashboard.managedRunKinds` for a deployment where your team runs work for
clients:

```yaml
dashboard:
  managedRunKinds:
    - answer-visibility
    - site-audit
```

For containers, set
`CANONRY_DASHBOARD_MANAGED_RUN_KINDS=answer-visibility,site-audit` and restart.
Values must belong to `schedulableRunKindSchema`; an unknown kind refuses boot
with the setting name. The list is deduplicated. Other schedulable kinds are
accepted for configuration, but this release changes only sweep and scan UI.

Resolution order is the new environment list, the legacy environment boolean,
the new YAML list, then the legacy YAML boolean. Blank environment values fall
through. An empty YAML list disables management. Within each source, the new
list replaces the legacy setting; it does not add to it.
`CANONRY_DASHBOARD_MANAGED_SWEEPS=1` and `dashboard.managedSweeps: true` remain
compatible aliases for `['answer-visibility']` only. The legacy environment
value `0` still disables management unless the new environment list is set.

Simple and Advanced Measurement dashboards use the same presentation policy:

- `answer-visibility` hides launch controls for **all dashboard roles, including
  admins**. This preserves the original managed-sweeps deployment behavior.
  Operators retain `canonry run <project>` as their manual lever. Settings keeps
  schedule reads but hides schedule changes. Dashboard Aero uses read-only tools
  and disables its sweep shortcut and write-scope toggle. Aero is also refused
  sweep and schedule writes on the server; see below.
- `site-audit` hides scan launch and retry controls, plus next-scan settings, for
  **viewers only**. Admins retain scan controls so they can investigate failures
  from Site Health. Both scan dispatchers also suppress managed viewer launches.
  This role-aware scan policy deliberately differs from the legacy sweep policy.

Managed status reads the corresponding schedule's actual `nextRunAt`.
Site Health shows “Next scan Thursday 1 Oct, 06:00 UTC · managed by your Canonry
team” when that is the enabled schedule's time. Without a usable schedule time,
it shows “Scans are run by your Canonry team”, with no invented date. The sweep
status shows the next date in the schedule's own timezone, such as “Next sweep:
Sep 23”. It shows “Sweep running…” during a run and “Next sweep unavailable”
when there is no usable time. Pages that would otherwise offer a sweep say
“Sweeps are run by your Canonry team”.
Queued/running states, scores, factor scorecards, page lists, maps, failure and
partial-scan explanations, and dead-link results remain available.

The admin-only project-creation scan in `OnboardingSetupPage` is outside this
client presentation policy. Discovery and Research runs retain their existing
access rules and use provider quota separately from scheduled visibility sweeps.

These settings are **presentation only**, with one exception: Aero. CLI, API,
MCP, scheduling, and server authorization are unchanged. Viewer sessions and
read-only keys cannot start scans or sweeps regardless of these settings. With
neither setting, the injected client config is byte-identical;
`managedRunKinds` is injected only when non-empty.

When `answer-visibility` is managed, Aero does not get the tools that start
or fill a run, write or delete a schedule, or apply a project config (an
applied spec replaces the schedule). Its cancel tool refuses answer-visibility
sweeps but still stops the site audits and syncs Aero can start. This holds in
every tool scope, so a write-scope Aero turn from the API or
`canonry agent ask` cannot start a sweep either. Aero can still read runs and
schedules. The operator's own `canonry run` and `canonry schedule` commands are
unaffected.

### Viewer Aero

By default only administrators can use Aero. To let signed-in viewer accounts
use it too:

```yaml
agent:
  allowViewers: true
```

`CANONRY_AGENT_ALLOW_VIEWERS=1` overrides it for container deployments.

A viewer gets their own Aero conversation, kept in server memory and cleared
on restart. They never see an administrator's conversations, history or Aero
memory notes, and an administrator's conversation never receives a viewer's
turns. Each turn runs on a short-lived read-only key delegated to the viewer,
so every tool call has exactly the viewer's own access, and the key is revoked
when the turn ends. Viewers get read tools only, without live ads or Google
Marketing reads, and cannot pick the model. On a managed install they cannot
start or schedule sweeps either. Each viewer can run 50 turns per project per
UTC day; every turn uses the install's configured Aero model and its budget.
API keys are unaffected: a narrow key is still refused on every Aero route.

### Viewer research

An operator can let signed-in viewer accounts run isolated research queries:

```yaml
research:
  allowViewers: true
  viewerDailyRunLimit: 20
```

`CANONRY_RESEARCH_ALLOW_VIEWERS` and
`CANONRY_RESEARCH_VIEWER_DAILY_RUN_LIMIT` override these values for container
deployments. The opt-in defaults to false; the daily per-project cap defaults
to 20 and resets at 00:00 UTC.

This grant covers only `POST /projects/:name/research/runs`. It does not grant
access to provider settings, tracked-query changes, discovery, or visibility
sweeps. Administrators and wildcard API keys keep their existing access.
Explicit `research.run` API keys can run research independently of the viewer
opt-in; `read` alone and unrelated scopes cannot. Viewer OAuth clients must
explicitly obtain `research.run` consent, bounded by this deployment opt-in.
Existing read-only OAuth grants do not acquire research permission automatically.

The daily cap is shared by all limited research callers for a project across
browser sessions, API, CLI, and MCP. Reconnecting or using another key does not
reset it; replaying an identical idempotent request does not consume another
batch. The configuration names remain unchanged for compatibility. Each new
run records the initiating account or API key and whether it consumed the
limited budget. MCP retains the original account, not an ephemeral session
identity. See [MCP research access](mcp.md#research-access) for setup.

### Embed fonts

Canonry ignores the `font` key in `embed.theme` and `X-Canonry-Embed-Theme`.
All dashboards use the bundled Geist fonts. They do not load Google Fonts or
fonts from the host page. The `mode`, `bg`, `fg`, and `accent` theme keys remain
available.

---

## Behind a Reverse Proxy

You can serve canonry behind any reverse proxy — nginx, Caddy, Traefik, etc. — at either the root path or a sub-path.

Canonry checks the HTTP `Host` header to prevent DNS rebinding. It accepts
`localhost`, valid IPv4/IPv6 addresses, the configured bind hostname, and the
hostnames in `apiUrl` and `publicUrl`. Other DNS names receive HTTP 403.

If the proxy hostname is absent from `apiUrl`, set `publicUrl` in
`~/.canonry/config.yaml`:

```yaml
publicUrl: https://example.com
```

Use the external URL's actual scheme and hostname. Restart Canonry after this
change. Configure the proxy to forward the external `Host` header.

For a sub-path, include the prefix in `publicUrl`, for example
`https://example.com/canonry/`, and set `basePath: /canonry/`.

**First-run password through a proxy.** The proxy connects to Canonry over
loopback, but the visitor is remote. Enter the root API key in the setup form
(see [First-run dashboard password](#first-run-dashboard-password)). You can
also create the password on the server itself before you set `publicUrl` and
open the proxy.

Canonry refuses a first-run password setup without the root API key in these
cases:

- `publicUrl` or `apiUrl` names a host other than `localhost` or a loopback
  address, a base path is set, or `CANONRY_TRUST_PROXY` is set. This applies
  to every request.
- The request has a `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`,
  `CF-Connecting-IP`, or `True-Client-IP` header.
- The request has a `Host` that is not `localhost` or a loopback address.
- The request uses HTTP/1.0. nginx sends HTTP/1.0 to Canonry unless you set
  `proxy_http_version`. This catches a bare `proxy_pass`, which sets `Host` to
  the loopback upstream and adds no forwarding header.

The client sets `Host`, and nginx's `$host` is the value that the client sent.
Thus `Host` cannot show that a request is local. The forwarding headers mark a
request as proxied, so configure the proxy to send `X-Forwarded-For`, as the
examples below do.

> **A proxy without forwarding headers leaves setup open.** Some proxies send
> HTTP/1.1 and no forwarding header, for example nginx with
> `proxy_http_version 1.1;` and no `X-Forwarded-For`, or HAProxy without
> `option forwardfor`. Through such a proxy, a visitor who sends
> `Host: localhost` looks local to Canonry. If neither `publicUrl` nor a base
> path is set, that visitor can create the password without the root API key.
> Create the password before you open the proxy, or configure the proxy to
> send `X-Forwarded-For`.

### Root path (`/`)

Proxy all traffic on a domain directly to canonry's port:

**Caddy:**
```caddy
example.com {
    reverse_proxy localhost:4100
}
```

**nginx:**
```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://localhost:4100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

### Sub-path (`/canonry/`, `/tools/canonry/`, etc.)

When canonry shares a domain with other services, serve it under a prefix. Use `--base-path` to tell canonry where it lives:

```bash
canonry serve --base-path /canonry/
```

Or set it in your config (`~/.canonry/config.yaml`):

```yaml
basePath: /canonry/
```

Canonry will automatically:
- Inject `<base href="/canonry/">` into the HTML so all asset URLs resolve correctly
- Make the web app route relative to the prefix
- Route API calls through the prefix so the reverse proxy can forward them correctly

**Caddy:**
```caddy
example.com {
    # Canonry API — must be routed before the UI prefix rule
    handle /api/v1* {
        reverse_proxy localhost:4100
    }

    # Canonry UI — strip prefix before proxying
    handle /canonry* {
        uri strip_prefix /canonry
        reverse_proxy localhost:4100
    }

    # Other services
    handle {
        reverse_proxy localhost:3000
    }
}
```

**nginx:**
```nginx
server {
    listen 80;
    server_name example.com;

    # Canonry API
    location /api/v1/ {
        proxy_pass http://localhost:4100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Canonry UI
    location /canonry/ {
        proxy_pass http://localhost:4100/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **Note:** The `/api/v1` rule must come before the catch-all. Canonry's API calls use absolute paths (`/api/v1/...`) — they need to reach port 4100 regardless of the UI prefix.

---

## Daemon mode

Run canonry as a background process that survives terminal exits:

```bash
canonry start                          # Start in background
canonry start --base-path /canonry/   # With sub-path
canonry stop                           # Stop daemon
```

---

## Environment variables

All CLI flags have environment variable equivalents:

| Flag | Env var | Default |
|------|---------|---------|
| `--port` | `CANONRY_PORT` | `4100` |
| `--host` | `CANONRY_HOST` | `127.0.0.1` |
| `--base-path` | `CANONRY_BASE_PATH` | _(none)_ |

Example with env vars (useful for systemd units, Docker, etc.):

```bash
CANONRY_PORT=4100 CANONRY_BASE_PATH=/canonry/ canonry serve
```

Deployment identity is env-only and is reported by `GET /health`: `CANONRY_INSTANCE` names the instance, `CANONRY_INSTANCE_ROLE` tags what it is for (convention: `internal`, `client-demo`, `client-trial`, `preview`), and `CANONRY_COMMIT` supplies the build commit when the bundle was built without git. See "Health endpoint" in `AGENTS.md` for the response shape.

```bash
CANONRY_INSTANCE=acme-demo CANONRY_INSTANCE_ROLE=client-demo canonry serve
```

---

## Tailscale

To share canonry over a Tailscale network with HTTPS:

Set `publicUrl` to your Tailscale HTTPS URL in `~/.canonry/config.yaml`:

```yaml
publicUrl: https://your-node.your-tailnet.ts.net
```

Restart Canonry after this change.

```bash
# Expose port 4100 via Tailscale Serve (HTTPS on :443)
tailscale serve --bg http://localhost:4100

# Access at https://<hostname>.tail…ts.net
```

Because `publicUrl` names the tailnet host, the first-run password setup asks
for the root API key, also on this machine (see
[First-run dashboard password](#first-run-dashboard-password)).

For sub-path via Caddy + Tailscale, configure Tailscale Serve to point at Caddy's port (80) and use the Caddy sub-path config above.

---

## Systemd unit (Linux)

Create `/etc/systemd/system/canonry.service`:

```ini
[Unit]
Description=Canonry — agent-first AEO operating platform
After=network.target

[Service]
Type=simple
User=youruser
ExecStart=/usr/local/bin/canonry serve --port 4100 --base-path /canonry/
Restart=on-failure
RestartSec=5
Environment=CANONRY_CONFIG_DIR=/home/youruser/.canonry

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now canonry
```

---

## Docker

```dockerfile
FROM node:22-alpine
RUN npm install -g @canonry/canonry
# Tells update notices to upgrade by rebuilding this image.
ENV CANONRY_INSTALL_METHOD=docker
EXPOSE 4100
CMD ["canonry", "serve", "--host", "0.0.0.0"]
```

```bash
docker build -t canonry .
docker run -d \
  -p 4100:4100 \
  -v $HOME/.canonry:/root/.canonry \
  -e CANONRY_BASE_PATH=/canonry/ \
  canonry
```

Direct access through `localhost` or the Docker host's IP address requires no
`publicUrl`. For a DNS name, configure `publicUrl` as described under
"Behind a Reverse Proxy".

The container binds `0.0.0.0`, so the first-run password setup always asks
for the root API key, also from the Docker host. In the example above, the key
is `apiKey` in the mounted `$HOME/.canonry/config.yaml`. For a container
without that mount, read it from the container:

```bash
docker exec <container> sh -c 'grep "^apiKey:" "${CANONRY_CONFIG_DIR:-$HOME/.canonry}/config.yaml"'
```

---

## How sub-path works (internals)

Canonry's web app is built with relative asset paths (`./assets/...`). At runtime, when `--base-path` is set, the server injects two things into every HTML response before it reaches the browser:

1. `<base href="/canonry/">` — tells the browser to resolve all relative URLs from the prefix, so `./assets/index.js` → `/canonry/assets/index.js`
2. `window.__CANONRY_CONFIG__ = { ..., basePath: "/canonry/" }` — the app reads this at startup to configure routing and API calls

This means a single pre-built canonry binary can be deployed at any path without rebuilding.

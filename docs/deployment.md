# Deployment Guide

Canonry runs as a self-hosted server. This guide covers common deployment patterns.

## Local (default)

```bash
canonry serve
```

Opens at [http://localhost:4100](http://localhost:4100). No configuration needed.

---

## Behind a Reverse Proxy

You can serve canonry behind any reverse proxy — nginx, Caddy, Traefik, etc. — at either the root path or a sub-path.

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
    }

    # Canonry UI
    location /canonry/ {
        proxy_pass http://localhost:4100/;
        proxy_set_header Host $host;
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

---

## Tailscale

To share canonry over a Tailscale network with HTTPS:

```bash
# Expose port 4100 via Tailscale Serve (HTTPS on :443)
tailscale serve --bg http://localhost:4100

# Access at https://<hostname>.tail…ts.net
```

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
RUN npm install -g @ainyc/canonry
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

---

## How sub-path works (internals)

Canonry's web app is built with relative asset paths (`./assets/...`). At runtime, when `--base-path` is set, the server injects two things into every HTML response before it reaches the browser:

1. `<base href="/canonry/">` — tells the browser to resolve all relative URLs from the prefix, so `./assets/index.js` → `/canonry/assets/index.js`
2. `window.__CANONRY_CONFIG__ = { ..., basePath: "/canonry/" }` — the app reads this at startup to configure routing and API calls

This means a single pre-built canonry binary can be deployed at any path without rebuilding.

## Summary

Two changes:

### 1. `canonry notify add --tunnel` — Spin up a cloudflared quicktunnel automatically

Adds `--tunnel` as an alternative to `--webhook`. When used, canonry spawns a cloudflared quicktunnel to the local server and uses the resulting public URL as the webhook target. The tunnel is kept alive for the duration of the process so the webhook remains reachable.

```bash
# Before: manually find a publicly reachable URL
canonry notify add myproject --webhook https://public.example.com/hooks/canonry --events run.completed,run.failed

# After: canonry handles the tunnel automatically
canonry notify add myproject --tunnel --events run.completed,run.failed
# Spawning cloudflared quicktunnel to local canonry server...
#   Tunnel ready: https://xxxx.trycloudflare.com
```

**Implementation:**
- `packages/canonry/src/commands/tunnel.ts` — new file, wraps cloudflared spawn + URL extraction
- `packages/canonry/src/cli-commands/notify.ts` — new `--tunnel` flag, mutually exclusive with `--webhook`

### 2. `resolveHostAddresses` DNS resolution fix

The webhook URL validator was using `dns.lookup`, which routes through the system stub resolver (e.g. systemd-resolved). On networks where the stub resolver fails to reach authoritative DNS for CDN domains (cloudflared, Fastly, etc.), this caused valid webhook URLs to be rejected as "hostname could not be resolved."

Switched to `dns.resolve4` / `dns.resolve6` which perform recursive queries directly to the configured nameservers.

```diff
- const records = await dns.lookup(hostname, { all: true, verbatim: true })
+ const [ipv4, ipv6] = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)])
```

**Files changed:**
- `packages/api-routes/src/webhooks.ts` — replace `dns.lookup` with `dns.resolve4`/`dns.resolve6`

## Testing

```bash
canonry notify add myproject --tunnel --events run.completed,run.failed
# Verify the notification was created with a public trycloudflare.com URL
canonry notify list myproject
```

## Requirements

- `cloudflared` binary must be installed and in PATH
- DNS resolution for `*.trycloudflare.com` must work via the configured nameserver

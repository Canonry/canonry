# Security Policy

## Reporting a vulnerability

Email **security@canonry.ai**. Do not open a public issue, pull request or
discussion for a suspected vulnerability.

Include what you can of:

- the affected version (`cnry --version`) and how Canonry runs (local
  `canonry serve`, Docker, Cloud Run or the MCP gateway);
- the component (API route, CLI command, MCP tool, dashboard page or
  integration);
- steps to reproduce, or a proof of concept against your own install;
- the impact you expect, such as data exposure, privilege escalation or
  server-side request forgery.

Do not send real API keys, OAuth tokens, customer data or production database
files. Redact them, or reproduce against a fresh install with test credentials.

## Supported versions

Fixes ship in the next release of `@canonry/canonry` on npm. Only the latest
published version is supported, so upgrade before reporting and confirm the
issue still reproduces.

## Scope

In scope: the `@canonry/canonry` package (CLI, server, MCP adapter, built-in
Aero agent and dashboard), `apps/api`, `apps/mcp-gateway`, and the agent
plugins and skills in this repository.

Out of scope:

- vulnerabilities in third-party services Canonry connects to (AI engines,
  Google, Bing, Cloudflare, Vercel, WordPress, ad platforms); report those to
  the vendor;
- findings that need an attacker who already holds a full-instance API key or
  shell access to the host;
- running one instance for unrelated tenants. Canonry is single-tenant by
  design: one trust boundary per instance (see "Deployment Posture" in
  [AGENTS.md](AGENTS.md)).

## Safe harbor

Good-faith research that follows this policy, stays within your own
installation and accounts, and avoids privacy violations, data destruction and
service disruption is welcome. Give us a reasonable chance to fix an issue
before you disclose it.

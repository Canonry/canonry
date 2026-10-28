import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import html from 'escape-html'

export const consentFontPath = '/assets/geist-latin-5.3.0.woff2'
export const consentFont = readFileSync(createRequire(import.meta.url).resolve('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'))
const canary = readFileSync(new URL('../assets/canary.svg', import.meta.url), 'utf8')

// Standalone equivalents of DESIGN.md and apps/web/src/geist.css. No dashboard runtime is required.
const styles = `
@font-face {
  font-family: 'Geist'; font-style: normal; font-weight: 100 900; font-display: swap;
  src: url('${consentFontPath}') format('woff2');
}
:root {
  color-scheme: dark;
  --bg: hsl(0 0% 4%); --surface: hsl(0 0% 4%); --hover: hsl(0 0% 10%);
  --border: hsl(0 0% 18%); --border-strong: hsl(0 0% 53%);
  --text: hsl(0 0% 93%); --secondary: hsl(0 0% 63%);
  --accent-hover: hsl(0 0% 80%); --focus: hsl(210 100% 66%);
  font-family: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-synthesis: none; -webkit-font-smoothing: antialiased;
  background: var(--bg); color: var(--text);
}
* { box-sizing: border-box; }
body { margin: 0; font-size: 14px; line-height: 20px; }
main { min-height: 100vh; min-height: 100svh; display: flex; align-items: center; justify-content: center; padding: 48px 24px; }
.connection { width: 100%; max-width: 448px; min-width: 0; }
.brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 24px; font-size: 18px; line-height: 24px; font-weight: 600; }
.brand-icon, .brand-icon svg { display: block; width: 28px; height: 28px; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 32px; }
h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -.96px; }
p { margin: 0; overflow-wrap: anywhere; }
.intro { color: var(--secondary); margin-top: 8px; }
strong { color: var(--text); font-weight: 550; }
form { margin-top: 28px; }
label { display: block; margin-bottom: 8px; font-weight: 500; }
select, button { font: inherit; }
select { display: block; width: 100%; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); text-overflow: ellipsis; cursor: pointer; }
select:hover:not(:disabled) { border-color: var(--border-strong); }
.hint { margin-top: 8px; font-size: 13px; line-height: 20px; color: var(--secondary); }
.permissions { margin-top: 24px; padding: 20px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.permissions p { color: var(--secondary); }
.permissions p + p { margin-top: 8px; }
details { margin-top: 16px; }
summary { width: fit-content; max-width: 100%; padding: 6px 0; color: var(--secondary); cursor: pointer; font-size: 13px; line-height: 20px; border-radius: 2px; }
summary:hover { color: var(--text); }
summary::marker { font-size: 11px; }
dl { margin: 8px 0 0; font-size: 13px; line-height: 20px; }
dt { color: var(--secondary); }
dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin-top: 24px; }
button { min-height: 36px; border: 1px solid transparent; border-radius: 6px; padding: 7px 14px; font-size: 14px; line-height: 20px; font-weight: 500; cursor: pointer; transition: background-color 150ms ease-out, border-color 150ms ease-out; }
.primary { background: var(--text); color: var(--bg); }
.primary:hover:not(:disabled) { background: var(--accent-hover); }
.primary:active:not(:disabled) { background: var(--secondary); }
.secondary { border-color: var(--border); background: var(--surface); color: var(--text); }
.secondary:hover { background: var(--hover); border-color: var(--border-strong); }
.secondary:active { background: var(--border); }
:where(select, button, summary):focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 480px) {
  main { padding: 32px 16px; align-items: flex-start; }
  .brand { margin-bottom: 24px; }
  .panel { padding: 24px; }
  .actions { grid-template-columns: minmax(0, 1fr); }
  select { height: 48px; font-size: 16px; }
  button { min-height: 44px; padding: 11px 14px; }
  summary { min-height: 44px; display: list-item; padding-top: 12px; padding-bottom: 12px; }
}
@media (pointer: coarse) { select, button, summary { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
@media (forced-colors: active) { .primary, .secondary, select { border: 1px solid ButtonText; } }
`

interface ConsentPage {
  nonce: string
  clientName: string
  redirectUri: string
  action: string
  csrf: string
  workspaces: Array<{ id: string; name: string }>
}

export function renderConsentPage(input: ConsentPage): string {
  const unavailable = input.workspaces.length === 0
  const options = input.workspaces.map(workspace => `<option value="${html(workspace.id)}">${html(workspace.name)}</option>`).join('')
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#0a0a0a">
<title>Connect a workspace · Canonry</title>
<style nonce="${html(input.nonce)}">${styles}</style>
</head><body><main><div class="connection">
<div class="brand"><span class="brand-icon" aria-hidden="true">${canary}</span><span>Canonry</span></div>
<section class="panel" aria-labelledby="consent-title">
<header><h1 id="consent-title">Connect a workspace</h1>
<p class="intro"><strong>${html(input.clientName)}</strong> requests read-only access.</p></header>
<form method="post" action="${html(input.action)}">
<input type="hidden" name="csrf" value="${html(input.csrf)}">
<label for="workspace">Workspace</label>
<select id="workspace" name="tenant"${unavailable ? ' aria-describedby="workspace-hint" disabled' : ''}>${unavailable ? '<option>No workspaces available</option>' : options}</select>
${unavailable ? '<p id="workspace-hint" class="hint">No workspaces are available. Contact your Canonry administrator.</p>' : ''}
<div class="permissions">
<p>Can read stored data. Cannot make changes or start paid work.</p>
<p>Access lasts until you disconnect or it expires.</p>
</div>
<details><summary>Connection details</summary><dl><dt>Return address</dt><dd>${html(input.redirectUri)}</dd></dl></details>
<div class="actions"><button class="primary" type="submit" name="approve" value="yes"${unavailable ? ' disabled' : ''}>Approve read access</button><button class="secondary" type="submit" name="approve" value="no">Cancel</button></div>
</form></section>
</div></main></body></html>`
}

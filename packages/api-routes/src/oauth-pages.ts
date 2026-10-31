import { RESEARCH_RUN_SCOPE } from '@canonry/canonry-contracts'

/**
 * The OAuth sign-in and consent pages, served outside the dashboard. A
 * connection through the hosted gateway reaches them straight after the
 * gateway's Connect page, so they share its standalone DESIGN.md
 * styles and Canonry mark (apps/mcp-gateway/src/consent.ts and
 * apps/mcp-gateway/assets/canonry-mark.svg). Everything is inline: the gate
 * CSP allows no other resource except the dashboard's own font file.
 */

// The plugin icon's canary (plugins/canonry/assets/logo.svg), cropped tight
// so the bird still reads at 28px. Same bytes as the gateway's copy.
const CANONRY_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="154.7 160.4 692.7 692.7" width="28" height="28">
  <rect x="154.7" y="160.4" width="692.7" height="692.7" rx="155" fill="#FFFFFF"/>
  <g fill="#000000">
    <path d="M643.280273,349.521912 C663.564758,358.227753 677.878296,372.354462 685.971619,392.573181 C686.972107,395.072723 688.558105,396.657318 690.965576,397.793091 C700.154480,402.128113 709.299805,406.557098 718.418152,411.038940 C720.137024,411.883789 722.297424,412.287781 723.082764,414.505646 C722.436829,416.736572 720.315369,417.297180 718.672974,418.283936 C710.677063,423.087982 702.737610,428.007751 694.536316,432.438995 C690.292847,434.731812 689.623474,437.601929 690.721252,441.873505 C694.409424,456.224579 697.080322,470.783447 698.648254,485.516296 C706.980408,563.808472 674.667969,637.691406 599.837036,675.696777 C591.244507,680.060791 589.348999,684.706055 588.762085,693.643799 C587.802551,708.253723 591.334656,719.604431 603.608582,728.042114 C606.993469,730.369080 609.692200,733.711975 612.633240,736.661011 C614.834778,738.868713 616.390259,741.451965 615.484070,744.714661 C614.463074,748.390442 611.040588,748.530701 608.186829,748.873535 C602.282593,749.582764 596.495117,748.300415 591.085144,746.121216 C584.405823,743.430725 578.196350,743.029907 571.347473,745.981567 C565.596313,748.460205 559.291748,749.906616 552.809509,748.608948 C546.415894,747.329041 544.679260,742.387268 549.100769,737.268677 C553.124512,732.610596 557.478271,728.232239 561.777283,723.819031 C565.233093,720.271423 566.768433,716.091919 566.706421,711.171570 C566.618774,704.216675 566.684204,697.259827 566.684204,689.673462 C558.493774,691.342041 551.083862,693.058167 543.598328,694.328552 C532.268250,696.251221 520.852844,697.742981 509.332672,697.280762 C504.396545,697.082764 503.395782,699.117798 502.988739,703.669495 C502.131439,713.256897 504.788086,720.890442 512.407776,726.972046 C516.164429,729.970459 519.393433,733.638672 522.797852,737.066711 C525.003601,739.287781 526.529358,741.943420 525.592102,745.147461 C524.603699,748.526367 521.390869,748.625854 518.629883,748.986389 C512.858459,749.740051 507.260590,748.525085 502.034332,746.295715 C496.310394,743.854187 491.006897,743.716125 485.176880,746.123047 C479.977631,748.269592 474.388336,749.726379 468.595459,748.899902 C462.113007,747.975098 460.216949,743.495361 464.340210,738.341492 C467.662201,734.189087 471.266022,730.214600 475.101440,726.532776 C479.828003,721.995667 481.496887,716.581360 481.076111,710.263123 C480.976654,708.769592 481.041229,707.264771 481.039337,705.765137 C481.027771,696.497192 481.037323,696.410034 471.694427,695.478516 C442.248657,692.542664 414.247101,684.167725 387.215302,672.526550 C348.882019,656.018433 314.611755,633.294312 284.843445,603.941284 C282.757477,601.884460 280.240143,600.093811 279.139984,596.988037 C281.286224,594.889709 283.922913,595.734070 286.249481,595.797302 C308.058136,596.389587 329.499695,594.198181 350.292328,587.321228 C397.447968,571.724976 433.482452,542.002075 460.186523,500.492340 C473.036499,480.517883 482.051941,458.583374 492.496124,437.377869 C503.334290,415.372559 514.369690,393.433014 532.379700,376.153564 C552.092468,357.240356 575.247620,345.211548 602.822083,343.025940 C616.616638,341.932617 630.063782,344.054810 643.280273,349.521912 M495.527954,631.939941 C547.588440,610.400635 576.816711,571.974487 581.564331,515.495239 C581.785034,512.869202 582.262817,510.040649 580.342407,507.036652 C576.384949,514.126831 573.027527,520.802063 568.784912,526.969849 C554.886353,547.175476 536.622559,562.492676 515.187866,573.967163 C493.818420,585.406677 473.139191,597.697327 455.509399,614.599426 C445.589752,624.109680 434.727051,632.323120 421.726410,637.308838 C420.815826,637.658081 419.832977,638.096313 420.111389,640.036011 C445.648468,644.186218 470.547882,641.495972 495.527954,631.939941 M620.682800,404.632080 C621.568542,406.034393 622.304260,407.563599 623.365356,408.817505 C628.476868,414.857666 636.107910,416.365417 643.242798,412.856628 C649.758179,409.652466 653.593445,402.235199 652.212341,395.509857 C650.181763,385.621887 641.324646,379.919281 631.735962,382.326355 C622.488525,384.647736 617.546265,394.065552 620.682800,404.632080 z"/>
    <path d="M609.415771,298.999939 C609.404480,308.826233 609.236938,318.156067 609.453552,327.476990 C609.549316,331.600281 608.532349,333.592590 603.946533,333.514648 C599.994507,333.447479 595.979919,334.127533 592.078735,334.906799 C588.809875,335.559723 586.920410,334.955017 585.414673,331.663605 C576.860962,312.965210 563.870667,298.161072 545.954712,287.865753 C542.771973,286.036835 540.935547,284.239990 545.001099,281.431763 C562.686279,269.215973 582.051392,262.950745 603.739685,264.480255 C607.911316,264.774414 609.185059,266.794464 609.195984,270.523499 C609.223389,279.849091 609.336914,289.174438 609.415771,298.999939 z"/>
    <path d="M528.548218,295.440735 C530.920166,292.833984 533.166809,292.846558 535.939697,294.247742 C553.777527,303.261475 567.022461,316.798035 576.192078,334.477356 C577.604675,337.200958 577.081482,338.818573 574.231934,339.850098 C565.409119,343.044037 557.316101,347.609619 549.694580,353.041199 C548.369812,353.985291 547.054626,354.269806 545.502991,353.559906 C532.158264,347.454254 518.989014,348.832764 505.922913,354.526489 C505.487671,354.716187 504.953705,354.679352 504.485840,354.745270 C498.829224,345.102753 512.282654,311.787689 528.548218,295.440735 z"/>
    <path d="M627.180786,334.941315 C618.853943,333.440460 618.957336,333.440582 618.967651,325.463226 C618.989685,308.494110 618.886902,291.524811 618.848572,274.555603 C618.835571,268.806610 619.716431,268.037811 625.258728,269.238525 C643.614075,273.215179 658.819092,282.436798 671.065857,296.672333 C673.732483,299.771912 674.003357,301.755615 670.442383,304.695953 C660.370789,313.012299 655.150024,324.168915 653.311096,336.971527 C652.435242,343.069092 652.024658,343.353271 646.585510,340.962372 C640.477112,338.277283 634.187866,336.164337 627.180786,334.941315 z"/>
  </g>
</svg>`

/** A same-origin path to a woff2 file, safe to place inside url(''). */
const FONT_PATH = /^\/[\w\-./]*\.woff2$/

const styles = `
:root {
  color-scheme: dark;
  --bg: hsl(0 0% 4%); --surface: hsl(0 0% 4%); --hover: hsl(0 0% 10%);
  --border: hsl(0 0% 18%); --border-strong: hsl(0 0% 53%);
  --text: hsl(0 0% 93%); --secondary: hsl(0 0% 63%);
  --accent-hover: hsl(0 0% 80%); --focus: hsl(210 100% 66%);
  --negative: hsl(358 100% 69%);
  --caution: hsl(39 90% 50%); --caution-surface: hsl(35 100% 8%); --caution-border: hsl(35 100% 17%);
  font-family: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-synthesis: none; -webkit-font-smoothing: antialiased;
  background: var(--bg); color: var(--text);
}
* { box-sizing: border-box; }
body { margin: 0; font-size: 14px; line-height: 20px; }
main { min-height: 100vh; min-height: 100svh; display: flex; align-items: center; justify-content: center; padding: 48px 24px; }
.gate { width: 100%; max-width: 448px; min-width: 0; }
.brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 24px; font-size: 18px; line-height: 24px; font-weight: 600; }
.brand-icon, .brand-icon svg { display: block; width: 28px; height: 28px; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 32px; }
h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -.96px; }
p { margin: 0; overflow-wrap: anywhere; }
.intro { color: var(--secondary); margin-top: 8px; }
strong { color: var(--text); font-weight: 550; }
a { color: var(--text); text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--text); }
.err { margin-top: 16px; color: var(--negative); }
.warn { margin-top: 16px; padding: 12px; border: 1px solid var(--caution-border); border-radius: 6px; background: var(--caution-surface); color: var(--caution); font-size: 13px; line-height: 20px; }
.grant { margin: 24px 0 0; padding: 16px 0 20px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); font-size: 13px; line-height: 20px; }
dt { color: var(--secondary); }
dd { margin: 4px 0 0; overflow-wrap: anywhere; }
dd + dt { margin-top: 12px; }
form { margin-top: 28px; }
.grant + form, .warn + form { margin-top: 0; }
label { display: block; margin-bottom: 8px; font-weight: 500; }
.field + .field { margin-top: 16px; }
input, button { font: inherit; }
input:is([type="text"], [type="password"]) { display: block; width: 100%; min-width: 0; height: 40px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
input:is([type="text"], [type="password"]):hover { border-color: var(--border-strong); }
.actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin-top: 24px; }
.actions.single { grid-template-columns: minmax(0, 1fr); }
button { min-height: 36px; border: 1px solid transparent; border-radius: 6px; padding: 7px 14px; font-size: 14px; line-height: 20px; font-weight: 500; cursor: pointer; transition: background-color 150ms ease-out, border-color 150ms ease-out; }
.primary { background: var(--text); color: var(--bg); }
.primary:hover { background: var(--accent-hover); }
.primary:active { background: var(--secondary); }
.secondary { border-color: var(--border); background: var(--surface); color: var(--text); }
.secondary:hover { background: var(--hover); border-color: var(--border-strong); }
.secondary:active { background: var(--border); }
:where(input, button, a):focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
@media (max-width: 480px) {
  main { padding: 32px 16px; align-items: flex-start; }
  .panel { padding: 24px; }
  .actions { grid-template-columns: minmax(0, 1fr); }
  input:is([type="text"], [type="password"]) { height: 48px; font-size: 16px; }
  button { min-height: 44px; padding: 11px 14px; }
}
@media (pointer: coarse) { input:is([type="text"], [type="password"]), button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
@media (forced-colors: active) { .primary, .secondary, input:is([type="text"], [type="password"]) { border: 1px solid ButtonText; } }
`

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ))
}

/** An escaped address that wraps after a path slash rather than mid-word on a phone. */
function breakableUrl(value: string): string {
  return escapeHtml(value).replace(/(?<!\/)\/(?!\/)/g, '/<wbr>')
}

function fontFace(fontUrl: string | undefined): string {
  if (!fontUrl || !FONT_PATH.test(fontUrl)) return ''
  return `@font-face {
  font-family: 'Geist'; font-style: normal; font-weight: 100 900; font-display: swap;
  src: url('${fontUrl}') format('woff2');
}`
}

function gatePage(title: string, body: string, fontUrl: string | undefined, head = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#0a0a0a">${head}
<title>${title} · Canonry</title>
<style>${fontFace(fontUrl)}${styles}</style>
</head><body><main><div class="gate">
<div class="brand"><span class="brand-icon" aria-hidden="true">${CANONRY_MARK}</span><span>Canonry</span></div>
<section class="panel" aria-labelledby="gate-title">
${body}
</section>
</div></main></body></html>`
}

/** Minimal self-contained sign-in. No SPA route, no bundle, no base-path trap. */
export function renderSignInPage(o: { action: string; error: string | null; fontUrl?: string }): string {
  return gatePage('Sign in', `<h1 id="gate-title">Sign in to continue</h1>
${o.error ? `<p class="err" role="alert">${escapeHtml(o.error)}</p>` : ''}
<form method="post" action="${escapeHtml(o.action)}">
<div class="field"><label for="name">Name</label><input id="name" type="text" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus></div>
<div class="field"><label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password"></div>
<div class="actions single"><button class="primary" type="submit">Sign in</button></div>
</form>`, o.fontUrl)
}

/**
 * The approval step. Names the client, where it will send the code, and exactly
 * what is being granted, so the person approving can see what they are agreeing
 * to rather than inferring it from a redirect flash.
 */
export function renderConsentPage(o: {
  action: string
  clientName: string
  selfRegistered: boolean
  redirectUri: string
  scope: string
  userName: string
  csrf: string
  fontUrl?: string
}): string {
  // indexOf, not split: a literal '?' inside any value (a state parameter, say)
  // would otherwise truncate the query, dropping scope or state — failing
  // closed, but leaving the user stuck on an unrecoverable "could not be
  // verified" with no way to tell why.
  const cut = o.action.indexOf('?')
  const consentAction = cut === -1
    ? `${o.action}/consent`
    : `${o.action.slice(0, cut)}/consent${o.action.slice(cut)}`
  return gatePage('Allow access', `<h1 id="gate-title">Allow access?</h1>
<p class="intro"><strong>${escapeHtml(o.clientName)}</strong> wants to access Canonry as <strong>${escapeHtml(o.userName)}</strong>.</p>
${o.selfRegistered
  ? '<p class="warn">This application chose its own name and has not been verified by anyone. Check the address below before allowing it.</p>'
  : ''}
<dl class="grant">
<dt>Permissions</dt><dd>${escapeHtml(o.scope)}</dd>
<dt>Redirects to</dt><dd>${breakableUrl(o.redirectUri)}</dd>
</dl>
${o.scope.split(/\s+/).includes(RESEARCH_RUN_SCOPE)
  ? '<p class="warn">Run research queries using the operator\'s provider quota, subject to the shared daily research limit. This does not grant permission to change tracking or settings.</p>'
  : ''}
<form method="post" action="${escapeHtml(consentAction)}">
<input type="hidden" name="csrf" value="${escapeHtml(o.csrf)}">
<div class="actions"><button class="primary" type="submit" name="approve" value="yes">Allow</button><button class="secondary" type="submit" name="approve" value="no">Deny</button></div>
</form>`, o.fontUrl)
}

/**
 * The page after Allow or Deny. It sends the browser on to the client's
 * callback with a meta refresh from this new document, never a redirect from
 * the consent form (sendHandoffPage in oauth.ts says why). The link covers a
 * browser that ignores the refresh.
 */
export function renderAuthorizationHandoff(o: {
  target: string
  approved: boolean
  clientName: string
  fontUrl?: string
}): string {
  const target = escapeHtml(o.target)
  const title = o.approved ? 'Access allowed' : 'Access denied'
  return gatePage(title, `<h1 id="gate-title">${title}</h1>
<p class="intro">Returning you to <strong>${escapeHtml(o.clientName)}</strong>. If nothing happens, <a href="${target}" rel="noreferrer">continue</a>.</p>`,
  o.fontUrl, `\n<meta http-equiv="refresh" content="0;url=${target}">`)
}

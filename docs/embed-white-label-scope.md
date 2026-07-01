# Canonry Embed white-label: scope

Status: scoping (not started). Owner: TBD. Last updated: 2026-07-01.

## What this is

Let a client's embedded Canonry dashboard (the chromeless `serve --embed` render
consumed by the Canonry Embed v2 `/e` proxy) be re-skinned to the client's brand:
their colors, their logo, their product name, their fonts. This is what "Canonry
Embed" advertises (a white-label client portal surface), and today it is not
buildable through config.

## The honest headline

**Full white-label is a design-system migration, not a config toggle.** The
dashboard sets color with roughly 2,600 literal Tailwind sites (`bg-zinc-950`,
`text-zinc-400`, `emerald/amber/rose`) plus hardcoded chart hex, and there is
**no semantic color-token layer** today (the `@theme` block in `styles.css`
defines only fonts). Re-theming per client means tokenizing that surface first.

One thing that is already good: the chromeless embed shell renders **zero Canonry
branding** of its own (no logo, no "Powered by Canonry" badge anywhere in the
repo). So *removing* Canonry is mostly done; the work is *tokenizing colors* and
*adding the client's brand*.

The theming mechanism must stay presentational only. It is NOT a security
boundary; the project-scoped API key is what isolates a client's data.

## Current state (measured)

Color is applied through literal Tailwind v4 palette utilities, in two layers:

- `apps/web/src/styles.css` (~2,206 lines, ~1,500 semantic classes): ~399 `@apply`
  color utilities + ~13 raw hex/rgba literals (`#09090b` shell bg, gauge/sparkline
  strokes `#34d399/#fbbf24/#fb7185`, highlight rgba, scrollbar rgba).
- `.tsx` components: ~2,215 inline color-utility sites. Heaviest:
  `pages/ProjectPage.tsx` (156), `components/project/GscSection.tsx` (147),
  `ActivitySection.tsx` (117), `pages/ReportPage.tsx` (104),
  `components/shared/AeroBar.tsx` (95), `BacklinksSection.tsx` (94).

Other color axes:
- Charts: hardcoded hex constants in `components/shared/ChartPrimitives.tsx`
  (`CHART_SERIES_COLORS` 8 hex, `PROVIDER_SERIES_COLORS` per-engine, `CHART_TONE`,
  `CHART_NEUTRAL`, `CHART_TOOLTIP_STYLE`, `CHART_GRID_STROKE`, `CHART_AXIS_*`).
  Recharts reads these as JS props, so CSS vars alone do not reach them.
- Tone source of truth: `components/ui/badge.tsx` cva variants
  (neutral/success/warning/destructive) behind `ToneBadge`; `ProviderBadge.tsx`
  hardcodes a per-engine palette (a second, data-encoding color axis).
- The only runtime theme hook: `apps/web/src/embed.ts` `THEME_VARS` maps a host
  theme to exactly two vars, `--canonry-embed-bg` / `--canonry-embed-fg`, guarded
  by a strict `COLOR_VALUE` regex, applied on `.app-shell-embed`. Its own code
  comment says a broader palette "would need component-level wiring and is out of
  scope for the read-only embed." That comment is precisely this work.

Typography: Geist Sans/Mono, loaded via a **cross-origin `@import`** to
`fonts.googleapis.com` (`styles.css:1`) with pinned OpenType features
(`cv11/ss01/ss03`). The cross-origin import leaks the embed to Google and breaks
under strict-CSP / privacy hosts, worth self-hosting regardless of white-label.

Branding touchpoints: `BrandLockup.tsx` wordmark + `favicon.svg` (the "canary")
are only in the NON-embed sidebar/topbar (not in the embed shell). Residual
in-body "Canonry" copy in ~5 spots (`ProjectPage.tsx:1198`,
`DiscoverySection.tsx:160`, `EvidenceDetailModal.tsx:574/594/633`,
`GscSection.tsx:755`). Static `index.html` meta still says Canonry/AINYC.

## Token taxonomy (the target)

Semantic CSS custom properties registered in the Tailwind v4 `@theme` layer, with
today's zinc/emerald/amber/rose values as the default (dark) theme:

- Background: `--color-bg`, `--color-bg-elevated`
- Surface: `--color-surface`, `-subtle`, `-hover`, `-inset`
- Border: `--color-border`, `-subtle`, `-strong`
- Text: `--color-text-primary`, `-secondary`, `-muted`, `-faint/eyebrow`, `-on-accent`
- Accent / brand: `--color-accent`, `--color-accent-fg` (the primary client-swap hue)
- Tone quartets (text / border / bg-soft / solid-fill) for positive (emerald),
  caution (amber), negative (rose), neutral (zinc)
- Focus ring: `--color-ring`, `--color-ring-accent`
- Chart tokens (JS-consumed): `--canonry-chart-series-1..8`, `-tone-*`, `-neutral`,
  `-tooltip-*`, `-grid`, `-axis`
- Typography: `--canonry-font-sans`, `--canonry-font-mono`
- Brand (non-color): product name, logo URL, favicon URL

Granularity decision: one base token per role with runtime alpha (`color-mix`) vs
an explicit token per opacity step. Today's palette leans hard on `/NN` alpha
modifiers (`zinc-800/60` vs `/40` vs `/30`), which do not collapse to one token
cleanly; this is the single biggest fidelity-vs-taxonomy-size tradeoff.

## Workstreams

| # | Workstream | Effort |
|---|---|---|
| 1 | Token foundation: define the semantic `@theme` layer; defaults byte-identical to today's dark look | L |
| 2 | Migrate ~399 CSS `@apply` sites + ~2,215 inline `.tsx` sites + ~13 raw literals to tokens (codemod + heavy review) | XL |
| 3 | Charts (ChartPrimitives hex -> CSS-var bridge for Recharts; gauges/sparklines) + typography (self-host Geist + client-font path) | L |
| 4 | Brand + de-brand: client logo + product-name slot in the chromeless shell; tab-title/favicon override; neutralize ~5 in-body "Canonry" strings; default favicon | M |
| 5 | Transport + platform wiring: full `embed.theme` object; per-dashboard delivery via an `X-Canonry-Embed-Theme` header (reuses the `X-Canonry-Embed-Tabs` mechanism); the `embed_dashboards.theme` column already exists | M |
| 6 | Report-renderer parity: `packages/api-routes/src/report-renderer.ts` is a separate (non-Tailwind) renderer that must stay visually aligned (CI-enforced); tokenize it in the same pass | L |

## Transport design

A full theme is a large object (a dozen-plus colors + logo/font URLs + product
name), so it does not fit the per-value header shape used for tabs. Recommended:
carry it per dashboard as a single `X-Canonry-Embed-Theme` request header holding
base64url(JSON), set by the `/e` proxy from `embed_dashboards.theme` (server-side,
never from client input, exactly like the tabs header). The engine's
`injectConfig` decodes + validates it and merges it into
`window.__CANONRY_CONFIG__.embed.theme`. `serializeForInlineScript` already
guards the inline-script injection. Header size is well within the ~8KB limit.
Per-dashboard is the right grain (one agency instance, different clients), and it
reuses the mechanism already built for `X-Canonry-Embed-Tabs`.

## Report parity

`ReportPage.tsx` (SPA) and `report-renderer.ts` (downloadable HTML, no Tailwind,
inlines its own SVG/CSS) are two renderers of one DTO and MUST stay visually
aligned (root `CLAUDE.md` "Report parity", enforced by `report-renderer.test.ts`).
Tokenizing the SPA report without the HTML renderer breaks CI, so the report is
either in-scope for the same pass or explicitly deferred for BOTH surfaces.

## Security checklist

- Colors: reuse the existing `COLOR_VALUE` regex sanitizer (hex/rgb/hsl only).
- Logo / font / favicon URLs: validate `https:` (or `data:`) only; reject `http`
  (mixed content) and non-URL values at config-resolve time.
- Logo: render via `<img src>`, NEVER inline arbitrary client SVG (SVG-in-DOM XSS).
- Fonts: a font-family validator (allowlist quoted names + safe generics; strip
  `; { } : <`). `COLOR_VALUE` rejects font names, so this is a separate validator.
- CSP: the embed doc emits only `frame-ancestors` today. A self-hosted logo/font
  path needs NO CSP change. A client-URL path requires deliberately widening
  `img-src` / `font-src` with the client origin, without weakening the injection
  posture.
- Inline script: already handled by `serializeForInlineScript` (escapes `< > &` +
  U+2028/U+2029). The theme header is server-set; the client cannot reach the
  loopback engine to inject it.

## Open decisions (scope levers)

1. **Arbitrary palette (incl. a light theme) or client-brand-on-dark?** The
   biggest lever (roughly XL vs L). "Full white-label" implies a light-branded
   client gets a light dashboard, the XL path, where the opacity-modifier problem
   bites hardest.
2. **Are per-engine / chart-series colors brandable or fixed?** They encode WHICH
   engine (data meaning), not tone. Recommend keeping them fixed.
3. **Font delivery:** self-host client woff2 (no CSP change, onboarding cost) vs
   accept a client font URL (needs `font-src` CSP + allowlist). Also self-host
   Geist as the default regardless (drop the cross-origin Google Fonts import).
4. **Logo delivery:** hosted `https` URL first (simplest) vs an upload endpoint +
   storage later.
5. **Is the downloadable report in v1?** Parity is CI-enforced; both report
   surfaces move together or neither does.
6. **Per-dashboard vs per-instance theme.** Per-dashboard (proxy header) is the
   right grain and reuses existing plumbing.
7. **How far to de-brand static `index.html` meta** (description/theme-color/OG
   still say Canonry): accept residual vendor name in page source for v1, or
   invest in server-side HTML rewrite.

## Recommended phasing

```
Phase 0  Token foundation (WS1): define the semantic layer; prove default dark is byte-identical
Phase 1  MVP white-label: colors->tokens on the dark base + accent + client logo + product name + de-brand
         (WS2 partial, WS4, WS5)  ~1.5-2 wks  -> "it's the client's brand"
Phase 2  Full fidelity: charts + typography + report-renderer parity  (WS3, WS6, rest of WS2)
Phase 3  Arbitrary palette / light theme (the XL tail)  -- only if clients need non-dark
```

Rough total for a full, tested white-label with report parity: ~4-6 weeks.

## Top risks

- **Report-parity trap:** SPA + HTML report must move together (CI-enforced).
- **Charts bypass CSS:** Recharts consumes hex as JS props; a CSS-var-only theme
  leaves every chart, gridline, and tooltip un-themed (a visible miss).
- **Regression scale:** ~2,600 sites; a codemod that misses opacity/conditional
  cases silently breaks tone colors. Needs visual-regression snapshots + a real
  second theme to prove the abstraction actually decouples.
- **Provider-axis conflict:** recoloring `PROVIDER_SERIES_COLORS` to a client
  accent destroys the per-engine data encoding.
- **Font / CSP:** the client-font path is the sharp edge (cross-origin, CSP).
- **Tailwind v4 `@theme` runtime override** must be validated: overriding
  `--color-*` on `:root` at runtime must recolor already-generated utilities
  without a rebuild.

## Cross-repo note

Roughly 90% of this is the ENGINE (`apps/web` token migration + charts + branding
+ report-renderer). The PLATFORM (`canonry-platform`) owns WS5: accepting `theme`
on the dashboard (`embed_dashboards.theme` column + create/PATCH route) and the
`/e` proxy forwarding the `X-Canonry-Embed-Theme` header, mirroring the
`X-Canonry-Embed-Tabs` work already in flight.

---
name: Canonry
description: Operator-grade dashboard for the agent-first AEO operating platform.
colors:
  zinc-night: "#09090b"
  surface-ash: "#18181b"
  surface-ash-faint: "#27272a"
  hairline: "#3f3f46"
  hairline-soft: "#52525b"
  snow: "#fafafa"
  silver: "#e4e4e7"
  smoke: "#a1a1aa"
  fog: "#71717a"
  shadow-text: "#52525b"
  whisper: "#3f3f46"
  signal-green: "#34d399"
  signal-green-deep: "#10b981"
  caution-amber: "#fbbf24"
  caution-amber-deep: "#f59e0b"
  alert-rose: "#fb7185"
  alert-rose-deep: "#f43f5e"
  destructive-rose: "#e11d48"
  series-blue: "#60a5fa"
  series-pink: "#f472b6"
  series-yellow: "#facc15"
  series-violet: "#a78bfa"
  series-orange: "#fb923c"
  series-cyan: "#22d3ee"
  series-red: "#f87171"
  track-sky: "#38bdf8"
  provider-gemini: "#93c5fd"
  provider-openai: "#86efac"
  provider-claude: "#fcd34d"
  provider-perplexity: "#5eead4"
  provider-local: "#d8b4fe"
  meta-theme: "#10141c"
typography:
  page-title:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: "1.25"
    letterSpacing: "-0.02em"
    fontFeature: "cv11, ss01, ss03"
  hero:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "1.15"
    letterSpacing: "-0.02em"
    fontFeature: "cv11, ss01, ss03"
  stat:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: "1.1"
    letterSpacing: "-0.02em"
    fontFeature: "cv11, ss01, ss03, tnum"
  gauge:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: "1"
    letterSpacing: "-0.01em"
    fontFeature: "cv11, ss01, ss03, tnum"
  section-title:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "1.35"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.55"
    letterSpacing: "normal"
    fontFeature: "cv11, ss01, ss03"
  body-compact:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.45"
  caption:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "1.4"
  eyebrow:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "1"
    letterSpacing: "0.18em"
    textTransform: "uppercase"
  eyebrow-soft:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: "1"
    letterSpacing: "0.16em"
    textTransform: "uppercase"
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    fontFeature: "ss02, cv11, tnum"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  "2xl": "16px"
  full: "9999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  base: "16px"
  lg: "20px"
  xl: "24px"
  "2xl": "32px"
  sidebar-width: "224px"
  page-max: "1152px"
components:
  button-default:
    backgroundColor: "{colors.snow}"
    textColor: "{colors.zinc-night}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
    typography: "{typography.body-compact}"
  button-default-hover:
    backgroundColor: "{colors.silver}"
  button-secondary:
    backgroundColor: "{colors.zinc-night}"
    textColor: "{colors.silver}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-ash}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.smoke}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-ash}"
    textColor: "{colors.snow}"
  button-destructive:
    backgroundColor: "{colors.destructive-rose}"
    textColor: "{colors.snow}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 16px"
  badge-neutral:
    backgroundColor: "{colors.zinc-night}"
    textColor: "{colors.silver}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-success:
    backgroundColor: "{colors.signal-green}"
    textColor: "{colors.signal-green}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-warning:
    backgroundColor: "{colors.caution-amber}"
    textColor: "{colors.caution-amber}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-destructive:
    backgroundColor: "{colors.alert-rose}"
    textColor: "{colors.alert-rose}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  surface-card:
    backgroundColor: "{colors.surface-ash}"
    rounded: "{rounded.xl}"
    padding: "16px"
  health-pill-ok:
    backgroundColor: "{colors.signal-green}"
    textColor: "{colors.signal-green}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  filter-chip:
    backgroundColor: "{colors.zinc-night}"
    textColor: "{colors.fog}"
    rounded: "{rounded.full}"
    padding: "6px 12px"
  filter-chip-active:
    backgroundColor: "{colors.surface-ash}"
    textColor: "{colors.silver}"
    rounded: "{rounded.full}"
    padding: "6px 12px"
  input:
    backgroundColor: "{colors.surface-ash}"
    textColor: "{colors.silver}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "36px"
---

# Design System: Canonry

## 1. Overview

**Creative North Star: "The Listening Post"**

Canonry is an instrument, not a marketing surface. It sits on an analyst's desk while they (or their agent) scan what AI answer engines are saying about a domain, drill into the regression that just appeared, and decide whether to act. The visual system serves that posture: the room is dim, the chrome is quiet, the data is loud, the rhythm is fast. Whitespace exists to create hierarchy, not atmosphere. Tone color (emerald, amber, rose) is rationed; it appears only when it carries meaning, never as decoration.

The aesthetic family is **operator-grade dark mode in the Vercel lineage**: cool zinc neutrals, tinted toward black with no synthetic blue cast, Geist Sans as a single sans-serif workhorse (no display pairing), tabular numerics everywhere a number lives, eyebrow labels in tight letter-spacing to mark sections, hairline borders instead of cards-within-cards. It explicitly rejects the Semrush / Ahrefs reflex (every-pixel-occupied SEO dashboard, panels competing for attention) and the "AI startup" reflex (purple-to-pink gradients, sparkle icons, glass blurs, "✨ AI-powered" stickers). Canonry is itself an AI product, which is exactly why none of those tropes appear.

The system carries one deliberate moment of warmth: the mascot bird in the sidebar chirps and tilts when a new canonry version is available, with a small amber bubble announcing the upgrade. That is the entire personality budget for the surface. Everywhere else, the data does the talking.

**Key Characteristics:**
- Dark zinc base (`#09090b`) with sub-step surface tinting at low opacities, no `#000` and no `#fff`.
- Geist Sans + Geist Mono pairing, OpenType stylistic sets `cv11`, `ss01`, `ss03` enabled globally for sharper `i / l / I / 0` disambiguation.
- Tabular numerics on every metric, gauge value, and stat strip.
- Tables, not card grids, for any list of three or more structured items.
- Tone color is semantic only: emerald = positive, amber = caution, rose = negative, zinc = neutral.
- Hairline borders (`#27272a / #3f3f46`) carry shape; shadows are reserved for floating UI (toasts, evidence modal).
- Page width capped at 1152px (`max-w-6xl`); fixed 224px sidebar; no fluid headings.

## 2. Colors: The Listening Post Palette

A near-monochromatic zinc field with three rationed tone colors and a multi-series chart palette held back for data viz.

### Primary

- **Snow** (`#fafafa`): The interface's accent. Used as the primary button fill (white-on-dark inverted), active subnav background, and the brightest body text. This is a chroma-free accent: maximum lightness carries weight where a saturated brand color would in a marketing surface.
- **Zinc Night** (`#09090b`): The base canvas. Slightly tinted toward neutral-cool, never pure black. Applied to `<body>`, the sidebar, the topbar (at 95% opacity for a faint frosted-glass effect under content scroll).

### Tone (semantic, never decorative)

- **Signal Green** (`#34d399`, emerald-400): Cited, positive, success, gain, OK-state health pill, score-gauge fill when reading positive. Paired with `bg-emerald-500/10` and `border-emerald-500/25` for badges; with `bg-emerald-950/25` for sustained-state surfaces like the citation leaderboard "you" row.
- **Caution Amber** (`#fbbf24`, amber-400): Partial state, warning, drift, "checking" health, the brand update bubble. The only tone allowed to appear as a sustained sidebar accent (the mascot's chirp bubble).
- **Alert Rose** (`#fb7185`, rose-400): Lost, failed, regression, negative-delta, destructive-action error state. Sustained-state surfaces use `bg-rose-950/20` to keep the dark room from feeling alarmed.
- **Destructive Rose** (`#e11d48`, rose-600): Solid fill for destructive primary buttons only. Distinct from Alert Rose, which is for state indication.

### Neutral (the ash scale)

- **Surface Ash** (`#18181b`, zinc-900): Card and table-header surface at 30–50% opacity. Lifts cards just enough off Zinc Night to read as containers without becoming objects.
- **Surface Ash Faint** (`#27272a`, zinc-800): Track color for progress bars, chart grid lines, divider lines between table rows.
- **Hairline** (`#3f3f46`, zinc-700): Default border between surface and canvas. Almost always rendered at 60% opacity (`border-zinc-800/60`) so it sits as a hint, not a frame.
- **Silver** (`#e4e4e7`, zinc-200) → **Smoke** (`#a1a1aa`, zinc-400) → **Fog** (`#71717a`, zinc-500) → **Whisper** (`#3f3f46`, zinc-700): the text ramp. Snow is the headline; Smoke is the body; Fog is the caption; Whisper is the eyebrow that almost dissolves.

### Series (chart-only)

`Series Blue` `#60a5fa`, `Series Pink` `#f472b6`, `Series Yellow` `#facc15`, `Series Violet` `#a78bfa`, `Series Orange` `#fb923c`, `Series Cyan` `#22d3ee`, `Series Red` `#f87171`. Saturated 400-step hues used only when a chart genuinely needs three or more series. Never appear in surface chrome, buttons, badges, or non-chart UI.

### Provider Identity (closed set, chrome-only)

Each LLM answer engine canonry tracks has a fixed identity color, applied only in `ProviderBadge` and provider-related chrome (model picker, provider-scoped headings). This is the one place the dashboard reaches outside the Listening Post zinc palette into provider-brand territory, because the user needs to recognize "Gemini" vs "Claude" vs "OpenAI" at a glance across long evidence tables. The colors are deliberately the lighter `-300` Tailwind step so they sit quietly inside the badge tint pattern (`border-{hue}-800/50 bg-{hue}-950/40 text-{hue}-300`), never as a saturated fill.

- **Provider Gemini** (`#93c5fd`, blue-300): Google's Gemini family.
- **Provider OpenAI** (`#86efac`, green-300): OpenAI / ChatGPT.
- **Provider Claude** (`#fcd34d`, amber-300): Anthropic's Claude.
- **Provider Perplexity** (`#5eead4`, teal-300): Perplexity.
- **Provider Local** (`#d8b4fe`, purple-300): Local / self-hosted LLM (e.g., Ollama, vLLM).

The set is closed: adding a sixth color requires adding a sixth provider, not borrowing one of these for a different purpose.

### Named Rules

**The Semantic-Only Rule.** Tone color (Signal Green, Caution Amber, Alert Rose) is reserved for indicating state. It is forbidden as a decorative accent. A card is never green because green looks nice; it is green because it is reporting a positive signal.

**The White-As-Accent Rule.** The brand "accent" is Snow (`#fafafa`). It carries primary actions, active states, and the brightest text. There is no chromatic brand color. Adding one (a "canonry purple", a "canonry blue") would betray the operator-instrument identity and pull the surface toward SaaS.

**The Rationed Rose Rule.** Alert Rose is the loudest color in the system. A page with three Alert Rose elements is almost certainly wrong: the analyst stops being able to triage. Pull rose back to the genuinely-negative signal; let other rows render in Smoke even when their value is below target.

**The Provider-Identity Rule.** The five Provider Identity colors (Gemini blue, OpenAI green, Claude amber, Perplexity teal, Local purple) are a closed set used only in provider chrome (`ProviderBadge`, the AeroBar model picker, provider-scoped section headings). They are never used decoratively, never reappear in non-provider UI, and never trade places (Claude is never green even if the visual rhythm would benefit). Adding a sixth color requires adding a sixth provider.

## 3. Typography

**Display + Body Font:** Geist (Google Fonts), with fallback `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. Weights loaded: 400, 500, 600, 700, 800.
**Mono Font:** Geist Mono, with fallback `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`. Weights loaded: 400, 500, 600.

**Character:** Geist is the typographic floor of the Vercel design language: a geometric humanist sans engineered for product UI density. Canonry runs it as a single workhorse (no serif display, no decorative pairing) and turns on its OpenType alternates (`cv11`, `ss01`, `ss03`) so the `1 / I / l`, `0 / O`, and `i / l` distinctions hold at 11–13px. Geist Mono carries every number that lives inside a column, a gauge, or a stat strip; `ss02` and `cv11` are enabled in mono so `0` and `1` stay unambiguous in dense tabular data. Hierarchy is built through scale and weight, not through font swap.

### Hierarchy

- **Hero** (`28px / 600 / -0.02em / 1.15`): The single `<h1>` on the project landing card. Snow color. One per page maximum.
- **Page Title** (`18px / 600 / -0.02em`): The page header title at the top of every route. Tightened tracking; Snow color.
- **Section Title** (`14px / 600 / -0.01em`): The `<h2>` / `<h3>` that opens a card or a panel. Silver color, never Snow (Snow is reserved for the page title).
- **Stat** (`24px / 700 / -0.02em`, tabular): Big numbers in the AEO hero rows, metric cards, and stat strips. Tabular numerics non-negotiable.
- **Gauge** (`20px / 700 / -0.01em`, tabular): Center value of the radial score gauges.
- **Body** (`14px / 400 / 1.55`): Paragraph copy, lede, descriptions. Cap line length at 65–75ch in prose surfaces; tables can run longer.
- **Body Compact** (`13px / 400 / 1.45`): Row titles in attention items, run rows, project lists, evidence cells. The dominant text size in the dashboard.
- **Caption** (`12px / 400 / 1.4`): Secondary detail copy in tables and metric subtitles. Fog color.
- **Eyebrow** (`11px / 500 / uppercase / 0.18em`): Section labels above a card, table headers (`0.14em`). Fog color.
- **Eyebrow Soft** (`10px / 500 / uppercase / 0.16em`): The faintest label tier; eyebrows on score gauges and metric cards. Whisper / Fog color.
- **Mono** (`13px / 400`, tabular): Version strings, code spans, command examples, debug payloads. Geist Mono with `tnum`.

### Named Rules

**The Single-Sans Rule.** Geist carries everything. No serif headlines, no display-only weight, no editorial pairing. The interface earns its hierarchy from scale and weight contrast (the Body → Section Title → Page Title → Hero ladder), not from a font swap.

**The Tabular-Numerics Rule.** Every number that lives inside a column, a gauge, a stat strip, or a delta carries `font-variant-numeric: tabular-nums`. Two `42.0%` values stacked vertically must align at the decimal. This is non-negotiable for an analyst surface.

**The Eyebrow-Over-Headline Rule.** Section context is carried by the 10–11px uppercase eyebrow above a card or stat, not by an oversized headline inside it. The eyebrow is the section's signage; the value inside is the content. Inverting this proportion (big headline, small label) reads as marketing.

## 4. Elevation

Canonry is flat. Surfaces are differentiated by hairline borders and ~25–50% opacity tints over the Zinc Night canvas, not by drop shadows. The one-step lift from `Zinc Night → Surface Ash` is the only "elevation" the resting interface needs. Cards do not sit *on* the canvas, they sit *in* it.

Real shadows appear only on floating, state-carrying UI: the toast viewport, the evidence modal, the brand mascot's drop-shadow at the sidebar top. Decorative shadows under cards, buttons, or chips are forbidden.

### Shadow Vocabulary

- **Mascot Atmosphere** (`drop-shadow: 0 10px 18px rgba(8, 11, 15, 0.34)`): On the brand icon (the canonry bird) at the sidebar top. The only ambient shadow in the resting interface; gives the mascot a sense of place above the deep canvas.
- **Bubble Glow** (`box-shadow: 0 8px 20px -10px rgba(245, 158, 11, 0.4), inset 0 0 0 1px rgba(245, 158, 11, 0.06)`): The colored ambient glow under the brand update bubble. Tints the room amber for the one moment that bubble exists.
- **Toast Lift** (`box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32)`): On the toast cards. The toast viewport floats above content, so this is the only fully-rendered drop shadow in the system.
- **Hairline Card** (`box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.01)`): Sub-pixel inset highlight on the Radix Card primitive. Not a shadow in the depth sense; a one-pixel sheen that keeps the card edge from disappearing on low-contrast displays.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadows appear only when an element actually floats (toast, modal, mascot drop-shadow) or as a one-moment state response (the amber bubble glow). A card with a drop shadow at rest is wrong.

**The Tint-Then-Border Rule.** When a surface needs to lift off the canvas, it earns it through a low-opacity background tint (`bg-zinc-900/30`) plus a hairline border (`border-zinc-800/60`). Never through `box-shadow`. This keeps the room dim and the rhythm scanable.

## 5. Components

### Buttons

- **Shape:** medium-radius (`rounded-md`, 6px). Heights of 36px (default) and 32px (`sm`). No pill-shaped CTAs in the action surface.
- **Default (Primary):** Snow background, Zinc Night text. The inverted-white "Run sweep" CTA. Hover steps down to Silver (`#e4e4e7`).
- **Secondary:** Zinc Night background, Silver text, hairline border. Hover lifts the background one step to Surface Ash.
- **Ghost:** Transparent background, Smoke text. Hover gives a Surface Ash background and lifts the text to Snow. Used in sidebars, footers, and dense control rows.
- **Outline:** Transparent background, hairline border, Silver text. Hover background = Surface Ash. Used when a button must read as a non-primary action but the row lacks a colored background to ground a ghost.
- **Destructive:** Destructive Rose (`#e11d48`) background, Snow text. Hover deepens to rose-700 (`#be123c`). For irreversible actions only; flagged inline before invocation, never as the lone primary on a screen.
- **Focus:** 2px Smoke focus ring with a 2px Zinc Night offset (visible on dark backgrounds without halation).

### Badges & Pills

- **Neutral / Success / Warning / Destructive (`Badge` primitive):** Pill-radius `rounded-md`, 11px font, `tracking-wide`. Tone variants render as `border-{tone}-500/25 bg-{tone}-500/10 text-{tone}-300` — a triple-low-opacity treatment that keeps the badge readable without painting the row.
- **Health Pills (topbar):** `rounded-full`, 10px uppercase with `0.1em` tracking. OK = signal green, Checking = neutral zinc, Error = alert rose. Live, always-visible state for global system health.
- **Filter Chips:** `rounded-full`, 14px text. Default = transparent over Zinc Night with Fog text; active = Surface Ash background with Silver text and a slightly brighter border. No left-stripe accent; the active state is carried by the fill.

### Cards & Surfaces

- **Surface Card (the dominant container):** `rounded-xl` (12px), Surface Ash at 30% opacity over the canvas, 60%-opacity hairline border. Internal padding `p-4`. This is the surface every section sits in.
- **AEO performance hero:** Same surface family, `px-5 py-5`. Holds the three paired Mention / Cited / Mention-share rows plus the mention-share breakdown. The project overview's lead instrument (see "AEO performance hero" below).
- **Score Gauge container:** Same surface family, `px-3 py-5` for tighter vertical rhythm around the radial.
- **Metric Card:** Same surface family, `px-4 py-5`, includes the big-number stat plus a 1.5px progress bar and a 12px caption. Laid out in a `sm:grid-cols-2 lg:grid-cols-3` grid for the overview's secondary metrics.
- **Hero Copy (project landing):** Same surface family, `px-4 py-4`, contains the project title and brief positioning.
- **No nested cards.** A card may contain a table, a sparkline, a list of rows, an action button, or a stat ladder, but never another card. If a child needs visual emphasis, lift its row (background tint + hairline) rather than wrapping it in a card.

### AEO performance hero (project overview's first-glance instrument)

The top of the project overview page is the **AEO performance hero** — a single Surface Card holding three comparable, full-width metric rows, not a cluster of radial gauges:

- **Three paired rows** — `Mentioned`, `Cited`, `Mention share` — each a four-part grid: label + `InfoTooltip`, a `24px` tabular value, a 1.5px linear progress bar tinted by tone, and an `11px` delta/detail line. Below `480px` the row stacks (label → value → bar → detail) so the fixed desktop columns never overflow a phone.
- **Mention-share breakdown** — a small ranked bar list (you vs. each tracked competitor) drops in beneath the rows whenever competitor data exists.
- **Linear bars, not radials, on purpose.** The three numbers are meant to be read against each other top-to-bottom; stacked radials would read as three unrelated dials. Bar fills animate `width` only under `motion-safe` and take their color from `progress-fill-{tone}` (never a hard-coded fill).

Directly below sit the **secondary metric cards** (`Mention Gaps`, `Citation Gaps`, `Index Coverage`) in a `sm:grid-cols-2 lg:grid-cols-3` grid of flat Surface Cards. This hero-plus-cards arrangement is the ratified overview pattern. There must be exactly one `.metric-grid` / `.metric-card` definition — a duplicate once lived in the stylesheet and silently overrode the column count (`lg:grid-cols-3` → `md:grid-cols-2`).

### Score Gauge (radial component)

- 96px (`size-24`) radial SVG ring with a 48px radius and 6px stroke. Background ring renders at 6% white opacity; fill renders in the metric's tone color (Signal Green, Caution Amber, Alert Rose, or neutral Smoke).
- Fill animates from 0 to the value over 600ms with `cubic-bezier(0.4, 0, 0.2, 1)` easing; the transition is dropped entirely under `prefers-reduced-motion`.
- Center value (`20px / 700`, tabular) sits inside the ring; eyebrow label drops below; an optional delta line and description follow.
- Used where a **single** metric reads better as a radial (e.g. the traffic-source detail page), not as the project-overview header cluster. On the overview, reach for the AEO performance hero + metric cards instead.

### Sparkline (signature component)

- 132×42 SVG polyline, 2px stroke with round caps. Stroke color follows the row's tone. A 1px white-at-6% baseline guide sits under the line. Clipped with an 8px-rounded rect so the line's edges feather rather than terminate hard.
- Inline next to a project row's stat strip; never appears as a standalone hero chart.

### Tables (the dominant evidence container)

- Wrap in a `rounded-xl` border-soft container with `overflow-x-auto` so wide tables scroll horizontally on narrow screens rather than reflowing.
- Headers render in Eyebrow style (`11px / 600 / uppercase / 0.14em`, Fog color) over a Surface Ash header band with a hairline bottom border.
- Body cells: `px-4 py-3`, Silver text. Row separators are 30%-opacity hairlines, no zebra striping. Hover tints the row to `bg-zinc-900/30`.
- Tables hold evidence, findings, competitors, traffic events: anything tabular and scannable. They do not hold narrative; that is what insight cards are for.

### Inputs & Form Controls

- **Style:** `rounded-md`, Surface Ash background at 50% opacity, hairline border (Hairline Soft, zinc-700 default), Silver text, Whisper placeholder.
- **Focus:** Border steps up to `border-zinc-500`; a 1px Smoke ring joins it. No glow, no colored ring. The change is decisive but quiet.
- **Disabled:** 50% opacity, `cursor-not-allowed`. State, not invisibility.
- **Setup wizard inputs** carry an Eyebrow Soft label above each field; no inline floating labels.

### Sidebar Navigation

- Fixed 224px wide, hidden below `lg`. Items: 13px font, `rounded-lg`, Fog text at rest, Surface Ash background and Silver text on hover, full Surface Ash background with `font-medium` Silver text when active.
- Section titles render as Eyebrow Soft `0.18em` in Whisper color. Projects in the projects section each carry a 1.5px colored dot (Signal Green / Caution Amber / Alert Rose / neutral Whisper) to indicate visibility health at a glance.
- The mascot bird sits at the top with its drop-shadow. When a new canonry version ships, the bird chirps and an amber bubble appears below it.

### Aero Composer (command bar)

- The bottom command bar on every project-scoped route is the human → Aero interface (the built-in analyst LLM). It collapses to a single input row at rest and expands into a chat transcript on demand.
- Behavior is documented in `apps/web/src/components/shared/AeroBar.tsx`; visually it follows the same surface vocabulary (Surface Ash container, hairline border, Smoke text, monospaced tool-trail blocks) as the rest of the dashboard. It never adopts a chatbot bubble aesthetic; tool calls render as inline collapsed blocks, not as chat heads.

## 6. Do's and Don'ts

### Do:

- **Do** use the Geist + Geist Mono pairing for every typographic decision; turn on `cv11`, `ss01`, `ss03` (and `ss02` for mono) so the 11–13px glyphs hold.
- **Do** apply tabular numerics (`font-variant-numeric: tabular-nums`) to every numeric value that lives in a column, a gauge, a stat strip, or a delta.
- **Do** prefer data tables over card grids for any list of three or more structured items (evidence, findings, competitors, traffic events).
- **Do** use Surface Ash at 30% opacity (`bg-zinc-900/30`) plus a 60%-opacity hairline border (`border-zinc-800/60`) as the default container. Vary padding (`p-4` / `px-4 py-5` / `px-3 py-5`) to fit the contents.
- **Do** ration tone color (Signal Green, Caution Amber, Alert Rose) to semantic state only. A row gets a tone color when it is reporting that state, never because the design needs accent.
- **Do** route every chart through `components/shared/ChartPrimitives.tsx`. Use `CHART_TOOLTIP_STYLE`, `CHART_AXIS_TICK`, `CHART_GRID_STROKE`, `CHART_AXIS_STROKE`, `CHART_SERIES_COLORS` so all charts in the surface share a single vocabulary.
- **Do** use the `ToneBadge` primitive (and its `Badge` underneath) for every status indicator. Map tones through the helpers (`toneFromRunStatus`, `toneFromCitationState`).
- **Do** show two glyphs when rendering snapshot state in a single cell: one for cited (`C / c`), one for mentioned (`M / m`), with `–` for missing. Never collapse the two signals into one label.
- **Do** respect `prefers-reduced-motion`. The toast slide, the aero typing dots, the brand mascot's chirp, and the bubble pop must all disable when the user requests reduced motion. Check the existing `@media (prefers-reduced-motion: reduce)` blocks in `styles.css` for the pattern.
- **Do** keep the page width capped at `max-w-6xl` (1152px). The sidebar is always 224px. Resist the temptation to widen for "more breathing room"; density is the design metric here.
- **Do** move explanatory prose into an `InfoTooltip` on the heading, label, or row title rather than setting it inline. A data surface shows values, one-line captions, and eyebrow labels; the "why" rides one hover (and the trigger's `aria-label`) away. Inline paragraphs are reserved for empty and onboarding states, which must instruct.

### Don't:

- **Don't** use `#000` or `#fff`. The base is Zinc Night (`#09090b`), the brightest body is Snow (`#fafafa`). Anything purer reads as cheap.
- **Don't** introduce a chromatic brand color (no "canonry purple", no "canonry blue"). The accent is Snow. Adding a brand hue pulls the surface toward generic SaaS.
- **Don't** ship gradient hero text, gradient buttons, glassmorphism cards, sparkle icons, mesh-gradient backgrounds, or "✨ AI-powered" stickers. Canonry is an AI product; that is exactly why none of those tropes appear. (Anti-references from PRODUCT.md.)
- **Don't** build dashboards that look like Semrush or Ahrefs (every-pixel occupied, panels competing for attention) or Profound (the AEO-category reflex). Density is good; chaos is not.
- **Don't** import `recharts` directly. Use `ChartPrimitives.tsx`. Don't add Chart.js, Highcharts, D3, Plotly, Nivo, or Victory. ESLint enforces this.
- **Don't** use display fonts for UI labels, buttons, or data. Geist + Geist Mono is the entire type system.
- **Don't** drop a card inside a card. If you find yourself nesting `surface-card`, lift the child row with a background tint and a hairline instead.
- **Don't** apply drop shadows to resting surfaces. The only shadows allowed are the mascot drop-shadow, the toast lift, the bubble glow, and the sub-pixel Card highlight.
- **Don't** reach for a modal as the first thought. Inline the form, slide a drawer, expand a row, anything before a modal. The evidence-detail modal is the existing exception; new modals need to justify themselves.
- **Don't** invent a new color name when an existing zinc / emerald / amber / rose token will do. Saturate carefully: every new hue is one more thing for an analyst's eye to triage.
- **Don't** set multi-sentence explanations, methodology notes, or finding rationale inline in a data view. They push the numbers down and break the scan. Attach them to an `InfoTooltip` instead. (Empty / onboarding states are the documented exception.)

### House exception: side-stripe borders

The current `styles.css` carries `border-l-2 border-l-{tone}-500/60` on `.attention-item-*`, `.insight-row-*`, `.insight-card-*`, `.opportunity-card-*`, and `.opportunity-item-*`. This pattern conflicts with the general design rule that bans side-stripe borders as colored accents on cards or list items. It is preserved here as a **deliberate house exception**: the stripe is the visual cue an analyst uses to scan a long list and triage by severity (rose first, amber next, emerald acknowledged). Removing it would force the eye to read the tone badge or the row title to recover the same information.

If a future revision wants to fold this into the general rule, the alternatives to consider in order: (1) replace the stripe with a leading 12px tone-colored circle (preserves scan but removes the side accent), (2) replace with a full-row background tint at very low opacity (e.g. `bg-rose-950/15`, already in use on citation-leaderboard rows), (3) keep the stripe but graduate to a 1px hairline so it reads as a marker rather than an accent. Until that decision is made, the side-stripe is correct.

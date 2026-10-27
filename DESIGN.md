# Canonry Dashboard Design System

This file is the durable UI contract for humans and coding agents. Read it with
`PRODUCT.md` before changing `apps/web`.

Canonry uses Vercel's [Geist typography](https://vercel.com/geist/typography),
[colors](https://vercel.com/geist/colors),
[materials](https://vercel.com/geist/materials), and
[control guidance](https://vercel.com/geist/button) as its visual foundation.
The foundation lives in `apps/web/src/geist.css`; `apps/web/src/styles.css`
and the shared React components apply it. Fonts are bundled locally; React, Tailwind, Radix, and Lucide remain
our implementation libraries. Geist's visual guidance does not replace the
product hierarchy, measurement semantics, or interaction rules below.

## Scene and register

Canonry is a professional desktop analytics tool used by an operator scanning
dense evidence on a monitor for extended periods. The default dark theme must
remain restrained, high contrast, and quiet. Design serves the task. Prioritize
desktop density and keyboard use; mobile is a compatibility check, not the design
target.

## Information hierarchy

Every page should reduce to this order:

1. A compact title and optional one-sentence subtitle. On project pages at md
   and up, the topbar breadcrumb's project name is the visible compact title.
2. Current readiness or state.
3. One primary action, only when action is required.
4. The primary chart or table.
5. History, methodology, and diagnostics behind disclosure.

Do not repeat a page choice through cards, tabs, and headings. One control owns
each choice.

## Copy

- Page subtitles are optional, one sentence, and normally no more than 90
  characters.
- Do not restate the heading in the subtitle.
- Labels use customer language: `Recent jobs`, not process commentary;
  `Connections`, not authentication architecture.
- If copy explains methodology or implementation, put it in an `InfoTooltip`,
  a `details` disclosure, or documentation.
- Empty and error states may contain the minimum copy needed to recover.
- Avoid acronyms until the expanded product name has established the context.
- Do not use em dashes in UI copy.
- Measured-report headers describe the displayed run and its date. Keep future assignment counts and revision mechanics out of the results header; configuration changes do not make saved results incomplete. When tracking changed after the displayed run, one status line below the header, on the default latest view only, may say when it changed, which results show, and when new numbers arrive.
- Status headers show only decision-relevant state. Next-run headers use the schedule-local calendar date; keep time, weekday, year, team ownership, and explanatory prose out of the header.

## Typography and contrast

- Geist Sans is the UI face; Geist Mono is reserved for code, IDs, paths, and
  tabular numerics. Both variable fonts are self-hosted through Fontsource.
- Use a complete `text-heading-*`, `text-label-*`, `text-copy-*`, or
  `text-button-*` preset. Each owns size, line height, weight, and tracking.
  Do not rebuild a preset with separate font-size, weight, leading, and tracking
  utilities. Use a different preset when its role changes.
- Headings introduce a page or section. The full Geist heading scale is
  available, but dashboard sections normally use 16 or 20; compact headings
  use 14, and page titles use 24. Large metric values may use 32.
- Labels name controls, navigation, table columns, and short metadata. Use 14
  normally, 13 for secondary labels, and 12 for tertiary metadata. No dashboard
  text is smaller than 12px, including chart ticks and tooltip copy.
- Copy styles are for multiline content: `text-copy-14` normally,
  `text-copy-13` for dense secondary detail, and `text-copy-16` for spacious
  dialog explanations. Meaningful body and recovery text is at least 13px.
- Strong label and copy variants carry their preset's emphasis. Use the
  `-mono` variants for compact code and identifiers, and `tabular-nums` for
  aligned numerical columns. Do not apply mono to ordinary prose.
- Button text uses `text-button-14`, or `text-button-16` in a large action.
  `text-button-12` is reserved for a tiny action inside an input field.
- `text-secondary` is the minimum contrast for meaningful supporting copy.
- `text-muted` and `text-faint` are only for nonessential metadata, timestamps,
  table labels, and disabled context. Never put instructions or recovery steps
  in them.
- Body prose is capped at 65-75 characters per line.

## Color and themes

- Use semantic utilities such as `bg-bg`, `bg-surface`, `border-default`,
  `text-primary`, and `text-secondary`. Their values resolve through the Geist
  palette for the active theme. Avoid literal Tailwind palette colors in UI.
- Neutral surfaces use the achromatic Geist gray scale. Background 1 is the
  default surface; Background 2 provides occasional page differentiation.
  Gray steps 1–3 express component states, 4–6 borders, and 9–10 readable text.
- Positive uses green, caution amber, negative red, and informational accents
  blue. Use `ToneBadge` and semantic tone tokens instead of choosing a shade
  independently in each component.
- Gray-alpha is for translucent effects. Resting surfaces and floating panels
  are opaque; underlying data must not show through a menu or tooltip.
- The shared topbar offers a compact Sun/Moon/Monitor segmented toggle for
  Light, Dark, and System on every standalone page,
  including Simple and Advanced portfolios. Dark is the initial default.
  Each icon retains its accessible name and tooltip; arrow keys move the choice.
  Save the preference in this browser, across projects and reloads; System
  follows live OS changes. A blocked storage write must not prevent switching.
- Apply the resolved mode at the document root before the first paint, including
  native `color-scheme` and browser `theme-color`, so charts and body portals
  change together. Synchronize other open tabs. Embeds retain their configured
  theme (dark when unspecified), custom colors, and chromeless layout.
- Provider colors identify engines. Chart series and the Site Health state
  palette retain their separate analytical meanings; they are not decorative
  aliases for button or badge colors.

## Controls

- Pills are reserved for non-interactive tags and semantic status badges.
- Navigation uses underline tabs or standard links.
- Project selection uses the sidebar. Measurement scope uses the shared
  group-first scope picker, a searchable disclosure, because a flat select
  cannot express Group drill-down.
- A small mutually exclusive time range may use one rectangular segmented
  control with `rounded-md`, never a rack of separate pills.
- Chart series use a checkbox-style legend.
- Actions use the shared rectangular `Button` component and its standard desktop
  sizes: small 32px, default 36px, and large 40px. Small/default controls use a
  6px radius; large controls use 8px. Preserve usable touch targets on mobile.
  Do not add blanket 44px minimum heights to desktop actions or list rows.
- Keep Canonry's existing sentence-case product labels. Button styling does not
  require renaming actions or changing accessible names.
- Active filters use compact rectangular tokens only when the filter value must
  remain visible; otherwise keep state in the originating control.
- Every control needs default, hover, focus, active, disabled, and loading
  behavior where applicable.
- Hover fills must remain distinct and keep normal-text contrast in both
  themes. Canonry deepens the dark destructive hover fill to retain readable
  white labels.

## Surfaces and data

- Choose a named material for a bounded surface. The preset owns the fill,
  outline, radius, and layered shadow; do not add a second border or shadow
  that doubles its edge. Spacing remains the component's responsibility.

  | Material | Use | Radius |
  | --- | --- | --- |
  | `material-base` | Resting cards and bounded table surfaces | 6px |
  | `material-small` | Slightly raised inline content | 6px |
  | `material-medium` | Raised panels | 12px |
  | `material-large` | Prominent raised content | 12px |
  | `material-tooltip` | Floating help | 6px |
  | `material-menu` | Menus and scope pickers | 12px |
  | `material-modal` | Dialogs and drawers | 12px |
  | `material-fullscreen` | Inset takeovers | 16px |

- Use the lowest appropriate elevation and a matching stacking order. A sheet
  attached to a viewport edge keeps that edge square. Tooltips alone may use a
  triangular stem. Keep dialog roles, keyboard dismissal, focus management,
  and accessible names on the existing interactive wrapper.
- Cards are for a bounded interpretation, readiness state, or callout. They are
  not the default page container.
- Never nest cards. Avoid grids of identical cards.
- Use section dividers for page structure and tables for three or more
  structured records.
- One chart or table should dominate a section. Secondary detail collapses.
- Radial/progress gauges require a real bounded scale. Raw event counts,
  sessions, hits, and totals use flat KPI rows without synthetic progress.
- Status color communicates state; it is not decoration.

## Navigation and naming

- Global surfaces and project surfaces must be named by scope. Source
  administration is not the same as project analysis.
- The sidebar label and destination page title must match.
- Do not repeat a global collection link and collection heading with the same
  label in one navigation group.
- Keep project identity in the topbar breadcrumb. Project pages keep one
  visually hidden `h1` that is visible below md and in embeds. Editing domains,
  aliases, locations, and other configuration belongs in project Settings.

## Accessibility and responsive behavior

- Normal text must meet WCAG AA contrast. Interactive controls have visible
  focus states and keyboard access. Keep desktop controls compact; increase
  standalone touch targets for coarse pointers where needed.
- Do not communicate state through color alone.
- Site Health graph states use the dedicated color-vision-safe
  `--chart-site-health-*` palette plus matching status glyphs in labels, search,
  and the legend. Node size remains reserved for internal-link importance.
- Dense tables may scroll horizontally; controls and headings must reflow
  without clipping at narrow widths.
- Respect reduced-motion preferences. Motion only explains state changes.

## Canonry-specific invariants

- `ToneBadge` remains the status vocabulary.
- Mention and citation labels must preserve their independent data semantics.
- Recharts is the only chart library and is consumed through
  `ChartPrimitives.tsx`.
- Embed mode remains read-only and may hide chrome, actions, or disallowed tabs.
  The one exception is the client Queries tab: when the agency lets a
  dashboard's clients manage their own queries, they can add and remove that
  project's queries there, and nothing else.

## Review checklist

- Can the page purpose be understood without reading supporting copy?
- Is there one obvious primary action?
- Did any implementation detail leak into the default view?
- Is any meaningful text below 13px or using `text-muted`/`text-faint`?
- Are text presets intact, with no text below the 12px metadata minimum?
- Does each bounded surface use one material without duplicated chrome?
- Do colors, native controls, charts, and floating layers work in both themes?
- Is a pill being used for navigation, filtering, or an action?
- Are multiple cards competing at the same visual weight?
- Does every empty or failure state offer a truthful recovery path?
- Were focused tests, typecheck, lint, build, and representative visual states
  checked?

# Canonry Dashboard Design System

This file is the durable UI contract for humans and coding agents. Read it with
`PRODUCT.md` before changing `apps/web`.

## Scene and register

Canonry is a professional desktop analytics tool used by an operator scanning
dense evidence on a monitor for extended periods. The default dark theme must
remain restrained, high contrast, and quiet. Design serves the task.

## Information hierarchy

Every page should reduce to this order:

1. A compact title and optional one-sentence subtitle.
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
- Measured-report headers describe the displayed run and its date. Keep future assignment counts and revision mechanics out of the results header; configuration changes do not make saved results incomplete.
- Status headers show only decision-relevant state. Next-run headers use the schedule-local calendar date; keep time, weekday, year, team ownership, and explanatory prose out of the header.

## Typography and contrast

- Geist Sans is the UI face; Geist Mono is reserved for code, IDs, paths, and
  tabular numerics.
- Meaningful body and explanatory text is at least 13px, normally 14px.
- `text-secondary` is the minimum contrast for meaningful supporting copy.
- `text-muted` and `text-faint` are only for nonessential metadata, timestamps,
  table labels, and disabled context. Never put instructions or recovery steps
  in them.
- Text at 10-11px is limited to short, nonessential metadata and table headers.
- Body prose is capped at 65-75 characters per line.

## Controls

- Pills are reserved for non-interactive tags and semantic status badges.
- Navigation uses underline tabs or standard links.
- Scope and project selection uses a native/select control.
- A small mutually exclusive time range may use one rectangular segmented
  control with `rounded-md`, never a rack of separate pills.
- Chart series use a checkbox-style legend.
- Actions use the shared rectangular `Button` component.
- Active filters use compact rectangular tokens only when the filter value must
  remain visible; otherwise keep state in the originating control.
- Every control needs default, hover, focus, active, disabled, and loading
  behavior where applicable.

## Surfaces and data

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
- Keep project identity in the header. Editing domains, aliases, locations, and
  other configuration belongs in project Settings.

## Accessibility and responsive behavior

- Normal text must meet WCAG AA contrast. Interactive controls have visible
  focus states and at least a 44px touch target where they stand alone.
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
- SPA and downloadable report copy remain in parity. Follow the report parity
  instructions before changing `ReportPage.tsx`.
- Embed mode remains read-only and may hide chrome, actions, or disallowed tabs.

## Review checklist

- Can the page purpose be understood without reading supporting copy?
- Is there one obvious primary action?
- Did any implementation detail leak into the default view?
- Is any meaningful text below 13px or using `text-muted`/`text-faint`?
- Is a pill being used for navigation, filtering, or an action?
- Are multiple cards competing at the same visual weight?
- Does every empty or failure state offer a truthful recovery path?
- Were focused tests, typecheck, lint, build, and representative visual states
  checked?

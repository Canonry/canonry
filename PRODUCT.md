# Product

## Register

product

## Users

**Primary**: AEO (Answer Engine Optimization) analysts. Humans whose job is to track how AI answer engines (ChatGPT, Gemini, Claude, Perplexity) cite a given domain for tracked queries, diagnose regressions, and act on the signal.

**Co-primary**: Aero, the built-in LLM analyst that ships inside canonry, plus external agents the user attaches via webhook or MCP. The dashboard is one of two clients on the API; the other is software. Whatever the human can see, an agent can fetch.

**Derivative audiences** (via the HTML report renderer): clients (less technical, want the "what" and the "so what") and agencies (operator-grade, want the evidence and the recommended next move).

Context of use: focused, ops-shaped sessions. Open the dashboard, scan what changed since last sweep, drill into the failing run or the lost citation, decide whether to act through content + integrations or escalate. Not casual browsing. Not first-time onboarding marketing.

## Product Purpose

Canonry is the **agent-first open-source AEO operating platform**. It tracks citation + mention behavior across LLM answer engines for a tracked set of queries, surfaces regressions, and acts on the signal through integrations (Google Search Console, Bing Webmaster, GA4, WordPress) and an AI analyst (Aero).

Success looks like an analyst (or their agent) detecting, diagnosing, and acting on an AEO regression faster than they could with Semrush, Ahrefs, or Profound — and being able to script the entire workflow because every surface is API-first.

## Brand Personality

Three words: **expert · agentic · honest**.

Voice: the instrument, not the showroom. Speak the way a senior analyst would in a postmortem — direct, evidence-led, no posturing. Numbers carry the headline; commentary explains the move. Never marketing-voice ("Unlock the power of…", "AI-driven insights"). Never coy.

Emotional goal: when the user opens the dashboard, the feeling is "I'm running an instrument" — not "I'm reading a SaaS landing page." Confidence comes from data density and signal clarity, not from chrome.

References in spirit: Linear (operator-grade, no fluff), Raycast (tool-density), Vercel (typographic polish on dense surfaces), Stripe docs (evidence-led prose). Bloomberg Terminal in attitude, Vercel in restraint.

## Anti-references

What canonry must explicitly NOT look or feel like:

- **Semrush / Ahrefs** — overstuffed SEO dashboards where every pixel is occupied, every panel competes for attention, and no scanning rhythm exists. Density is good; chaos is not.
- **Profound and the AEO-tool reflex** — the obvious aesthetic for this category. If a user could guess "this is an AEO dashboard" from the chrome alone, we've fallen into the category reflex. Lean against it on purpose.
- **Generic SaaS marketing** — gradient hero, three feature cards in a row, testimonial carousel, big "Get started free" CTA. Canonry has no marketing surface inside the app, and never should.
- **"AI startup" aesthetic** — purple-to-pink gradients, sparkle/wand icons, generative-art backgrounds, glassmorphism, "✨ Powered by AI" stickers, animated mesh gradients. Canonry IS an AI product, which is exactly why none of these belong.

## Design Principles

Strategic principles that should guide every design call, not visual rules.

1. **Agent-first means machine-readable.** The UI is a consumer of the API, never a privileged surface. Every metric a human sees, an agent can fetch via CLI / API / MCP in a single call. Derived calculations live in the API response, not in component code. If a UI widget displays something an agent cannot retrieve, that's a bug in the API, not a "UI-only metric." (Encoded as the UI/CLI parity rule in `AGENTS.md`.)

2. **Density over decoration.** Analysts scan; they don't browse. Data tables beat card grids for any list of 3+ structured items. Information per square inch is the design metric. Whitespace is for rhythm and hierarchy, not for atmosphere. Cards are reserved for narrative — insights, interpretations — not for evidence lists.

3. **Two signals, never collapsed.** "Cited" (the domain appears in the source links the LLM used) and "mentioned" (the brand appears in the answer text) are independent signals. A model can do either, both, or neither. The UI must always disambiguate — never invent a unified "visibility" score that collapses them, never label one and compute from the other. (Encoded as the Vocabulary rule in `AGENTS.md`.)

4. **Honest over hype.** No gradient-text headlines, no "AI-powered ✨" stickers, no manufactured urgency, no fake counts, no fabricated trends. The data is the story. When a metric is zero, say zero. When data is missing, say missing — don't infer a fallback that pretends the signal exists.

5. **One DTO, many renderers.** The CLI text output, the dashboard SPA, the downloadable HTML report, and the MCP/API JSON all render from the same underlying contract. Drift between any two is a bug, not a styling difference. Visual choices are constrained by what survives across all four surfaces — anything dashboard-only (rich React components, hover-only affordances) needs a deliberate degradation path for the static and machine-readable renderers.

## Accessibility & Inclusion

- WCAG: aim for AA contrast as a floor. The dark zinc-950 base + zinc-50 primary text already clears AA; tone colors (emerald, amber, rose) on zinc-900/30 surfaces have been chosen with this in mind. Verify any new tone-on-surface combination before shipping.
- Keyboard: skip-to-content link, focus-visible rings on every interactive element, `aria-current="page"` on active nav, `aria-label` on nav landmarks, `.sr-only` labels where icons stand alone.
- Reduced motion: respect `prefers-reduced-motion` for sparklines, gauges, and chart animations. Charts already use exponential ease-out curves; static fallbacks should drop the entry animation entirely rather than shortening it.
- Color-blind safety: tone is never carried by hue alone. Every tone-colored element pairs with an icon, glyph, or label (`ToneBadge`, two-glyph snapshot cells like `[citation][mention]` from `canonry citations`). Severity is encoded redundantly.
- Internationalization: the dashboard is English-first today; UI copy should still avoid idioms that don't translate. Numbers use `en-US` locale formatting via shared utilities in `packages/contracts/src/formatting.ts`.

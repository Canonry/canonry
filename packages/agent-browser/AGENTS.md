# agent-browser

## Purpose

The engine behind agent-browser checks: AI agents try a task on a site in a real Chrome, driven over the Chrome DevTools Protocol (`chrome-remote-interface`, the same layer as `provider-cdp`). It is internal and bundled into `@canonry/canonry`; `packages/canonry/src/execute-agent-browser-check.ts` runs it for the `agent-browser-check` run kind.

## Key Files

| File | Role |
|------|------|
| `src/browser.ts` | `BrowserSession`: one isolated browser context per agent run (no cookies or sign-ins carry over), fixed 1280×800 viewport, real mouse and keyboard events, screenshots, history, a stand-in find bar, new tabs folded into the page. `launchChrome` / `findChromeExecutable` start a local headless Chrome; `connectedChrome` wraps one someone else runs. |
| `src/fence.ts` | `decideFence`: what the browser lets through. Writes to the site are answered locally (`{"ok":true}`) and recorded; writes elsewhere and tracker requests are dropped; another site opened in the page gets a local "blocked" page. `egressOrigin`: the origin an egress check classifies. |
| `src/a11y.ts` | The accessibility-tree agent's view: Chrome's `Accessibility.getFullAXTree` as an outline with refs, and acting by ref (real click on the element's box, text replacement, option selection with input/change events). |
| `src/agents.ts` | The four agents: OpenAI Responses `computer` tool, Claude `computer_toolset_20260801`, Gemini `generateContent` + `computerUse`, and Claude over the accessibility tree. Each maps its provider's actions onto `BrowserSession`. |
| `src/checks.ts` | `evaluateExpectation` and `judgeAgentRun`: Canonry's verdict from what it saw (final page, answer, caught submission), never from the agent's claim. |
| `src/keys.ts` | Key-name normalization across providers and US-layout CDP key definitions. |
| `src/run.ts` | `runAgentBrowserCheck`: runs agents × repeats with bounded concurrency and returns one result per run. |

## Rules

- **Verdicts come from evidence, not the agent.** `passed` needs every expectation to hold; with no expectation a pass is `verified: false`. Page text can tell an agent it succeeded, so never let the answer alone decide.
- **`errored` is not `failed`.** A run that threw (provider error, browser crash, missing key) is `errored`; it says nothing about the site and never counts against an agent. Do not fold provider failures into `failed`.
- **Every request that leaves the browser passes the host's egress policy.** `BrowserSession` asks its `egress` check once per origin before continuing a request the fence lets through, and refuses when the check fails: a refused subresource fails, a refused page becomes the blocked page. The executor passes `agentBrowserEgress` (the shared policy in `packages/api-routes/src/egress-policy.ts`). Never continue a request around it.
- **Nothing that writes leaves the browser.** Keep every non-GET request inside `decideFence`. A check may run on a client's live site: a leaked submission is a fake lead, a leaked beacon a fake ad conversion. Add a tracker host to `TRACKER_HOSTS` rather than special-casing it.
- **Match the browser agents really use.** The page-only browser has no address bar or find bar, so the session handles browser shortcuts (Ctrl+F, back, reload) itself. A native `<select>`'s open list is drawn outside the page, so clicks on its options do not land, as in other CDP-driven agent browsers. Change these only to match real agent browsers more closely.
- **Provider APIs drift.** Gemini's Interactions API refused every follow-up computer-use turn on the keys this was built with, so the Gemini agent uses `generateContent`. Claude Opus 5.5 accepts computer use only through `computer_toolset_20260801` on the Claude API.
- Site-host membership lives in contracts (`agentBrowserSiteHosts`, `isAgentBrowserSiteHost`); request, result and summary shapes in `packages/contracts/src/agent-browser.ts`.

## Testing

Unit tests cover keys, the fence, egress origins and verdicts (`test/`). To smoke a change to the egress path without spending, open a `BrowserSession` on a local Chrome with an `egress` check that refuses a second local server's origin, load a page that embeds it, then open it as a page: that server must receive no request. Driving a real browser and real providers spends money and needs Chrome, so it is a manual smoke: build the CLI, run `canonry serve` on a scratch config with provider keys in the environment, and run `canonry agent-browser check <project> --task "…" --expect-url … --wait`.

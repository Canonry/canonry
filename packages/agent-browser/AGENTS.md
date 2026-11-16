# agent-browser

## Purpose

The engine behind agent-browser checks: AI agents try a task on a site in a real Chrome, driven over the Chrome DevTools Protocol (`chrome-remote-interface`, the same layer as `provider-cdp`). It is internal and bundled into `@canonry/canonry`; `packages/canonry/src/execute-agent-browser-check.ts` runs it for the `agent-browser-check` run kind.

## Key Files

| File | Role |
|------|------|
| `src/browser.ts` | `BrowserSession`: one agent run's page in a Chrome of its own, fixed 1280×800 viewport, real mouse and keyboard events, screenshots, history, a stand-in find bar. Containment: the fence runs browser-wide (`Fetch` on the browser target), every target is attached before it runs (`setAutoAttach` with `waitForDebuggerOnStart`), new tabs are folded into the page on their first load, a site's service worker is held paused, and `SOCKETS_OFF` removes WebSocket, WebTransport and WebRTC in every page, frame and worker. `launchChrome` starts a local headless Chrome, behind a proxy when given one. |
| `src/egress-proxy.ts` | `startEgressProxy`: the browser's only way out. Every connection, loopback included, goes through it; it dials only the address the egress check vetted (`createEgressGate`, once per host and port per run), for plain HTTP and CONNECT tunnels (HTTPS, WebSockets) alike. |
| `src/fence.ts` | `decideFence`: what the browser lets through. Writes to the site are answered locally (`{"ok":true}`) and recorded; writes elsewhere and tracker requests are dropped; another site opened in the page gets a local "blocked" page. `egressTarget`: the host and port a request dials. |
| `src/a11y.ts` | The accessibility-tree agent's view: Chrome's `Accessibility.getFullAXTree` as an outline with refs, and acting by ref (real click on the element's box, text replacement, option selection with input/change events). |
| `src/agents.ts` | The four agents: OpenAI Responses `computer` tool, Claude `computer_toolset_20260801`, Gemini `generateContent` + `computerUse`, and Claude over the accessibility tree. Each maps its provider's actions onto `BrowserSession`, stops at a provider safety gate, and reads terminal states (`openAIResponseStop`, `geminiFinishStop`, `claudeFinishStop`). |
| `src/checks.ts` | `evaluateExpectation` and `judgeAgentRun`: Canonry's verdict from what it saw (a page the site served, the answer, a submission the check answered), never from the agent's claim. |
| `src/keys.ts` | Key-name normalization across providers and US-layout CDP key definitions. |
| `src/run.ts` | `runAgentBrowserCheck`: runs agents × repeats with bounded concurrency; each run gets its own proxy and Chrome and a wall-clock deadline that aborts calls in flight. |

## Rules

- **Verdicts come from evidence, not the agent.** `passed` needs every expectation to hold; with no expectation a pass is `verified: false`. Page text can tell an agent it succeeded, so never let the answer alone decide.
- **`errored` is not `failed`.** A run that threw (provider error, browser crash, missing key) is `errored`; it says nothing about the site and never counts against an agent. Do not fold provider failures into `failed`.
- **Every connection leaves through the egress proxy.** Launch the check browser only with `launchChrome(..., { proxyServer })`; the flags also force loopback through it and keep WebRTC and QUIC from going around it. The proxy dials only what the egress check vetted (the executor's `agentBrowserEgress`, the shared policy in `packages/api-routes/src/egress-policy.ts`). Never run a check in a browser you did not launch this way, and never add a direct route out.
- **Nothing that writes leaves the browser.** Keep the fence browser-wide (`Fetch.enable` on the browser target, one browser per run): a page-level fence misses iframes in other processes, popups and workers. Keep `SOCKETS_OFF` in every attached page, frame and worker, and keep site service workers paused: their traffic is outside any fence. A check may run on a client's live site: a leaked submission is a fake lead, a leaked beacon a fake ad conversion. Add a tracker host to `TRACKER_HOSTS` rather than special-casing it.
- **An attached target waiting for the debugger answers nothing until it resumes.** Queue its commands without awaiting them one by one, with `Runtime.runIfWaitingForDebugger` last (one session runs commands in order); awaiting deadlocks it. An iframe target needs `Page.enable` before `addScriptToEvaluateOnNewDocument` takes effect.
- **A provider safety gate stops the run.** OpenAI's `pending_safety_checks` and Gemini's `safety_decision` ask for a person's confirmation; nobody is there, so the run stops before the gated action (`stop: safety-check`) and never acknowledges it. Refusals and cut-off responses (`refusal`, `incomplete`) are not a finish either.
- **The time limit is a hard limit.** Every provider call gets the run's signal and its remaining time; a call still in flight at the deadline is aborted and the run ends `time-limit` with its usage so far. A call stuck in the browser is freed by closing the browser.
- **Match the browser agents really use.** The page-only browser has no address bar or find bar, so the session handles browser shortcuts (Ctrl+F, back, reload) itself. A native `<select>`'s open list is drawn outside the page, so clicks on its options do not land, as in other CDP-driven agent browsers. Change these only to match real agent browsers more closely.
- **Provider APIs drift.** Gemini's Interactions API refused every follow-up computer-use turn on the keys this was built with, so the Gemini agent uses `generateContent`. Claude Opus 5.5 accepts computer use only through `computer_toolset_20260801` on the Claude API.
- Site-host membership lives in contracts (`agentBrowserSiteHosts`, `isAgentBrowserSiteHost`); request, result and summary shapes in `packages/contracts/src/agent-browser.ts`.

## Testing

Unit tests cover keys, the fence, egress targets, the proxy, verdicts and the agent loops' safety, terminal and deadline handling (provider SDKs mocked). `test/containment.test.ts` drives a real Chrome behind the real proxy through a popup, a cross-site iframe, a worker, a service worker, a beacon and WebSockets, and asserts nothing reaches the servers it must not. It skips without Chrome; the test setup moves `HOME`, so point it at a Chrome explicitly: `CANONRY_CHROME_PATH=<chrome> pnpm exec vitest run --project 'agent-browser*'`. Driving a real browser and real providers spends money and needs Chrome, so it is a manual smoke: build the CLI, run `canonry serve` on a scratch config with provider keys in the environment, and run `canonry agent-browser check <project> --task "…" --expect-url … --wait`.

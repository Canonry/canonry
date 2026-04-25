# Canonry Desktop (POC)

Tauri 2 wrapper that boots `canonry serve` as a sidecar and shows the dashboard in a native window.

## Prerequisites

- **Rust** (1.77+): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).
- **Linux**: `webkit2gtk-4.1`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the full list.
- **Windows**: Microsoft C++ Build Tools + WebView2 (preinstalled on Win11).
- **canonry**: either on PATH or pointed at via `CANONRY_BIN`.

## First run

From the repo root:

```bash
pnpm install
pnpm --filter @ainyc/canonry build       # produce dist/cli.js
pnpm --filter @ainyc/canonry-desktop dev
```

What happens:
1. Tauri compiles the Rust shell (~1 min the first time, seconds after).
2. The shell auto-detects `packages/canonry/dist/cli.js` and spawns it with `node`.
3. The shell picks a free port, waits for canonry to bind, then opens the native window pointing at `http://127.0.0.1:<port>`.
4. Closing the window kills the sidecar.

To override the auto-detect (e.g. point at a different canonry build), set
`CANONRY_BIN` (and optionally `CANONRY_ARGS`):

```bash
CANONRY_BIN="$(which canonry)" pnpm --filter @ainyc/canonry-desktop dev
```

## Production build

```bash
pnpm --filter @ainyc/canonry-desktop build
```

Outputs a `.app` bundle (macOS), `.msi` (Windows), or `.deb`/`.AppImage` (Linux) in `apps/desktop/src-tauri/target/release/bundle/`.

**This will not work end-to-end yet** — the bundled app expects `canonry` on the user's PATH. To produce a self-contained app you need to ship canonry as a Tauri sidecar binary; see the "What this POC deliberately skips" section in `AGENTS.md`.

## Tests

```bash
pnpm --filter @ainyc/canonry-desktop test
```

Requires Rust. Covers the pure helpers (env resolution, command construction,
port binding, sidecar error paths). Tauri runtime hooks are not unit-tested.

## Known limitations of the POC

- Placeholder icon (flat zinc-800 square). Replace with `pnpm exec tauri icon path/to/logo.png`.
- No code signing / notarization wired up.
- No auto-update plugin.
- Sidecar discovery relies on `CANONRY_BIN` or PATH — no bundled binary yet.

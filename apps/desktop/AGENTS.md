# canonry-desktop

## Purpose

POC Tauri 2 shell that wraps `canonry serve` + the bundled SPA into a native macOS / Windows / Linux app. Spawns the canonry CLI as a sidecar process, waits for it to bind a port, then loads the dashboard in a native webview.

This is **not** a separate runtime — it just wraps the existing canonry binary. All product logic stays in `packages/canonry/`.

## Key Files

| File | Role |
|------|------|
| `src-tauri/src/lib.rs` | Tauri `setup` hook — picks free port, spawns `canonry serve`, polls for readiness, builds the webview window |
| `src-tauri/src/main.rs` | Binary entry point — calls `canonry_desktop_lib::run()` |
| `src-tauri/Cargo.toml` | Rust deps (tauri 2, url, serde) |
| `src-tauri/tauri.conf.json` | Window/build/bundle config |
| `src-tauri/capabilities/default.json` | Tauri 2 capabilities for the main window |
| `src-tauri/icons/icon.png` | Placeholder app icon — replace before shipping |
| `public/index.html` | Stub frontend — never actually loaded since we navigate to `http://127.0.0.1:<port>` |
| `package.json` | Wrapper scripts that invoke `@tauri-apps/cli` |

## How sidecar discovery works

The Tauri shell needs to find the canonry binary. Resolution order:

1. **`CANONRY_BIN` env var** — full path to a canonry executable. Honored in
   both dev and release. `CANONRY_ARGS` (optional, whitespace-split) is
   inserted between the bin and `serve`, e.g.
   `CANONRY_BIN=node CANONRY_ARGS=/path/cli.js` → `node /path/cli.js serve`.
2. **Dev-mode workspace auto-detect.** When `cfg!(debug_assertions)` is true
   (i.e. `tauri dev`), the shell looks for
   `<workspace_root>/packages/canonry/dist/cli.js` (resolved relative to
   `CARGO_MANIFEST_DIR`). If found, it spawns `node <path> serve` — so dev
   "just works" once `pnpm --filter @ainyc/canonry build` has run. No env vars
   needed.
3. **Fallback:** `canonry` from PATH. Used in release mode if no `CANONRY_BIN`,
   and in dev mode if the workspace dist hasn't been built yet.

## Lifecycle

1. App boot: bind a free port via `TcpListener::bind("127.0.0.1:0")`.
2. Spawn canonry with `CANONRY_PORT=<port>` and `CANONRY_HOST=127.0.0.1`.
3. Poll `127.0.0.1:<port>` until it accepts TCP, up to 60s.
4. Open the main window pointing at `http://127.0.0.1:<port>`.
5. On window close: SIGKILL the sidecar via `Child::kill()`.

## What this POC deliberately skips

- **Bundled canonry binary.** Right now you need canonry on PATH (or via `CANONRY_BIN`). For a real release, canonry should be a Tauri "sidecar" binary at `src-tauri/binaries/canonry-<target-triple>` and declared in `tauri.conf.json` under `bundle.externalBin`. That requires building canonry as a single executable per target (Node SEA, `bun build --compile`, or `pkg`).
- **Real icons.** The placeholder `icon.png` is a flat zinc-800 square. Run `pnpm exec tauri icon path/to/logo.png` once a real logo exists.
- **Code signing / notarization.** Required for distribution outside dev — see Tauri's macOS signing docs.
- **Auto-update.** Tauri ships an updater plugin (`tauri-plugin-updater`); not wired up here.
- **Health check.** We poll TCP, not `/health`. A real impl should hit `/health` and verify the JSON response.

## Testing

Unit tests live in `src-tauri/src/lib.rs` under a `#[cfg(test)] mod tests` block.
Run them with:

```bash
pnpm --filter @ainyc/canonry-desktop test
# or
cd apps/desktop/src-tauri && cargo test
```

Requires Rust toolchain (`rustup`). These tests cover the pure helpers — env
resolution, command construction, port binding, sidecar startup error paths. The
Tauri runtime hooks (`setup`, `on_window_event`) are not unit-tested; covering
them requires either a fake `canonry` binary or a Tauri integration harness.

The repo's primary test runner is Vitest (per the root `AGENTS.md`); this
package is the one Rust-only exception, and `pnpm test` at the repo root does
not invoke `cargo test`. CI for this package needs a Rust step.

## Common Mistakes

- **Spawning an unbuilt canonry.** `CANONRY_BIN=node CANONRY_ARGS=.../cli.js` works only if `pnpm --filter @ainyc/canonry build` has run.
- **Port 4100 collision.** We pick a free port, so this isn't an issue — but if you hardcode `CANONRY_PORT`, it'll conflict with any other local canonry.
- **Closing the window leaks the sidecar on a panic.** The `on_window_event(Destroyed)` handler kills the child cleanly, but if the Rust process crashes between spawn and window-build, the sidecar lives on. Use `pkill canonry` to clean up.

## See Also

- `packages/canonry/src/commands/serve.ts` — the sidecar command this app wraps
- `apps/web/` — the SPA that gets served at `http://127.0.0.1:<port>/`

use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const CANONRY_BIN_ENV: &str = "CANONRY_BIN";
const CANONRY_ARGS_ENV: &str = "CANONRY_ARGS";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

/// Owns the spawned `canonry serve` child so we can kill it on window close.
struct CanonrySidecar(Mutex<Option<Child>>);

fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let addr = format!("127.0.0.1:{port}").parse().unwrap();
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn parse_extra_args(raw: Option<String>) -> Vec<String> {
    raw.map(|s| s.split_whitespace().map(String::from).collect())
        .unwrap_or_default()
}

/// Build the `canonry serve` command with sidecar wiring.
///
/// `extra_args` is inserted *between* the binary and `serve`, so that
/// `CANONRY_BIN=node CANONRY_ARGS=/path/to/cli.js` produces
/// `node /path/to/cli.js serve --port <port> --host 127.0.0.1`.
///
/// We pass `--port` / `--host` as flags rather than relying on env, because
/// canonry's CLI dispatch (`applyServerEnv` in `cli-commands/system.ts`)
/// **overwrites** `process.env.CANONRY_PORT` to the flag value or `"4100"` if
/// the flag is missing — so env-only spawning silently gets the default port.
/// Env vars are still set as belt-and-suspenders.
fn build_canonry_command(bin: &str, extra_args: &[String], port: u16) -> Command {
    let port_str = port.to_string();
    let mut cmd = Command::new(bin);
    cmd.args(extra_args)
        .arg("serve")
        .arg("--port")
        .arg(&port_str)
        .arg("--host")
        .arg("127.0.0.1")
        .env("CANONRY_PORT", &port_str)
        .env("CANONRY_HOST", "127.0.0.1");
    cmd
}

fn spawn_with(bin: &str, extra_args: &[String], port: u16) -> Result<Child, String> {
    let mut cmd = build_canonry_command(bin, extra_args, port);
    cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    cmd.spawn().map_err(|e| {
        format!(
            "failed to spawn `{bin} serve`: {e}.\n\
             Set {CANONRY_BIN_ENV} to the canonry executable, or install it on PATH."
        )
    })
}

/// If `<workspace_root>/packages/canonry/dist/cli.js` exists, return a
/// `(node, [path])` invocation pointing at it. Used to auto-wire dev mode
/// from inside the monorepo without requiring `CANONRY_BIN` env vars.
fn workspace_canonry_dev_invocation_at(workspace_root: &Path) -> Option<(String, Vec<String>)> {
    let cli_path = workspace_root.join("packages/canonry/dist/cli.js");
    let resolved = cli_path.canonicalize().ok()?;
    Some((
        "node".to_string(),
        vec![resolved.to_string_lossy().into_owned()],
    ))
}

/// CARGO_MANIFEST_DIR is set at compile time to `apps/desktop/src-tauri` —
/// three levels deep from the workspace root, so we need three `..`s.
const WORKSPACE_REL_FROM_MANIFEST: &str = "../../..";

fn workspace_canonry_dev_invocation() -> Option<(String, Vec<String>)> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let workspace_root = PathBuf::from(manifest_dir).join(WORKSPACE_REL_FROM_MANIFEST);
    workspace_canonry_dev_invocation_at(&workspace_root)
}

/// Resolve `(bin, args)` from explicit env values + an optional dev fallback.
/// Pure — no env reads, no filesystem access. The wrappers above feed the
/// real env / fs into this.
///
/// Priority:
/// 1. `bin_env` set → use it (with `args_env` as extra args)
/// 2. `dev_fallback` provided → use it
/// 3. Default to `canonry` on PATH with no extra args
fn resolve_canonry_invocation_from(
    bin_env: Option<String>,
    args_env: Option<String>,
    dev_fallback: Option<(String, Vec<String>)>,
) -> (String, Vec<String>) {
    if let Some(bin) = bin_env {
        return (bin, parse_extra_args(args_env));
    }
    if let Some(fallback) = dev_fallback {
        return fallback;
    }
    ("canonry".to_string(), Vec::new())
}

fn resolve_canonry_invocation() -> (String, Vec<String>) {
    let dev_fallback = if cfg!(debug_assertions) {
        workspace_canonry_dev_invocation()
    } else {
        None
    };
    resolve_canonry_invocation_from(
        std::env::var(CANONRY_BIN_ENV).ok(),
        std::env::var(CANONRY_ARGS_ENV).ok(),
        dev_fallback,
    )
}

/// Append a dev-mode hint to a spawn-failure message when the user didn't
/// override `CANONRY_BIN`, didn't have a workspace dist to fall back to, and
/// we ended up trying `canonry` from PATH unsuccessfully.
fn augment_error_with_dev_hint(base: String, expected_dist_path: Option<PathBuf>) -> String {
    match expected_dist_path {
        Some(path) => format!(
            "{base}\n\
             Dev mode auto-detect looked for `{}` but it doesn't exist.\n\
             Run `pnpm --filter @ainyc/canonry build` to produce the CLI bundle.",
            path.display()
        ),
        None => base,
    }
}

fn expected_dev_dist_path() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../../packages/canonry/dist/cli.js")
}

fn spawn_canonry(port: u16) -> Result<Child, String> {
    let (bin, extras) = resolve_canonry_invocation();
    spawn_with(&bin, &extras, port).map_err(|e| {
        // We only want to mention the dev-detect path when the user was
        // expecting it to work — i.e. dev build, no explicit override.
        let dev_hint_path = if cfg!(debug_assertions) && std::env::var(CANONRY_BIN_ENV).is_err() {
            Some(expected_dev_dist_path())
        } else {
            None
        };
        augment_error_with_dev_hint(e, dev_hint_path)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let port = pick_free_port().map_err(|e| format!("could not reserve a port: {e}"))?;
            let (bin_for_log, args_for_log) = resolve_canonry_invocation();
            eprintln!(
                "[canonry-desktop] spawning sidecar: bin={bin_for_log} args={args_for_log:?} CANONRY_PORT={port}"
            );

            let child = spawn_canonry(port)?;
            app.manage(CanonrySidecar(Mutex::new(Some(child))));

            if !wait_for_port(port, STARTUP_TIMEOUT) {
                return Err(format!(
                    "canonry sidecar did not bind to 127.0.0.1:{port} within {}s",
                    STARTUP_TIMEOUT.as_secs()
                )
                .into());
            }

            let url = format!("http://127.0.0.1:{port}");
            let parsed = url::Url::parse(&url)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Canonry")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<CanonrySidecar>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::fs;

    fn collect_args(cmd: &Command) -> Vec<String> {
        cmd.get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn collect_envs(cmd: &Command) -> HashMap<String, String> {
        cmd.get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            })
            .collect()
    }

    #[test]
    fn parse_extra_args_returns_empty_when_unset() {
        assert!(parse_extra_args(None).is_empty());
    }

    #[test]
    fn parse_extra_args_returns_empty_for_whitespace_only() {
        assert!(parse_extra_args(Some("   \t  ".into())).is_empty());
    }

    #[test]
    fn parse_extra_args_splits_on_whitespace_collapsing_runs() {
        assert_eq!(
            parse_extra_args(Some("foo  bar\tbaz".into())),
            vec!["foo".to_string(), "bar".to_string(), "baz".to_string()]
        );
    }

    #[test]
    fn build_canonry_command_uses_bin_as_program() {
        let cmd = build_canonry_command("canonry", &[], 4100);
        assert_eq!(cmd.get_program(), OsStr::new("canonry"));
    }

    #[test]
    fn build_canonry_command_passes_port_and_host_as_flags() {
        // canonry's `applyServerEnv` clobbers the env, so flags are required.
        let cmd = build_canonry_command("canonry", &[], 5234);
        let args = collect_args(&cmd);
        assert_eq!(
            args,
            vec![
                "serve".to_string(),
                "--port".to_string(),
                "5234".to_string(),
                "--host".to_string(),
                "127.0.0.1".to_string(),
            ]
        );
    }

    #[test]
    fn build_canonry_command_inserts_extra_args_before_serve() {
        // Contract: `CANONRY_BIN=node CANONRY_ARGS=/path/cli.js` must produce
        // `node /path/cli.js serve --port ... --host ...`, not
        // `node serve /path/cli.js ...`.
        let extras = vec!["/abs/path/cli.js".to_string()];
        let cmd = build_canonry_command("node", &extras, 5000);
        assert_eq!(
            collect_args(&cmd),
            vec![
                "/abs/path/cli.js".to_string(),
                "serve".to_string(),
                "--port".to_string(),
                "5000".to_string(),
                "--host".to_string(),
                "127.0.0.1".to_string(),
            ]
        );
    }

    #[test]
    fn build_canonry_command_also_passes_port_and_host_as_env_belt_and_suspenders() {
        let cmd = build_canonry_command("canonry", &[], 4100);
        let envs = collect_envs(&cmd);
        assert_eq!(envs.get("CANONRY_PORT"), Some(&"4100".to_string()));
        assert_eq!(envs.get("CANONRY_HOST"), Some(&"127.0.0.1".to_string()));
    }

    #[test]
    fn pick_free_port_returns_non_privileged_port() {
        let port = pick_free_port().expect("should pick a port");
        assert!(port > 1024, "should pick a non-privileged port, got {port}");
    }

    #[test]
    fn pick_free_port_returns_distinct_ports_on_repeat_call() {
        let a = pick_free_port().unwrap();
        let b = pick_free_port().unwrap();
        assert_ne!(a, b, "OS should cycle ephemeral ports between binds");
    }

    #[test]
    fn wait_for_port_returns_false_after_timeout_when_unbound() {
        let port = pick_free_port().unwrap();
        let started = Instant::now();
        let ready = wait_for_port(port, Duration::from_millis(500));
        assert!(!ready, "unbound port should time out");
        assert!(
            started.elapsed() >= Duration::from_millis(400),
            "wait should have respected the timeout, only waited {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn wait_for_port_returns_true_when_listener_present() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(wait_for_port(port, Duration::from_secs(2)));
        drop(listener);
    }

    #[test]
    fn spawn_with_returns_helpful_error_for_missing_binary() {
        let result = spawn_with("/nonexistent/canonry-test-binary-xyz", &[], 4100);
        let err = result.expect_err("missing binary should fail to spawn");
        assert!(err.contains("failed to spawn"), "missing 'failed to spawn' in: {err}");
        assert!(
            err.contains("/nonexistent/canonry-test-binary-xyz"),
            "missing bin path in: {err}"
        );
        assert!(err.contains(CANONRY_BIN_ENV), "missing env var name hint in: {err}");
    }

    #[test]
    fn resolve_invocation_uses_env_bin_when_set_ignoring_dev_fallback() {
        let result = resolve_canonry_invocation_from(
            Some("/custom/canonry".to_string()),
            None,
            Some(("node".to_string(), vec!["/dev/cli.js".to_string()])),
        );
        assert_eq!(result, ("/custom/canonry".to_string(), vec![]));
    }

    #[test]
    fn resolve_invocation_combines_env_bin_with_env_args() {
        let result = resolve_canonry_invocation_from(
            Some("node".to_string()),
            Some("/abs/cli.js".to_string()),
            None,
        );
        assert_eq!(result, ("node".to_string(), vec!["/abs/cli.js".to_string()]));
    }

    #[test]
    fn resolve_invocation_uses_dev_fallback_when_no_env_bin() {
        let fallback = ("node".to_string(), vec!["/workspace/cli.js".to_string()]);
        let result = resolve_canonry_invocation_from(None, None, Some(fallback.clone()));
        assert_eq!(result, fallback);
    }

    #[test]
    fn resolve_invocation_falls_back_to_canonry_on_path_when_no_env_no_dev() {
        let result = resolve_canonry_invocation_from(None, None, None);
        assert_eq!(result, ("canonry".to_string(), vec![]));
    }

    #[test]
    fn workspace_dev_invocation_returns_node_invocation_when_dist_present() {
        let tmp = tempfile::tempdir().unwrap();
        let dist_dir = tmp.path().join("packages/canonry/dist");
        fs::create_dir_all(&dist_dir).unwrap();
        let cli_path = dist_dir.join("cli.js");
        fs::write(&cli_path, "// stub").unwrap();

        let result = workspace_canonry_dev_invocation_at(tmp.path()).expect("should detect dist");
        assert_eq!(result.0, "node");
        // The returned arg should be the canonicalized absolute path.
        assert_eq!(result.1.len(), 1);
        let returned = PathBuf::from(&result.1[0]);
        assert_eq!(returned, cli_path.canonicalize().unwrap());
    }

    #[test]
    fn workspace_dev_invocation_returns_none_when_dist_absent() {
        let tmp = tempfile::tempdir().unwrap();
        // No packages/canonry/dist/cli.js created.
        assert!(workspace_canonry_dev_invocation_at(tmp.path()).is_none());
    }

    #[test]
    fn augment_error_returns_base_unchanged_when_no_dev_hint() {
        let result = augment_error_with_dev_hint("boom".to_string(), None);
        assert_eq!(result, "boom");
    }

    /// Lexically normalize a path: collapse `..` against the parent component.
    /// Doesn't touch the filesystem (unlike `canonicalize`).
    fn lexically_normalize(path: &Path) -> PathBuf {
        path.components().fold(PathBuf::new(), |mut acc, c| {
            match c {
                std::path::Component::ParentDir => {
                    acc.pop();
                }
                other => acc.push(other),
            }
            acc
        })
    }

    #[test]
    fn workspace_rel_from_manifest_lands_at_workspace_root() {
        // The constant must resolve `apps/desktop/src-tauri` → workspace root.
        // If someone moves this crate, this test will fail and remind them to
        // update WORKSPACE_REL_FROM_MANIFEST.
        let manifest = PathBuf::from("/repo/apps/desktop/src-tauri");
        let candidate = manifest.join(WORKSPACE_REL_FROM_MANIFEST);
        assert_eq!(lexically_normalize(&candidate), PathBuf::from("/repo"));
    }

    #[test]
    fn augment_error_appends_build_hint_with_path_when_dev_hint_present() {
        let path = PathBuf::from("/repo/packages/canonry/dist/cli.js");
        let result = augment_error_with_dev_hint("boom".to_string(), Some(path));
        assert!(result.starts_with("boom\n"), "should preserve base: {result}");
        assert!(
            result.contains("/repo/packages/canonry/dist/cli.js"),
            "should mention expected path: {result}"
        );
        assert!(
            result.contains("pnpm --filter @ainyc/canonry build"),
            "should suggest the build command: {result}"
        );
    }
}

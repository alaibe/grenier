use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "macos")]
mod menu_bar;
mod updater;
mod usage;

/// The daemon this app started, if it had to: stopped when the app quits. One started by `grenier run` is left alone.
struct Sidecar(Mutex<Option<CommandChild>>);

#[derive(Serialize)]
struct Connection {
    url: String,
    token: String,
}

/// GRENIER_HOME, else ~/.grenier: the same place the CLI uses.
fn grenier_home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("GRENIER_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    let user = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("no home directory")?;
    Ok(PathBuf::from(user).join(".grenier"))
}

/// GRENIER_CONFIG, else config.toml in the home: the same file the CLI reads.
fn config_file(home: &Path) -> PathBuf {
    std::env::var_os("GRENIER_CONFIG")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("config.toml"))
}

/// The `port` of config.toml's [proxy] table, comments allowed, else 7788.
fn configured_port(config: &str) -> u16 {
    let mut in_proxy = false;
    for line in config.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            in_proxy = line == "[proxy]";
        } else if in_proxy {
            if let Some(value) = line
                .strip_prefix("port")
                .and_then(|rest| rest.trim_start().strip_prefix('='))
            {
                if let Ok(port) = value.trim().parse() {
                    return port;
                }
            }
        }
    }
    7788
}

/// Where the daemon listens: what the running one wrote in daemon.json, else the configured port.
fn daemon_port(home: &Path) -> u16 {
    let recorded = std::fs::read_to_string(home.join("daemon.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|info| info.get("port")?.as_u64())
        .and_then(|port| u16::try_from(port).ok());
    recorded.unwrap_or_else(|| configured_port(&std::fs::read_to_string(config_file(home)).unwrap_or_default()))
}

fn answers(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

fn grenier(app: &AppHandle, args: &[&str]) -> Result<Command, String> {
    let script = app
        .path()
        .resolve("grenier/dist/grenier.js", BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    Ok(app
        .shell()
        .sidecar("grenier-node")
        .map_err(|error| error.to_string())?
        .arg(script)
        .args(args))
}

/// The daemon's port, after starting the bundled daemon when none answers; calls made meanwhile wait for that start.
fn start_daemon(app: &AppHandle, home: &Path) -> Result<u16, String> {
    let state = app.state::<Sidecar>();
    let mut sidecar = state.0.lock().map_err(|error| error.to_string())?;
    let port = daemon_port(home);
    if answers(port) {
        return Ok(port);
    }
    let (mut events, child) = grenier(app, &["daemon"])?
        .spawn()
        .map_err(|error| format!("cannot start the Grenier daemon: {error}"))?;
    *sidecar = Some(child);
    let said = Arc::new(Mutex::new(Vec::<String>::new()));
    let exited = Arc::new(AtomicBool::new(false));
    {
        let said = said.clone();
        let exited = exited.clone();
        std::thread::spawn(move || {
            while let Some(event) = events.blocking_recv() {
                match event {
                    CommandEvent::Stderr(line) | CommandEvent::Stdout(line) => {
                        if let Ok(mut lines) = said.lock() {
                            lines.push(String::from_utf8_lossy(&line).trim_end().to_string());
                            let excess = lines.len().saturating_sub(20);
                            lines.drain(..excess);
                        }
                    }
                    CommandEvent::Terminated(_) => exited.store(true, Ordering::SeqCst),
                    _ => {}
                }
            }
        });
    }
    let started = Instant::now();
    loop {
        let port = daemon_port(home);
        if answers(port) {
            return Ok(port);
        }
        let gave_up = started.elapsed() > Duration::from_secs(15);
        if exited.load(Ordering::SeqCst) || gave_up {
            *sidecar = None;
            let lines = said.lock().map(|lines| lines.join("\n")).unwrap_or_default();
            let why = if lines.trim().is_empty() {
                "it said nothing".to_string()
            } else {
                lines
            };
            return Err(if gave_up {
                format!("the Grenier daemon did not answer on 127.0.0.1:{port} within 15 seconds:\n{why}")
            } else {
                format!("the Grenier daemon stopped as it started:\n{why}")
            });
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Stops the daemon this app started with `grenier stop`, and kills it only if that fails.
fn stop_daemon(app: &AppHandle) {
    let Some(child) = app.state::<Sidecar>().0.lock().ok().and_then(|mut child| child.take()) else {
        return;
    };
    let stopped = grenier(app, &["stop"])
        .ok()
        .and_then(|command| tauri::async_runtime::block_on(command.output()).ok())
        .is_some_and(|output| output.status.success());
    if !stopped {
        let _ = child.kill();
    }
    let Ok(home) = grenier_home() else {
        return;
    };
    let port = daemon_port(&home);
    let waited = Instant::now();
    while answers(port) && waited.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The folder the person picks in the system's dialog, starting at `from`; None when they cancel.
#[tauri::command]
async fn pick_folder(app: AppHandle, from: String) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if !from.is_empty() {
        dialog = dialog.set_directory(from);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|error| error.to_string())?;
    picked
        .map(|folder| folder.into_path().map(|path| path.display().to_string()))
        .transpose()
        .map_err(|error| error.to_string())
}

/// The daemon's address and admin token, starting the bundled daemon first when none answers.
#[tauri::command]
async fn daemon_connection(app: AppHandle) -> Result<Connection, String> {
    let home = grenier_home()?;
    let starting = app.clone();
    let start_home = home.clone();
    let port = tauri::async_runtime::spawn_blocking(move || start_daemon(&starting, &start_home))
        .await
        .map_err(|error| error.to_string())??;
    let token = std::fs::read_to_string(home.join("admin-token"))
        .map_err(|error| format!("cannot read {}: {error}", home.join("admin-token").display()))?;
    Ok(Connection {
        url: format!("http://127.0.0.1:{port}"),
        token: token.trim().to_string(),
    })
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sidecar(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            daemon_connection,
            pick_folder,
            usage::usage_page_view,
            usage::usage_enabled,
            usage::usage_set_enabled
        ])
        .setup(|app| {
            let store = usage::Store::new(
                app.path()
                    .app_local_data_dir()
                    .ok()
                    .map(|dir| dir.join(usage::STORE_FILE)),
            );
            let version = app.package_info().version.to_string();
            app.manage(usage::Usage::new(
                store,
                !cfg!(debug_assertions),
                usage::Os::current(),
                version,
            ));
            updater::schedule(app.handle());
            #[cfg(target_os = "macos")]
            menu_bar::install(app.handle())?;
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder.on_window_event(menu_bar::on_window_event);
    let app = builder
        .build(tauri::generate_context!())
        .expect("the Grenier window could not start");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        menu_bar::on_run_event(handle, &event);
        if let RunEvent::Exit = event {
            stop_daemon(handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::configured_port;

    #[test]
    fn reads_the_port_with_comments() {
        assert_eq!(configured_port("[proxy]\nport = 7790  # where it listens\n"), 7790);
        assert_eq!(
            configured_port("[budgets]\nport = 1\n[proxy]\nupstream = \"x\"\n"),
            7788
        );
        assert_eq!(configured_port(""), 7788);
    }
}

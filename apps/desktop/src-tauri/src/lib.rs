use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{Command, CommandChild};
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "macos")]
mod menu_bar;
mod updater;

/// The daemon this app started, if it had to: stopped when the app quits. One started by `grenier start` is left alone.
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

/// The proxy port from config.toml's [proxy] table, else 7788.
fn daemon_port(home: &PathBuf) -> u16 {
    let config = std::fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let mut in_proxy = false;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_proxy = line == "[proxy]";
        } else if in_proxy {
            if let Some(value) = line.strip_prefix("port").and_then(|rest| rest.trim_start().strip_prefix('=')) {
                if let Ok(port) = value.trim().parse() {
                    return port;
                }
            }
        }
    }
    7788
}

fn answers(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

/// The bundled CLI with these arguments, run by the bundled Node.
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

/// The daemon's port, after starting the bundled daemon when none answers there.
fn start_daemon(app: &AppHandle, home: &PathBuf) -> Result<u16, String> {
    let port = daemon_port(home);
    if answers(port) {
        return Ok(port);
    }
    let (_events, child) = grenier(app, &["daemon"])?
        .spawn()
        .map_err(|error| format!("cannot start the Grenier daemon: {error}"))?;
    *app.state::<Sidecar>().0.lock().map_err(|error| error.to_string())? = Some(child);
    let started = Instant::now();
    while !answers(port) {
        if started.elapsed() > Duration::from_secs(15) {
            return Err(format!("the Grenier daemon did not start on 127.0.0.1:{port}"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(port)
}

/// Stops the daemon this app started, if it did, and waits for its port to close.
fn stop_daemon(app: &AppHandle) {
    let Some(child) = app.state::<Sidecar>().0.lock().ok().and_then(|mut child| child.take()) else {
        return;
    };
    let _ = child.kill();
    let Ok(home) = grenier_home() else {
        return;
    };
    let port = daemon_port(&home);
    let stopped = Instant::now();
    while answers(port) && stopped.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The daemon's address and admin token, starting the bundled daemon first when none answers.
#[tauri::command]
async fn daemon_connection(app: AppHandle) -> Result<Connection, String> {
    let home = grenier_home()?;
    let port = start_daemon(&app, &home)?;
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
        .invoke_handler(tauri::generate_handler![daemon_connection])
        .setup(|app| {
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

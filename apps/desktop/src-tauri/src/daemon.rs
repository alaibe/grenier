use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{Command, CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The proxy's port when config.toml names none, as in the CLI.
const DEFAULT_PORT: u16 = 7788;
/// How long a start may take before the app says the daemon did not answer.
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a stop waits for `grenier stop`, then for the port to close.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);
/// The daemon's last lines kept, to say why it did not start.
const KEPT_LINES: usize = 20;

/// The daemon this app started, if it had to: stopped when the app quits. One started by `grenier run` is left alone.
#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    /// Held through a start, so calls made meanwhile wait for it; never by a stop, which must not wait for a start.
    starting: Mutex<()>,
}

/// Which daemon a stop ends.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// Only the one this app started, as when the app quits.
    Own,
    /// Whichever answers, even one started from a terminal: an update replaces the files it runs from.
    Any,
}

/// `GRENIER_HOME`, else ~/.grenier: the same place the CLI uses.
pub fn grenier_home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("GRENIER_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    let user = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or("no home directory")?;
    Ok(PathBuf::from(user).join(".grenier"))
}

/// `GRENIER_CONFIG`, else config.toml in the home: the same file the CLI reads.
fn config_file(home: &Path) -> PathBuf {
    std::env::var_os("GRENIER_CONFIG")
        .filter(|value| !value.is_empty())
        .map_or_else(|| home.join("config.toml"), PathBuf::from)
}

/// The `port` of config.toml's [proxy] table, comments allowed, else the default.
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
    DEFAULT_PORT
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

pub fn grenier(app: &AppHandle, args: &[&str]) -> Result<Command, String> {
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
pub fn start_daemon(app: &AppHandle, home: &Path) -> Result<u16, String> {
    let state = app.state::<Sidecar>();
    let _starting = state.starting.lock().map_err(|error| error.to_string())?;
    let port = daemon_port(home);
    if answers(port) {
        return Ok(port);
    }
    let (mut events, child) = grenier(app, &["daemon"])?
        .spawn()
        .map_err(|error| format!("cannot start the Grenier daemon: {error}"))?;
    *state.child.lock().map_err(|error| error.to_string())? = Some(child);
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
                            let excess = lines.len().saturating_sub(KEPT_LINES);
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
        let gave_up = started.elapsed() > START_TIMEOUT;
        if exited.load(Ordering::SeqCst) || gave_up {
            let child = state.child.lock().ok().and_then(|mut guard| guard.take());
            if gave_up {
                if let Some(child) = child {
                    let _ = child.kill();
                }
            }
            let lines = said.lock().map_or_default(|lines| lines.join("\n"));
            let why = if lines.trim().is_empty() {
                "it said nothing".to_string()
            } else {
                lines
            };
            return Err(if gave_up {
                format!(
                    "the Grenier daemon did not answer on 127.0.0.1:{port} within {} seconds:\n{why}",
                    START_TIMEOUT.as_secs()
                )
            } else {
                format!("the Grenier daemon stopped as it started:\n{why}")
            });
        }
        std::thread::sleep(POLL);
    }
}

/// Stops the daemon with `grenier stop`, killing the one this app started only if that fails, then waits for its port to close.
pub fn stop_daemon(app: &AppHandle, which: Stop) {
    let child = app
        .state::<Sidecar>()
        .child
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    if child.is_none() && which == Stop::Own {
        return;
    }
    if !run_stop(app) {
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
    let Ok(home) = grenier_home() else {
        return;
    };
    let port = daemon_port(&home);
    let waited = Instant::now();
    while answers(port) && waited.elapsed() < STOP_TIMEOUT {
        std::thread::sleep(POLL);
    }
}

/// Whether `grenier stop` succeeded within `STOP_TIMEOUT`; one still running then is killed.
fn run_stop(app: &AppHandle) -> bool {
    let Ok((mut events, child)) =
        grenier(app, &["stop"]).and_then(|command| command.spawn().map_err(|error| error.to_string()))
    else {
        return false;
    };
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        while let Some(event) = events.blocking_recv() {
            if let CommandEvent::Terminated(payload) = event {
                let _ = sender.send(payload.code == Some(0));
            }
        }
    });
    receiver.recv_timeout(STOP_TIMEOUT).unwrap_or_else(|_| {
        let _ = child.kill();
        false
    })
}

#[cfg(test)]
mod tests {
    use super::{configured_port, DEFAULT_PORT};

    #[test]
    fn reads_the_port_with_comments() {
        assert_eq!(configured_port("[proxy]\nport = 7790  # where it listens\n"), 7790);
        assert_eq!(
            configured_port("[budgets]\nport = 1\n[proxy]\nupstream = \"x\"\n"),
            DEFAULT_PORT
        );
        assert_eq!(configured_port(""), DEFAULT_PORT);
    }
}

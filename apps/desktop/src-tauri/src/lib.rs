use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;

use crate::daemon::{grenier_home, start_daemon, stop_daemon, Sidecar};

mod daemon;
#[cfg(target_os = "macos")]
mod menu_bar;
mod updater;
#[allow(
    clippy::doc_markdown,
    clippy::cast_possible_wrap,
    clippy::format_collect,
    clippy::assert_is_empty,
    reason = "its core is shared byte for byte with Kestrel and Statim"
)]
mod usage;

#[derive(Serialize)]
struct Connection {
    url: String,
    token: String,
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
    let token_file = home.join("admin-token");
    let port = tauri::async_runtime::spawn_blocking(move || start_daemon(&app, &home))
        .await
        .map_err(|error| error.to_string())??;
    let token = std::fs::read_to_string(&token_file)
        .map_err(|error| format!("cannot read {}: {error}", token_file.display()))?;
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
    #[expect(
        clippy::expect_used,
        reason = "there is nothing to fall back to when Tauri cannot build the app"
    )]
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

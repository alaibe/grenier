use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Window, WindowEvent};

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The menu bar item: today's spending and savings, from `grenier statusline --today`, every 30 seconds.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let today = MenuItem::with_id(app, "today", "Today", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Grenier", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Grenier", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&today, &PredefinedMenuItem::separator(app)?, &open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("today")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;

    let app = app.clone();
    std::thread::spawn(move || loop {
        let line = tauri::async_runtime::block_on(async {
            let output = crate::grenier(&app, &["statusline", "--today"])?
                .output()
                .await
                .map_err(|error| error.to_string())?;
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = stderr
                .lines()
                .find(|line| line.starts_with("grenier:") || line.contains("Error:"))
                .or_else(|| stderr.lines().next())
                .unwrap_or_default();
            Err(message.to_string())
        });
        // A failure is often the database being created by the daemon at the same moment: try again soon.
        let wait = match line {
            Ok(line) => {
                let _ = tray.set_title(Some(&line));
                let _ = today.set_text(format!("Today: {line} by the prompt cache"));
                30
            }
            Err(error) => {
                let _ = tray.set_title(None::<&str>);
                let _ = today.set_text(format!("Cannot read today's usage: {error}"));
                5
            }
        };
        std::thread::sleep(Duration::from_secs(wait));
    });
    Ok(())
}

/// Closing the window hides it, so the menu bar item stays until Quit.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
}

/// Clicking the Dock icon brings the hidden window back.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    if let RunEvent::Reopen { .. } = event {
        show_window(app);
    }
}

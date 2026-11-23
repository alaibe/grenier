use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Window, WindowEvent, Wry};

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The project lines sit between the "Today" heading and the separator.
const FIRST_LINE: usize = 1;

/// Each project's spend today, from `grenier statusline --today`, refreshed every 30 seconds.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let today = MenuItem::with_id(app, "today", "Today", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Grenier", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Grenier", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&today, &separator, &open, &update, &quit])?;
    let mut builder = TrayIconBuilder::with_id("today")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "update" => {
                let app = app.clone();
                std::thread::spawn(move || crate::updater::check_now(&app));
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    let app = app.clone();
    std::thread::spawn(move || {
        let mut shown: Vec<MenuItem<Wry>> = Vec::new();
        loop {
            let output = tauri::async_runtime::block_on(async {
                let output = crate::grenier(&app, &["statusline", "--today"])?
                    .output()
                    .await
                    .map_err(|error| error.to_string())?;
                if output.status.success() {
                    return Ok(String::from_utf8_lossy(&output.stdout).to_string());
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
            let (lines, wait) = match output {
                Ok(output) => {
                    let lines = output.lines().filter(|line| !line.trim().is_empty());
                    (lines.map(String::from).collect(), 30)
                }
                Err(error) => (vec![format!("Cannot read today's usage: {error}")], 5),
            };
            let _ = show_lines(&app, &menu, &mut shown, &lines);
            std::thread::sleep(Duration::from_secs(wait));
        }
    });
    Ok(())
}

/// Changes the menu's project lines in place, so an open menu keeps its items.
fn show_lines(
    app: &AppHandle,
    menu: &Menu<Wry>,
    shown: &mut Vec<MenuItem<Wry>>,
    lines: &[String],
) -> tauri::Result<()> {
    while shown.len() > lines.len() {
        if let Some(item) = shown.pop() {
            menu.remove(&item)?;
        }
    }
    for (index, line) in lines.iter().enumerate() {
        match shown.get(index) {
            Some(item) => item.set_text(line)?,
            None => {
                let item = MenuItem::new(app, line, false, None::<&str>)?;
                menu.insert(&item, FIRST_LINE + index)?;
                shown.push(item);
            }
        }
    }
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

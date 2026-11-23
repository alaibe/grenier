//! Updates, on the Mac, Windows and Linux alike: Tauri's updater reads the `latest.json` at `plugins.updater.endpoints`
//! (tauri.conf.json), the one each release on alaibe/grenier carries, and installs only an update signed for the
//! version it announces with the key whose public half is `plugins.updater.pubkey`. A release build
//! checks a minute after launch, then once a day, and asks before installing; the menu bar's Check for Updates checks
//! at once.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tauri::async_runtime::block_on;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const FIRST_CHECK: Duration = Duration::from_secs(60);
const INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

pub fn schedule(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK);
        loop {
            check(&app, false);
            thread::sleep(INTERVAL);
        }
    });
}

/// Checks now, as asked from the menu: unlike the daily check, it also says when Grenier is up to date or the check
/// failed. It waits for the person's answer, so it must not run on the main thread.
#[cfg(target_os = "macos")]
pub fn check_now(app: &AppHandle) {
    check(app, true);
}

/// One check at a time: a check asked for while another one's dialog is open does nothing.
static CHECKING: AtomicBool = AtomicBool::new(false);

fn check(app: &AppHandle, asked: bool) {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let installed = check_and_install(app, asked);
    CHECKING.store(false, Ordering::SeqCst);
    if let Err(error) = installed {
        let message = format!("The update could not be installed: {error}");
        ask(
            app,
            MessageDialogKind::Error,
            "Grenier could not update",
            &message,
            None,
        );
    }
}

/// A failed check (offline, say) waits for the next one unless it was asked for; a failed download or install is shown.
fn check_and_install(app: &AppHandle, asked: bool) -> Result<(), String> {
    let found = app
        .updater()
        .and_then(|updater| block_on(updater.check()))
        .map_err(|error| error.to_string());
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) if asked => {
            let message = format!("You have {}, the newest version.", app.package_info().version);
            ask(app, MessageDialogKind::Info, "Grenier is up to date", &message, None);
            return Ok(());
        }
        Err(error) if asked => {
            let message = format!("The check for a new version failed: {error}");
            ask(
                app,
                MessageDialogKind::Error,
                "Grenier could not check for updates",
                &message,
                None,
            );
            return Ok(());
        }
        _ => return Ok(()),
    };
    let title = format!("Grenier {} is available", update.version);
    let message = format!(
        "You have {}. Installing it stops Grenier's daemon for a moment and restarts the app.",
        update.current_version
    );
    if !ask(
        app,
        MessageDialogKind::Info,
        &title,
        &message,
        Some(("Install and Restart", "Later")),
    ) {
        return Ok(());
    }
    let bytes = block_on(update.download(|_, _| {}, || {})).map_err(|error| error.to_string())?;
    // The daemon runs from the app's own files: the installer must not find it running, nor the new app reuse it.
    crate::stop_daemon(app);
    if let Err(error) = update.install(bytes) {
        if let Ok(home) = crate::grenier_home() {
            let _ = crate::start_daemon(app, &home);
        }
        return Err(error.to_string());
    }
    // Windows' installer has quit Grenier by now; the Mac's app and Linux's package were replaced in place.
    app.restart();
}

/// A dialog over the app; true when its first button was chosen.
fn ask(app: &AppHandle, kind: MessageDialogKind, title: &str, message: &str, buttons: Option<(&str, &str)>) -> bool {
    let mut dialog = app.dialog().message(message).title(title).kind(kind);
    if let Some((yes, no)) = buttons {
        dialog = dialog.buttons(MessageDialogButtons::OkCancelCustom(yes.to_owned(), no.to_owned()));
    }
    dialog.blocking_show()
}

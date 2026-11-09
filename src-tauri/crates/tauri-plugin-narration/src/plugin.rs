//! The Tauri plugin: what the webview may call, and what the app holds for it.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

use crate::commands::{self, NarrationState};

/// The plugin.
///
/// ⚠️ **THE COMMAND INVENTORY IS IN THREE PLACES** — this handler list,
/// `build.rs`'s `COMMANDS`, and `permissions/default.toml`. `commands/tests.rs`'s
/// `lists_agree` fails the build when they disagree; the repetition is the cost
/// of `tauri::generate_handler!` needing literal tokens at expansion time.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("narration")
        .invoke_handler(tauri::generate_handler![
            commands::narration_supported,
            commands::narration_pick,
            commands::narration_begin,
            commands::narration_discard_chapter,
            commands::narration_discard,
            commands::narrate_package,
            commands::narration_exists,
            commands::narration_discard_book,
            commands::narration_release,
        ])
        .setup(|app, _api| {
            /* THE APP'S DATA ROOT ITSELF: the scratch root and the voices
             * plugin's clip store are both resolved under it. */
            let data = app.path().app_data_dir()?;
            app.manage(NarrationState::new(data));
            Ok(())
        })
        .build()
}

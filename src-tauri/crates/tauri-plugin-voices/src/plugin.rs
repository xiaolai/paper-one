//! The Tauri plugin: what the webview may call, and what the app holds for it.

use std::path::PathBuf;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

use crate::commands::{self, VoicesState};


/// The plugin.
///
/// ⚠️ **THE COMMAND INVENTORY IS IN THREE PLACES** — this handler list,
/// `build.rs`'s `COMMANDS`, and `permissions/default.toml`. `commands.rs`'s
/// `lists_agree` fails the build when they disagree, and that repetition is the
/// cost of `tauri::generate_handler!` needing literal tokens at expansion time.
/// `tauri-plugin-peer`'s header records the same conclusion for the same reason.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("voices")
        .invoke_handler(tauri::generate_handler![
            commands::voices_catalogue,
            commands::voices_install,
            commands::voices_stop,
            commands::voices_remove,
            commands::voices_render,
            commands::voices_render_file,
            commands::voices_release,
        ])
        .setup(|app, _api| {
            let state = VoicesState::default();
            // The data root is the app's, resolved once here rather than by
            // each command: a command that resolved its own root could be
            // asked to write somewhere else by whoever called it.
            /* ⚠️ **THE APP'S DATA ROOT, NOT A `voices/` UNDER IT.**
             * `Layout::under` joins its own `voices` segment, so passing one
             * here made the real path `…/one.paper.reader/voices/voices/packs`.
             * Found by looking at the disk after a real install on 2026-09-23;
             * nothing failed, because a doubled directory works perfectly and
             * is merely wrong. */
            let root: PathBuf = app.path().app_data_dir()?;
            state.set_root(root);
            app.manage(state);
            Ok(())
        })
        .build()
}

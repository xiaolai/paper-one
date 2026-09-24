//! The Tauri plugin: what the webview may call, and what the app holds for it.

use std::path::PathBuf;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

use crate::commands::{self, PassagesState};

/// The plugin.
///
/// ⚠️ **THE COMMAND INVENTORY IS IN THREE PLACES** — this handler list,
/// `build.rs`'s `COMMANDS`, and `permissions/default.toml`. `commands.rs`'s
/// `lists_agree` fails the build when they disagree, and that repetition is the
/// cost of `tauri::generate_handler!` needing literal tokens at expansion time.
/// `tauri-plugin-peer`'s header records the same conclusion for the same reason.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("passages")
        .invoke_handler(tauri::generate_handler![
            commands::passages_put,
            commands::passages_note,
            commands::passages_note_partial,
            commands::passages_flush,
            commands::passages_forget,
            commands::passages_rekey,
            commands::passages_pending,
            commands::passages_indexed,
            commands::passages_rebuild,
            commands::passages_retry,
            commands::passages_status,
            commands::passages_search,
        ])
        .setup(|app, _api| {
            let state = PassagesState::default();
            /* ⚠️ **THE APP'S DATA ROOT, NOT A `passages/` UNDER IT.**
             * `Layout::under` joins its own segment, so passing one here would
             * make the real path `…/one.paper.reader/passages/passages/index`.
             * The voices plugin shipped exactly that for a phase: nothing
             * failed, because a doubled directory works perfectly and is merely
             * wrong. */
            let root: PathBuf = app.path().app_data_dir()?;
            state.set_root(root);
            /* ⚠️ **NOTHING IS OPENED HERE.** Opening a tantivy index scans a
             * directory and maps its segments; a reader who never searches
             * should not pay for that at every launch. The first command that
             * needs it opens it — see `PassagesState::with`. */
            app.manage(state);
            Ok(())
        })
        .build()
}

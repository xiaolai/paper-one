/// Base port for the MCP automation bridge.
///
/// Pinned and project-unique on purpose. The plugin defaults to 9223 and, if
/// that is taken, scans the next 100 ports — so any two Tauri projects left on
/// the default stack up next to each other and the MCP host attaches to
/// whichever won the bind, which is usually not the one being worked on.
///
/// Ports already spoken for on this machine: 9223 (the plugin default) and
/// 9323 (vmark). 31415 clears both by far more than the 100-port scan window.
#[cfg(debug_assertions)]
const MCP_BRIDGE_PORT: u16 = 31415;

/// Put the menu-bar icon up and make it toggle the window.
///
/// The asset is named `tray-iconTemplate@2x.png` deliberately: macOS keys the
/// automatic light/dark tint off the `Template` filename suffix. A file named
/// `tray-icon@2x.png` is drawn verbatim in full colour and will not adapt to
/// the menu bar. `icon_as_template(true)` is the matching half of that.
#[cfg(desktop)]
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{
        image::Image,
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        Manager,
    };

    let icon = Image::from_bytes(include_bytes!("../icons/tray-iconTemplate@2x.png"))?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Paper")
        // Left click is the direct action. Enabling a left-click menu as well
        // would fire both, which reads as the window flickering.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let showing =
                        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
                    if showing {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // Scoped by `capabilities/default.json`, not by these registrations —
        // registering a plugin grants nothing on its own.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        /* MUST come after fs and dialog: it restores the saved scope into the
         * fs plugin's state, so the plugin it is restoring into has to exist.
         *
         * What it fixes: a path the reader chose in the dialog is added to the
         * filesystem scope in memory, and the shelf stores that path — so
         * reopening worked until the app quit and failed silently afterwards.
         *
         * PHASE 3 WAS EXPECTED TO DELETE THIS AND DOES NOT. Paper now keeps its
         * own copy of every book under $APPDATA, which is in scope permanently,
         * so reopening no longer depends on any scope being restored — that was
         * the plugin's whole justification and it is gone.
         *
         * One job remains, and it is a migration rather than a feature. A row
         * shelved BEFORE the vault existed has no copy, only a path into the
         * reader's own filesystem. It gets its copy the next time it is opened
         * — there is no startup sweep, because that would turn a cold launch
         * into a disk copy of the whole library — and that open has to succeed
         * for the migration to happen at all. Without this plugin it would fail
         * after the first relaunch, and every book on an existing shelf would be
         * stranded exactly where phase 2 left it.
         *
         * So this comes out when pre-vault rows can no longer exist, not now. */
        .plugin(tauri_plugin_persisted_scope::init())
        .setup(|app| {
        if cfg!(debug_assertions) {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
        }

        #[cfg(desktop)]
        setup_tray(app.handle())?;

        Ok(())
    });

    // Automation bridge for end-to-end testing: drives the webview, reads the
    // DOM and captures window screenshots. Debug builds only — it opens a
    // local socket into the app and has no place in a shipped binary.
    //
    // bind_address is set explicitly because the plugin's own default is
    // 0.0.0.0, which would expose the bridge to the LAN.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .base_port(MCP_BRIDGE_PORT)
                .build(),
        );
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

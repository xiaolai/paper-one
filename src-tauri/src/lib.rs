// The platform set is closed and the switch is a Cargo feature, so a mobile
// build has to say so: `--no-default-features --features ios|android`. Left to
// the default, `desktop` would compile the tray, the automation bridge and the
// persisted scope into a phone build — silently, since all three are inert
// there. This turns that into a build error naming the fix. (`tauri ios build`
// forwards trailing runner args to cargo: `-- --no-default-features`.)
#[cfg(all(mobile, feature = "desktop"))]
compile_error!(
    "the `desktop` feature is on for a mobile target; build with \
     `--no-default-features --features ios` (or `android`)"
);

/// Base port for the MCP automation bridge.
///
/// Pinned and project-unique on purpose. The plugin defaults to 9223 and, if
/// that is taken, scans the next 100 ports — so any two Tauri projects left on
/// the default stack up next to each other and the MCP host attaches to
/// whichever won the bind, which is usually not the one being worked on.
///
/// Ports already spoken for on this machine: 9223 (the plugin default) and
/// 9323 (vmark). 31415 clears both by far more than the 100-port scan window.
#[cfg(all(feature = "desktop", debug_assertions))]
const MCP_BRIDGE_PORT: u16 = 31415;

/// The bridge port for this process: `PAPER_MCP_PORT` if set, else the pin.
///
/// The override exists for the two-instance harness (a shelf and a satchel
/// on one machine, each with its own `PAPER_TEST_DATA_DIR`): the plugin would
/// scan past a taken 31415 on its own, but the MCP host attaches to a port it
/// was told, so the second instance has to be given one on purpose. Debug
/// desktop builds only, like the bridge itself. A value that is not a port
/// number stops the launch with the value named rather than quietly falling
/// back to the pin — a harness that thinks it set a port must not attach to
/// the wrong instance.
#[cfg(all(feature = "desktop", debug_assertions))]
fn mcp_bridge_port() -> u16 {
    match std::env::var("PAPER_MCP_PORT") {
        Ok(value) => value
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("PAPER_MCP_PORT must be a port number, got {value:?}")),
        Err(_) => MCP_BRIDGE_PORT,
    }
}

/// Put the menu-bar icon up and make it toggle the window.
///
/// The asset is named `tray-iconTemplate@2x.png` deliberately: macOS keys the
/// automatic light/dark tint off the `Template` filename suffix. A file named
/// `tray-icon@2x.png` is drawn verbatim in full colour and will not adapt to
/// the menu bar. `icon_as_template(true)` is the matching half of that.
///
/// The size is not set here and cannot be: `tray-icon` scales whatever bitmap
/// it is given to 18pt tall. How large the mark reads is decided in
/// `tray-icon-source.svg`, by how much transparent margin the export carries —
/// see the note in that file before changing either.
///
/// Gated on the `desktop` feature rather than the `desktop` cfg: the feature
/// is what turns `tauri/tray-icon` on, and without it the tray types do not
/// exist to compile against, even on a desktop host.
#[cfg(feature = "desktop")]
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
                    let showing = window.is_visible().unwrap_or(false)
                        && window.is_focused().unwrap_or(false);
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

/// The characters that may appear in a URL unescaped — RFC 3986's unreserved
/// set. Everything else is percent-encoded from its UTF-8 bytes.
///
/// Written out rather than pulled in as a dependency: this is the only URL this
/// application builds, and a crate for twelve lines is a supply chain for
/// twelve lines.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The longest passage worth handing to a dictionary.
///
/// Not a defensive round number: a `dict://` lookup of a paragraph finds
/// nothing, and a reader can select a whole chapter. This is the point past
/// which the feature cannot work, so refusing is more honest than launching
/// Dictionary.app to show it nothing.
const MAX_LOOKUP: usize = 120;

/// Hand a passage to the system dictionary.
///
/// A HANDOFF, not a lookup: what comes back from `DCSCopyTextDefinition` is a
/// doubled headword and whatever dictionaries the reader has enabled, run
/// together with no structure, and a multi-word selection returns nothing at
/// all — see `lookUp.ts` for why that cannot be typeset into the panel the
/// design draws. Dictionary.app is the version of this that is true everywhere.
///
/// NO SHELL IS INVOLVED. The URL is one `arg`, so it reaches `open` through
/// `execve` as a single element and nothing in it is ever parsed as syntax; the
/// scheme is written here rather than accepted from the caller, so this cannot
/// be turned into a general "open any URL" command by passing one.
#[tauri::command]
fn look_up(term: String) -> Result<(), String> {
    let trimmed = term.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_LOOKUP {
        return Err("nothing to look up".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("that passage cannot be looked up".into());
    }

    #[cfg(target_os = "macos")]
    {
        let url = format!("dict://{}", percent_encode(trimmed));
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|cause| format!("could not open the dictionary: {cause}"))?;
        Ok(())
    }

    /* Loud on every other platform rather than silently doing nothing. The
     * reader never reaches this — `hasDictionary` is what decides whether the
     * button is drawn — so arriving here means the two have drifted apart, and
     * that is worth an error in the console rather than a button that appears
     * to work. */
    #[cfg(not(target_os = "macos"))]
    {
        Err("this platform has no system dictionary".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        /* This application's own commands. Unlike a plugin's, they are not
        gated by the capability file — an app command is reachable from the
        webview the moment it is registered here, which is why `look_up`
        validates its own argument rather than trusting the caller. */
        .invoke_handler(tauri::generate_handler![look_up])
        // Scoped by `capabilities/default.json`, not by these registrations —
        // registering a plugin grants nothing on its own.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

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
     * So this comes out when pre-vault rows can no longer exist, not now.
     *
     * Desktop only: a pre-vault row can only exist on a desktop shelf, so a
     * mobile build has nothing for this plugin to do and does not compile it. */
    #[cfg(feature = "desktop")]
    {
        builder = builder.plugin(tauri_plugin_persisted_scope::init());
    }

    builder = builder
        // The peer transport, every platform. Its commands are granted by
        // `peer:default` in capabilities/default.json.
        .plugin(tauri_plugin_peer::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(feature = "desktop")]
            setup_tray(app.handle())?;

            Ok(())
        });

    // Automation bridge for end-to-end testing: drives the webview, reads the
    // DOM and captures window screenshots. Debug desktop builds only — it
    // opens a local socket into the app and has no place in a shipped binary,
    // or on a phone.
    //
    // bind_address is set explicitly because the plugin's own default is
    // 0.0.0.0, which would expose the bridge to the LAN.
    #[cfg(all(feature = "desktop", debug_assertions))]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .base_port(mcp_bridge_port())
                .build(),
        );
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

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
/// The override exists so a second app on ONE machine can be driven without
/// the two fighting over 31415: the plugin would scan past a taken port on its
/// own, but the MCP host attaches to a port it was told, so the second instance
/// has to be given one on purpose. Debug desktop builds only, like the bridge
/// itself. A value that is not a port number stops the launch with the value
/// named rather than quietly falling back to the pin — a harness that thinks it
/// set a port must not attach to the wrong instance.
///
/// NOT, any longer, for the shelf ⇄ satchel harness. That runs two MACHINES
/// (`scripts/second-instance.sh`), because `PAPER_TEST_DATA_DIR` moves the peer
/// plugin's root and not the kernel's — see the header of `data_root.rs`. Two
/// instances here would still share one book vault, whatever ports they hold.
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
///
/// MACOS-ONLY, because its one caller is. `look_up` builds a `dict://` URL
/// inside a `#[cfg(target_os = "macos")]` block — every other platform takes
/// the branch that says it has no system dictionary — so on iOS, Android,
/// Windows and Linux this function compiled with nothing calling it and earned
/// a `dead_code` warning in each. The gate here is not a silencer: it states
/// the same platform scope the caller already has, so the two cannot drift, and
/// a future caller on another platform fails to compile rather than quietly
/// widening what this is for.
#[cfg(target_os = "macos")]
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

/// The only two schemes a book may hand to the platform.
///
/// AN ALLOWLIST, NOT A BLOCKLIST, and the direction is the point: a list of the
/// schemes somebody thought of is wrong the moment a platform adds one.
const OPENABLE: [&str; 2] = ["http://", "https://"];

/// The longest URL worth launching. See `externalLink.ts` for the same number.
const MAX_URL: usize = 2048;

/// Open a web link a book asked for.
///
/// WHY THIS COMMAND EXISTS AT ALL. foliate hands any link whose scheme leaves
/// the package to `globalThis.open(href, '_blank')` unless the embedder cancels
/// the event — and "external" under `epub.js` is `/^(?!blob)\w+:/i`, ANY scheme
/// but `blob:`. So an EPUB, which is a zip a stranger wrote, could put
/// `javascript:` or `data:` in front of the app's own window. Paper now cancels
/// that event and routes the href here instead.
///
/// `look_up` says of itself that the scheme is written in Rust "so this cannot
/// be turned into a general 'open any URL' command by passing one". This IS the
/// general one, which is exactly why it validates rather than trusting: the TS
/// side already refused everything but http and https, and a check that only
/// exists on the caller's side is not a boundary.
///
/// NO SHELL IS INVOLVED — the URL is one `arg`, so it reaches `open` through
/// `execve` as a single element and nothing in it is ever parsed as syntax.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_URL {
        return Err("that link cannot be opened".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("that link is malformed".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !OPENABLE.iter().any(|scheme| lower.starts_with(scheme)) {
        return Err("Paper only opens web links".into());
    }

    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(target_os = "linux")]
        let mut command = std::process::Command::new("xdg-open");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "start", ""]);
            c
        };
        command
            .arg(trimmed)
            .spawn()
            .map_err(|cause| format!("could not open that link: {cause}"))?;
        Ok(())
    }

    /* Loud rather than silently doing nothing, exactly as `look_up` is. The
     * reader never reaches this — `canOpenExternal` decides whether the route
     * exists at all — so arriving here means the two have drifted. */
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("this platform has no browser to open a link in".into())
    }
}

/// Make tao apply the traffic-light position it is already holding.
///
/// THERE ARE TWO IMPLEMENTATIONS OF `trafficLightPosition` AND THEY DO NOT
/// AGREE. The config value in `tauri.conf.json` goes to tao's `WindowBuilder`,
/// where `set_traffic_light_inset` **only stores it** (tao-0.35.0
/// `platform_impl/macos/window.rs`); it is applied from `drawRect:` in
/// `view.rs`, and nowhere else. The other path — `WebviewWindowBuilder`, which
/// goes to wry's `WryWebViewParent` — applies immediately and again on every
/// draw. Nothing in Tauri maps the config value onto the webview attributes,
/// so the two never meet: the main window takes the first path, and any window
/// built in Rust takes the second.
///
/// A WKWebView covers the tao view, so its `drawRect:` does not run at first
/// paint. The buttons stay where AppKit put them until something marks the view
/// dirty — which a resize does, and which is why the misplacement appears to
/// heal itself the moment the reader touches the window edge.
///
/// So this marks the content view dirty once, and tao applies its own stored
/// value one display cycle later.
///
/// DELIBERATELY NOT A SECOND COPY OF THE GEOMETRY. Setting the position here
/// as well would put the buttons in one place on the first frame and in tao's
/// place on every redraw after it, and the two disagreeing would show only as
/// a flicker — the hardest kind of wrong to attribute. One owner of the maths,
/// which is tao; this only asks it to run.
///
/// `docs/traffic-lights.md` owns the measured mapping. Do not restate it here.
#[cfg(target_os = "macos")]
fn nudge_traffic_lights(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindow;

    let Ok(handle) = window.ns_window() else {
        /* No window handle is not a thing to fail a launch over: the reader
         * gets buttons in AppKit's default place, which is where they were
         * before this existed. */
        log::warn!(
            "traffic lights: no ns_window handle; leaving the buttons where AppKit put them"
        );
        return;
    };
    // SAFETY: `ns_window()` returns the `NSWindow` this webview lives in, and
    // it outlives this call — we neither retain it nor keep the reference.
    unsafe {
        let ns_window = &*(handle as *const NSWindow);
        match ns_window.contentView() {
            Some(view) => view.setNeedsDisplay(true),
            None => log::warn!("traffic lights: the window has no content view yet"),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        /* This application's own commands. Unlike a plugin's, they are not
        gated by the capability file — an app command is reachable from the
        webview the moment it is registered here, which is why `look_up`
        validates its own argument rather than trusting the caller. */
        .invoke_handler(tauri::generate_handler![look_up, open_external])
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

            /* The traffic lights, which tao will not place until something
             * asks its view to draw — see `nudge_traffic_lights`. */
            #[cfg(target_os = "macos")]
            if let Some(main) = tauri::Manager::get_webview_window(app, "main") {
                nudge_traffic_lights(&main);
            }

            #[cfg(all(feature = "desktop", target_os = "macos"))]
            shutdown::install_quit_item(app.handle())?;

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

    // THE WEBVIEW IS GIVEN TIME TO CLOSE THE JOURNAL BEFORE THE PROCESS DIES.
    //
    // Teardown lives in TypeScript (`main.tsx`), hangs off `pagehide`, and
    // ends in an async `journal.close()` that drains a write queue, writes the
    // journal meta and removes `journal.dirty`. Quitting destroys the webview,
    // and nothing held the process open for that tail — so the close never
    // finished and the flag was never cleared. MEASURED on a real library: it
    // survived every ordinary `quit app "Paper"`, which made every subsequent
    // launch treat the last one as a crash and re-verify all 1 960 books, and
    // made `paper` refuse to journal on a machine the app had ever run.
    //
    // So the first exit request is DEFERRED: tell the webview, wait for it to
    // say it is done, then exit for real.
    //
    // BOUNDED, and exits anyway on timeout. A teardown that hangs must not
    // make the app unquittable — the failure this repair is allowed to cause
    // is "the flag stayed up", exactly today's behaviour, and never "the
    // reader cannot close their book app".
    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // ONLY the quit path is logged. A `match` over every RunEvent
            // was what established which event a macOS quit produces — the
            // answer was "none that can be deferred, unless the Quit item is
            // ours" — but `MainEventsCleared` arrives on every loop tick, so
            // leaving it in would write a log line several times a second.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                log::info!(
                    "shutdown: exit requested (code {code:?}, started {})",
                    shutdown::started()
                );
                // NOT gated on `code.is_none()`. That was the first version and
                // it never fired: macOS quits — ⌘Q, the app menu, an AppleScript
                // `quit` — arrive with a code, so the one branch that mattered
                // was the one being skipped, and the app exited in under three
                // seconds having deferred nothing.
                //
                // `started()` alone is what prevents recursion: the first
                // request defers and sets it, and the `app.exit(0)` below comes
                // back through here and passes straight out.
                if !shutdown::started() {
                    shutdown::begin();
                    api.prevent_exit();
                    let app = app.clone();
                    // A plain OS thread, not the async runtime: the whole wait
                    // is one blocking `recv_timeout`, and this adds no
                    // dependency the app crate did not already have.
                    std::thread::spawn(move || {
                        shutdown::run(&app);
                        app.exit(0);
                    });
                }
            }
        });
}

/// The quit handshake with the webview.
mod shutdown {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Listener, Runtime};

    /// How long the webview gets. A journal close is a queue drain and three
    /// small writes; this is generous by an order of magnitude, and the app
    /// quits regardless when it lapses.
    const GRACE: Duration = Duration::from_secs(5);

    /// The event the webview listens for, and the one it answers with.
    pub const ASK: &str = "paper://shutdown";
    pub const DONE: &str = "paper://shutdown-done";

    /// Our own Quit item's id.
    pub const QUIT_ID: &str = "paper-quit";

    static STARTED: AtomicBool = AtomicBool::new(false);

    /// Replace macOS's predefined Quit with one that goes through
    /// `AppHandle::exit`.
    ///
    /// THE PREDEFINED ITEM CANNOT BE INTERCEPTED. It calls AppKit's terminate
    /// straight through, and the only thing the run loop then reports is
    /// `RunEvent::Exit` — measured, by logging every event and quitting from
    /// the menu. `Exit` cannot be deferred, so there is no moment at which the
    /// webview could be asked to close the journal, and the dirty flag
    /// survived every quit. Upstream tracks this as tauri#9198 and #7586.
    ///
    /// `AppHandle::exit` DOES emit `ExitRequested`, which is deferrable. So
    /// the menu keeps its shape, its position and its ⌘Q, and only the thing
    /// it calls changes.
    #[cfg(target_os = "macos")]
    pub fn install_quit_item<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
        use tauri::menu::{Menu, MenuItem, MenuItemKind};

        let menu = Menu::default(app)?;
        let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
            log::warn!("shutdown: no application submenu; leaving the default Quit in place");
            return Ok(());
        };
        // Removed by KIND rather than by id: the predefined item's id is
        // Tauri's to choose and not ours to hard-code.
        for item in app_menu.items()? {
            if let MenuItemKind::Predefined(predefined) = &item {
                if predefined.text().unwrap_or_default().starts_with("Quit") {
                    app_menu.remove(&item)?;
                }
            }
        }
        let quit = MenuItem::with_id(app, QUIT_ID, "Quit Paper", true, Some("CmdOrCtrl+Q"))?;
        app_menu.append(&quit)?;
        app.set_menu(menu)?;
        app.on_menu_event(|app, event| {
            if event.id() == QUIT_ID {
                // Straight to `exit`, which the run loop reports as
                // `ExitRequested` and the handler there defers.
                app.exit(0);
            }
        });
        Ok(())
    }

    pub fn started() -> bool {
        STARTED.load(Ordering::SeqCst)
    }

    pub fn begin() {
        STARTED.store(true, Ordering::SeqCst);
    }

    pub fn run<R: Runtime>(app: &AppHandle<R>) {
        let (tx, rx) = mpsc::channel::<()>();
        // LISTENED FOR BEFORE THE ASK, or a webview that answers immediately
        // answers into nothing and the quit waits out the whole grace period.
        let id = app.listen(DONE, move |_| {
            let _ = tx.send(());
        });
        if app.emit(ASK, ()).is_err() {
            // No webview to ask — nothing to wait for.
            app.unlisten(id);
            return;
        }
        match rx.recv_timeout(GRACE) {
            Ok(()) => log::info!("shutdown: the webview finished its teardown"),
            Err(mpsc::RecvTimeoutError::Timeout) => log::warn!(
                "shutdown: the webview did not finish within {}s; quitting anyway, so the sync journal may be left dirty",
                GRACE.as_secs()
            ),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                log::warn!("shutdown: the teardown channel closed without an answer")
            }
        }
        app.unlisten(id);
    }
}

#[cfg(test)]
mod open_external_tests {
    use super::open_external;

    #[test]
    fn refuses_every_scheme_but_http_and_https() {
        for url in [
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "file:///etc/passwd",
            "mailto:someone@example.org",
            "itms-apps://open",
            "",
            "   ",
        ] {
            assert!(open_external(url.into()).is_err(), "should refuse {url}");
        }
    }

    #[test]
    fn refuses_control_characters_and_overlong_urls() {
        assert!(open_external("https://example.org/\nx".into()).is_err());
        assert!(open_external(format!("https://example.org/{}", "a".repeat(4096))).is_err());
    }

    /* THE BOUNDARY IS HERE TOO, not only in TypeScript. `externalLink.ts`
     * refuses the same set, and a check that only exists on the caller's side
     * is not a boundary — the webview is where the untrusted string comes
     * from. This asserts the refusals rather than the launch, because
     * launching a browser in a unit test is not something a test should do. */
    #[test]
    fn the_scheme_check_is_case_insensitive() {
        assert!(open_external("JavaScript:alert(1)".into()).is_err());
    }
}

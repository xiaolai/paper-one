//! The window-state file, sanitised before `tauri-plugin-window-state` reads it.
//!
//! WINDOWS PARKS A MINIMISED WINDOW AT `(-32000, -32000)` with a size of
//! `0×0`. The plugin refuses to persist those values itself, but a state file
//! written by an older build, or by a regression, can still hold them — and
//! WebView2 then rejects the restored bounds with `0x80070057` ("the
//! parameter is incorrect") and the app cannot launch at all. Readest hit
//! exactly this (readest/readest#4398) and its answer is the shape here: a
//! plugin registered immediately BEFORE the window-state plugin, which strips
//! any entry with impossible geometry from the file so that window falls
//! back to its configured size and place instead of failing to open.
//!
//! The cutoff is generous on purpose. A monitor to the left of the primary
//! gives a legitimately negative position — `-1920`, or `-11520` for three
//! stacked 4K displays — and those are kept; only a coordinate at or below
//! `-16000`, roughly halfway to the sentinel and past any real desktop, is
//! read as the minimise marker. And the COORDINATE rule runs on Windows
//! only: the sentinel is a Windows behaviour, the state file never travels
//! between machines, and a fourth stacked display on a Mac would put a
//! legitimate coordinate past any fixed cutoff. The size rule is universal —
//! a zero-sized window is impossible everywhere.
//!
//! `prev_x`/`prev_y` are validated by the same rule as `x`/`y`: they are
//! where a MAXIMISED window returns to, so a sentinel there fails the
//! restore in exactly the way this file exists to prevent — it was the one
//! field pair the first draft forgot.

use std::path::Path;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

/// At or below this, a coordinate is the sentinel and not a place.
const MIN_VALID_COORD: i64 = -16000;

/// No real display exceeds this on a side; a size past it is corruption
/// (`u32::MAX` from a damaged file), and native restore can refuse it just
/// as it refuses zero.
const MAX_VALID_SIZE: i64 = 32_767;

/// Whether the sentinel-coordinate rule applies — see the header.
const STRIP_SENTINEL_COORDS: bool = cfg!(target_os = "windows");

/// The file with every impossible entry removed, or `None` when nothing
/// needs to change — already valid, empty, or not something we can parse,
/// which is the plugin's problem and not ours to guess at.
pub fn sanitize_json(content: &str) -> Option<String> {
    let mut windows: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(content).ok()?;
    let before = windows.len();
    windows.retain(|_, state| has_valid_geometry(state));
    if windows.len() == before {
        return None;
    }
    serde_json::to_string_pretty(&windows).ok()
}

/// A positive, bounded size and an on-screen position — for the live fields
/// AND the `prev_*` pair a maximised window returns to. A MISSING field is
/// valid, so a schema change in the plugin never drops an otherwise good
/// entry; a PRESENT field of the wrong TYPE is invalid, because the plugin
/// deserialises the whole file strictly and one mistyped entry would
/// otherwise take every window's saved state down with it.
fn has_valid_geometry(state: &serde_json::Value) -> bool {
    // None = absent (fine, default applies); Some(None) = present but not an
    // integer (the entry is damaged); Some(Some(n)) = the value.
    let int = |key: &str| state.get(key).map(serde_json::Value::as_i64);
    let size_ok = |key: &str, default: i64| match int(key) {
        None => default > 0,
        Some(Some(n)) => n > 0 && n <= MAX_VALID_SIZE,
        Some(None) => false,
    };
    let coord_ok = |key: &str| match int(key) {
        None => true,
        Some(Some(n)) => !STRIP_SENTINEL_COORDS || n > MIN_VALID_COORD,
        Some(None) => false,
    };
    size_ok("width", 1)
        && size_ok("height", 1)
        && coord_ok("x")
        && coord_ok("y")
        && coord_ok("prev_x")
        && coord_ok("prev_y")
}

fn sanitize_file(path: &Path) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let Some(sanitized) = sanitize_json(&content) else {
        return;
    };
    log::warn!(
        "window-state: removing impossible geometry from {}",
        path.display()
    );
    /* The write is temp-and-rename, not in place: this file holds EVERY
     * window's saved state, and a partial in-place write would corrupt the
     * entries the sanitiser was keeping. And a failure is LOGGED — the
     * warning above says the geometry is being removed, so a removal that
     * silently did not happen must not hide behind it. */
    let outcome = if sanitized.trim() == "{}" {
        std::fs::remove_file(path)
    } else {
        let tmp = path.with_extension("json.sanitizing");
        std::fs::write(&tmp, sanitized).and_then(|()| std::fs::rename(&tmp, path))
    };
    if let Err(error) = outcome {
        log::warn!(
            "window-state: could not rewrite {}: {error} — the plugin may refuse the file",
            path.display()
        );
    }
}

/// Register this immediately before `tauri_plugin_window_state`, so the file
/// is clean before that plugin's setup reads it.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("window-state-sanitizer")
        .setup(|app, _api| {
            if let Ok(dir) = app.path().app_config_dir() {
                sanitize_file(&dir.join(tauri_plugin_window_state::DEFAULT_FILENAME));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{sanitize_json, STRIP_SENTINEL_COORDS};

    const VALID: &str = r#"{"main":{"width":1440,"height":900,"x":100,"y":100,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#;

    /// Parsed, not substring-matched: `contains("\"main\"")` would also match
    /// a nested key or a string value.
    fn keys(json: &str) -> Vec<String> {
        let map: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(json).expect("sanitized output parses");
        map.keys().cloned().collect()
    }

    #[test]
    fn a_valid_state_is_left_alone() {
        assert!(sanitize_json(VALID).is_none());
    }

    #[test]
    fn a_monitor_left_of_the_primary_is_a_place_not_a_sentinel() {
        assert!(sanitize_json(r#"{"main":{"width":1280,"height":800,"x":-1920,"y":0}}"#).is_none());
        assert!(
            sanitize_json(r#"{"main":{"width":1280,"height":800,"x":-11520,"y":0}}"#).is_none()
        );
    }

    #[test]
    fn the_coordinate_sentinel_is_windows_s_and_stripped_there_only() {
        let parked = r#"{"main":{"width":1280,"height":800,"x":-32000,"y":-32000}}"#;
        let out = sanitize_json(parked);
        if STRIP_SENTINEL_COORDS {
            assert_eq!(
                keys(&out.expect("the parked entry is removed")),
                Vec::<String>::new()
            );
        } else {
            assert!(out.is_none(), "a coordinate is not a sentinel off Windows");
        }
    }

    #[test]
    fn a_parked_prev_position_is_judged_like_the_live_one() {
        let parked =
            r#"{"main":{"width":1280,"height":800,"x":10,"y":10,"prev_x":-32000,"prev_y":-32000}}"#;
        let out = sanitize_json(parked);
        if STRIP_SENTINEL_COORDS {
            assert!(out.is_some(), "a maximised window returns to prev_x/prev_y");
        } else {
            assert!(out.is_none());
        }
    }

    #[test]
    fn the_minimised_sentinel_is_dropped_and_the_other_window_kept() {
        let json = r#"{"main":{"width":0,"height":0,"x":-32000,"y":-32000},"other":{"width":800,"height":600,"x":10,"y":10}}"#;
        let out = sanitize_json(json).expect("the sentinel entry is removed");
        assert_eq!(keys(&out), vec!["other".to_string()]);
    }

    #[test]
    fn a_zero_size_alone_is_enough_to_drop_an_entry() {
        let out =
            sanitize_json(r#"{"main":{"width":0,"height":900,"x":10,"y":10}}"#).expect("dropped");
        assert_eq!(keys(&out), Vec::<String>::new());
    }

    #[test]
    fn a_size_past_any_real_display_is_corruption_not_a_window() {
        let out = sanitize_json(r#"{"main":{"width":4294967295,"height":900,"x":10,"y":10}}"#)
            .expect("dropped");
        assert_eq!(keys(&out), Vec::<String>::new());
    }

    #[test]
    fn a_field_of_the_wrong_type_drops_the_entry_rather_than_the_whole_file() {
        let json = r#"{"main":{"width":"wide","height":900,"x":10,"y":10},"other":{"width":800,"height":600,"x":10,"y":10}}"#;
        let out = sanitize_json(json).expect("the mistyped entry is removed");
        assert_eq!(keys(&out), vec!["other".to_string()]);
    }

    #[test]
    fn a_missing_field_is_not_an_impossible_one() {
        assert!(sanitize_json(r#"{"main":{"maximized":true}}"#).is_none());
    }

    #[test]
    fn what_cannot_be_parsed_is_not_ours_to_rewrite() {
        assert!(sanitize_json("not json").is_none());
        assert!(sanitize_json("").is_none());
    }
}

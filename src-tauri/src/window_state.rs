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
//! read as the minimise marker.

use std::path::Path;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

/// The plugin's own default; it takes no other name from us.
const STATE_FILENAME: &str = ".window-state.json";

/// At or below this, a coordinate is the sentinel and not a place.
const MIN_VALID_COORD: i64 = -16000;

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

/// A positive size and an on-screen position. A MISSING field is valid, so a
/// schema change in the plugin never drops an otherwise good entry.
fn has_valid_geometry(state: &serde_json::Value) -> bool {
    let int = |key: &str, default: i64| {
        state
            .get(key)
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(default)
    };
    int("width", 1) > 0
        && int("height", 1) > 0
        && int("x", 0) > MIN_VALID_COORD
        && int("y", 0) > MIN_VALID_COORD
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
    if sanitized.trim() == "{}" {
        let _ = std::fs::remove_file(path);
    } else {
        let _ = std::fs::write(path, sanitized);
    }
}

/// Register this immediately before `tauri_plugin_window_state`, so the file
/// is clean before that plugin's setup reads it.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("window-state-sanitizer")
        .setup(|app, _api| {
            if let Ok(dir) = app.path().app_config_dir() {
                sanitize_file(&dir.join(STATE_FILENAME));
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::sanitize_json;

    const VALID: &str = r#"{"main":{"width":1440,"height":900,"x":100,"y":100,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#;

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
    fn the_minimised_sentinel_is_dropped_and_the_other_window_kept() {
        let json = r#"{"main":{"width":0,"height":0,"x":-32000,"y":-32000},"other":{"width":800,"height":600,"x":10,"y":10}}"#;
        let out = sanitize_json(json).expect("the sentinel entry is removed");
        assert!(!out.contains("\"main\""));
        assert!(out.contains("\"other\""));
    }

    #[test]
    fn a_zero_size_alone_is_enough_to_drop_an_entry() {
        let out =
            sanitize_json(r#"{"main":{"width":0,"height":900,"x":10,"y":10}}"#).expect("dropped");
        assert_eq!(out.trim(), "{}");
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

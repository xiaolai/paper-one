//! What holds the command inventory's three copies together.

/// The three lists name the same commands.
///
/// ⚠️ **THIS TEST IS THE MECHANISM, AND THE REPETITION IS THE COST OF THE
/// MACRO.** `tauri::generate_handler!` needs its paths as literal tokens at
/// expansion time, and `build.rs` runs before the crate compiles, so neither
/// list can be derived from the other without a third artifact that would
/// itself become a fourth place to keep in step. `tauri-plugin-peer` reached
/// the same conclusion, having tried.
///
/// ⚠️ **AND A COMMAND MISSING FROM `build.rs` IS STILL REACHABLE** — omission
/// there only stops its permission pair being generated, and a hand-written
/// `allow-` file grants it like any other. That is why this reads all three
/// rather than trusting the generator.
#[test]
fn lists_agree() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let plugin = std::fs::read_to_string(root.join("src/plugin.rs")).expect("plugin.rs");
    let build = std::fs::read_to_string(root.join("build.rs")).expect("build.rs");
    let permissions =
        std::fs::read_to_string(root.join("permissions/default.toml")).expect("default.toml");
    let source = std::fs::read_to_string(root.join("src/commands.rs")).expect("commands.rs");

    // Every `#[tauri::command]` in this file, by the name it is declared with.
    //
    // ⚠️ **A LINE THAT IS THE ATTRIBUTE, NOT A LINE THAT CONTAINS IT.** The
    // first version split the file on the attribute's text and found SEVEN
    // where there are six: a doc comment a few lines up explains what a
    // `#[tauri::command] async fn` costs, and to a `split` that is an
    // attribute. It then took the next `pub fn` — `VoicesState::set_root` —
    // and failed asking why a setter was not registered as a command. This
    // repository has met the same shape twice before: `check-browser-safe`
    // counted `@tauri-apps` inside doc comments, and prose beginning with the
    // words of a `Stryker disable` looks like a directive to a grep and is
    // nothing to the tool. Read the attribute as a LINE OF ITS OWN, which is
    // where a real one on a top-level item always sits.
    let mut declared: Vec<String> = Vec::new();
    let mut lines = source.lines();
    while let Some(line) = lines.next() {
        if line.trim() != "#[tauri::command]" {
            continue;
        }
        // The signature may be on the next line or a few below it, past
        // further attributes, but never past another command.
        for next in lines.by_ref() {
            let trimmed = next.trim_start();
            let Some(rest) = trimmed
                .strip_prefix("pub async fn ")
                .or_else(|| trimmed.strip_prefix("pub fn "))
            else {
                continue;
            };
            let end = rest
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(rest.len());
            declared.push(rest[..end].to_owned());
            break;
        }
    }
    assert!(
        !declared.is_empty(),
        "no commands found — the parse is wrong, not the code"
    );
    assert!(
        !declared.iter().any(|name| !name.starts_with("voices_")),
        "a name that is not a command slipped into the parse: {declared:?}"
    );

    for name in &declared {
        assert!(
            plugin.contains(&format!("commands::{name}")),
            "{name} is declared but not registered in plugin.rs"
        );
        assert!(
            build.contains(&format!("\"{name}\"")),
            "{name} is declared but not in build.rs's COMMANDS, so it has no permission pair"
        );
        // `voices_catalogue` becomes `allow-voices-catalogue`.
        let granted = format!("allow-{}", name.replace('_', "-"));
        assert!(
            permissions.contains(&granted),
            "{name} is declared but {granted} is not in permissions/default.toml, \
             so the webview cannot call it"
        );
    }

    // And nothing is granted that is not declared, which is the direction that
    // leaves a command reachable after it has been deleted.
    for line in permissions.lines() {
        let line = line.trim().trim_matches(|c| c == '"' || c == ',');
        if let Some(rest) = line.strip_prefix("allow-") {
            let name = rest.replace('-', "_");
            assert!(
                declared.contains(&name),
                "{line} is granted but no such command is declared"
            );
        }
    }
}

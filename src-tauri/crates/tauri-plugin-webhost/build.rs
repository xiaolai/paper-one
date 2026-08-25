/// Every command the plugin exposes, by its Rust name.
///
/// THIS LIST IS ONE OF FOUR THAT MUST AGREE, and `tauri-plugin-peer`'s
/// `commands.rs` opens with what it costs when they do not: "Adding a command
/// means four edits: here, `generate_handler!` in `lib.rs`, `COMMANDS` in
/// `build.rs`, and `permissions/default.toml`. Miss the handler or the build
/// list and the command is unreachable; miss the ACL and it is refused."
///
/// Unlike that crate, this one has a TEST that reads all four and fails when
/// they disagree — `lists_agree` in `commands.rs`. Adding a command still means
/// four edits; forgetting one is now a red test rather than a silent hole.
const COMMANDS: &[&str] = &[
    "webhost_status",
    "webhost_begin_code",
    "webhost_cancel_code",
    "webhost_sessions",
    "webhost_revoke",
    "webhost_ready",
    "webhost_send",
    "webhost_session_recv",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
    embed_client();
}

/// The browser client's bundle, as a table in `OUT_DIR`.
///
/// Walks `dist-web/` — what `pnpm build:web` writes — and emits one `Asset` per
/// file, its bytes reached by `include_bytes!` so the generated source stays
/// small. An absent directory is NOT an error: `cargo build` must work in a
/// tree where the JavaScript build has never run, or a fresh clone cannot
/// compile the Rust. The table is then empty and the server says so at runtime.
fn embed_client() {
    use std::fmt::Write as _;

    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // crates/tauri-plugin-webhost → src-tauri → the repository root.
    let dist = manifest.join("../../../dist-web");
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut entries = Vec::new();
    collect(&dist, &dist, &mut entries);
    /* SORTED, so the generated file is identical for identical input. An
     * unsorted directory walk changes with the filesystem and would rebuild
     * this crate for no reason. */
    entries.sort();

    let mut out = String::from("pub static CLIENT: &[Asset] = &[\n");
    for (request_path, absolute) in &entries {
        writeln!(
            out,
            "    Asset {{ path: {request_path:?}, content_type: paper_webhost::assets::content_type_for({request_path:?}), bytes: include_bytes!({absolute:?}) }},",
        )
        .unwrap();
    }
    out.push_str("];\n");

    let target =
        std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("client_assets.rs");
    std::fs::write(&target, out).expect("write the client asset table");
}

fn collect(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, out);
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        /* The REQUEST path, always with a forward slash — a Windows build
         * would otherwise emit keys no browser can ever send. */
        let request = format!("/{}", relative.to_string_lossy().replace('\\', "/"));
        out.push((request, path.to_string_lossy().into_owned()));
    }
}

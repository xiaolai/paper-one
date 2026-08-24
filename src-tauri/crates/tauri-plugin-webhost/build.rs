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
}

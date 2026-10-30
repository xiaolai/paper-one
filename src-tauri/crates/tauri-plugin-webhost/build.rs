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
    "webhost_address",
    "webhost_begin_code",
    "webhost_cancel_code",
    "webhost_sessions",
    "webhost_browsers",
    "webhost_revoke",
    "webhost_revoke_all",
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
/// small. An absent directory is NOT an error in a DEBUG build: `cargo build`
/// must work in a tree where the JavaScript build has never run, or a fresh
/// clone cannot compile the Rust. The table is then empty and the server says
/// so at runtime.
///
/// ⚠️ **A RELEASE BUILD REFUSES AN EMPTY CLIENT**, and the permissiveness above
/// is why it has to. `dist-web/` is gitignored, the release workflow ran
/// `pnpm build` (which is the DESKTOP bundle) and never `pnpm build:web`, and
/// this function's tolerance turned that into a successful compile. The result
/// was a shipped shelf whose every browser request answered 503 — no failing
/// build, no failing test, no warning. Two correct behaviours, and the gap
/// between them belonged to neither.
///
/// `pnpm verify` now runs `build:web`, which closes the local and CI path. This
/// closes the one that does not go through `verify` at all.
fn embed_client() {
    use std::fmt::Write as _;

    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // crates/tauri-plugin-webhost → src-tauri → the repository root.
    let dist = manifest.join("../../../dist-web");
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut entries = Vec::new();
    let present = collect(&dist, &dist, &mut entries);

    /* THE ENTRY DOCUMENT IS THE ONE FILE THAT MAKES THE BUNDLE A CLIENT. Every
     * unknown path falls back to it (`assets::ENTRY`), so a table without it
     * serves nothing at all however many hashed chunks it holds. */
    let has_entry = entries
        .iter()
        .any(|(request, _)| request == "/index.web.html");
    /* EVERY PROFILE THAT IS NOT `debug`, not `== "release"`: a custom
     * distribution profile (`[profile.dist]`, say) inherits from release,
     * reports its own name, and would have shipped an empty client past a
     * guard that only knew one spelling. Dev builds are the one case the
     * absent client is legitimate, and they are the one profile named. */
    let release = std::env::var("PROFILE").as_deref() != Ok("debug");
    if release && !has_entry {
        panic!(
            "dist-web/ has no index.web.html, so this release would ship a browser client that \
             answers 503 to every request.\n\
             \n\
             Run `pnpm build:web` before building the app for release. `pnpm build` is the \
             DESKTOP bundle and does not write dist-web/, which is also gitignored — so nothing \
             else in the tree can notice it is missing.\n\
             \n\
             (dist-web present: {present}, files found: {})",
            entries.len(),
        );
    }
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

/// Walk `dir`, appending every file. Returns whether `dir` existed.
///
/// ⚠️ **ONLY "NOT FOUND" IS TOLERATED**, and it used to be every error. This
/// was `let Ok(read) = read_dir(dir) else { return }` over `read.flatten()`, so
/// a permission error on a subdirectory, a broken symlink, or an interrupted
/// walk all read exactly like "the JavaScript build has not run" — the one case
/// that is genuinely fine. The bundle came out silently partial: an entry
/// document with half its chunks, which the browser reports as a blank page and
/// the build reports as success.
///
/// Distinguishing them costs one `match` and is the difference between "no
/// client was asked for" and "the client is broken and nobody said so".
///
/// ⚠️ **NOTHING IS FOLLOWED AND NOTHING IRREGULAR IS EMBEDDED**, which is what
/// keeps the walk inside `dist-web/` and what keeps it terminating. See the
/// note at the type check below.
fn collect(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) -> bool {
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        /* THE TOLERATED CASE, AND ONLY AT THE ROOT. "`dist-web/` is absent" is
         * a fresh clone and is fine; "a subdirectory of `dist-web/` is absent"
         * is a tree that changed under the walk or a broken link, and quietly
         * skipping it emits a bundle missing whatever was in it — the partial
         * client this function's note is about, arrived at one level down. */
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && dir == root => return false,
        Err(error) => panic!(
            "cannot read {} for the browser client: {error}",
            dir.display()
        ),
    };
    for entry in read {
        let entry = entry.unwrap_or_else(|error| {
            panic!(
                "cannot walk {} for the browser client: {error}",
                dir.display()
            )
        });
        let path = entry.path();
        /* ⚠️ `symlink_metadata`, NOT `path.is_dir()` — and this used to be
         * `is_dir()`, which FOLLOWS the link.
         *
         * A symlinked directory anywhere under `dist-web/` was therefore
         * walked as though it were part of the tree. Whatever it pointed at
         * came out embedded in the binary under request paths that claim to
         * be inside the bundle, and a link at an ancestor — `..`, or `/` —
         * took the walk out of `dist-web/` altogether while every
         * `strip_prefix` below still succeeded, because the paths were built
         * by descending from the root rather than resolved against it. A
         * link back INTO the tree was worse: there is no visited set here, so
         * it recursed until the build ran out of stack.
         *
         * Refusing links outright answers both without a canonicalisation or
         * a visited set: nothing is followed, so nothing can leave the tree
         * and nothing can cycle. It is the same rule `tauri-plugin-inference`
         * holds over the staged runtime, for the same reason — the build that
         * writes this directory (Vite) emits regular files, so anything else
         * in it is a tree somebody else arranged. */
        let kind = std::fs::symlink_metadata(&path)
            .unwrap_or_else(|error| {
                panic!(
                    "cannot read the type of {} for the browser client: {error}",
                    path.display()
                )
            })
            .file_type();
        if kind.is_dir() {
            /* The return is discarded ON PURPOSE here and only here: a
             * subdirectory that vanished mid-walk now panics above rather than
             * reporting `false`, so the only value this can return is `true`. */
            let _ = collect(root, &path, out);
            continue;
        }
        if !kind.is_file() {
            /* Loud, not skipped: a client silently missing a chunk is the
             * exact failure this function's note above is about, arrived at
             * from a different direction. */
            panic!(
                "{} is {} and not a regular file, so the browser client bundle will not embed \
                 it.\n\
                 \n\
                 dist-web/ holds what `pnpm build:web` wrote and nothing else. Delete it and \
                 rebuild.",
                path.display(),
                if kind.is_symlink() {
                    "a symbolic link"
                } else {
                    "a special file"
                },
            );
        }
        /* `expect`, not a silent `continue`: every path here was produced by
         * walking `root`, so a prefix miss is an invariant violation — and a
         * recovery branch for one hides the day a traversal change breaks it. */
        let relative = path
            .strip_prefix(root)
            .expect("walked path must remain under dist-web");
        /* The REQUEST path, always with a forward slash — a Windows build
         * would otherwise emit keys no browser can ever send. And `to_str`,
         * not `to_string_lossy`: a lossy name would generate an
         * `include_bytes!` path that names a DIFFERENT file, or none. Vite
         * writes UTF-8 names; anything else in the tree is a build to stop. */
        let utf8 = |p: &std::path::Path| -> String {
            p.to_str()
                .unwrap_or_else(|| {
                    panic!(
                        "{} is not valid UTF-8; the browser client cannot serve it",
                        p.display()
                    )
                })
                .to_owned()
        };
        let request = format!("/{}", utf8(relative).replace('\\', "/"));
        out.push((request, utf8(&path)));
    }
    true
}

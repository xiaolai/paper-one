//! Books a launch carried — from the Finder, from a shell, or from a second
//! launch that this process absorbed.
//!
//! THREE ROUTES, ONE PATH THROUGH THEM. macOS hands an app the files it was
//! opened with as `RunEvent::Opened { urls }`, whether at launch or while it
//! is already running; Windows and Linux put them in `argv`, and a second
//! launch there is a second PROCESS — which the single-instance plugin turns
//! into a callback on the first with the newcomer's `argv`. All three arrive
//! here as a list of paths and go the same way: into the fs scope, then to
//! the webview as one event, through the same intake a picked or dropped book
//! takes.
//!
//! QUEUED UNTIL THE WEBVIEW CAN TAKE THEM. A file opened AT launch is known to
//! Rust before the webview exists, let alone before it has registered a
//! listener; an event emitted then is emitted into nothing, and the book the
//! reader double-clicked never opens — silently, which is the failure this
//! whole module is shaped around. So the webview says when it is listening
//! (`READY`), and anything that arrived before that is held and handed over
//! on that signal. Anything after is sent at once.
//!
//! INTO THE FS SCOPE FIRST. The webview reads a book off disk through the fs
//! plugin, whose scope is the app's own data directory; a path the Finder
//! chose is outside it, and `readFile` would refuse. The dialog plugin solves
//! this for a picked file by allowing that one path at runtime, and this does
//! exactly that — one file, not its directory.
//!
//! ONLY BOOKS. `argv` also carries flags, and on Linux an `xdg-open` may hand
//! over a `file://` URL rather than a path; a launch that carried something
//! else — a `.txt`, a directory — is not an import. The extension list is the
//! one `formats.ts` accepts, and a test holds the two together.
//!
//! ⚠️ ONE WINDOW REMAINS OPEN UPSTREAM, and it is tao's, not this queue's.
//! tao 0.35.3 `app_state.rs` `handle_nonuser_event` DELIVERS ONLY when the
//! event loop's callback is installed — an `application:openURLs:` that fires
//! before `EventLoop::run` is dropped, not queued, so a document that macOS
//! delivers early in a LAUNCH may never reach `RunEvent::Opened` at all. This
//! queue cannot hold what tao never hands it. Measured live 2026-08-28: a
//! file sent to a BOOTING instance (1 s in) arrives and imports, and a file
//! on a second launch arrives through the single-instance callback — but a
//! document attached to the launching `open` invocation itself (with `--env`,
//! which may also change delivery) did not arrive. A genuine Finder
//! double-click that LAUNCHES the app is the case to check by hand; if it
//! loses the file, the fault is the drop above, and the fix is upstream.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};

/// The event the webview listens for. Payload: absolute paths, as strings.
pub const OPEN: &str = "paper://open-files";
/// The event the webview sends once its listener is up. No payload.
pub const READY: &str = "paper://open-files-ready";

/// What a launch may carry — `ACCEPT_FORMATS` in `src/kernel/core/formats.ts`,
/// without the dots. `accepted_extensions_are_the_formats_the_app_accepts`
/// reads that file and refuses a drift.
pub const ACCEPTED: [&str; 7] = ["epub", "pdf", "mobi", "azw3", "cbz", "fb2", "fbz"];

/// Whether a path names a book by its extension. Case-blind: the Finder keeps
/// whatever case the file was saved with.
pub fn is_book(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ACCEPTED.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// The books an `argv` names: everything after the program, that is not a
/// flag, that is a book — `file://` URLs unwrapped, and a RELATIVE path
/// resolved against `cwd`. The cwd matters because a second launch's argv is
/// delivered to the FIRST process: `paper book.epub` from a shell in
/// `~/Books` must not resolve against wherever the first instance happened
/// to start — the single-instance callback carries the newcomer's cwd for
/// exactly this.
pub fn books_in_argv<I>(argv: I, cwd: Option<&Path>) -> Vec<PathBuf>
where
    I: IntoIterator<Item = String>,
{
    argv.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| match tauri::Url::parse(&arg) {
            Ok(url) if url.scheme() == "file" => url.to_file_path().ok(),
            /* A bare path on Windows — `C:\Books\x.epub` — parses as a URL
             * with the one-letter scheme `c`, and is a path. Any other
             * scheme is a URL that is not a file — `https://…/x.epub` is
             * not a book on this disk, whatever it ends in — and the first
             * draft of this let it through to the extension check. */
            Ok(url) if url.scheme().len() > 1 => None,
            _ => Some(PathBuf::from(arg)),
        })
        .map(|path| match (path.is_relative(), cwd) {
            (true, Some(base)) => base.join(path),
            _ => path,
        })
        .filter(|path| is_book(path))
        .collect()
}

/// The books the URLs of a macOS `RunEvent::Opened` name.
///
/// GATED, not merely documented as macOS-only. `RunEvent::Opened` is a macOS
/// event and its one caller in `lib.rs` sits under
/// `cfg(all(feature = "desktop", target_os = "macos"))`, so on every other
/// target this has no caller at all — dead code, which `-D warnings` makes an
/// error. Invisible on macOS, where the caller is compiled in.
#[cfg(target_os = "macos")]
pub fn books_in_urls<'a, I>(urls: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = &'a tauri::Url>,
{
    urls.into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .filter(|path| is_book(path))
        .collect()
}

/// Paths that arrived before the webview could take them.
///
/// A value rather than logic spread over two event handlers, so the one rule
/// — nothing is lost, nothing is sent twice — is a thing a test can hold.
#[derive(Debug, Default)]
pub struct Pending {
    ready: bool,
    queued: Vec<PathBuf>,
}

impl Pending {
    /// Hand paths in. What comes back is what to send NOW: everything, once
    /// the webview is listening; nothing before that, when it is queued.
    pub fn offer(&mut self, paths: Vec<PathBuf>) -> Vec<PathBuf> {
        if self.ready {
            paths
        } else {
            self.queued.extend(paths);
            Vec::new()
        }
    }

    /// The webview is listening. What comes back is everything queued, once;
    /// a second `READY` — a reload, StrictMode's double mount — gets nothing,
    /// because the first already had it.
    pub fn ready(&mut self) -> Vec<PathBuf> {
        self.ready = true;
        std::mem::take(&mut self.queued)
    }

    /// An emission failed — the webview is gone. The paths go back on the
    /// queue and `ready` is withdrawn, so the NEXT webview's `READY` is what
    /// hands them over.
    pub fn requeue(&mut self, paths: Vec<PathBuf>) {
        self.ready = false;
        self.queued.extend(paths);
    }
}

/// The managed state: one queue for the app's lifetime.
#[derive(Default)]
pub struct Opens(pub Mutex<Pending>);

/// Books a launch carried: into the scope, then to the webview — now, or
/// when it says it is ready.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    /* A directory named `archive.epub` passes the extension check — the pure
     * functions judge names, and only here is the filesystem at hand. It is
     * dropped with a log rather than sent to a read that must fail: the
     * module's contract says a directory is not an import. */
    let (paths, not_files): (Vec<_>, Vec<_>) = paths.into_iter().partition(|p| p.is_file());
    for wrong in &not_files {
        log::warn!("open: {} is not a file; not an import", wrong.display());
    }
    if paths.is_empty() {
        return;
    }
    /* `try_state`, not `state`: the queue is managed in `setup`, and a
     * `RunEvent::Opened` is delivered after setup on every launch measured —
     * but a panic here would take the app down over a file it could not
     * open, which is the wrong size of failure for the wrong reason. The
     * queue is checked BEFORE the scope is widened: a request this drops
     * must not leave a permission behind. */
    let Some(opens) = app.try_state::<Opens>() else {
        log::error!(
            "open: the queue does not exist yet; {} path(s) dropped",
            paths.len()
        );
        return;
    };
    allow_in_scope(app, &paths);
    let now = opens
        .0
        .lock()
        .expect("the open queue is poisoned")
        .offer(paths);
    if now.is_empty() {
        log::info!("open: holding what the launch carried until the webview is listening");
    } else {
        emit_or_requeue(app, now);
    }
}

/// Hear the webview say it is listening, for the life of the app.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.listen(READY, move |_| {
        let opens = handle.state::<Opens>();
        let held = opens.0.lock().expect("the open queue is poisoned").ready();
        if !held.is_empty() {
            log::info!(
                "open: the webview is listening; handing over {} held path(s)",
                held.len()
            );
            emit_or_requeue(&handle, held);
        }
    });
}

fn allow_in_scope<R: Runtime>(app: &AppHandle<R>, paths: &[PathBuf]) {
    use tauri_plugin_fs::FsExt;
    let scope = app.fs_scope();
    for path in paths {
        if let Err(cause) = scope.allow_file(path) {
            /* Logged and still sent: the read will refuse and the intake
             * counts it as unreadable, which is a sentence the reader sees.
             * Dropping the path here would be the silent version. */
            log::warn!(
                "open: could not admit {} to the fs scope: {cause}",
                path.display()
            );
        }
    }
}

fn emit_or_requeue<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    let payload: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if let Err(cause) = app.emit(OPEN, payload) {
        /* Requeued, not dropped: an emit fails when the webview is gone, and
         * the next webview announces itself with READY — at which point the
         * held paths go out again. Losing the reader's double-clicked book
         * over a transient emit failure is the silent failure this module is
         * shaped around. */
        log::error!(
            "open: could not hand the launch's files to the webview: {cause}; holding them for the next READY"
        );
        if let Some(opens) = app.try_state::<Opens>() {
            opens
                .0
                .lock()
                .expect("the open queue is poisoned")
                .requeue(paths);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn argv_yields_the_books_and_not_the_program_the_flags_or_the_rest() {
        let found = books_in_argv(
            argv(&[
                "/Applications/Paper.app/Contents/MacOS/Paper",
                "--flag",
                "-x",
                "/Books/Moby-Dick.epub",
                "/Books/notes.txt",
                "/Books/Paper.PDF",
                "/Books",
            ]),
            None,
        );
        assert_eq!(
            found,
            vec![
                PathBuf::from("/Books/Moby-Dick.epub"),
                PathBuf::from("/Books/Paper.PDF")
            ]
        );
    }

    #[test]
    fn a_relative_path_resolves_against_the_launch_s_own_cwd() {
        // A second launch's argv is handled in the FIRST process; the path
        // must resolve where the reader typed it, not where Paper started.
        let found = books_in_argv(argv(&["paper", "book.epub"]), Some(Path::new("/Books")));
        assert_eq!(found, vec![PathBuf::from("/Books/book.epub")]);
        // With no cwd to resolve against, the path is left as given.
        let found = books_in_argv(argv(&["paper", "book.epub"]), None);
        assert_eq!(found, vec![PathBuf::from("book.epub")]);
    }

    #[test]
    fn a_file_url_in_argv_is_unwrapped_to_its_path() {
        let found = books_in_argv(argv(&["paper", "file:///Books/One%20Book.epub"]), None);
        assert_eq!(found, vec![PathBuf::from("/Books/One Book.epub")]);
    }

    #[test]
    fn a_url_that_is_not_a_file_is_not_a_book() {
        assert!(books_in_argv(argv(&["paper", "https://example.org/x.epub"]), None).is_empty());
    }

    /// macOS only, because the function it covers is — see `books_in_urls`.
    #[cfg(target_os = "macos")]
    #[test]
    fn opened_urls_yield_their_file_paths_and_only_the_books() {
        let urls = [
            tauri::Url::parse("file:///Books/A.epub").unwrap(),
            tauri::Url::parse("file:///Books/A.txt").unwrap(),
            tauri::Url::parse("https://example.org/A.epub").unwrap(),
        ];
        assert_eq!(
            books_in_urls(urls.iter()),
            vec![PathBuf::from("/Books/A.epub")]
        );
    }

    /// Nothing lost before the webview listens, nothing sent twice after.
    #[test]
    fn what_arrives_early_is_held_and_handed_over_once_on_ready() {
        let mut pending = Pending::default();
        assert!(pending.offer(vec![PathBuf::from("/a.epub")]).is_empty());
        assert!(pending.offer(vec![PathBuf::from("/b.epub")]).is_empty());
        assert_eq!(
            pending.ready(),
            vec![PathBuf::from("/a.epub"), PathBuf::from("/b.epub")]
        );
        // A second READY — a reload — has nothing to hand over.
        assert!(pending.ready().is_empty());
        // And once listening, an offer is sent at once and not queued.
        assert_eq!(
            pending.offer(vec![PathBuf::from("/c.epub")]),
            vec![PathBuf::from("/c.epub")]
        );
        assert!(pending.ready().is_empty());
    }

    /// A failed emission withdraws READY: the paths wait for the NEXT
    /// webview instead of being lost to the one that just went away.
    #[test]
    fn a_requeued_delivery_waits_for_the_next_ready() {
        let mut pending = Pending::default();
        assert!(pending.ready().is_empty());
        pending.requeue(vec![PathBuf::from("/a.epub")]);
        // Not ready any more: a new offer queues rather than sends.
        assert!(pending.offer(vec![PathBuf::from("/b.epub")]).is_empty());
        assert_eq!(
            pending.ready(),
            vec![PathBuf::from("/a.epub"), PathBuf::from("/b.epub")]
        );
    }

    /// One list of what a launch may carry, held to the one `formats.ts`
    /// accepts. Two lists that agree until somebody edits one is how a book
    /// the app opens from the picker stops opening from the Finder.
    #[test]
    fn accepted_extensions_are_the_formats_the_app_accepts() {
        let source = include_str!("../../src/kernel/core/formats.ts");
        let line = source
            .lines()
            .find(|l| l.starts_with("export const ACCEPT_FORMATS = "))
            .expect("formats.ts no longer declares ACCEPT_FORMATS on one line");
        let quoted = line
            .split('\'')
            .nth(1)
            .expect("ACCEPT_FORMATS is not a single-quoted string");
        let mut theirs: Vec<&str> = quoted
            .split(',')
            .map(|e| e.trim().trim_start_matches('.'))
            .collect();
        let mut ours: Vec<&str> = ACCEPTED.to_vec();
        theirs.sort_unstable();
        ours.sort_unstable();
        assert_eq!(
            ours, theirs,
            "opened.rs ACCEPTED and formats.ts ACCEPT_FORMATS disagree"
        );
    }

    /// And the Finder is told the same list: every association in
    /// `tauri.conf.json` is an accepted format, and every accepted format has
    /// an association — otherwise a book the app reads is not offered to it.
    #[test]
    fn the_file_associations_are_the_accepted_formats() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let associations = conf["bundle"]["fileAssociations"]
            .as_array()
            .expect("bundle.fileAssociations is an array");
        let mut declared: Vec<String> = associations
            .iter()
            .flat_map(|one| one["ext"].as_array().expect("ext is an array").iter())
            .map(|ext| ext.as_str().expect("ext is a string").to_ascii_lowercase())
            .collect();
        declared.sort_unstable();
        let mut ours: Vec<String> = ACCEPTED.iter().map(|s| s.to_string()).collect();
        ours.sort_unstable();
        assert_eq!(declared, ours);
        for one in associations {
            assert_eq!(one["role"], "Viewer", "Paper reads; it does not edit");
            assert_eq!(
                one["rank"], "Alternate",
                "Paper does not claim to be the default reader"
            );
        }
    }
}

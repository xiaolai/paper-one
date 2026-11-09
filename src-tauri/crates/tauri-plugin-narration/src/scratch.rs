//! Each export's own scratch directory: made, handed out, and removed here.
//!
//! ⚠️ **ONE DIRECTORY PER EXPORT, AND IT USED TO BE ONE FOR ALL OF THEM.**
//! `chapter-<index>.wav` under a shared root meant two exports running together
//! wrote over each other's chapters, and each one's tidy-up deleted the other's
//! files. It also meant nothing OWNED a leftover, so a crash left files behind
//! for ever. The front end used to make and sweep these through the fs plugin;
//! the plugin does it now, so the window is handed a run id and never asks for a
//! directory by path.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::inputs::real_directory;
use crate::limits::{Refused, MAX_LIVE_RUNS};

/// How long an abandoned run directory is left alone before it is removed.
///
/// Long enough that a run genuinely in flight is never touched — a ten-hour
/// book at 22× real time is under half an hour — and short enough that a crash
/// does not leave gigabytes indefinitely. Live runs are never swept at any age.
pub const ABANDONED_AFTER: Duration = Duration::from_secs(6 * 60 * 60);

/// The runs this process made and has not discarded, by id.
#[derive(Debug)]
pub struct Runs {
    root: PathBuf,
    live: Mutex<HashMap<String, PathBuf>>,
}

/// What `begin` hands the window: the run's id, and the prefix a chapter's
/// scratch path is built from (`<prefix><index>.wav`), which is what the voices
/// plugin is asked to write.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    pub run: String,
    pub chapter_prefix: String,
}

impl Runs {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            live: Mutex::new(HashMap::new()),
        }
    }

    fn live(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, PathBuf>>, String> {
        self.live
            .lock()
            .map_err(|_| "the export's scratch was poisoned".to_owned())
    }

    /// Make a new run directory, sweeping abandoned ones first.
    pub fn begin(&self) -> Result<Begun, String> {
        self.begin_at(SystemTime::now())
    }

    /// As [`Runs::begin`], at a given moment — so a test can age a run.
    pub fn begin_at(&self, now: SystemTime) -> Result<Begun, String> {
        let mut live = self.live()?;
        if live.len() >= MAX_LIVE_RUNS {
            return Err(Refused::TooManyRuns.into());
        }
        let millis = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        self.sweep(&live, millis);
        let run = format!("run-{}-{}", base36(millis), random_hex(4));
        let dir = self.root.join(&run);
        /* `create_dir`, NOT `create_dir_all`: exclusive, so a name that somehow
         * exists already is refused rather than shared. */
        std::fs::create_dir(&dir)
            .map_err(|error| format!("cannot make the export's scratch directory: {error}"))?;
        let chapter_prefix = dir.join("chapter-").to_string_lossy().into_owned();
        live.insert(run.clone(), dir);
        Ok(Begun {
            run,
            chapter_prefix,
        })
    }

    /// The directory of a live run, checked to still be a real directory.
    pub fn dir(&self, run: &str) -> Result<PathBuf, String> {
        let dir = self
            .live()?
            .get(run)
            .cloned()
            .ok_or_else(|| format!("there is no export called {run}"))?;
        let meta = std::fs::symlink_metadata(&dir)
            .map_err(|error| format!("cannot read the export's scratch directory: {error}"))?;
        real_directory(&dir, &meta)?;
        Ok(dir)
    }

    /// Where chapter `index` of a run is written.
    pub fn chapter(dir: &Path, index: u32) -> PathBuf {
        dir.join(format!("chapter-{index}.wav"))
    }

    /// Remove one chapter's scratch file. One that is already gone is fine:
    /// the tidy-up asks for every chapter it attempted.
    pub fn discard_chapter(&self, run: &str, index: u32) -> Result<(), String> {
        let dir = self.dir(run)?;
        match std::fs::remove_file(Self::chapter(&dir, index)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("cannot remove chapter {index}'s scratch: {error}")),
        }
    }

    /// Remove a run's directory and everything in it, and forget the run.
    pub fn discard(&self, run: &str) -> Result<(), String> {
        let dir = self
            .live()?
            .remove(run)
            .ok_or_else(|| format!("there is no export called {run}"))?;
        let meta = match std::fs::symlink_metadata(&dir) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("cannot read the export's scratch: {error}")),
        };
        real_directory(&dir, &meta)?;
        std::fs::remove_dir_all(&dir)
            .map_err(|error| format!("cannot remove the export's scratch: {error}"))
    }

    /// Remove run directories no export can still own.
    ///
    /// ⚠️ **AGE IS READ FROM THE NAME, AND A LIVE RUN IS NEVER TOUCHED.** The id
    /// carries the clock it was made at, which stays honest across a copied or
    /// restored profile where file times do not. A failed removal is logged and
    /// does not stop the export that triggered the sweep.
    fn sweep(&self, live: &HashMap<String, PathBuf>, now_millis: u128) {
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!("narration: cannot list the scratch directory: {error}");
                return;
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if live.contains_key(&name) {
                continue;
            }
            let Some(made) = stamp_of(&name) else {
                continue;
            };
            if now_millis.saturating_sub(made) < ABANDONED_AFTER.as_millis() {
                continue;
            }
            /* `DirEntry::file_type` does not follow a link, so a link with a
             * run's name is passed over rather than walked. */
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                log::warn!("narration: cannot remove the abandoned export {name}: {error}");
            }
        }
    }
}

/// The millisecond stamp in a run's name, if it has one.
fn stamp_of(name: &str) -> Option<u128> {
    let rest = name.strip_prefix("run-")?;
    let (stamp, _) = rest.split_once('-')?;
    u128::from_str_radix(stamp, 36).ok()
}

fn base36(mut value: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `words` × 32 random bits, as hex.
///
/// ⚠️ **NO RANDOMNESS CRATE, AND NONE IS NEEDED.** `RandomState` is seeded from
/// the operating system's generator once per process and perturbed per instance;
/// a fresh one per word, fed a counter and the clock, gives values the window
/// cannot predict. These are capability tokens for one process lifetime, not
/// keys, and adding a dependency to make them would be a dependency to review.
pub fn random_hex(words: usize) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut out = String::with_capacity(words * 16);
    for _ in 0..words {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runs() -> (tempfile::TempDir, Runs) {
        let dir = tempfile::tempdir().expect("tempdir");
        let runs = Runs::new(dir.path().to_path_buf());
        (dir, runs)
    }

    #[test]
    fn a_run_is_a_new_directory_and_its_prefix_names_a_chapter_inside_it() {
        let (dir, runs) = runs();
        let begun = runs.begin().expect("begin");
        let made = dir.path().join(&begun.run);
        assert!(made.is_dir());
        assert_eq!(
            format!("{}3.wav", begun.chapter_prefix),
            Runs::chapter(&made, 3).to_string_lossy()
        );
        assert_eq!(runs.dir(&begun.run).expect("dir"), made);
    }

    #[test]
    fn two_runs_never_share_a_directory() {
        let (_dir, runs) = runs();
        let a = runs.begin().expect("a");
        let b = runs.begin().expect("b");
        assert_ne!(a.run, b.run);
    }

    #[test]
    fn the_live_runs_are_capped_and_a_discard_frees_a_place() {
        let (_dir, runs) = runs();
        let mut begun = Vec::new();
        for _ in 0..MAX_LIVE_RUNS {
            begun.push(runs.begin().expect("begin"));
        }
        assert_eq!(runs.begin(), Err(Refused::TooManyRuns.to_string()));
        runs.discard(&begun[0].run).expect("discard");
        runs.begin().expect("a place was freed");
    }

    #[test]
    fn discarding_a_run_removes_it_and_everything_in_it_and_forgets_it() {
        let (dir, runs) = runs();
        let begun = runs.begin().expect("begin");
        let made = dir.path().join(&begun.run);
        std::fs::write(Runs::chapter(&made, 0), b"audio").expect("chapter");
        runs.discard(&begun.run).expect("discard");
        assert!(!made.exists());
        assert!(runs.dir(&begun.run).is_err());
        assert!(runs.discard(&begun.run).is_err(), "discarded twice");
    }

    #[test]
    fn a_chapter_is_discarded_and_one_already_gone_is_not_an_error() {
        let (dir, runs) = runs();
        let begun = runs.begin().expect("begin");
        let chapter = Runs::chapter(&dir.path().join(&begun.run), 2);
        std::fs::write(&chapter, b"audio").expect("chapter");
        runs.discard_chapter(&begun.run, 2).expect("discard");
        assert!(!chapter.exists());
        runs.discard_chapter(&begun.run, 2).expect("again");
    }

    #[test]
    fn an_unknown_run_is_refused_by_every_operation() {
        let (_dir, runs) = runs();
        assert!(runs.dir("run-0-0").is_err());
        assert!(runs.discard_chapter("run-0-0", 0).is_err());
        assert!(runs.discard("run-0-0").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_run_directory_swapped_for_a_link_is_refused() {
        let (dir, runs) = runs();
        let begun = runs.begin().expect("begin");
        let made = dir.path().join(&begun.run);
        let elsewhere = tempfile::tempdir().expect("elsewhere");
        std::fs::write(elsewhere.path().join("keep"), b"theirs").expect("keep");
        std::fs::remove_dir(&made).expect("remove");
        std::os::unix::fs::symlink(elsewhere.path(), &made).expect("plant");
        assert!(runs.dir(&begun.run).is_err());
        assert!(runs.discard(&begun.run).is_err());
        assert!(elsewhere.path().join("keep").exists());
    }

    #[test]
    fn the_sweep_removes_an_old_run_and_keeps_a_young_one_and_a_live_one() {
        let (dir, runs) = runs();
        let now = SystemTime::now();
        let old = now - ABANDONED_AFTER - Duration::from_secs(60);
        let live_old = runs.begin_at(old).expect("live, and old");
        let millis = |at: SystemTime| at.duration_since(UNIX_EPOCH).expect("epoch").as_millis();
        let abandoned = dir.path().join(format!("run-{}-dead", base36(millis(old))));
        let young = dir
            .path()
            .join(format!("run-{}-young", base36(millis(now))));
        let other = dir.path().join("notes");
        for made in [&abandoned, &young, &other] {
            std::fs::create_dir(made).expect("plant");
        }
        runs.begin_at(now).expect("begin sweeps");
        assert!(!abandoned.exists(), "an abandoned run survived");
        assert!(young.exists(), "a young run was swept");
        assert!(other.exists(), "a directory that is not a run was swept");
        assert!(
            dir.path().join(&live_old.run).exists(),
            "a live run was swept"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_does_not_walk_a_link_with_a_runs_name() {
        let (dir, runs) = runs();
        let elsewhere = tempfile::tempdir().expect("elsewhere");
        std::fs::write(elsewhere.path().join("keep"), b"theirs").expect("keep");
        std::os::unix::fs::symlink(elsewhere.path(), dir.path().join("run-1-link")).expect("plant");
        runs.begin().expect("begin sweeps");
        assert!(elsewhere.path().join("keep").exists());
    }

    #[test]
    fn a_stamp_round_trips_through_its_name() {
        assert_eq!(
            stamp_of(&format!("run-{}-x", base36(1_234_567))),
            Some(1_234_567)
        );
        assert_eq!(base36(0), "0");
        assert_eq!(stamp_of("run-"), None);
        assert_eq!(stamp_of("other-1-x"), None);
    }

    #[test]
    fn random_hex_is_as_long_as_asked_and_does_not_repeat() {
        let a = random_hex(2);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, random_hex(2));
    }
}

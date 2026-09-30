//! The rendered reading, kept on disk so a section is spoken once and played
//! many times.
//!
//! ```text
//! <data root>/
//!   audio/
//!     clips/      one `.wav` and one `.json` sidecar per rendered section
//!     staging/    a render in progress, promoted only when it is whole
//!     state.json  the checkpoint: what is durable, and when it was last played
//! ```
//!
//! ⚠️ **`Layout::under` TAKES THE APP'S DATA ROOT AND JOINS `audio` ITSELF**,
//! exactly as `paths::Layout` joins `voices` and `tauri-plugin-passages`'s joins
//! `passages`. This plugin has already shipped the other mistake once — it was
//! handed a root that already ended in its own segment and installed every pack
//! one directory deeper than the app looked, `…/voices/voices/packs`, which
//! works perfectly and is merely wrong, so nothing failed.
//!
//! # `staging/` is a sibling of `clips/`, and that is what makes a stop safe
//!
//! A render is minutes long and the reader may stop it. Bytes land in
//! `staging/`, and only a whole artifact is RENAMED across — so there is no
//! window in which a partly written WAV sits where the player would read it.
//! `install.rs` leans on the same primitive for the same reason, and `rename(2)`
//! across filesystems is a copy, which would put the window back, so the two
//! directories stay under one root.
//!
//! ⚠️ **AND THE CHECKPOINT IS WRITTEN ONLY AFTER THE ARTIFACT IS DURABLE.** The
//! other order claims a section is ready that nothing can play, and — because
//! [`Store::find`] believes the checkpoint — nothing ever looks again. This is
//! `tauri-plugin-passages`'s rule verbatim, and it is why [`Store::put`] fsyncs
//! both files, renames both, and writes `state.json` last.
//!
//! # What the key is, and why a digest rather than a timestamp
//!
//! A clip answers to `(book, section, pack, voice, rate)` — that tuple names the
//! FILE — and the sidecar carries two digests that must both match before the
//! bytes are used. An mtime would not do: a book whose text changed could play
//! stale audio over changed words, and a book merely re-saved would throw away a
//! render that is still correct.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// The subdirectory this module owns under the data root.
pub const AUDIO_DIR: &str = "audio";

/// How many bytes of rendered reading Paper will keep.
///
/// **Owner's number, 2026-09-30.** The artifact is exactly 48 000 bytes per
/// second of audio — 24 kHz, mono, 16-bit — which is 172.8 MB an hour, so this
/// is about **28.9 hours of audio**, or three or four books in flight at once.
///
/// ⚠️ **IT IS A BUDGET AND NOT A LIMIT ON ONE CLIP.** A single section can be
/// two and a half hours of audio (p99 of this shelf is 137 971 canonical
/// characters, 2.3 h), so a clip is written first and the budget applied
/// afterwards — see [`Store::put`]. Refusing a clip for being large would refuse
//  the reading the reader just asked for, which is never the right answer.
pub const BUDGET_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// What names one rendered section.
///
/// ⚠️ **`rate` IS IN THE KEY BECAUSE IT IS IN THE AUDIO.** Kokoro renders at the
/// rate it is given rather than resampling afterwards, so audio made at 1.0 is
/// not audio made at 1.5 slowed down. A key that left it out would play the
/// wrong speed and nothing would notice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    pub book: String,
    /// Which spine item, or `None` where the reader's place cannot say yet.
    ///
    /// ⚠️ **OPTIONAL, AND A SENTINEL `-1` IS WHAT MADE IT SO — MEASURED IN THE
    /// RUNNING APP, 2026-09-30.** `ReaderPosition.sectionIndex` is documented as
    /// null "when that cannot be told yet", the host spelled that as `?? -1`, and
    /// a `u32` refuses a negative: *"invalid value: integer `-1`, expected u32"*.
    /// Reading aloud was dead on a real machine while 3 007 tests passed, because
    /// every one of them supplied a section. A value the caller genuinely may not
    /// have is an `Option`, not a number outside the range.
    ///
    /// It is still part of the identity, so two sections with no index are told
    /// apart by their text digests exactly as two with one are.
    pub section: Option<u32>,
    pub pack: String,
    pub voice: String,
    /// Milli-units, so the key is an integer and two spellings of one speed
    /// cannot make two clips. `1.0` is 1000.
    pub rate_milli: u32,
    /// A digest of the section's CANONICAL text — `indexText`'s form, the one
    /// phase 31 indexes.
    ///
    /// ⚠️ **THE PLAN'S OWN REQUIREMENT, AND THE REASON IS AGREEMENT RATHER THAN
    /// FRESHNESS.** Using the same form as the search index means the audio key
    /// and the index cannot disagree about what a section says.
    pub text_digest: String,
    /// A digest of the exact string the engine was handed.
    ///
    /// ⚠️ **A SECOND DIGEST, AND IT IS NOT BELT AND BRACES.** The word timings
    /// index the string that was RENDERED — the reader's own collected text,
    /// which is not the canonical form: the canonical walk collapses whitespace
    /// runs and block edges to a single space. So two documents can share a
    /// canonical form and hand the engine different strings, and then every
    /// word offset in the sidecar points at the wrong character. The canonical
    /// digest says *the section still says this*; this one says *the offsets
    /// still mean what they meant*. Both are checked.
    pub spoken_digest: String,
}

impl Key {
    /// The filename stem: a readable slug, then a digest of the whole identity.
    ///
    /// ⚠️ **THE BOOK ID CANNOT BE THE FILENAME, AND THE REASON IS WINDOWS.**
    /// Real ids here look like `book:9f3c…` and `:` is not a character a
    /// filename may hold there. `tauri-plugin-passages`'s `file_stem` records
    /// the rest of it, including why a many-to-one fold will not do: the digest
    /// covers the whole identity, and the identity is written INSIDE the sidecar
    /// as well, so a collision is DETECTED on read rather than merged.
    ///
    /// # Errors
    /// [`Error::BadKey`] for an empty book id or one past [`MAX_ID`].
    pub fn stem(&self) -> Result<String> {
        /* ⚠️ **NAMED SEPARATELY, BECAUSE `BadPath` SENT A READER AFTER THE WRONG
         * THING.** Its text is *" is not a path inside the pack"*, which is about
         * a PACK and shows nothing at all when the value is empty — three rounds
         * were spent on 2026-09-30 asking which of four call sites could produce
         * an empty path. */
        if self.book.is_empty() {
            return Err(Error::BadKey {
                field: "the book",
                why: "empty — the reader's place has no book id yet",
            });
        }
        if self.book.len() > MAX_ID {
            return Err(Error::BadKey {
                field: "the book",
                why: "longer than an id may be",
            });
        }
        /* ⚠️ **THE SEPARATOR `identity` JOINS ON IS NUL, AND NOTHING REFUSED ONE
         * IN A FIELD — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** A separator
         * that can occur inside what it separates is not a separator: two
         * different readings hashed to one name and would have overwritten each
         * other's audio. Refused HERE rather than escaped in `identity`, because
         * this is the one road to a filename and because a NUL in a book id, a
         * pack id, a voice id or a digest is a caller defect in every case. */
        for (field, value) in [
            ("the book", self.book.as_str()),
            ("the pack", self.pack.as_str()),
            ("the voice", self.voice.as_str()),
            ("the text digest", self.text_digest.as_str()),
            ("the spoken digest", self.spoken_digest.as_str()),
        ] {
            if value.contains('\0') {
                return Err(Error::BadKey {
                    field,
                    why: "holding a NUL, which is the byte the identity joins on",
                });
            }
        }
        let slug: String = self
            .book
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .take(SLUG)
            .collect();
        /* `x` for a section nobody could name, so the filename stays readable and
        cannot be confused with section 0. */
        let at = self
            .section
            .map_or_else(|| "x".to_owned(), |n| n.to_string());
        Ok(format!("{slug}-{at}-{:016x}", self.identity()))
    }

    /// FNV-1a over every field that names the clip, digests included.
    ///
    /// ⚠️ **`DefaultHasher` WOULD NOT DO, BECAUSE THIS NAME IS ON DISK.** std's
    /// hasher is explicitly not stable across releases, so a Rust upgrade would
    /// rename every clip and orphan the lot — silently, since a missing file
    /// reads as a section that was never rendered. The same conclusion
    /// `tauri-plugin-passages` reached, for the same reason.
    ///
    /// The fields are joined by a byte `stem` refuses in any of them, so
    /// `("ab", "c")` and `("a", "bc")` are different identities.
    ///
    /// ⚠️ **AND THAT CLAIM USED TO BE FALSE — FOUND BY AN INDEPENDENT AUDIT,
    /// 2026-09-30.** It read *"a byte that cannot appear in any of them"*, which
    /// is not true of a Rust `String`: NUL is a perfectly legal `char`. So
    /// `(pack: "a\0b", voice: "c")` and `(pack: "a", voice: "b\0c")` hashed
    /// IDENTICALLY, and two different readings would overwrite each other's audio
    /// under one name. `stem` refuses an embedded NUL now, which is what makes the
    /// separator a separator — the comment asserted the property the code needed.
    #[must_use]
    pub fn identity(&self) -> u64 {
        let mut hash = FNV_OFFSET;
        for part in [
            self.book.as_str(),
            &self
                .section
                .map_or_else(|| "none".to_owned(), |n| n.to_string()),
            self.pack.as_str(),
            self.voice.as_str(),
            &self.rate_milli.to_string(),
            self.text_digest.as_str(),
            self.spoken_digest.as_str(),
        ] {
            hash = fnv1a64_from(hash, part.as_bytes());
            hash = fnv1a64_from(hash, &[0]);
        }
        hash
    }
}

/// The longest a book id may be here — `MAX_RECORD_FIELD` on the TypeScript
/// side, which is where ids are bounded for every other store.
const MAX_ID: usize = 500;

/// How much of the id survives into the filename, for a human reading the
/// directory. The digest is what makes the name unique.
const SLUG: usize = 32;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

/// Whether this is a name this module could have written.
///
/// ⚠️ **A STEM READ BACK FROM `state.json` IS UNTRUSTED INPUT, AND IT WAS JOINED
/// STRAIGHT INTO A PATH — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.**
/// `reconcile`, `evict` and `forget` all build
/// `clips_dir.join(format!("{stem}.wav"))` and then REMOVE it. The checkpoint is
/// Paper's own file under the app's own data directory, which is why this is a
/// hardening rather than an exploit — but *"the file is ours"* is exactly the
/// assumption `paths::safe_component` exists to stop relying on, and a store that
/// deletes what a row tells it to must be able to say no.
///
/// The alphabet is [`Key::stem`]'s own output: a slug of `[A-Za-z0-9_]`, the
/// section (digits, or `x` for one nobody could name), and sixteen hex digits,
/// joined by `-`. Nothing else is a name this module ever wrote.
#[must_use]
pub fn safe_stem(stem: &str) -> bool {
    !stem.is_empty()
        && stem.len() <= 120
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// FNV-1a, 64-bit, continued from an existing state.
#[must_use]
pub fn fnv1a64_from(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// A digest of some text, spelled exactly as `clipKey.ts`'s `textDigest` spells
/// it: `fnv1a64:<utf-16 code units>:<sixteen hex digits>`.
///
/// ⚠️ **THE LENGTH IS IN UTF-16 CODE UNITS AND THE HASH IS OVER UTF-8 BYTES**,
/// which are two units on purpose and are the TypeScript side's two units. A
/// `char` count here would disagree with `String.length` there for every astral
/// character, and the disagreement would look like a tampered key.
///
/// ⚠️ **THIS IS A SECOND IMPLEMENTATION OF A SHARED RULE, AND THAT IS THE POINT
/// RATHER THAN THE COST.** Two writers for one reader is the shape this repository
/// keeps having to fix — and the fix is always the same: make them AGREE where
/// both halves exist. `a_text_digest_is_spelled_as_the_reader_spells_it` pins this
/// against the strings `clipKey.test.ts` pins, so a change to either is a failure
/// rather than a rename of every clip on every reader's disk.
#[must_use]
pub fn text_digest(text: &str) -> String {
    format!(
        "fnv1a64:{}:{:016x}",
        text.encode_utf16().count(),
        fnv1a64(text.as_bytes())
    )
}

/// FNV-1a, 64-bit.
#[must_use]
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    fnv1a64_from(FNV_OFFSET, bytes)
}

/// A word, and when it is spoken — the same shape `commands::WordRow` crosses
/// the IPC in, stored so a replayed clip needs no re-render to be followed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub start: usize,
    pub length: usize,
    pub start_ms: u32,
    pub end_ms: u32,
}

/// A sentence or a word that was not said, and why.
///
/// ⚠️ **CARRIED THROUGH THE STORE SO A CACHED CLIP ANSWERS WHAT A FRESH RENDER
/// ANSWERS.** `SpokenAudio.skipped` is part of the port's contract and
/// `rows.ts` validates it; dropping it on the cached road would make one port
/// answer differently depending on whether the audio happened to be on disk,
/// which is the kind of difference nothing fails on and nobody can explain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skip {
    pub text: String,
    pub why: String,
}

/// The sidecar: everything about a clip that is not its samples.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sidecar {
    /// Bumped when this file's shape changes. A sidecar of another format is
    /// REFUSED rather than read as an empty one — the defect eighteen stores in
    /// this tree have already had to fix.
    pub format: u32,
    pub key: Key,
    pub sample_rate: u32,
    pub duration_ms: u32,
    pub words: Vec<Word>,
    /// Absent in a sidecar written before this field existed, which reads as
    /// "nothing was skipped" — the only value a file with no such list can
    /// honestly stand for.
    #[serde(default)]
    pub skipped: Vec<Skip>,
}

/// The format this build writes and is the only one it reads.
pub const SIDECAR_FORMAT: u32 = 1;

/// One row of the checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub stem: String,
    pub key: Key,
    pub bytes: u64,
    pub duration_ms: u32,
    pub sample_rate: u32,
    pub words: u32,
    /// Unix milliseconds. Least-recently-PLAYED is what eviction sorts on, and
    /// a `find` that hands the clip out counts as playing it.
    pub last_played_ms: u64,
}

/// What is durable, as `state.json` holds it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub format: u32,
    #[serde(default)]
    pub held: Vec<Held>,
}

/// The format this build writes.
pub const STATE_FORMAT: u32 = 1;

/// What one eviction took away, so the reader can be told rather than left to
/// wonder why audio they heard yesterday is being made again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evicted {
    pub clips: u32,
    pub bytes: u64,
}

/// The directories, RESOLVED — not created. [`Layout::ensure`] is the half that
/// touches the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// `<data root>/audio`
    pub base: PathBuf,
    pub clips_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub state_path: PathBuf,
}

impl Layout {
    /// The layout under `root`, pure — no directory is created.
    #[must_use]
    pub fn under(root: &Path) -> Self {
        let base = root.join(AUDIO_DIR);
        Self {
            clips_dir: base.join("clips"),
            staging_dir: base.join("staging"),
            state_path: base.join("state.json"),
            base,
        }
    }

    /// Create every directory, and keep the tree out of Time Machine.
    ///
    /// # Errors
    /// Returns the underlying I/O failure.
    pub fn ensure(&self) -> Result<()> {
        std::fs::create_dir_all(&self.base)?;
        std::fs::create_dir_all(&self.clips_dir)?;
        std::fs::create_dir_all(&self.staging_dir)?;
        /* ⚠️ **ON EVERY OPEN, NOT ONLY AT CREATION.** `identity.rs` learned this
         * for `peer/` and `tauri-plugin-passages` copied it: every tree that
         * exists today was made before the marker did, and opening is what
         * reaches them. */
        exclude_from_backup(&self.base);
        Ok(())
    }

    /// Where a clip's samples live.
    ///
    /// # Errors
    /// As [`Key::stem`].
    pub fn wav_path(&self, key: &Key) -> Result<PathBuf> {
        Ok(self.clips_dir.join(format!("{}.wav", key.stem()?)))
    }

    /// Where a clip's sidecar lives.
    ///
    /// # Errors
    /// As [`Key::stem`].
    pub fn sidecar_path(&self, key: &Key) -> Result<PathBuf> {
        Ok(self.clips_dir.join(format!("{}.json", key.stem()?)))
    }
}

/// A clip that is there and can be played.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Clip {
    pub stem: String,
    /// Absolute, for a caller that reads the bytes itself — the audiobook
    /// packer, which is Rust.
    ///
    /// ⚠️ **THERE WAS A `relative` BESIDE THIS AND IT HAS GONE.** It existed so
    /// the webview could read the file through the fs plugin's `$APPDATA` scope,
    /// and `no-direct-fs-plugin-outside-storage` refuses that for a capability —
    /// correctly, since the scope grants the whole directory. `voices_clip_read`
    /// takes the STEM and resolves the path from the checkpoint's own row, which
    /// is narrower. A field with no reader is what this repository deletes.
    pub path: PathBuf,
    pub bytes: u64,
    pub sample_rate: u32,
    pub duration_ms: u32,
    pub words: Vec<Word>,
    pub skipped: Vec<Skip>,
}

/// The store: the layout, plus the checkpoint held in memory between calls.
#[derive(Debug)]
pub struct Store {
    layout: Layout,
    budget: u64,
    state: State,
    /**
     * Clips something is reading right now, which eviction and forgetting skip.
     *
     * ⚠️ **THE AUDIOBOOK EXPORT IS WHY — FOUND BY AN INDEPENDENT AUDIT,
     * 2026-09-30.** WI-34.4 hands `narrate_package` the PATH of a clip the
     * reading made instead of rendering the chapter again, and the packer then
     * reads that file for as long as the muxing takes. Nothing stopped a
     * concurrent reading's render from evicting it under the packer, or a reader
     * pressing *Forget them* from deleting it: the export would fail by name,
     * which is loud but is a failure that did not have to happen.
     *
     * ⚠️ **IN MEMORY AND NOT IN THE CHECKPOINT, DELIBERATELY.** A hold is about
     * work in flight in THIS process, so a crash must not leave a clip pinned for
     * ever — and a restart is exactly when nothing is reading. Written down
     * because the opposite is the obvious choice and is wrong.
     */
    held_open: std::collections::HashSet<String>,
}

impl Store {
    /// Open the store under `root`, creating the directories and reading the
    /// checkpoint.
    ///
    /// ⚠️ **A CHECKPOINT THAT WILL NOT READ IS REFUSED, NOT TREATED AS EMPTY.**
    /// Eighteen stores in this tree have had the other behaviour and every one
    /// of them lost data by it: a parser that answers "nothing stored" for bytes
    /// it cannot read hands the next write a blank page to save over. Here the
    /// consequence is milder — the clips would be orphaned rather than deleted —
    /// and the shape is the same, so the answer is the same.
    ///
    /// # Errors
    /// The underlying I/O failure, or a `state.json` that is not this format.
    pub fn open(root: &Path, budget: u64) -> Result<Self> {
        let layout = Layout::under(root);
        layout.ensure()?;
        let state = read_state(&layout.state_path)?;
        let mut store = Self {
            layout,
            budget,
            state,
            held_open: std::collections::HashSet::new(),
        };
        store.reconcile()?;
        Ok(store)
    }

    #[must_use]
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    #[must_use]
    pub fn budget(&self) -> u64 {
        self.budget
    }

    /// How many bytes the clips hold.
    #[must_use]
    pub fn bytes(&self) -> u64 {
        /* ⚠️ **SATURATING, BECAUSE EVERY ONE OF THESE NUMBERS CAME OFF DISK —
         * FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `sum()` panics on overflow
         * in a debug build and wraps in a release one, and a wrapped total reads as
         * *the store is empty*, which would turn a tampered checkpoint into a
         * budget that never evicts. Saturating reads as *the store is enormous*,
         * which evicts — the safe direction of the same arithmetic. */
        self.state
            .held
            .iter()
            .fold(0u64, |total, h| total.saturating_add(h.bytes))
    }

    /// How many clips are held.
    #[must_use]
    pub fn clips(&self) -> usize {
        self.state.held.len()
    }

    /// Where a clip's samples are, for a stem the checkpoint holds.
    ///
    /// ⚠️ **THE CHECKPOINT IS THE AUTHORISATION, NOT THE ALPHABET.** A name is
    /// answered only when a row holds it, so this cannot be asked for a file
    /// Paper did not write — which is what makes `voices_clip_read` narrower than
    /// the fs plugin's `$APPDATA` scope rather than a second spelling of it. The
    /// path is then BUILT from the row's own stem, so nothing the caller sent is
    /// joined into it.
    #[must_use]
    pub fn path_of(&self, stem: &str) -> Option<PathBuf> {
        let held = self.state.held.iter().find(|h| h.stem == stem)?;
        Some(self.layout.clips_dir.join(format!("{}.wav", held.stem)))
    }

    /// Drop any row whose files are gone, and forget any file no row names.
    ///
    /// ⚠️ **THE CHEAP CHECK IS WHAT MAKES THIS AFFORDABLE, AND IT IS A VERY GOOD
    /// CHECK RATHER THAN A PROOF.** A row whose WAV is missing or whose size
    /// disagrees with the checkpoint cannot be played, and believing it would
    /// hand the player a path to nothing. Comparing the recorded size against
    /// the file's own is one `stat` per row; re-reading the samples would be
    /// gigabytes at every launch to find nothing almost every time. Two errors
    /// that cancel exactly — a truncation to precisely the recorded length —
    /// would pass, and that is the honest limit of it.
    fn reconcile(&mut self) -> Result<()> {
        let mut kept: Vec<Held> = Vec::with_capacity(self.state.held.len());
        for held in std::mem::take(&mut self.state.held) {
            /* ⚠️ **THE STEM IS CHECKED BEFORE IT IS JOINED, AND IT WAS NOT — FOUND
             * BY AN INDEPENDENT AUDIT, 2026-09-30.** A row whose stem reads
             * `../../index` would otherwise delete outside `audio/` entirely. A
             * row this module cannot have written is DROPPED without touching the
             * filesystem at all: there is nothing safe to remove, because the name
             * does not say where. */
            if !safe_stem(&held.stem) {
                log::warn!(
                    "voices: the checkpoint names {:?}, which is not a name Paper wrote — the row is dropped and no file is touched",
                    held.stem
                );
                continue;
            }
            /* ⚠️ **THE STEM IS CHECKED AGAINST THE ROW'S OWN KEY, AND WAS ONLY
             * CHECKED FOR ITS ALPHABET — FOUND BY AN INDEPENDENT AUDIT,
             * 2026-09-30.** `safe_stem` answers *this is a name Paper could have
             * written*; it does not answer *this is the name THIS key produces*.
             * A row carrying book A's key beside book B's perfectly well-formed
             * stem passed, and `forget(Some(A))` then deleted B's audio. The stem
             * is DERIVED from the key, so the two can simply be asked to agree —
             * and one that does not is a row this module cannot have written. */
            match held.key.stem() {
                Ok(derived) if derived == held.stem => {}
                _ => {
                    log::warn!(
                        "voices: the checkpoint names {:?} against a key that produces another name — the row is dropped and no file is touched",
                        held.stem
                    );
                    continue;
                }
            }
            /* ⚠️ **AND A NAME IS NOT ACCEPTED TWICE.** Two rows naming one file,
             * with different byte counts, made the pass DELETE a valid artifact
             * while judging the wrong row against it. Uniqueness is decided before
             * anything is removed, which is the only order in which the decision
             * is safe to act on. */
            if kept.iter().any(|k: &Held| k.stem == held.stem) {
                log::warn!(
                    "voices: the checkpoint names {:?} twice — the later row is dropped and no file is touched",
                    held.stem
                );
                continue;
            }
            let wav = self.layout.clips_dir.join(format!("{}.wav", held.stem));
            let side = self.layout.clips_dir.join(format!("{}.json", held.stem));
            /* ⚠️ **ABSENT AND UNREADABLE WERE ONE ANSWER HERE, WITH THE
             * DESTRUCTIVE HALF ATTACHED.** It read `metadata(&wav).is_ok_and(…)`,
             * so a permission failure or a momentary I/O error answered *"the clip
             * is gone"* — and the row was dropped AND both files deleted. That is
             * the defect eighteen stores in this tree have already had to fix.
             * Only `NotFound`, or a length that genuinely disagrees, forgets a
             * clip. */
            let ok = match std::fs::metadata(&wav) {
                Ok(found) => found.len() == held.bytes && side.try_exists().unwrap_or(true),
                Err(why) if why.kind() == std::io::ErrorKind::NotFound => false,
                Err(why) => {
                    log::warn!(
                        "voices: {} could not be read ({why}) — the rendered reading is kept, because unreadable is not absent",
                        wav.display()
                    );
                    true
                }
            };
            if ok {
                kept.push(held);
            } else {
                log::info!(
                    "voices: the rendered reading {} is gone from disk and has been forgotten",
                    held.stem
                );
                let _ = std::fs::remove_file(&wav);
                let _ = std::fs::remove_file(&side);
            }
        }
        let named: HashMap<&str, ()> = kept.iter().map(|h| (h.stem.as_str(), ())).collect();
        /* ⚠️ **A FILE NO ROW NAMES IS REMOVED, AND THE NAME IS NOT READ BACK TO
         * GUESS AT ONE.** `tauri-plugin-passages` records why: the slug's fold
         * is many-to-one, so recovering an id from a filename invents a book
         * that does not exist. The stem is matched FORWARDS against what the
         * checkpoint holds, which is exact. */
        if let Ok(entries) = std::fs::read_dir(&self.layout.clips_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if stem.is_empty() || named.contains_key(stem) {
                    continue;
                }
                log::info!(
                    "voices: {} is under audio/clips and the checkpoint does not name it — removing",
                    path.display()
                );
                let _ = std::fs::remove_file(&path);
            }
        }
        /* A staging directory only ever holds a render that did not finish. */
        if let Ok(entries) = std::fs::read_dir(&self.layout.staging_dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        self.state.held = kept;
        Ok(())
    }

    /// The clip for this key, if there is one — and it counts as played.
    ///
    /// ⚠️ **BOTH DIGESTS ARE IN THE KEY, SO A MISMATCH IS A MISS AND NOT A
    /// REPAIR.** The digests are part of the filename, so a section whose text
    /// changed asks for a different file and simply does not find it; the stale
    /// clip is left for eviction to take in its own time rather than deleted
    /// here, because deleting it would be a write on the READ path.
    ///
    /// # Errors
    /// As [`Key::stem`], or a sidecar that will not read.
    pub fn find(&mut self, key: &Key) -> Result<Option<Clip>> {
        let stem = key.stem()?;
        let Some(at) = self.state.held.iter().position(|h| h.stem == stem) else {
            return Ok(None);
        };
        let wav = self.layout.wav_path(key)?;
        let side = self.layout.sidecar_path(key)?;
        let sidecar = match read_sidecar(&side) {
            Ok(Some(sidecar)) => sidecar,
            /* Absent or unreadable, with a row that says otherwise: the row is
             * wrong, so it goes. Not silently — a clip disappearing under a
             * reader is worth a line in `Paper.log`. */
            Ok(None) | Err(_) => {
                /* ⚠️ **NOT WHILE SOMETHING IS READING IT — AND THIS ROAD IGNORED
                 * THE LEASE UNTIL AN INDEPENDENT AUDIT FOUND IT, 2026-09-30.** The
                 * lease's whole promise is that the PATH survives for as long as
                 * the packer is reading it, and this took the file out from under
                 * it: the export then failed with *no such file*, which reads as a
                 * broken export rather than as the race it is. A damaged clip is
                 * still a miss here; the cleanup simply waits. */
                if self.reading(&stem) {
                    log::warn!(
                        "voices: {} would not read, and something is reading the clip — the row is answered as a miss and nothing is removed",
                        side.display()
                    );
                    return Ok(None);
                }
                log::warn!(
                    "voices: {} would not read, so the rendered reading is being forgotten",
                    side.display()
                );
                self.state.held.remove(at);
                let _ = std::fs::remove_file(&wav);
                let _ = std::fs::remove_file(&side);
                self.write_state()?;
                return Ok(None);
            }
        };
        /* ⚠️ **THE SIDECAR'S OWN KEY IS COMPARED, WHICH IS WHAT MAKES A DIGEST
         * COLLISION A DETECTION RATHER THAN A MERGE.** The filename is a fold of
         * the identity and folds are many-to-one; the identity itself is written
         * inside the file, so the two can be asked to agree. */
        if &sidecar.key != key {
            log::warn!(
                "voices: {} names another section — two identities folded to one name",
                side.display()
            );
            return Ok(None);
        }
        /* ⚠️ **A WAV THAT HAS VANISHED SINCE THE STORE OPENED IS A MISS, NOT AN
         * ERROR FOR EVER — FOUND BY AN INDEPENDENT AUDIT.** This was
         * `metadata(&wav)?`, so a deleted file made every later `find` for that
         * section reject: the reading could not play it and could not re-render
         * it either, because the caller sees a refusal rather than "there is no
         * clip". Absent is a miss; anything else is still an error, because
         * unreadable is not absent. */
        let bytes = match std::fs::metadata(&wav) {
            Ok(found) => found.len(),
            Err(why) if why.kind() == std::io::ErrorKind::NotFound => {
                /* The lease cannot bring a vanished file back, so this one is a
                 * miss either way — but the SIDECAR is left, because removing it
                 * while a lease names the clip would turn a recoverable state into
                 * two missing files. See the guard above. */
                if self.reading(&stem) {
                    log::warn!(
                        "voices: {} has gone while something was reading the clip — answered as a miss, nothing removed",
                        wav.display()
                    );
                    return Ok(None);
                }
                log::warn!(
                    "voices: {} has gone since the store opened — forgetting the row so it can be made again",
                    wav.display()
                );
                self.state.held.remove(at);
                let _ = std::fs::remove_file(&side);
                self.write_state()?;
                return Ok(None);
            }
            Err(why) => return Err(why.into()),
        };
        if bytes != self.state.held[at].bytes {
            /* The worst of the three to remove under a lease: the file EXISTS and
             * the packer has been told to read it, so deleting it turns *this
             * chapter could not be verified* into *this file is not there*. See
             * the guard on the sidecar road above. */
            if self.reading(&stem) {
                log::warn!(
                    "voices: {} is {bytes} bytes where the checkpoint says {}, and something is reading it — answered as a miss, nothing removed",
                    wav.display(),
                    self.state.held[at].bytes
                );
                return Ok(None);
            }
            log::warn!(
                "voices: {} is {bytes} bytes where the checkpoint says {} — forgetting it",
                wav.display(),
                self.state.held[at].bytes
            );
            self.state.held.remove(at);
            let _ = std::fs::remove_file(&wav);
            let _ = std::fs::remove_file(&side);
            self.write_state()?;
            return Ok(None);
        }
        self.state.held[at].last_played_ms = now_ms();
        self.write_state()?;
        Ok(Some(Clip {
            stem,
            path: wav,
            bytes,
            sample_rate: sidecar.sample_rate,
            duration_ms: sidecar.duration_ms,
            words: sidecar.words,
            skipped: sidecar.skipped,
        }))
    }

    /// Keep a render: stage it, make it durable, promote it, then checkpoint —
    /// and only then apply the budget.
    ///
    /// ⚠️ **THE ORDER IS THE WHOLE OF THIS FUNCTION.** Bytes to `staging/`,
    /// fsynced; renamed into `clips/`; `state.json` written last. A stop or a
    /// crash at any point before the rename leaves a file in `staging/` that
    /// nothing reads and [`Store::reconcile`] removes at the next open; a crash
    /// between the rename and the checkpoint leaves a clip no row names, which
    /// the same pass removes. **At no point does a row claim a clip that cannot
    /// be played.**
    ///
    /// # Errors
    /// The underlying I/O failure, or a key that is not a name Paper may write.
    pub fn put(
        &mut self,
        key: &Key,
        samples: &[i16],
        sample_rate: u32,
        words: Vec<Word>,
        skipped: Vec<Skip>,
    ) -> Result<(Clip, Evicted)> {
        let stem = key.stem()?;
        /* ⚠️ **A CLIP SOMETHING IS READING IS NOT REPLACED, AND THIS ROAD IGNORED
         * THE LEASE UNTIL AN INDEPENDENT AUDIT FOUND IT, 2026-09-30.** The reader
         * can press Listen on a chapter an export is packaging: same book, same
         * section, same text, same voice, same rate, so the SAME stem — and the
         * rename below would put different samples under the path the packer was
         * told to read.
         *
         * What is answered instead is the clip that is already there, whole, which
         * is not a compromise: the key holds the text digest, the pack, the voice
         * and the rate, so a clip at this stem is audio of exactly these words in
         * exactly this voice. A cache hit found late is still a cache hit — and
         * the new render's timings are NOT substituted, because they belong to
         * samples this store is not keeping.
         *
         * Nothing is staged first, so there is nothing to clean up. */
        if self.reading(&stem) {
            /* THROUGH `find`, so the clip answered here has been through every
            check a cache hit goes through — the sidecar's own key, the length
            against the checkpoint — rather than assembled from the row. */
            return match self.find(key)? {
                Some(clip) => {
                    log::info!(
                        "voices: {stem} is being read, so the render that has just finished is not filed over it"
                    );
                    Ok((clip, Evicted::default()))
                }
                /* Held AND unusable: this store can neither file the new render
                nor serve the old one, so it says so rather than doing one of
                the two things it has just decided it must not do. */
                None => Err(Error::BadKey {
                    field: "the section",
                    why: "being read by something else, and the clip on disk will not answer",
                }),
            };
        }
        let duration_ms = duration_ms(samples.len(), sample_rate);
        let wav = crate::wav::bytes(samples, sample_rate).map_err(|why| Error::Malformed {
            route: format!("audio/clips/{stem}.wav"),
            why,
        })?;
        let sidecar = Sidecar {
            format: SIDECAR_FORMAT,
            key: key.clone(),
            sample_rate,
            duration_ms,
            words: words.clone(),
            skipped: skipped.clone(),
        };
        let side_bytes = serde_json::to_vec(&sidecar).map_err(|why| Error::Malformed {
            route: format!("audio/clips/{stem}.json"),
            why: why.to_string(),
        })?;

        let staged_wav = self.layout.staging_dir.join(format!("{stem}.wav"));
        let staged_side = self.layout.staging_dir.join(format!("{stem}.json"));
        /* Whatever a previous stopped render left at these names. */
        let _ = std::fs::remove_file(&staged_wav);
        let _ = std::fs::remove_file(&staged_side);
        if let Err(why) =
            write_durable(&staged_wav, &wav).and_then(|()| write_durable(&staged_side, &side_bytes))
        {
            let _ = std::fs::remove_file(&staged_wav);
            let _ = std::fs::remove_file(&staged_side);
            return Err(why);
        }

        let target_wav = self.layout.wav_path(key)?;
        let target_side = self.layout.sidecar_path(key)?;
        /* ⚠️ **WHICH FILE GOES FIRST DEPENDS ON WHETHER THERE IS ONE THERE
         * ALREADY, AND IT USED TO BE THE SIDECAR UNCONDITIONALLY — FOUND BY AN
         * INDEPENDENT AUDIT, 2026-09-30.**
         *
         * | | crash between the two renames leaves |
         * |---|---|
         * | a NEW clip, sidecar first | a sidecar with no samples, which no row names and `reconcile` removes ✅ |
         * | a REPLACEMENT, sidecar first | **new timings beside the OLD samples** — and the old row's `bytes` still matches the old WAV, so every check accepts the pair ❌ |
         * | a replacement, samples first | new samples beside the old sidecar, whose `bytes` no longer match the row — `find` forgets it and the section is made again ✅ |
         *
         * So the rule is: put the file whose MISMATCH is detectable last. For a
         * new clip that is the samples; for a replacement it is the sidecar. */
        let replacing = self.state.held.iter().any(|h| h.stem == stem);
        let (first, first_to, second, second_to) = if replacing {
            (&staged_wav, &target_wav, &staged_side, &target_side)
        } else {
            (&staged_side, &target_side, &staged_wav, &target_wav)
        };
        std::fs::rename(first, first_to)?;
        /* ⚠️ **THE FIRST RENAME IS MADE DURABLE BEFORE THE SECOND, AND IT WAS NOT
         * — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** The table above chooses
         * WHICH file to promote first so that a crash between the two renames
         * leaves a detectable mismatch. That reasoning assumes the two land in
         * that order on disk, and a single sync after both does not: the directory
         * entries could reach the platter in either order, so the state the table
         * calls impossible — new timings beside old samples, every check
         * accepting the pair — was reachable after all. Best effort, as every
         * other sync here is. */
        sync_dir(&self.layout.clips_dir);
        if let Err(why) = std::fs::rename(second, second_to) {
            if !replacing {
                /* Only for a NEW clip: there is nothing there to put back, so the
                half that landed is rubbish. A replacement's half is the new
                samples over the old, and removing them would take the clip
                away entirely — `find` will forget the row and it is made
                again, which is the better of the two. */
                let _ = std::fs::remove_file(first_to);
            }
            return Err(why.into());
        }
        /* ⚠️ **THE DIRECTORY ENTRY IS NOT DURABLE UNTIL THE DIRECTORY IS SYNCED.**
         * `write_durable` syncs `staging/`, and the rename creates an entry in
         * `clips/` that nothing had synced — so a power failure could lose a clip
         * the checkpoint was about to claim, which is the one state this whole
         * ordering exists to make impossible. Best effort, as the file sync is. */
        sync_dir(&self.layout.clips_dir);

        let bytes = wav.len() as u64;
        let held = Held {
            stem: stem.clone(),
            key: key.clone(),
            bytes,
            duration_ms,
            sample_rate,
            words: words.len() as u32,
            last_played_ms: now_ms(),
        };
        if let Some(at) = self.state.held.iter().position(|h| h.stem == stem) {
            self.state.held[at] = held;
        } else {
            self.state.held.push(held);
        }
        self.write_state()?;
        /* AFTER the checkpoint, so a clip is never evicted on the strength of a
         * row that is not yet durable. */
        let evicted = self.evict(&stem)?;
        Ok((
            Clip {
                stem,
                path: target_wav,
                bytes,
                sample_rate,
                duration_ms,
                words,
                skipped,
            },
            evicted,
        ))
    }

    /// Bring the store back under its budget, least-recently-played first.
    ///
    /// `keep` is never evicted: it is the clip the reader is about to hear, and
    /// a budget that removed it would make Listen a loop.
    fn evict(&mut self, keep: &str) -> Result<Evicted> {
        let mut gone = Evicted::default();
        if self.bytes() <= self.budget {
            return Ok(gone);
        }
        let mut order: Vec<usize> = (0..self.state.held.len())
            .filter(|&i| {
                /* NEITHER the clip about to be played NOR one something is
                reading — see `held_open`, which the audiobook export takes. */
                self.state.held[i].stem != keep && !self.reading(&self.state.held[i].stem)
            })
            .collect();
        order.sort_by_key(|&i| self.state.held[i].last_played_ms);
        /* ⚠️ **REMOVED AS THE LIST IS WALKED, AND IT USED TO BE CHOSEN FIRST AND
         * REMOVED AFTERWARDS — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** Two
         * defects lived in that order, and only the first had been fixed:
         *
         * 1. A row whose file would not go was DROPPED ANYWAY — `let _ =
         *    remove_file(…)` beside an unconditional `retain`. The bytes were
         *    reported as freed while the WAV was still on disk, so the accounting
         *    then said the store was inside its budget when it was not.
         * 2. And the candidate list was decided from the bytes the removals were
         *    ASSUMED to free, so one refusal ended the eviction with the store
         *    still over budget and removable clips still in the list. The fix for
         *    the first made this one reachable: the correction subtracted the
         *    refused bytes back out and then stopped.
         *
         * Walking and removing together answers both: the budget is measured
         * against what has ACTUALLY gone, and a refusal costs one candidate rather
         * than the whole pass. `removed` treats an already-absent file as success,
         * so a clip the disk has lost anyway still counts. */
        let mut drop: Vec<String> = Vec::new();
        let mut held = self.bytes();
        for i in order {
            if held <= self.budget {
                break;
            }
            let stem = self.state.held[i].stem.clone();
            if !removed(&self.layout.clips_dir, &stem) {
                log::warn!(
                    "voices: {stem} would not go, so the budget looks at the next clip instead"
                );
                continue;
            }
            held -= self.state.held[i].bytes;
            gone.bytes += self.state.held[i].bytes;
            gone.clips += 1;
            drop.push(stem);
        }
        /* `drop` now holds only what really went, so there is nothing to put
        back: a refusal never reached this list. */
        self.state.held.retain(|h| !drop.contains(&h.stem));
        self.write_state()?;
        if gone.clips > 0 {
            log::info!(
                "voices: {} rendered section(s), {} bytes, were removed to stay inside the budget",
                gone.clips,
                gone.bytes
            );
        }
        Ok(gone)
    }

    /// Whether something is reading this clip right now.
    ///
    /// ⚠️ **ONE PREDICATE, ASKED BY EVERY ROAD THAT REMOVES OR REPLACES — AND IT
    /// USED TO BE TWO INLINE `contains` CALLS IN THE TWO ROADS SOMEBODY THOUGHT
    /// OF.** Eviction and `forget` were guarded; `put`'s replacement and `find`'s
    /// three cleanup paths were not, so the lease promised a path would survive
    /// while four other roads could still take it (audit, 2026-09-30). Two
    /// failures of one shape are one defect: this is the shape, named once, so the
    /// next removal added here has an obvious question to ask.
    ///
    /// `Store::open`'s own reconciliation does NOT ask it, deliberately: the set
    /// is empty by construction until `open` has returned, so a guard there would
    /// be a branch no test could reach.
    fn reading(&self, stem: &str) -> bool {
        self.held_open.contains(stem)
    }

    /// Hold a clip open, so nothing removes it while it is being read.
    ///
    /// Answers whether there is a clip by that name to hold. A stem the
    /// checkpoint does not know is not held — the caller is asking about
    /// something this store did not write.
    pub fn hold(&mut self, stem: &str) -> bool {
        if !self.state.held.iter().any(|h| h.stem == stem) {
            return false;
        }
        self.held_open.insert(stem.to_owned());
        true
    }

    /// Let a clip go. Answers whether it was being held.
    ///
    /// ⚠️ **IDEMPOTENT, BECAUSE THE CALLER'S `finally` IS NOT THE ONLY ROAD
    /// OUT.** An export that fails, is stopped, or whose window closes must be
    /// able to release without knowing whether it ever held.
    pub fn release(&mut self, stem: &str) -> bool {
        self.held_open.remove(stem)
    }

    /// How many clips are being held open.
    #[must_use]
    pub fn holds(&self) -> usize {
        self.held_open.len()
    }

    /// Forget every clip, or every clip of one book.
    ///
    /// # Errors
    /// The underlying I/O failure while the checkpoint is written.
    pub fn forget(&mut self, book: Option<&str>) -> Result<Evicted> {
        let mut gone = Evicted::default();
        let drop: Vec<Held> = self
            .state
            .held
            .iter()
            /* ⚠️ **A CLIP SOMETHING IS READING IS NOT FORGOTTEN**, however
             * explicitly the reader asked: the audiobook export is holding it
             * open and deleting it would fail the export rather than free any
             * disk — the file stays until the last reader of it lets go. It is
             * offered again the next time. */
            .filter(|h| book.is_none_or(|b| h.key.book == b) && !self.reading(&h.stem))
            .cloned()
            .collect();
        /* As `evict`: a row whose file would not go is KEPT, or the count a reader
        is shown is bytes that are still on the disk. */
        let mut stayed: Vec<String> = Vec::new();
        for held in &drop {
            if removed(&self.layout.clips_dir, &held.stem) {
                gone.bytes += held.bytes;
                gone.clips += 1;
            } else {
                stayed.push(held.stem.clone());
            }
        }
        self.state
            .held
            .retain(|h| !drop.iter().any(|d| d.stem == h.stem) || stayed.contains(&h.stem));
        self.write_state()?;
        Ok(gone)
    }

    /// Write the checkpoint, durably and atomically.
    fn write_state(&self) -> Result<()> {
        self.state_written(&State {
            format: STATE_FORMAT,
            held: self.state.held.clone(),
        })
    }

    fn state_written(&self, state: &State) -> Result<()> {
        let bytes = serde_json::to_vec(state).map_err(|why| Error::Malformed {
            route: "audio/state.json".to_owned(),
            why: why.to_string(),
        })?;
        let temporary = self.layout.base.join("state.json.writing");
        write_durable(&temporary, &bytes)?;
        std::fs::rename(&temporary, &self.layout.state_path)?;
        /* AFTER the rename, for the reason the clips directory is synced after
        its own: the bytes were fsynced under the temporary name, and it is the
        DIRECTORY ENTRY that makes them reachable as the checkpoint. */
        sync_dir(&self.layout.base);
        Ok(())
    }
}

/// How long `frames` of mono audio lasts, in whole milliseconds, rounded DOWN.
///
/// ⚠️ **DOWN, AND THIS SAID "TO THE NEAREST" WHILE TRUNCATING — FOUND BY AN
/// INDEPENDENT AUDIT TWICE, 2026-09-30.** Truncation is the decision: a clip must
/// never claim to be longer than it is, because a mark past the end of the audio
/// is worse than one a millisecond early. What was wrong was the sentence, which
/// promised rounding and was cited as evidence that the code had a defect. A
/// comment that contradicts the code sends the next reader to fix the wrong half.
///
/// ⚠️ **IN FRAMES, CONVERTED ONCE.** `narrate::chapter_starts` records what the
/// other order costs: summing rounded milliseconds drifts, and forty chapters
/// each rounded down can put the last mark most of a second early.
///
/// The multiplication cannot overflow for any real argument — `u64::MAX / 1000`
/// frames is 585 million years of 24 kHz audio, and `frames` is the length of a
/// slice that is already in memory — so there is no `u128` here and no branch
/// that could not be reached.
#[must_use]
pub fn duration_ms(frames: usize, sample_rate: u32) -> u32 {
    if sample_rate == 0 {
        return 0;
    }
    let ms = (frames as u64 * 1000) / u64::from(sample_rate);
    u32::try_from(ms).unwrap_or(u32::MAX)
}

/// Take a clip's two files away, and say whether they really went.
///
/// ⚠️ **`NotFound` IS SUCCESS AND ANYTHING ELSE IS NOT.** A file that was already
/// gone is a file this does not have to remove; a file that REFUSED to go is
/// bytes still on the disk, and reporting them as freed is what makes the budget
/// a number with nothing behind it.
fn removed(clips: &Path, stem: &str) -> bool {
    /* A stem this module could not have written names nothing safe to remove —
    see `safe_stem`. Answering false keeps the row, which is what makes the
    orphan visible rather than acted on. */
    if !safe_stem(stem) {
        return false;
    }
    let gone = |path: PathBuf| match std::fs::remove_file(&path) {
        Ok(()) => true,
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => true,
        Err(why) => {
            log::warn!("voices: {} would not go: {why}", path.display());
            false
        }
    };
    let wav = gone(clips.join(format!("{stem}.wav")));
    let side = gone(clips.join(format!("{stem}.json")));
    wav && side
}

/// Fsync a directory, so an entry created in it survives a power failure.
///
/// Best effort, as the file sync is: a filesystem that refuses to open a
/// directory still performed the rename, and refusing the render over it would
/// be worse than the risk.
fn sync_dir(dir: &Path) {
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

/// Bytes to `path`, fsynced, with the directory fsynced after it.
///
/// ⚠️ **A `write` THAT HAS NOT REACHED THE DISK IS NOT A DURABLE ARTIFACT**, and
/// this whole module's promise is that a checkpoint never names a clip that
/// cannot be played. Without the fsync the rename can land and the bytes not,
/// which is exactly the state the ordering exists to make impossible.
fn write_durable(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    /* The DIRECTORY too, so the entry itself survives. Best effort: a
     * filesystem that refuses to open a directory still wrote the file, and
     * refusing the render over it would be worse than the risk. */
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

/// The checkpoint, or an empty one when there is no file.
///
/// ⚠️ **ABSENT AND UNREADABLE ARE TWO ANSWERS.** `settings.ts` spelled them the
/// same for months after the read-throw path was fixed, because the fix and the
/// defect used one word. Absent is empty; present-and-wrong is refused.
fn read_state(path: &Path) -> Result<State> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => return Ok(State::default()),
        Err(why) => return Err(why.into()),
    };
    let state: State = serde_json::from_slice(&bytes).map_err(|why| Error::Malformed {
        route: "audio/state.json".to_owned(),
        why: why.to_string(),
    })?;
    if state.format != STATE_FORMAT {
        return Err(Error::Malformed {
            route: "audio/state.json".to_owned(),
            why: format!(
                "this is format {}, and this build reads {STATE_FORMAT}",
                state.format
            ),
        });
    }
    Ok(state)
}

/// One clip's sidecar: `None` when there is no file, an error when there is one
/// that will not read.
fn read_sidecar(path: &Path) -> Result<Option<Sidecar>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(why) => return Err(why.into()),
    };
    let sidecar: Sidecar = serde_json::from_slice(&bytes).map_err(|why| Error::Malformed {
        route: path.display().to_string(),
        why: why.to_string(),
    })?;
    if sidecar.format != SIDECAR_FORMAT {
        return Err(Error::Malformed {
            route: path.display().to_string(),
            why: format!(
                "this is format {}, and this build reads {SIDECAR_FORMAT}",
                sidecar.format
            ),
        });
    }
    Ok(Some(sidecar))
}

/// Unix milliseconds. Monotonicity is not needed: this orders evictions, and a
/// clock that went backwards evicts in a slightly wrong order rather than
/// wrongly.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The marker Time Machine reads — see `tauri-plugin-passages`'s `paths.rs`,
/// which carries the whole account of what this attribute is and why it is on
/// the item rather than in a preference file.
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_XATTR: &str = "com.apple.metadata:com_apple_backup_excludeItem";
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_VALUE: &[u8] = b"com.apple.backupd";

/// Keep `audio/` out of Time Machine.
///
/// ⚠️ **NOT INHERITED FROM `passages/` OR `peer/` — AN EXTENDED ATTRIBUTE DOES
/// NOT TRAVEL TO A SIBLING**, and the reason here is its own. `peer/` is excluded
/// because a restored Mac must not come back as the peer it was copied from,
/// which is identity. `passages/` is excluded because its bytes are derived from
/// books the backup already carries. This one is both of those AND the largest:
/// five gigabytes of audio that a re-render reproduces exactly, which would
/// otherwise be backed up in full every time a reader listens to a new chapter.
///
/// Best effort, deliberately: a filesystem without extended attributes refuses
/// it, and a device that cannot mark its directory must still be able to read
/// aloud. The failure is logged, not raised.
#[cfg(target_os = "macos")]
fn exclude_from_backup(dir: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = CString::new(dir.as_os_str().as_bytes()) else {
        log::warn!(
            "voices: {} could not be excluded from backup: the path holds a NUL",
            dir.display()
        );
        return;
    };
    let name = CString::new(BACKUP_EXCLUDE_XATTR).expect("a literal without NUL");
    // SAFETY: two NUL-terminated strings that outlive the call, and a value
    // buffer whose length is passed beside its pointer; `setxattr` copies the
    // value and keeps no pointer to it.
    let rc = unsafe {
        libc::setxattr(
            path.as_ptr(),
            name.as_ptr(),
            BACKUP_EXCLUDE_VALUE.as_ptr().cast(),
            BACKUP_EXCLUDE_VALUE.len(),
            0,
            0,
        )
    };
    if rc != 0 {
        log::warn!(
            "voices: {} could not be excluded from backup: {}",
            dir.display(),
            std::io::Error::last_os_error()
        );
    }
}

/// Nothing to mark: Linux and Windows have no per-item backup exclusion.
#[cfg(not(target_os = "macos"))]
fn exclude_from_backup(_dir: &Path) {}

#[cfg(test)]
mod tests;

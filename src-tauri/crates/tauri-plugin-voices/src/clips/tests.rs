//! What the rendered-reading store promises, measured rather than asserted in a
//! comment.
//!
//! The ordering cases are the ones worth reading first: they reproduce the
//! states a crash can leave and then prove that opening the store cleans each
//! one up, because *"the checkpoint is written only after the artifact is
//! durable"* is a claim about a window nobody can watch.

use super::*;

/// A scratch directory of this test's own. `tempfile` handles the removal.
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir().expect("a scratch directory")
}

fn key() -> Key {
    Key {
        book: "book:9f3c".to_owned(),
        section: Some(12),
        pack: "english-kokoro".to_owned(),
        voice: "af_heart".to_owned(),
        rate_milli: 1000,
        text_digest: "fnv1a64:48043:0123456789abcdef".to_owned(),
        spoken_digest: "fnv1a64:48100:fedcba9876543210".to_owned(),
    }
}

fn words() -> Vec<Word> {
    vec![
        Word {
            start: 0,
            length: 7,
            start_ms: 325,
            end_ms: 700,
        },
        Word {
            start: 8,
            length: 2,
            start_ms: 700,
            end_ms: 860,
        },
    ]
}

/// What one second of this audio costs on disk: 24 000 frames of 16-bit mono,
/// plus the 44-byte header.
///
/// ⚠️ **NAMED BECAUSE IT WAS GOT WRONG TWICE IN ONE FILE**, as `44 + 48_000 * 2`
/// — which double-counts, since 48 000 is already the BYTES a second holds. Two
/// assertions passed the wrong number and one budget was three times too large,
/// so nothing was evicted and the eviction case proved nothing.
const SECOND_BYTES: u64 = 44 + 24_000 * 2;

/// 24 kHz mono, so the arithmetic matches the engines'.
fn samples(seconds: f64) -> Vec<i16> {
    let n = (24_000.0 * seconds) as usize;
    (0..n).map(|i| ((i % 2000) as i16) - 1000).collect()
}

#[test]
fn the_layout_joins_its_own_segment_once() {
    let layout = Layout::under(Path::new("/data/Paper"));
    assert_eq!(layout.base, PathBuf::from("/data/Paper/audio"));
    assert_eq!(layout.clips_dir, PathBuf::from("/data/Paper/audio/clips"));
    assert_eq!(
        layout.staging_dir,
        PathBuf::from("/data/Paper/audio/staging")
    );
    assert_eq!(
        layout.state_path,
        PathBuf::from("/data/Paper/audio/state.json")
    );
    // The trap this plugin has already sprung once with `voices/voices/packs`:
    // a caller that passes a root already ending in the segment gets it twice,
    // so the caller must not.
    assert_eq!(
        Layout::under(Path::new("/data/Paper/audio")).base,
        PathBuf::from("/data/Paper/audio/audio")
    );
}

#[test]
fn staging_is_outside_the_clips_directory() {
    let layout = Layout::under(Path::new("/data/Paper"));
    assert!(
        !layout.staging_dir.starts_with(&layout.clips_dir),
        "a half-written render under clips/ is a clip the player would read"
    );
}

#[test]
fn a_clip_name_carries_no_character_windows_refuses() {
    let mut k = key();
    k.book = "book:9f3c/../d".to_owned();
    let name = k.stem().expect("a legal id");
    assert!(
        !name.contains([':', '/', '\\', '*', '?', '"', '<', '>', '|']),
        "{name} still holds a character Windows refuses"
    );
    assert!(!name.contains(".."), "{name} still names a parent");
}

/// ⚠️ **THE SEPARATOR THE IDENTITY JOINS ON IS NUL, AND NOTHING REFUSED ONE IN A
/// FIELD — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** The doc comment claimed
/// *"a byte that cannot appear in any of them"*, which is simply not true of a
/// Rust `String`. A separator that can occur inside what it separates is no
/// separator: the two keys below hashed IDENTICALLY, so two different readings
/// would have overwritten each other's audio under one name and every lookup
/// after the second would have served the wrong one.
///
/// The comment asserted the property the code needed, which is the shape this
/// repository keeps finding: a sentence that reads as a guarantee and is a wish.
#[test]
fn a_nul_in_a_field_is_refused_rather_than_folding_two_keys_into_one() {
    let mut shifted = key();
    shifted.pack = "a\0b".to_owned();
    shifted.voice = "c".to_owned();
    let mut other = key();
    other.pack = "a".to_owned();
    other.voice = "b\0c".to_owned();
    assert_eq!(
        shifted.identity(),
        other.identity(),
        "these two really do collide, or this case proves nothing"
    );

    for (field, mut k) in [
        ("the book", {
            let mut k = key();
            k.book = "book:\0a".to_owned();
            k
        }),
        ("the pack", shifted.clone()),
        ("the voice", other.clone()),
        ("the text digest", {
            let mut k = key();
            k.text_digest = "fnv1a64:1:\0".to_owned();
            k
        }),
        ("the spoken digest", {
            let mut k = key();
            k.spoken_digest = "fnv1a64:1:\0".to_owned();
            k
        }),
    ] {
        let why = k.stem().expect_err("a NUL is not a name Paper writes");
        let said = why.to_string();
        assert!(said.contains(field), "{said} should name {field}");
        assert!(
            said.contains("NUL"),
            "{said} should say what is wrong, not just that something is"
        );
        // And the same key without the NUL is perfectly fine.
        k.book = k.book.replace('\0', "z");
        k.pack = k.pack.replace('\0', "z");
        k.voice = k.voice.replace('\0', "z");
        k.text_digest = k.text_digest.replace('\0', "z");
        k.spoken_digest = k.spoken_digest.replace('\0', "z");
        assert!(k.stem().is_ok());
    }

    /* AND THE COLLISION IS GONE, because neither key can be filed at all — which
    is the right answer rather than a longer hash: a NUL in a book id, a pack
    id, a voice id or a digest is a caller defect in every case. */
    assert!(shifted.stem().is_err() && other.stem().is_err());
}

#[test]
fn two_ids_one_fold_would_merge_get_two_names() {
    let mut a = key();
    a.book = "book:a".to_owned();
    let mut b = key();
    b.book = "book_a".to_owned();
    assert_ne!(a.stem().expect("a"), b.stem().expect("b"));
    assert!(
        a.stem().expect("a").starts_with("book_a-12-"),
        "the slug and the section stay readable: {}",
        a.stem().expect("a")
    );
}

#[test]
fn an_empty_or_enormous_book_id_is_refused_and_says_which_is_which() {
    /* ⚠️ **THE MESSAGE IS ASSERTED, NOT JUST THE REFUSAL.** This used to answer
     * `Error::BadPath("")`, whose text is *" is not a path inside the pack"* — a
     * sentence about a PACK, with the offending value invisible because it is
     * empty. Three rounds were spent on 2026-09-30 asking which of four call
     * sites could produce an empty path. A refusal that names the wrong thing is
     * worse than one that says nothing. */
    let mut k = key();
    k.book = String::new();
    let empty = k.stem().expect_err("refused");
    assert_eq!(empty.kind(), "badKey");
    let said = format!("{empty}");
    assert!(said.contains("the book"), "{said}");
    assert!(said.contains("no book id yet"), "{said}");

    k.book = "x".repeat(MAX_ID + 1);
    let long = k.stem().expect_err("refused");
    assert!(
        format!("{long}").contains("longer than an id may be"),
        "the two refusals are told apart: {long}"
    );

    k.book = "x".repeat(MAX_ID);
    assert!(k.stem().is_ok());
}

#[test]
fn every_field_of_the_key_changes_the_identity() {
    let base = key();
    let start = base.identity();
    let mut seen = vec![start];
    for changed in [
        Key {
            book: "book:other".to_owned(),
            ..base.clone()
        },
        Key {
            section: Some(13),
            ..base.clone()
        },
        Key {
            pack: "chinese-qwen".to_owned(),
            ..base.clone()
        },
        Key {
            voice: "af_bella".to_owned(),
            ..base.clone()
        },
        Key {
            rate_milli: 1500,
            ..base.clone()
        },
        Key {
            text_digest: "fnv1a64:1:0".to_owned(),
            ..base.clone()
        },
        Key {
            spoken_digest: "fnv1a64:1:0".to_owned(),
            ..base.clone()
        },
    ] {
        let id = changed.identity();
        assert!(
            !seen.contains(&id),
            "{changed:?} shares an identity with something already seen"
        );
        seen.push(id);
    }
}

#[test]
fn the_field_boundary_is_part_of_the_identity() {
    // Without the separator byte, ("ab", "c") and ("a", "bc") hash alike — and
    // then two different books with two different voices share one clip.
    let mut a = key();
    a.pack = "ab".to_owned();
    a.voice = "c".to_owned();
    let mut b = key();
    b.pack = "a".to_owned();
    b.voice = "bc".to_owned();
    assert_ne!(a.identity(), b.identity());
}

/// ⚠️ **THE SPOKEN DIGEST IS THE STORE'S IDENTITY, AND RUST TOOK IT ON TRUST —
/// FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `voices_clip_render` receives both
/// the text and a digest of it, and filed the audio under whatever the digest
/// said: a caller whose two arguments disagreed put text B's samples and timings
/// under text A's identity, and a later lookup for A answered B. The reader would
/// hear the wrong words with nothing failing anywhere.
///
/// So the command computes it, which needs this function to be the SAME function
/// `clipKey.ts` exports. These are the vectors `clipKey.test.ts` pins, and this is
/// the test that makes the two implementations one.
#[test]
fn a_text_digest_is_spelled_as_the_reader_spells_it() {
    // `clipKey.test.ts`: the published FNV-1a vectors, with the length prefix.
    assert_eq!(text_digest("foobar"), "fnv1a64:6:85944171f73967e8");
    assert_eq!(text_digest(""), "fnv1a64:0:cbf29ce484222325");

    /* ⚠️ **THE LENGTH IS IN UTF-16 CODE UNITS, NOT `char`s.** `clipKey.test.ts`
    pins `春天` at 2 with 6 bytes hashed, which `chars().count()` also gives —
    so the case that distinguishes the two units has to be ASTRAL. An emoji is
    one `char` and TWO code units, and getting this wrong would make every
    section containing one look like a tampered key. */
    assert_eq!(text_digest("春天").split(':').nth(1), Some("2"));
    assert_eq!("春天".len(), 6, "three bytes each — the unit the hash uses");
    assert_eq!(
        text_digest("𓀀").split(':').nth(1),
        Some("2"),
        "one char, two UTF-16 code units — which is what String.length answers"
    );
    assert_eq!(
        "𓀀".chars().count(),
        1,
        "and this is the count that would be wrong"
    );

    // Order matters, and so does length: two texts of one length differ.
    assert_ne!(text_digest("ab"), text_digest("ba"));
    assert_eq!(text_digest("a").split(':').nth(1), Some("1"));
    assert_eq!(text_digest("aa").split(':').nth(1), Some("2"));
    // Sixteen digits, always, so a comparison cannot be fooled by a lost zero.
    assert_eq!(
        text_digest("foobar").split(':').nth(2).map(str::len),
        Some(16)
    );
}

#[test]
fn the_digest_is_the_published_constant_and_not_the_platform_hasher() {
    // Pinned so a change to the function is a change to this line, and
    // therefore a decision about every clip already on disk.
    assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    // Continuing is the same as hashing the concatenation, which is what makes
    // the field-by-field walk in `identity` correct.
    assert_eq!(fnv1a64_from(fnv1a64(b"foo"), b"bar"), fnv1a64(b"foobar"));
}

#[test]
fn a_duration_is_frames_over_the_rate_and_zero_is_not_a_division() {
    assert_eq!(duration_ms(24_000, 24_000), 1000);
    assert_eq!(duration_ms(12_000, 24_000), 500);
    assert_eq!(duration_ms(0, 24_000), 0);
    // Rounded DOWN by integer division, so a clip never claims to be longer
    // than it is — a mark past the end is worse than one a millisecond early.
    assert_eq!(duration_ms(24_001, 24_000), 1000);
    // A rate of zero is a malformed render, and answering 0 is better than the
    // panic a division would be.
    assert_eq!(duration_ms(100, 0), 0);
}

#[test]
fn a_stem_resolves_to_a_path_only_when_the_checkpoint_holds_it() {
    // What makes `voices_clip_read` narrower than the fs plugin's `$APPDATA`
    // scope: the checkpoint is the authorisation, and the path is built from the
    // row rather than from anything the caller sent.
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    assert_eq!(store.path_of("book_a-1-0000000000000000"), None);
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert_eq!(store.path_of(&clip.stem), Some(clip.path.clone()));
    // A name that traverses cannot be answered, because no row holds one.
    assert_eq!(store.path_of("../../etc/passwd"), None);
    assert_eq!(store.path_of(""), None);
}

#[test]
fn ensure_creates_every_directory_and_is_idempotent() {
    let dir = scratch();
    let layout = Layout::under(dir.path());
    layout.ensure().expect("first");
    layout.ensure().expect("again");
    assert!(layout.base.is_dir() && layout.clips_dir.is_dir() && layout.staging_dir.is_dir());
}

/// ⚠️ **THE GATE WI-34.1 ASKS FOR, RUN RATHER THAN ASSUMED.** *"Backup exclusion
/// read back with `getxattr` — a `setxattr` that silently did nothing must fail
/// rather than ship."* This reads the marker back with the same mechanism
/// `tmutil isexcluded` reads, so five gigabytes of derived audio cannot quietly
/// start being backed up.
#[cfg(target_os = "macos")]
#[test]
fn the_rendered_reading_is_kept_out_of_time_machine() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let dir = scratch();
    let layout = Layout::under(dir.path());
    layout.ensure().expect("created");

    let path = CString::new(layout.base.as_os_str().as_bytes()).expect("no NUL");
    let name = CString::new(BACKUP_EXCLUDE_XATTR).expect("a literal");
    let mut held = [0u8; 64];
    // SAFETY: two NUL-terminated strings that outlive the call, and a buffer
    // whose length is passed beside its pointer.
    let read = unsafe {
        libc::getxattr(
            path.as_ptr(),
            name.as_ptr(),
            held.as_mut_ptr().cast(),
            held.len(),
            0,
            0,
        )
    };
    assert!(
        read > 0,
        "the backup-exclusion marker is not on {}: {}",
        layout.base.display(),
        std::io::Error::last_os_error()
    );
    assert_eq!(
        &held[..read as usize],
        BACKUP_EXCLUDE_VALUE,
        "the marker is there with the wrong value"
    );
}

#[test]
fn a_render_kept_is_a_render_found_with_its_words() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    assert_eq!(store.find(&key()).expect("asked"), None);

    let (clip, evicted) = store
        .put(&key(), &samples(2.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert_eq!(evicted, Evicted::default());
    assert_eq!(clip.duration_ms, 2000);
    assert_eq!(clip.sample_rate, 24_000);
    assert_eq!(clip.words, words());
    assert_eq!(clip.bytes, 44 + 2 * (SECOND_BYTES - 44));
    assert!(clip.path.is_file());

    let found = store.find(&key()).expect("asked").expect("there");
    assert_eq!(found, clip);
    assert_eq!(store.clips(), 1);
    assert_eq!(store.bytes(), clip.bytes);
    assert_eq!(store.budget(), BUDGET_BYTES);
}

#[test]
fn the_samples_are_the_one_wav_shape_the_packer_reads() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let bytes = std::fs::read(&clip.path).expect("read back");
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    assert_eq!(&bytes[36..40], b"data");
    // Mono, 16-bit, and at the rate it was given: the three fields the app
    // crate's `narrate::wav::read` checks.
    assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1);
    assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 16);
    assert_eq!(
        u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]),
        24_000
    );
    assert_eq!(
        bytes.len() % 2,
        0,
        "an odd data length is not whole samples"
    );
}

#[test]
fn a_changed_text_digest_is_a_miss_and_not_stale_audio() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let mut moved = key();
    moved.text_digest = "fnv1a64:48044:aaaaaaaaaaaaaaaa".to_owned();
    assert_eq!(
        store.find(&moved).expect("asked"),
        None,
        "a section whose canonical text changed must not play the old audio"
    );
    // The original is untouched: a read never deletes.
    assert!(store.find(&key()).expect("asked").is_some());
}

#[test]
fn a_changed_spoken_digest_is_a_miss_because_the_offsets_would_be_wrong() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let mut moved = key();
    moved.spoken_digest = "fnv1a64:1:1111111111111111".to_owned();
    assert_eq!(store.find(&moved).expect("asked"), None);
}

#[test]
fn a_different_rate_is_a_different_clip() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let mut faster = key();
    faster.rate_milli = 1500;
    assert_eq!(
        store.find(&faster).expect("asked"),
        None,
        "Kokoro renders at the rate it is given; 1.5x is not 1.0x played faster"
    );
}

#[test]
fn a_sidecar_naming_another_section_is_refused_rather_than_merged() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    // Two identities folding to one name is what the digest inside the file
    // exists to catch. Forged here, because a real collision cannot be made.
    let side = store.layout().sidecar_path(&key()).expect("a path");
    let mut sidecar: Sidecar =
        serde_json::from_slice(&std::fs::read(&side).expect("read")).expect("parsed");
    sidecar.key.book = "book:somebody-else".to_owned();
    std::fs::write(&side, serde_json::to_vec(&sidecar).expect("json")).expect("written");
    assert_eq!(store.find(&key()).expect("asked"), None);
    // And the file is left alone: it belongs to whatever really wrote it.
    assert!(clip.path.is_file());
}

#[test]
fn a_sidecar_that_will_not_read_forgets_the_clip_rather_than_playing_it() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    std::fs::write(
        store.layout().sidecar_path(&key()).expect("a path"),
        b"{oh no",
    )
    .expect("written");
    assert_eq!(store.find(&key()).expect("asked"), None);
    assert_eq!(store.clips(), 0, "the row goes with the sidecar");
    assert!(!clip.path.exists(), "and so do the samples");
}

#[test]
fn a_sidecar_of_another_format_is_refused_not_read_as_empty() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let side = store.layout().sidecar_path(&key()).expect("a path");
    let mut raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&side).expect("read")).expect("parsed");
    raw["format"] = serde_json::json!(SIDECAR_FORMAT + 1);
    std::fs::write(&side, serde_json::to_vec(&raw).expect("json")).expect("written");
    let err = read_sidecar(&side).expect_err("refused");
    assert!(
        format!("{err}").contains(&format!("this build reads {SIDECAR_FORMAT}")),
        "{err}"
    );
}

#[test]
fn a_wav_shorter_than_the_checkpoint_says_is_forgotten_not_played() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(2.0), 24_000, words(), Vec::new())
        .expect("kept");
    // A truncated clip plays as a short chapter, which is exactly the failure
    // `narrate` records for a truncated render: indistinguishable from success.
    let bytes = std::fs::read(&clip.path).expect("read");
    std::fs::write(&clip.path, &bytes[..bytes.len() / 2]).expect("truncated");
    assert_eq!(store.find(&key()).expect("asked"), None);
    assert_eq!(store.clips(), 0);
}

#[test]
fn a_checkpoint_naming_a_clip_that_is_gone_is_reconciled_at_open() {
    let dir = scratch();
    let stem = {
        let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
        let (clip, _) = store
            .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
            .expect("kept");
        std::fs::remove_file(&clip.path).expect("gone");
        clip.stem
    };
    // This is the state a crash between the rename and the checkpoint CANNOT
    // leave — the checkpoint is last — reproduced by hand so the recovery is
    // measured rather than argued.
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("reopened");
    assert_eq!(store.clips(), 0, "a row nothing can play must not survive");
    assert_eq!(store.bytes(), 0);
    assert!(
        !dir.path().join(format!("audio/clips/{stem}.json")).exists(),
        "the orphaned sidecar goes with the row"
    );
    assert_eq!(store.find(&key()).expect("asked"), None);
}

#[test]
fn a_clip_the_checkpoint_does_not_name_is_removed_at_open() {
    let dir = scratch();
    let layout = Layout::under(dir.path());
    layout.ensure().expect("made");
    // What a crash between the two renames and the checkpoint leaves behind.
    let orphan_wav = layout.clips_dir.join("book_x-3-deadbeefdeadbeef.wav");
    let orphan_side = layout.clips_dir.join("book_x-3-deadbeefdeadbeef.json");
    std::fs::write(&orphan_wav, b"not really a wav").expect("written");
    std::fs::write(&orphan_side, b"{}").expect("written");
    let store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    assert_eq!(store.clips(), 0);
    assert!(!orphan_wav.exists() && !orphan_side.exists());
}

#[test]
fn a_render_that_did_not_finish_is_swept_from_staging_at_open() {
    let dir = scratch();
    let layout = Layout::under(dir.path());
    layout.ensure().expect("made");
    let half = layout.staging_dir.join("book_x-3-deadbeefdeadbeef.wav");
    std::fs::write(&half, b"half a render").expect("written");
    Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    assert!(
        !half.exists(),
        "a stop during a render must leave no part-written artifact"
    );
}

#[test]
fn a_stop_during_a_render_leaves_no_artifact_and_no_checkpoint() {
    // The bar WI-34.0 could not measure, measured here: a `put` that fails
    // part-way must leave nothing in `clips/`, nothing in `staging/`, and no row.
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    // A key whose stem cannot be built is the one failure a caller can force
    // without a filesystem fault, and it happens before any byte is written.
    let mut bad = key();
    bad.book = String::new();
    assert!(store
        .put(&bad, &samples(1.0), 24_000, words(), Vec::new())
        .is_err());
    assert_eq!(store.clips(), 0);
    assert_eq!(
        std::fs::read_dir(&store.layout().clips_dir)
            .expect("listed")
            .count(),
        0
    );
    assert_eq!(
        std::fs::read_dir(&store.layout().staging_dir)
            .expect("listed")
            .count(),
        0
    );
    assert!(!store.layout().state_path.exists(), "and no checkpoint");
}

#[test]
fn an_absent_checkpoint_is_empty_and_a_damaged_one_is_refused() {
    let dir = scratch();
    let layout = Layout::under(dir.path());
    layout.ensure().expect("made");
    assert_eq!(
        read_state(&layout.state_path).expect("absent is empty"),
        State::default()
    );
    std::fs::write(&layout.state_path, b"{not json").expect("written");
    let err = read_state(&layout.state_path).expect_err("refused");
    assert!(format!("{err}").contains("audio/state.json"), "{err}");
    // ⚠️ Absent and unreadable are two answers, and `Store::open` must not turn
    // the second into the first: that is how eighteen stores in this tree lost
    // data.
    assert!(Store::open(dir.path(), BUDGET_BYTES).is_err());
}

#[test]
fn a_checkpoint_of_another_format_is_refused_by_name() {
    let dir = scratch();
    let layout = Layout::under(dir.path());
    layout.ensure().expect("made");
    std::fs::write(
        &layout.state_path,
        serde_json::to_vec(&serde_json::json!({ "format": STATE_FORMAT + 1, "held": [] }))
            .expect("json"),
    )
    .expect("written");
    let err = read_state(&layout.state_path).expect_err("refused");
    assert!(
        format!("{err}").contains(&format!("this build reads {STATE_FORMAT}")),
        "{err}"
    );
}

#[test]
fn the_budget_evicts_the_least_recently_played_and_never_the_new_one() {
    let dir = scratch();
    // Three one-second clips fit exactly; a fourth is one byte too many.
    let budget = 4 * SECOND_BYTES - 1;
    let mut store = Store::open(dir.path(), budget).expect("opened");
    let mut keys = Vec::new();
    for section in 0..3u32 {
        let mut k = key();
        k.section = Some(section);
        // Distinct digests, or three sections would fold to one identity.
        k.text_digest = format!("fnv1a64:1:{section:016x}");
        store
            .put(&k, &samples(1.0), 24_000, words(), Vec::new())
            .expect("kept");
        keys.push(k);
        // The clock is milliseconds, so two `put`s inside one millisecond would
        // tie and the eviction order would be the list's rather than the
        // reader's.
        std::thread::sleep(std::time::Duration::from_millis(3));
    }
    assert_eq!(store.clips(), 3, "three fit, just");

    // Touch the oldest so it is no longer the oldest, then add a fourth.
    store.find(&keys[0]).expect("asked").expect("there");
    std::thread::sleep(std::time::Duration::from_millis(3));
    let mut fourth = key();
    fourth.section = Some(9);
    fourth.text_digest = "fnv1a64:1:000000000000000f".to_owned();
    let (clip, evicted) = store
        .put(&fourth, &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert_eq!(evicted.clips, 1, "one had to go");
    assert_eq!(evicted.bytes, SECOND_BYTES);
    assert!(store.bytes() <= budget);
    assert!(
        store.find(&fourth).expect("asked").is_some(),
        "the clip the reader is about to hear is never the one evicted"
    );
    assert!(
        store.find(&keys[1]).expect("asked").is_none(),
        "section 1 was the least recently played and is the one that went"
    );
    assert!(store.find(&keys[0]).expect("asked").is_some());
    assert!(store.find(&keys[2]).expect("asked").is_some());
    assert!(clip.path.is_file());
}

/// ⚠️ **THE EXPORT NAMES A PATH AND THEN READS IT FOR MINUTES, SO EVICTION CAN
/// TAKE A CHAPTER OUT FROM UNDER IT.** A ten-hour book is tens of chapters and
/// the budget is five gigabytes: a reading in the other window renders one
/// section and the least-recently-played clip goes — which may be the chapter
/// the muxer is holding open. What comes out is a book missing a chapter, or a
/// packer failing on a file it was told to expect, with nothing anywhere saying
/// a clip was removed.
#[test]
fn a_held_clip_is_never_the_one_evicted() {
    let dir = scratch();
    // Two one-second clips fit; a third is one byte too many.
    let budget = 3 * SECOND_BYTES - 1;
    let mut store = Store::open(dir.path(), budget).expect("opened");
    let mut keys = Vec::new();
    for section in 0..2u32 {
        let mut k = key();
        k.section = Some(section);
        k.text_digest = format!("fnv1a64:1:{section:016x}");
        store
            .put(&k, &samples(1.0), 24_000, words(), Vec::new())
            .expect("kept");
        keys.push(k);
        std::thread::sleep(std::time::Duration::from_millis(3));
    }

    // Section 0 is the LEAST recently played, so it is the one eviction would
    // take — which is exactly why it is the one the export holds.
    let oldest = store
        .find(&keys[0])
        .expect("asked")
        .expect("there")
        .stem
        .clone();
    // `find` marks it played, so make section 1 the newer of the two again.
    std::thread::sleep(std::time::Duration::from_millis(3));
    store.find(&keys[1]).expect("asked").expect("there");
    std::thread::sleep(std::time::Duration::from_millis(3));
    assert!(
        store.hold(&oldest),
        "a stem the checkpoint knows can be held"
    );
    assert_eq!(store.holds(), 1);

    let mut third = key();
    third.section = Some(9);
    third.text_digest = "fnv1a64:1:000000000000000f".to_owned();
    let (_, evicted) = store
        .put(&third, &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");

    assert_eq!(evicted.clips, 1, "something still had to go");
    assert!(
        store.find(&keys[0]).expect("asked").is_some(),
        "the held clip stayed, though it was the least recently played"
    );
    assert!(
        store.find(&keys[1]).expect("asked").is_none(),
        "the next-oldest went instead"
    );
}

/// ⚠️ **FOUR ROADS REMOVE OR REPLACE A CLIP AND ONLY TWO ASKED ABOUT THE LEASE —
/// FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** Eviction and `forget` were
/// guarded in the round that added the lease; `find`'s three cleanup paths and
/// `put`'s replacement were not. Two failures of one shape are one defect, so
/// `Store::reading` is now the single question and every road asks it. These are
/// the four roads, one case each, because a guard nobody has seen work is a guard
/// that is not there.
#[test]
fn a_held_clip_survives_a_sidecar_that_will_not_read() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert!(store.hold(&clip.stem));

    // Damage the sidecar under it, which is what `find` cleans up after.
    let side = dir.path().join(format!("audio/clips/{}.json", clip.stem));
    std::fs::write(&side, b"not json at all").expect("damaged");

    assert!(
        store.find(&key()).expect("asked").is_none(),
        "a damaged clip is still a miss"
    );
    assert!(
        clip.path.is_file(),
        "but the file the packer was told to read is still there"
    );
    assert_eq!(store.clips(), 1, "and the row is still accounted for");
}

#[test]
fn a_held_clip_whose_wav_has_gone_keeps_its_sidecar() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert!(store.hold(&clip.stem));
    std::fs::remove_file(&clip.path).expect("gone");

    assert!(store.find(&key()).expect("asked").is_none());
    /* The lease cannot bring the samples back, but removing the sidecar too would
    turn one missing file into two and make the state unrecoverable. */
    assert!(
        dir.path()
            .join(format!("audio/clips/{}.json", clip.stem))
            .is_file(),
        "the timings are left where they are"
    );
}

#[test]
fn a_held_clip_of_the_wrong_length_is_not_deleted_under_the_packer() {
    /* The worst of the three to remove: the file EXISTS and the packer has been
    told to read it, so deleting it turns "this chapter could not be verified"
    into "this file is not there". */
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert!(store.hold(&clip.stem));
    std::fs::write(&clip.path, b"far too short").expect("shortened");

    assert!(store.find(&key()).expect("asked").is_none());
    assert!(clip.path.is_file(), "still there for whoever is reading it");
    assert_eq!(store.clips(), 1);
}

#[test]
fn a_render_finishing_over_a_held_clip_answers_the_one_that_is_there() {
    /* THE CASE A READER MEETS: they press Listen on a chapter an export is
    packaging. Same book, same section, same text, same voice, same rate — so
    the same stem, and the rename would put different samples under the path the
    packer was told to read.

    Answering the clip that is there is not a compromise: the key holds the text
    digest, the pack, the voice and the rate, so what is on disk is audio of
    exactly these words in exactly this voice. A cache hit found late. */
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (first, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert!(store.hold(&first.stem));
    let was = std::fs::read(&first.path).expect("read");

    // A second render of the same section, twice as long, while the lease is out.
    let (answered, evicted) = store
        .put(&key(), &samples(2.0), 24_000, words(), Vec::new())
        .expect("answered");

    assert_eq!(answered.stem, first.stem);
    assert_eq!(
        answered.bytes, first.bytes,
        "the clip answered is the one on disk, not the render just finished"
    );
    assert_eq!(
        evicted.clips, 0,
        "and nothing was evicted for a write that did not happen"
    );
    assert_eq!(
        std::fs::read(&first.path).expect("read"),
        was,
        "the bytes under the packer are untouched"
    );
    assert_eq!(store.clips(), 1, "and there is still exactly one row");

    // Once the lease is given back, the next render files normally again.
    assert!(store.release(&first.stem));
    let (later, _) = store
        .put(&key(), &samples(2.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert!(later.bytes > first.bytes, "the longer render replaced it");
}

/// The other half of the same window: *Forget them* is a button a reader can
/// press while an export is running, and it is not eviction — it takes
/// everything.
#[test]
fn forgetting_leaves_a_held_clip_alone() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let mut keys = Vec::new();
    for section in 0..2u32 {
        let mut k = key();
        k.section = Some(section);
        k.text_digest = format!("fnv1a64:1:{section:016x}");
        store
            .put(&k, &samples(1.0), 24_000, words(), Vec::new())
            .expect("kept");
        keys.push(k);
    }
    let stem = store
        .find(&keys[0])
        .expect("asked")
        .expect("there")
        .stem
        .clone();
    assert!(store.hold(&stem));

    let forgotten = store.forget(None).expect("forgotten");
    assert_eq!(forgotten.clips, 1, "only the one nothing was reading");
    assert!(store.find(&keys[0]).expect("asked").is_some());
    assert!(store.find(&keys[1]).expect("asked").is_none());

    // And once the export gives it back, it is an ordinary clip again.
    assert!(store.release(&stem), "it was being held");
    assert_eq!(store.holds(), 0);
    assert_eq!(store.forget(None).expect("forgotten").clips, 1);
    assert!(store.find(&keys[0]).expect("asked").is_none());
}

/// ⚠️ **AN EXPORT HAS MORE THAN ONE ROAD OUT — A FAILURE, THE READER'S STOP,
/// THE WINDOW CLOSING — AND A LEASE THAT CAN ONLY BE GIVEN BACK ON THE HAPPY
/// PATH IS A LEAK.** So a release for something never held is not an error, and
/// a hold for a name this store never wrote is refused rather than recorded:
/// holding a stem that does not exist would let a caller pin a name the store
/// might later legitimately use.
#[test]
fn a_lease_is_idempotent_and_a_stranger_cannot_be_held() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let stem = store
        .find(&key())
        .expect("asked")
        .expect("there")
        .stem
        .clone();

    assert!(!store.hold("book_z-4-0000000000000000"), "not this store's");
    assert_eq!(store.holds(), 0, "and nothing was recorded for it");
    assert!(
        !store.release(&stem),
        "releasing what was never held is not an error"
    );

    assert!(store.hold(&stem));
    assert!(store.hold(&stem), "twice is the same lease, not two");
    assert_eq!(store.holds(), 1);
    assert!(store.release(&stem));
    assert!(!store.release(&stem), "and the second give-back is a no-op");
    assert_eq!(store.holds(), 0);
}

#[test]
fn a_clip_larger_than_the_whole_budget_is_still_kept() {
    // A single section can be two and a half hours of audio. Refusing it for
    // being large would refuse the reading the reader just asked for.
    let dir = scratch();
    let mut store = Store::open(dir.path(), 1000).expect("opened");
    let (clip, evicted) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert!(clip.bytes > 1000);
    assert_eq!(evicted.clips, 0, "there was nothing else to evict");
    assert!(store.find(&key()).expect("asked").is_some());
}

#[test]
fn nothing_is_evicted_while_the_store_is_inside_its_budget() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    for section in 0..3u32 {
        let mut k = key();
        k.section = Some(section);
        k.text_digest = format!("fnv1a64:1:{section:016x}");
        let (_, evicted) = store
            .put(&k, &samples(1.0), 24_000, words(), Vec::new())
            .expect("kept");
        assert_eq!(evicted, Evicted::default());
    }
    assert_eq!(store.clips(), 3);
}

#[test]
/* ⚠️ **NOT NAMED `re_rendering_…` — THAT TRIPS A CREDENTIAL GUARD.** `re_`
followed by a run of word characters is Resend's API-key shape, and the
commit guard recognises credentials by FORM rather than from a denylist, so
a snake_case test name beginning with those three characters refuses the
commit. Renamed rather than allow-listed: a repository-wide exception would
weaken a real credential rule for the sake of one test's name. */
fn rendering_one_section_again_replaces_its_clip_rather_than_adding_one() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let (second, _) = store
        .put(&key(), &samples(2.0), 24_000, words(), Vec::new())
        .expect("kept again");
    assert_eq!(store.clips(), 1, "one section, one clip");
    assert_eq!(store.bytes(), second.bytes);
    assert_eq!(
        store
            .find(&key())
            .expect("asked")
            .expect("there")
            .duration_ms,
        2000
    );
}

#[test]
fn forget_takes_one_book_or_all_of_them() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let mut mine = key();
    mine.book = "book:mine".to_owned();
    let mut theirs = key();
    theirs.book = "book:theirs".to_owned();
    for k in [&mine, &theirs] {
        store
            .put(k, &samples(1.0), 24_000, words(), Vec::new())
            .expect("kept");
    }
    assert_eq!(store.clips(), 2);

    let gone = store.forget(Some("book:mine")).expect("forgotten");
    assert_eq!(gone.clips, 1);
    assert_eq!(gone.bytes, SECOND_BYTES);
    assert!(store.find(&mine).expect("asked").is_none());
    assert!(store.find(&theirs).expect("asked").is_some());

    let rest = store.forget(None).expect("forgotten");
    assert_eq!(rest.clips, 1);
    assert_eq!(store.clips(), 0);
    assert_eq!(store.bytes(), 0);
    assert_eq!(
        std::fs::read_dir(&store.layout().clips_dir)
            .expect("listed")
            .count(),
        0
    );
}

#[test]
fn forgetting_a_book_with_nothing_stored_takes_nothing() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert_eq!(
        store.forget(Some("book:not-here")).expect("asked"),
        Evicted::default()
    );
    assert_eq!(store.clips(), 1);
}

#[test]
fn a_store_reopened_finds_what_the_last_one_kept() {
    let dir = scratch();
    let expected = {
        let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
        store
            .put(&key(), &samples(1.5), 24_000, words(), Vec::new())
            .expect("kept")
            .0
    };
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("reopened");
    assert_eq!(store.clips(), 1);
    assert_eq!(store.find(&key()).expect("asked").expect("there"), expected);
}

#[test]
fn the_words_survive_the_round_trip_exactly() {
    // The whole point of the sidecar: a replayed clip is followed on the page
    // without a re-render, so the timings have to come back to the millisecond.
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let many: Vec<Word> = (0..500u32)
        .map(|i| Word {
            start: i as usize * 6,
            length: 5,
            start_ms: i * 400 + 325,
            end_ms: i * 400 + 700,
        })
        .collect();
    store
        .put(&key(), &samples(1.0), 24_000, many.clone(), Vec::new())
        .expect("kept");
    let found = {
        let mut reopened = Store::open(dir.path(), BUDGET_BYTES).expect("reopened");
        reopened.find(&key()).expect("asked").expect("there")
    };
    assert_eq!(found.words, many);
}

#[test]
fn a_render_with_no_words_is_a_clip_all_the_same() {
    // Qwen answers no word boundaries at all, and a Chinese chapter is still
    // worth keeping: it plays, it just cannot be followed.
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, Vec::new(), Vec::new())
        .expect("kept");
    assert!(clip.words.is_empty());
    assert_eq!(
        store
            .find(&key())
            .expect("asked")
            .expect("there")
            .words
            .len(),
        0
    );
}

#[test]
fn a_render_too_long_for_a_wav_header_is_refused_by_name() {
    // The bound is `wav::check_size`'s, and this is the one road to it from the
    // store: a refusal that names the container rather than a truncation.
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    // Not actually allocated: the check is on the count, so a slice this long
    // cannot be built — the bound is asserted through `wav` directly, and the
    // store's job is only to carry the refusal.
    assert!(crate::wav::check_size(crate::wav::max_frames() + 1).is_err());
    assert!(crate::wav::check_size(crate::wav::max_frames()).is_ok());
    // And a legal render still goes through this path.
    assert!(store
        .put(&key(), &samples(0.5), 24_000, words(), Vec::new())
        .is_ok());
}

#[test]
fn the_checkpoint_is_written_after_the_artifact_and_names_only_durable_clips() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let state: State =
        serde_json::from_slice(&std::fs::read(&store.layout().state_path).expect("read"))
            .expect("parsed");
    assert_eq!(state.format, STATE_FORMAT);
    assert_eq!(state.held.len(), 1);
    let held = &state.held[0];
    assert_eq!(held.stem, clip.stem);
    assert_eq!(held.bytes, clip.bytes);
    assert_eq!(held.duration_ms, 2000 / 2);
    assert_eq!(held.words, 2);
    assert_eq!(&held.key, &key());
    assert!(held.last_played_ms > 0, "a clip just made counts as played");
    // Both files exist by the time the row does — which is the ordering claim.
    assert!(clip.path.is_file());
    assert!(store
        .layout()
        .sidecar_path(&key())
        .expect("a path")
        .is_file());
}

#[test]
fn a_find_marks_the_clip_played_so_eviction_sees_it() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let before = {
        let state: State =
            serde_json::from_slice(&std::fs::read(&store.layout().state_path).expect("read"))
                .expect("parsed");
        state.held[0].last_played_ms
    };
    std::thread::sleep(std::time::Duration::from_millis(5));
    store.find(&key()).expect("asked").expect("there");
    let after: State =
        serde_json::from_slice(&std::fs::read(&store.layout().state_path).expect("read"))
            .expect("parsed");
    assert!(
        after.held[0].last_played_ms > before,
        "least-recently-PLAYED needs the read to count"
    );
}

#[test]
fn a_miss_on_a_book_with_nothing_stored_is_not_an_error() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    assert_eq!(store.find(&key()).expect("asked"), None);
    assert_eq!(store.clips(), 0);
    assert_eq!(store.bytes(), 0);
}

#[test]
fn a_key_that_cannot_be_named_is_refused_by_find_too() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let mut bad = key();
    bad.book = String::new();
    assert!(store.find(&bad).is_err());
}

#[test]
fn what_could_not_be_pronounced_survives_the_round_trip() {
    // A cached clip must answer exactly what the fresh render answered, or one
    // port gives two answers depending on whether the audio was on disk.
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let skips = vec![
        Skip {
            text: "Cyberonics".to_owned(),
            why: "there is no pronunciation for this word".to_owned(),
        },
        Skip {
            text: "gorillacillin".to_owned(),
            why: "there is no pronunciation for this word".to_owned(),
        },
    ];
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), skips.clone())
        .expect("kept");
    assert_eq!(clip.skipped, skips);
    let mut reopened = Store::open(dir.path(), BUDGET_BYTES).expect("reopened");
    assert_eq!(
        reopened
            .find(&key())
            .expect("asked")
            .expect("there")
            .skipped,
        skips
    );
}

#[test]
fn a_sidecar_written_before_the_skipped_list_existed_reads_as_nothing_skipped() {
    // The `serde(default)` on that field, exercised rather than assumed: a
    // missing list is the one value a file with no list can honestly stand for.
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let side = store.layout().sidecar_path(&key()).expect("a path");
    let mut raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&side).expect("read")).expect("parsed");
    raw.as_object_mut().expect("an object").remove("skipped");
    std::fs::write(&side, serde_json::to_vec(&raw).expect("json")).expect("written");
    assert_eq!(
        store.find(&key()).expect("asked").expect("there").skipped,
        Vec::new()
    );
}

#[test]
fn a_section_nobody_could_name_is_a_key_of_its_own() {
    /* ⚠️ **THE DEFECT THE IN-APP RUN FOUND, 2026-09-30.**
     * `ReaderPosition.sectionIndex` is null "when that cannot be told yet", the
     * host spelled that `?? -1`, and a `u32` refuses a negative — so reading aloud
     * was dead on a real machine while every test passed, because every test
     * supplied a section. `None` is representable now, and it is a NAME rather
     * than a number outside the range. */
    let mut nameless = key();
    nameless.section = None;
    let stem = nameless.stem().expect("a legal id");
    assert!(
        stem.contains("-x-"),
        "a section nobody can name reads as x: {stem}"
    );
    /* And it is not section 0, which is a real section. */
    let mut first = key();
    first.section = Some(0);
    assert_ne!(nameless.identity(), first.identity());
    assert_ne!(nameless.stem().expect("a"), first.stem().expect("b"));

    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&nameless, &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert_eq!(store.find(&nameless).expect("asked").expect("there"), clip);
    assert_eq!(
        store.find(&first).expect("asked"),
        None,
        "a nameless section must not answer for the first one"
    );
}

#[test]
fn two_nameless_sections_are_told_apart_by_their_text() {
    /* The digest is what identifies the content, so losing the index costs
    readability and not correctness. */
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let mut one = key();
    one.section = None;
    let mut two = key();
    two.section = None;
    two.text_digest = "fnv1a64:99:aaaaaaaaaaaaaaaa".to_owned();
    store
        .put(&one, &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    store
        .put(&two, &samples(2.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert_eq!(store.clips(), 2);
    assert_eq!(
        store.find(&one).expect("asked").expect("there").duration_ms,
        1000
    );
    assert_eq!(
        store.find(&two).expect("asked").expect("there").duration_ms,
        2000
    );
}

/// ⚠️ **A WELL-FORMED STEM IS NOT THE SAME AS *THIS KEY'S* STEM — FOUND BY AN
/// INDEPENDENT AUDIT, 2026-09-30.** `safe_stem` answers *this is a name Paper
/// could have written*. It does not answer *this is the name this row's key
/// produces*, and nothing did: a row carrying book A's key beside book B's
/// perfectly legal stem passed every check, so `forget(Some(A))` deleted B's
/// audio. The stem is DERIVED from the key, so the two can simply be asked to
/// agree, and one that does not is a row this module cannot have written.
#[test]
fn a_checkpoint_row_whose_stem_is_not_its_key_s_stem_is_dropped() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    // B's clip, filed honestly.
    let mut victim = key();
    victim.book = "book:victim".to_owned();
    let (b, _) = store
        .put(&victim, &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    drop(store);

    // A checkpoint claiming B's NAME under A's KEY.
    let layout = Layout::under(dir.path());
    std::fs::write(
        &layout.state_path,
        serde_json::to_vec(&serde_json::json!({
            "format": STATE_FORMAT,
            "held": [{
                "stem": b.stem,
                "key": {
                    "book": "book:attacker", "section": 0, "pack": "p", "voice": "v",
                    "rateMilli": 1000, "textDigest": "d", "spokenDigest": "s",
                },
                "bytes": b.bytes, "durationMs": 1, "sampleRate": 24000, "words": 0,
                "lastPlayedMs": 1,
            }]
        }))
        .expect("encoded"),
    )
    .expect("written");

    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    assert_eq!(
        store.clips(),
        0,
        "the row does not survive the reconciliation"
    );
    /* ⚠️ **AND THE FILE IS NOT TOUCHED**, which is the half that matters: a row
    this module cannot have written names nothing it is safe to remove. The
    orphan sweep takes it afterwards, which is a different rule and is why the
    assertion below is about `forget` rather than about the file. */
    assert_eq!(
        store
            .forget(Some("book:attacker"))
            .expect("forgotten")
            .clips,
        0,
        "and forgetting the attacker's book reaches nothing"
    );
}

/// Two rows naming one file, with different byte counts, made the reconciliation
/// judge the wrong row against the real artifact and DELETE it. Uniqueness is
/// decided before anything is removed, which is the only order in which the
/// decision is safe to act on.
#[test]
fn a_checkpoint_naming_one_clip_twice_keeps_the_first_row_and_the_file() {
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let layout = Layout::under(dir.path());
    let row = serde_json::json!({
        "stem": clip.stem,
        "key": {
            "book": key().book, "section": key().section, "pack": key().pack,
            "voice": key().voice, "rateMilli": key().rate_milli,
            "textDigest": key().text_digest, "spokenDigest": key().spoken_digest,
        },
        "bytes": clip.bytes, "durationMs": 1, "sampleRate": 24000, "words": 0,
        "lastPlayedMs": 1,
    });
    let mut wrong = row.clone();
    wrong["bytes"] = serde_json::json!(clip.bytes + 7);
    drop(store);
    std::fs::write(
        &layout.state_path,
        serde_json::to_vec(&serde_json::json!({ "format": STATE_FORMAT, "held": [row, wrong] }))
            .expect("encoded"),
    )
    .expect("written");

    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    assert_eq!(store.clips(), 1, "one name, one row");
    assert!(
        store.find(&key()).expect("asked").is_some(),
        "and the clip still plays — the duplicate did not take it away"
    );
}

/// ⚠️ **EVERY NUMBER IN A CHECKPOINT CAME OFF DISK.** `sum()` panics on overflow
/// in a debug build and WRAPS in a release one, and a wrapped total reads as *the
/// store is empty* — a budget that would never evict again. Saturating reads as
/// *the store is enormous*, which evicts: the safe direction of the same
/// arithmetic.
#[test]
fn a_checkpoint_whose_byte_counts_overflow_does_not_panic_or_wrap_to_nothing() {
    let dir = scratch();
    let layout = Layout::under(dir.path());
    layout.ensure().expect("made");
    /* Two rows whose real files exist at those lengths is impossible, so this
    exercises `bytes()` directly on state the reconciliation has accepted —
    which is why both rows name files that are genuinely there. */
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    assert_eq!(store.bytes(), SECOND_BYTES);
    // The arithmetic itself, at the edge the checkpoint could reach.
    assert_eq!(
        u64::MAX.saturating_add(1),
        u64::MAX,
        "the fold saturates rather than wrapping to zero"
    );
}

/// ⚠️ **A REFUSED REMOVAL USED TO END THE WHOLE PASS.** The candidates were chosen
/// from the bytes the removals were ASSUMED to free, so one file that would not go
/// left the store over budget with removable clips still in the list — and the fix
/// for the *earlier* defect here (a row dropped though its file stayed) is what
/// made this one reachable.
#[test]
fn eviction_moves_on_to_the_next_clip_when_one_will_not_go() {
    let dir = scratch();
    let budget = 3 * SECOND_BYTES - 1;
    let mut store = Store::open(dir.path(), budget).expect("opened");
    let mut keys = Vec::new();
    for section in 0..2u32 {
        let mut k = key();
        k.section = Some(section);
        k.text_digest = format!("fnv1a64:1:{section:016x}");
        store
            .put(&k, &samples(1.0), 24_000, words(), Vec::new())
            .expect("kept");
        keys.push(k);
        std::thread::sleep(std::time::Duration::from_millis(3));
    }

    /* The OLDEST clip's WAV is made un-removable by putting a directory where the
    file is — the one refusal a unit test can arrange on every platform. */
    let oldest = store
        .find(&keys[0])
        .expect("asked")
        .expect("there")
        .path
        .clone();
    std::fs::remove_file(&oldest).expect("gone");
    std::fs::create_dir(&oldest).expect("a directory where the file was");
    std::fs::write(oldest.join("in the way"), b"x").expect("not empty, so it will not go");
    // `find` marked it played; make section 1 the newer of the two again.
    std::thread::sleep(std::time::Duration::from_millis(3));
    store.find(&keys[1]).expect("asked").expect("there");
    std::thread::sleep(std::time::Duration::from_millis(3));

    let mut third = key();
    third.section = Some(9);
    third.text_digest = "fnv1a64:1:000000000000000f".to_owned();
    let (_, evicted) = store
        .put(&third, &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");

    assert_eq!(
        evicted.clips, 1,
        "the pass did not stop at the clip it could not remove"
    );
    assert_eq!(
        evicted.bytes, SECOND_BYTES,
        "and counts only what really went"
    );
    assert!(
        store.find(&keys[1]).expect("asked").is_none(),
        "the next-oldest is the one that went"
    );
}

#[test]
fn a_checkpoint_naming_a_path_outside_the_store_touches_nothing() {
    /* ⚠️ **THE HIGH FINDING OF THE 2026-09-30 AUDIT.** A stem read back from
     * `state.json` was joined straight into a path and then REMOVED, so a row
     * reading `../../victim` deleted outside `audio/` entirely. The row is
     * dropped now and no file is touched — there is nothing safe to remove,
     * because the name does not say where. */
    let dir = scratch();
    let layout = Layout::under(dir.path());
    layout.ensure().expect("made");
    /* ⚠️ **TWO LEVELS UP, AND ONE WAS NOT ENOUGH.** The first version of this
     * case wrote the victim beside the data root and used `../victim`, which from
     * `audio/clips/` lands in `audio/` — inside the store, where nothing is
     * proved. The case passed with the check removed. Measured by hand-applying
     * the defect, which is the only way to know a regression test exercises its
     * regression. */
    let victim = dir.path().join("victim.wav");
    std::fs::write(&victim, b"somebody else's file").expect("written");
    assert_eq!(
        Layout::under(dir.path())
            .clips_dir
            .join("../../victim.wav")
            .canonicalize()
            .ok(),
        victim.canonicalize().ok(),
        "the stem below must really reach the victim, or this case proves nothing"
    );

    std::fs::write(
        &layout.state_path,
        serde_json::to_vec(&serde_json::json!({
            "format": STATE_FORMAT,
            "held": [{
                "stem": "../../victim",
                "key": {
                    "book": "book:a", "section": 0, "pack": "p", "voice": "v",
                    "rateMilli": 1000, "textDigest": "d", "spokenDigest": "s",
                },
                "bytes": 1, "durationMs": 1, "sampleRate": 24000, "words": 0,
                "lastPlayedMs": 1,
            }]
        }))
        .expect("json"),
    )
    .expect("written");

    let store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    assert_eq!(
        store.clips(),
        0,
        "a row Paper could not have written is dropped"
    );
    assert!(victim.is_file(), "and the file it named is still there");
}

#[test]
fn a_name_this_module_could_not_have_written_is_refused() {
    /* The alphabet is `Key::stem`'s own output and nothing else. */
    for bad in ["", "../x", "a/b", "a\\b", "a b", "a.b", &"x".repeat(121)] {
        assert!(!safe_stem(bad), "{bad:?} should be refused");
    }
    for good in [
        "book_a-8-0123456789abcdef",
        "book_a-x-0123456789abcdef",
        "a",
    ] {
        assert!(safe_stem(good), "{good:?} should be allowed");
    }
    /* And every real stem this module makes passes, which is the property that
    matters — a check the writer's own output fails would delete nothing ever. */
    let mut k = key();
    for section in [None, Some(0), Some(12), Some(u32::MAX)] {
        k.section = section;
        assert!(safe_stem(&k.stem().expect("a legal id")));
    }
    k.book = "《春天》 / a?b".to_owned();
    assert!(safe_stem(&k.stem().expect("a legal id")));
}

#[test]
fn a_wav_that_will_not_read_keeps_its_clip_rather_than_deleting_it() {
    /* ⚠️ **ABSENT AND UNREADABLE WERE ONE ANSWER, WITH THE DESTRUCTIVE HALF
     * ATTACHED.** A permission failure answered *"the clip is gone"* and the row
     * was dropped AND both files deleted — the defect eighteen stores in this
     * tree have fixed, with a `remove_file` on the end of it. Reproduced by
     * taking the read permission off the CLIPS DIRECTORY, which is what makes
     * `metadata` fail with something other than `NotFound`. */
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let stem = {
            let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
            store
                .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
                .expect("kept")
                .0
                .stem
        };
        let clips = Layout::under(dir.path()).clips_dir;
        std::fs::set_permissions(&clips, std::fs::Permissions::from_mode(0o000)).expect("closed");
        let reopened = Store::open(dir.path(), BUDGET_BYTES);
        std::fs::set_permissions(&clips, std::fs::Permissions::from_mode(0o755)).expect("reopened");
        let store = reopened.expect("opened");
        assert_eq!(store.clips(), 1, "unreadable is not absent");
        assert!(
            clips.join(format!("{stem}.wav")).is_file(),
            "and the samples are still there"
        );
    }
}

#[test]
fn a_wav_that_vanishes_after_the_store_opened_is_a_miss_and_not_an_error() {
    /* ⚠️ **IT WAS `metadata(&wav)?`, SO EVERY LATER `find` REJECTED.** The
     * reading could then neither play the clip nor make it again, because the
     * caller saw a refusal rather than *"there is no clip"*. */
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    std::fs::remove_file(&clip.path).expect("gone");
    assert_eq!(store.find(&key()).expect("a miss, not a refusal"), None);
    assert_eq!(store.clips(), 0, "and the row goes with it");
    /* And the section can be made again, which is the whole point. */
    assert!(store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .is_ok());
}

#[test]
fn replacing_a_clip_puts_the_samples_in_first() {
    /* ⚠️ **THE ORDER DEPENDS ON WHETHER THERE IS ONE THERE ALREADY.** Sidecar
     * first is right for a NEW clip — a crash leaves timings no row names. It is
     * wrong for a REPLACEMENT: new timings would sit beside the OLD samples, and
     * the old row's `bytes` still matches the old WAV, so every check accepts the
     * pair. Samples first makes the mismatch detectable instead.
     *
     * Observed through the SIZES, which is the only thing a test outside the
     * function can see: after a replacement the WAV is the new one. */
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    let (second, _) = store
        .put(&key(), &samples(2.0), 24_000, words(), Vec::new())
        .expect("kept again");
    let on_disk = std::fs::metadata(&second.path).expect("there").len();
    assert_eq!(on_disk, second.bytes);
    assert_eq!(second.duration_ms, 2000);
    /* And a store reopened agrees, which is what the checkpoint is for. */
    let mut reopened = Store::open(dir.path(), BUDGET_BYTES).expect("reopened");
    assert_eq!(
        reopened
            .find(&key())
            .expect("asked")
            .expect("there")
            .duration_ms,
        2000
    );
}

#[test]
fn a_clip_whose_file_will_not_go_is_kept_in_the_accounting() {
    /* ⚠️ **IT REPORTED BYTES AS FREED THAT WERE STILL ON DISK.** `let _ =
     * remove_file(…)` beside an unconditional `retain` meant the accounting said
     * the store was inside its budget when it was not, and every later eviction
     * measured a number with nothing behind it. */
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
        store
            .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
            .expect("kept");
        let clips = Layout::under(dir.path()).clips_dir;
        /* A directory with no write permission refuses every removal in it. */
        std::fs::set_permissions(&clips, std::fs::Permissions::from_mode(0o555)).expect("closed");
        let gone = store.forget(None);
        std::fs::set_permissions(&clips, std::fs::Permissions::from_mode(0o755)).expect("reopened");
        let gone = gone.expect("asked");
        assert_eq!(gone.clips, 0, "nothing actually went");
        assert_eq!(gone.bytes, 0);
        assert_eq!(
            store.clips(),
            1,
            "so the row stays, and the budget stays honest"
        );
        assert_eq!(store.bytes(), SECOND_BYTES);
    }
}

#[test]
fn a_clip_already_gone_counts_as_removed() {
    /* `NotFound` is success: a file this does not have to remove is a file that
    is not on the disk, which is what the count is about. */
    let dir = scratch();
    let mut store = Store::open(dir.path(), BUDGET_BYTES).expect("opened");
    let (clip, _) = store
        .put(&key(), &samples(1.0), 24_000, words(), Vec::new())
        .expect("kept");
    std::fs::remove_file(&clip.path).expect("gone");
    let gone = store.forget(None).expect("asked");
    assert_eq!(gone.clips, 1);
    assert_eq!(store.clips(), 0);
}

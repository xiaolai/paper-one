//! The voice — the key a reader publishes to strangers under, and the
//! sequence it publishes at. WI-26.1 and WI-26.3.
//!
//! ⚠️ **NEVER DERIVED FROM THE PERSON ROOT, AND NEVER THE ENDPOINT KEY.** A
//! voice exists to be unlinked from the reader's circle identity; a derivation
//! would make the link recoverable by anybody who learned the derivation, which
//! is everybody, because it would be in this file. Generated from the OS
//! CSPRNG like `identity.key`, and rotatable — which the person root is not.
//!
//! ⚠️ **AND IT OPENS NO CONNECTIONS.** `identity.key` authenticates every QUIC
//! connection this device makes, so "the signing key IS the device id" there.
//! This one signs and nothing else, which is what lets the same reader hold a
//! circle identity and a voice with no observable relation between them beyond
//! the IP-level correlation phase 25 already concedes.
//!
//! ## What this module signs, and what it refuses
//!
//! ⚠️ **A COMMAND THAT SIGNS ARBITRARY BYTES IS A SIGNING ORACLE, AND THIS ONE
//! IS REACHABLE FROM THE RENDERER.** `identity::sign_page` learned this for the
//! circle and confines itself to `paper.circle.<version>.page\n…`. The same
//! confinement, one domain over: `paper.public.<version>.envelope\n…` and
//! nothing else. The two domains cannot overlap, so neither key can be made to
//! sign the other's bytes even by a caller trying to.
//!
//! ## The sequence is persisted BEFORE it is used
//!
//! ⚠️ **A COUNTER THAT RESTARTS AT ONE IS AN EQUIVOCATION BY THE PUBLIC LAYER'S
//! OWN RULE** — `order.ts` drops both envelopes at a sequence a voice has used
//! twice, so a voice whose counter was lost erases its own annotations from
//! every reader who saw both. Written and `fsync`ed before the number is
//! answered, so a crash costs a skipped sequence and never a reused one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use iroh::SecretKey;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::identity::PEER_DIR;
use crate::store::write_atomic;

/// `<root>/peer/voice.key` — the key in use.
const VOICE_KEY_FILE: &str = "voice.key";
/// `<root>/peer/voice-retired/` — keys kept only to withdraw what they signed.
const RETIRED_DIR: &str = "voice-retired";
/// `<root>/peer/voice.json` — the sequence and the retirement calendar.
const STATE_FILE: &str = "voice.json";

const STATE_VERSION: u32 = 1;

/// The domain a voice may sign under, and the only one.
const PUBLIC_DOMAIN: &str = "paper.public.";

/// One lock per data root, so every voice-state transaction is serialised.
///
/// ⚠️ **THE SEQUENCE WAS AN UNLOCKED READ-MODIFY-WRITE AND HANDED OUT THE SAME
/// NUMBER TWICE.** Found by audit: `peer_voice_next_seq` runs on a blocking
/// worker, two commands run on two workers, and both read the same state
/// before either wrote. A reused sequence is an equivocation by the public
/// fold's own rule, which DROPS BOTH ENVELOPES — the voice erases its own
/// annotations from every reader who saw them. Rotation and sweeping had the
/// same shape and could overwrite a newer sequence with an older snapshot.
///
/// ⚠️ **KEYED BY ROOT, NOT GLOBAL.** Two data roots are two installations and
/// have nothing to serialise between them; the tests run several at once.
///
/// This is a PROCESS lock and not a file lock: a second Paper on the same root
/// is outside what it covers, and `identity.rs` records that the endpoint key
/// takes a non-clobbering install for exactly that case. The sequence has no
/// equivalent, which is stated rather than fixed — one reader, one machine, one
/// app is the shape this design is for.
fn lock_for(root: &Path) -> &'static Mutex<()> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut held = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    held.entry(root.to_path_buf())
        .or_insert_with(|| Box::leak(Box::new(Mutex::new(()))))
}

/// The largest sequence this device will mint.
///
/// ⚠️ **`Number.MAX_SAFE_INTEGER`, BECAUSE THE COUNTER CROSSES INTO
/// JAVASCRIPT.** The command returns a `number` and `envelope.ts` requires
/// `Number.isSafeInteger` of it; a `u64` counter past this is one the reader's
/// own build refuses to publish under, for ever, with the number safely on
/// disk. Bounding it here is what keeps the two halves able to speak.
const MAX_SAFE_SEQ: u64 = 9_007_199_254_740_991;

/// The most retired keys kept at once.
///
/// ⚠️ **A BOUND ON A DIRECTORY THAT ONLY GROWS BY A HUMAN ACT, AND STILL WORTH
/// HAVING.** Rotation is rare; a loop that called it is not, and a key file per
/// rotation with nothing to stop it is the same unbounded-store defect WI-26.3
/// is about, wearing a private hat. Past this, the oldest retirement is dropped
/// — which forfeits the ability to withdraw what it signed, and says so.
pub const MAX_RETIRED: usize = 16;

/// `<root>/peer/voice.key`.
fn key_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(VOICE_KEY_FILE)
}

fn retired_dir(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(RETIRED_DIR)
}

fn state_path(root: &Path) -> PathBuf {
    root.join(PEER_DIR).join(STATE_FILE)
}

/// A key kept past its rotation, and the moment it may go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Retired {
    /// The public key, 64 lower-case hex — what a reader sees as the voice.
    pub voice: String,
    /// Epoch milliseconds: past this, nothing it signed can still be valid.
    pub until: i64,
}

/// Whether a string is a voice — 64 lower-case hex, and nothing else.
///
/// ⚠️ **THIS IS A PATH SEGMENT AND MUST BE CHECKED BEFORE IT IS JOINED.**
/// Found by audit: retirement records loaded from `voice.json` became deletion
/// paths unvalidated, so `../identity` under `voice` targeted the CIRCLE's
/// `identity.key` — and a short name panicked at the rotation log's `[..8]`
/// slice. The file is this device's own, so reaching that needs another
/// defect first; a containment check that depends on nothing else going wrong
/// is not a containment check.
fn is_voice(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct State {
    v: u32,
    /// The highest sequence this voice has published at. Never decreases.
    ///
    /// ⚠️ **NOT `#[serde(default)]`, AND IT WAS.** A present state file with no
    /// `seq` read as zero, which is the counter lost and the voice about to
    /// reuse every sequence it has already published at — an equivocation by
    /// the public fold's own rule, which drops both envelopes. Found by audit.
    /// A file this code wrote always has the field; one that does not was
    /// written by something else, and guessing is the one thing that must not
    /// happen here.
    seq: u64,
    #[serde(default)]
    retired: Vec<Retired>,
}

/// What a surface is told about this device's voice.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// The current voice, 64 lower-case hex.
    pub voice: String,
    /// The highest sequence published at so far.
    pub seq: u64,
    /// Keys kept only so that what they signed can still be withdrawn.
    pub retired: Vec<Retired>,
}

/// Load the voice key, or generate and persist one.
///
/// Goes through `identity::load_or_create_named`'s discipline by hand rather
/// than through the function, because that one's `debug_assert` names the two
/// ENDPOINT key files and this is not one: a voice key is never bound to a
/// socket, and letting it through that door would make the assertion a
/// formality.
fn load_or_create(root: &Path) -> Result<SecretKey> {
    let path = key_path(root);
    let dir = root.join(PEER_DIR);
    std::fs::create_dir_all(&dir)?;
    match std::fs::metadata(&path) {
        Ok(meta) => crate::keyfile::load(&path, meta.len()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let fresh = SecretKey::generate();
            install(&path, &fresh)?;
            /* Re-read rather than returning what was generated: `install` does
             * not clobber, so another writer may have won. `identity.rs`
             * carries the full account of why a caller that went on using its
             * own key would be a second peer wearing one install. */
            crate::keyfile::load(&path, std::fs::metadata(&path)?.len())
        }
        Err(err) => Err(err.into()),
    }
}

/* ⚠️ **THE KEY FILE PRIMITIVES ARE SHARED WITH `identity.rs` NOW.** This file
 * carried its own `load`, `install` and `tighten` — two thirds of what that
 * module had already learned, minus the directory sync, which is exactly the
 * drift `identity.rs`'s own header warns about. `keyfile.rs` is the one copy;
 * what stays here is what a VOICE means, which is the part that is not shared.
 *
 * `install` keeps its name and its signature so the retain-before-replace
 * ordering below reads unchanged; it is now one line over the shared writer,
 * and it fsyncs the directory it used not to. */
fn install(path: &Path, key: &SecretKey) -> Result<()> {
    crate::keyfile::install_new(path, key).map(|_| ())
}

fn read_state(root: &Path) -> Result<State> {
    match std::fs::read(state_path(root)) {
        Ok(bytes) => {
            let parsed: State =
                serde_json::from_slice(&bytes).map_err(|err| Error::ShareMalformed {
                    path: state_path(root),
                    why: err.to_string(),
                })?;
            if parsed.v != STATE_VERSION {
                return Err(Error::ShareMalformed {
                    path: state_path(root),
                    why: format!("version {} is not {STATE_VERSION}", parsed.v),
                });
            }
            /* ⚠️ **EVERY RETIREMENT RECORD IS VALIDATED HERE, WHERE IT ENTERS
             * — NOT WHERE IT IS USED.** See `is_voice`. Refused rather than
             * filtered: a `voice.json` holding a name that is not a voice was
             * not written by this code, and quietly dropping the bad entries
             * would leave the rest of the file trusted. */
            for one in &parsed.retired {
                if !is_voice(&one.voice) {
                    return Err(Error::ShareMalformed {
                        path: state_path(root),
                        why: "a retirement names something that is not a voice".into(),
                    });
                }
            }
            if parsed.retired.len() > MAX_RETIRED {
                return Err(Error::ShareMalformed {
                    path: state_path(root),
                    why: format!("{} retirements is over the cap", parsed.retired.len()),
                });
            }
            Ok(parsed)
        }
        /* ⚠️ **A MISSING FILE IS ONLY A FRESH START WHEN THERE IS NO KEY.**
         * With a key already on disk this voice has an unknown publishing
         * history, and starting at one reuses every sequence it has used —
         * which erases its own annotations from every reader who saw both.
         * Found by audit. Refused rather than guessed: the reader's remedy is
         * to rotate, which mints a voice with no history to collide with. */
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if key_path(root).exists() {
                return Err(Error::ShareMalformed {
                    path: state_path(root),
                    why: "this device has a voice key and no record of what it has published; \
                          rotate to publish under a voice with no history"
                        .into(),
                });
            }
            Ok(State {
                v: STATE_VERSION,
                seq: 0,
                retired: Vec::new(),
            })
        }
        /* ⚠️ **NOT READ AS "NEVER PUBLISHED".** That is the one reading that
         * loses the sequence, and losing the sequence is how a voice erases its
         * own annotations — see the module header. */
        Err(err) => Err(err.into()),
    }
}

fn write_state(root: &Path, state: &State) -> Result<()> {
    let bytes =
        serde_json::to_vec_pretty(state).map_err(|err| Error::ShareRefused(err.to_string()))?;
    write_atomic(&state_path(root), &bytes)
}

/// The key and the state together, creating both on a fresh root.
///
/// ⚠️ **THE STATE IS WRITTEN BEFORE THE KEY, AND THE ORDER IS THE WHOLE
/// POINT.** `read_state` refuses a root that has a voice key and no record of
/// what it has published, because starting the counter at zero there reuses
/// every sequence the voice has already used. That refusal is only correct if
/// a FRESH root never lands in it — so the state comes first, and an
/// interruption leaves a state with no key, which the next call simply fills
/// in. The other order leaves exactly the state the refusal exists to catch,
/// on an installation that has published nothing.
///
/// The caller holds the root's lock.
fn ensure(root: &Path) -> Result<(SecretKey, State)> {
    if !key_path(root).exists() && !state_path(root).exists() {
        write_state(
            root,
            &State {
                v: STATE_VERSION,
                seq: 0,
                retired: Vec::new(),
            },
        )?;
    }
    let key = load_or_create(root)?;
    let state = read_state(root)?;
    Ok((key, state))
}

/// This device's voice, its sequence and what it still holds keys for.
pub fn status(root: &Path) -> Result<VoiceStatus> {
    let lock = lock_for(root);
    let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (key, state) = ensure(root)?;
    Ok(VoiceStatus {
        voice: key.public().to_string(),
        seq: state.seq,
        retired: state.retired,
    })
}

/// The next sequence to publish at, persisted before it is answered.
pub fn next_seq(root: &Path) -> Result<u64> {
    let lock = lock_for(root);
    let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (_key, mut state) = ensure(root)?;
    /* ⚠️ **THE CEILING IS JAVASCRIPT'S, NOT `u64`'s.** `peer_voice_next_seq`
     * answers a TypeScript `number`, and `envelope.ts` refuses a sequence that
     * is not `Number.isSafeInteger` — so a counter past 2^53-1 is one this
     * device can persist, hand over, and then never publish under again. The
     * refusal belongs where the number is minted rather than at the far end,
     * which cannot do anything about it. Nothing reaches this in practice: a
     * publication a second for nearly three hundred million years. */
    let next = match state.seq.checked_add(1) {
        Some(next) if next <= MAX_SAFE_SEQ => next,
        _ => {
            return Err(Error::ShareRefused(
                "this voice has no sequence numbers left; rotate to publish under a fresh one"
                    .into(),
            ))
        }
    };
    state.seq = next;
    /* ⚠️ **WRITTEN FIRST, ANSWERED SECOND.** A crash between the two costs a
     * skipped sequence, which nothing minds; the other order costs a REUSED
     * one, which the public fold treats as equivocation and drops. */
    write_state(root, &state)?;
    Ok(next)
}

/// Whether `message` is a public envelope's signed bytes and nothing else.
///
/// `paper.public.<version>.envelope\n…` — see `publicSignedBytes`, which is the
/// ONE place these bytes are built. The version is not pinned here, for
/// `is_page_bytes`'s reason: a v2 envelope is still an envelope, and a Rust
/// constant that had to move in lockstep with a TypeScript one is a second
/// list of the kind `commands.rs` opens by warning about.
fn is_envelope_bytes(message: &str) -> bool {
    let Some(rest) = message.strip_prefix(PUBLIC_DOMAIN) else {
        return false;
    };
    let Some((version, tail)) = rest.split_once('.') else {
        return false;
    };
    !version.is_empty()
        && version.bytes().all(|b| b.is_ascii_digit())
        && tail.starts_with("envelope\n")
}

/// Sign a public envelope with the voice named, or with the current voice.
///
/// ⚠️ **`voice` NAMES WHICH KEY, AND A RETIRED ONE IS ALLOWED ON PURPOSE.**
/// WI-26.3: *"retaining an old key must happen before rotation destroys it"* —
/// the reason to retain one is to be able to withdraw what it published, and a
/// withdrawal is an envelope that key has to sign. Retention with no way to use
/// it would be a directory of dead files.
pub fn sign(root: &Path, message: &str, voice: Option<&str>) -> Result<String> {
    if !is_envelope_bytes(message) {
        return Err(Error::ShareRefused(
            "a voice signs public envelopes and nothing else".into(),
        ));
    }
    /* Under the root's lock, and through `ensure`: signing is the first thing
     * many installations ever do with a voice, so it is a path that CREATES
     * one — and a key created without its state file is the lost counter this
     * module refuses to guess at. */
    let lock = lock_for(root);
    let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (current, state) = ensure(root)?;
    let key = match voice {
        None => current,
        Some(named) if current.public().to_string() == named => current,
        Some(named) => retired_key(root, &state, named)?,
    };
    Ok(crate::keyfile::hex(
        &key.sign(message.as_bytes()).to_bytes(),
    ))
}

/// One retired key, by its public form.
fn retired_key(root: &Path, state: &State, voice: &str) -> Result<SecretKey> {
    /* ⚠️ **THE NAME IS VALIDATED BEFORE IT IS JOINED.** It arrives from the
     * renderer and becomes a path segment; sixty-four lower-case hex digits
     * cannot contain a separator or a `..`, which is the whole check. */
    if !is_voice(voice) {
        return Err(Error::ShareRefused("that is not a voice".into()));
    }
    /* ⚠️ **THE CALENDAR AUTHORISES, NOT THE DIRECTORY — AND IT WAS THE OTHER
     * WAY ROUND.** `sweep` removes the state entry first and ignores an unlink
     * that fails, so a key whose file survived a failed delete went on signing
     * for ever while `status` reported it forgotten. Found by audit. Reading
     * the calendar makes the sweep's own ordering correct: state first is the
     * safe order precisely because state is what is consulted. */
    if !state.retired.iter().any(|one| one.voice == voice) {
        return Err(Error::ShareRefused(
            "this device no longer holds that voice's key".into(),
        ));
    }
    let path = retired_dir(root).join(format!("{voice}.key"));
    match std::fs::metadata(&path) {
        Ok(meta) => crate::keyfile::load(&path, meta.len()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Err(Error::ShareRefused(
            "this device no longer holds that voice's key".into(),
        )),
        Err(err) => Err(err.into()),
    }
}

/// Rotate the voice, keeping the old key until `until`.
///
/// ⚠️ **RETAIN FIRST, THEN REPLACE — AND THE ORDER IS THE WHOLE WORK ITEM.**
/// WI-26.3 names the failure: *"rotation interrupted between key replacement
/// and old-key retention"*. Interrupted in THIS order, the worst outcome is a
/// retired copy of a key that is still current, which costs nothing; in the
/// other order it is a key destroyed with no copy, and every publication it
/// signed becomes permanently unwithdrawable.
pub fn rotate(root: &Path, until: i64) -> Result<VoiceStatus> {
    let lock = lock_for(root);
    let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    /* ⚠️ **NOT `ensure`, BECAUSE ROTATION IS THE REMEDY FOR THE STATE BEING
     * UNREADABLE.** `read_state` refuses a root that has a key and no record of
     * what it published, and tells the reader to rotate — and `rotate` went
     * through `ensure`, which hits that same refusal. The remedy could not run:
     * a device that lost `voice.json` was stuck for good, with the error
     * naming the one action that could not work. Found by audit.
     *
     * Only the KEY is needed to retire it, and `load_or_create` gives that
     * without consulting the state at all. */
    let old = load_or_create(root)?;
    let old_id = old.public().to_string();

    std::fs::create_dir_all(retired_dir(root))?;
    install(&retired_dir(root).join(format!("{old_id}.key")), &old)?;
    /* ⚠️ **THE DIRECTORY ENTRY, NOT ONLY THE BYTES.** `install` fsyncs the
     * file; the LINK that names it lives in the directory, and a crash after
     * the replacement below could lose it — leaving a rotation that destroyed
     * the current key and retained nothing, which is the exact failure the
     * retain-first ordering exists to prevent. Found by audit.
     *
     * ⚠️ **AND A FAILED SYNC STOPS THE ROTATION, WHERE IT USED TO BE A
     * WARNING.** Logging it and carrying on is the retain-first ordering
     * defeated by its own error handling: the whole point of retaining before
     * replacing is that a crash cannot leave a destroyed key with no copy, and
     * proceeding after the retention could not be made durable is exactly that
     * outcome, chosen deliberately. Nothing has been destroyed at this line, so
     * refusing costs the reader a retry and nothing else — where continuing can
     * cost them every publication the old voice signed, permanently
     * unwithdrawable.
     *
     * A directory that will not OPEN is still the platform accommodation
     * (Windows), not a failure: the key file itself is fsynced by `install`. */
    match std::fs::File::open(retired_dir(root)) {
        Ok(handle) => handle.sync_all().map_err(|err| {
            Error::ShareRefused(format!(
                "not rotating: the retained voice key could not be made durable ({err})"
            ))
        })?,
        Err(err) => {
            #[cfg(unix)]
            log::warn!("peer: could not open the retired voice directory to sync it: {err}");
            #[cfg(not(unix))]
            let _ = err;
        }
    }

    /* ⚠️ **AN UNREADABLE STATE IS RECOVERED FROM, NOT REFUSED — HERE AND ONLY
     * HERE.** Everywhere else a missing or malformed `voice.json` beside a key
     * must refuse, because publishing under that key with a guessed sequence
     * reuses numbers the voice has already used. Rotation is the one operation
     * where that reasoning inverts: it mints a voice nobody has ever seen, so
     * `seq: 0` under the NEW key cannot collide with anything by construction.
     * Refusing here is what made the failure permanent.
     *
     * Loud, because it is real loss: the retirement list is what lets the
     * reader withdraw what older voices published, and a state we could not
     * read is a list we cannot honour. The keys themselves survive on disk —
     * `sweep`'s orphan pass is what would remove them, and it is deliberately
     * not run from this path. */
    let mut state = match read_state(root) {
        Ok(held) => held,
        Err(err) => {
            log::warn!(
                "peer: rotating over an unreadable voice state ({err}); \
                 earlier retirements can no longer be withdrawn"
            );
            State {
                v: STATE_VERSION,
                seq: 0,
                retired: Vec::new(),
            }
        }
    };
    state.retired.retain(|one| one.voice != old_id);
    state.retired.push(Retired {
        voice: old_id,
        until,
    });
    /* Oldest retirement first, so the drop below takes the one with least left
     * to withdraw. */
    state.retired.sort_by_key(|one| one.until);
    /* ⚠️ **THE CALENDAR IS COMMITTED BEFORE ANY KEY IS DELETED, AND IT USED TO
     * BE THE OTHER WAY ROUND.** The evicted files were unlinked inside this
     * loop and `write_state` ran afterwards — so a failed write returned an
     * error while the keys were already gone, and the state still on disk went
     * on listing retirements whose files no longer existed. The reader was then
     * told they could withdraw what they could not. Deleting AFTER the commit
     * inverts the failure into the harmless one: a key kept a little longer
     * than its calendar says, which `sweep`'s orphan pass collects. */
    let mut evicted = Vec::new();
    while state.retired.len() > MAX_RETIRED {
        let dropped = state.retired.remove(0);
        log::warn!(
            "peer: forgetting the voice key {} — anything it published can no longer be withdrawn",
            &dropped.voice[..8]
        );
        evicted.push(dropped.voice);
    }
    write_state(root, &state)?;
    for voice in evicted {
        let path = retired_dir(root).join(format!("{voice}.key"));
        /* Reported, not swallowed: a key left behind is private material this
         * device promised to forget, and the orphan sweep is what will try
         * again. Absence is the expected outcome of a retry. */
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => log::warn!(
                "peer: could not delete the retired voice key {}: {err}",
                path.display()
            ),
        }
    }

    /* Only now is the current key replaced.
     *
     * ⚠️ **UNLINK-THEN-INSTALL LEFT A WINDOW WITH NO CURRENT KEY AT ALL**, and
     * an install that failed in it lost the name for good — the device would
     * mint a fresh voice on next use, silently, having thrown away the one it
     * had just promised to retire from. Found by audit. The new key is staged
     * under its own name first, so the only step that touches `voice.key` is
     * one atomic rename over it; a crash before it leaves the OLD key in place
     * and a crash after leaves the new one, and neither leaves nothing.
     *
     * `rename`, not the non-clobbering `hard_link` install: replacing is
     * exactly what is wanted here, and the retention above has already made the
     * old key durable under its retired name. */
    let fresh = SecretKey::generate();
    let path = key_path(root);
    let staged = path.with_extension("key.rotating");
    let _ = std::fs::remove_file(&staged);
    install(&staged, &fresh)?;
    std::fs::rename(&staged, &path)?;
    /* The bytes were fsynced by the install; this is the NAME that reaches
     * them, which a power cut would otherwise lose. */
    crate::keyfile::sync_dir(path.parent().expect("a key path has a parent"))?;

    /* ⚠️ **THE SEQUENCE IS NOT RESET.** A new key is a new voice, so it could
     * start at one — and a version of this that did would be one lost state
     * file away from a reused sequence under the old voice. Carrying the
     * number costs nothing and removes the case. */
    /* ⚠️ **NOT `status(root)` — THAT WOULD DEADLOCK ON THE LOCK THIS HOLDS.**
     * `std::sync::Mutex` is not reentrant, so a public entry point calling
     * another public entry point is a hang rather than a bug report. */
    let state = read_state(root)?;
    Ok(VoiceStatus {
        voice: fresh.public().to_string(),
        seq: state.seq,
        retired: state.retired,
    })
}

/// Delete retired keys whose retention has run out.
pub fn sweep(root: &Path, now: i64) -> Result<usize> {
    let lock = lock_for(root);
    let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = read_state(root)?;
    let before = state.retired.len();
    let gone: Vec<Retired> = state
        .retired
        .iter()
        .filter(|one| one.until <= now)
        .cloned()
        .collect();
    state.retired.retain(|one| one.until > now);
    if state.retired.len() != before {
        write_state(root, &state)?;
    }
    /* The state goes first, and that IS the authorisation: `sign` reads the
     * calendar rather than the directory, so a key whose file outlives its
     * entry cannot be used. What the unlink buys is that key material does not
     * sit on the disk after its purpose has gone — worth reporting when it
     * fails, and worth retrying on the next sweep, which the loop below makes
     * possible by not depending on the entry still being there. */
    for one in &gone {
        let path = retired_dir(root).join(format!("{}.key", one.voice));
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => log::warn!(
                "peer: key material for a forgotten voice is still on disk at {}: {err}",
                path.display()
            ),
        }
    }
    /* ⚠️ **AND ANY FILE WITH NO CALENDAR ENTRY GOES TOO — ON EVERY SWEEP, NOT
     * ONLY ONE THAT REMOVED SOMETHING.** That is what a failed unlink leaves
     * behind, and a version of this that returned early when the calendar had
     * not changed would never look at the orphan again: the entry it was swept
     * under is exactly what is gone. */
    /* ⚠️ **EVERY FAILURE HERE WAS SILENT, AND WHAT IS LEFT BEHIND IS PRIVATE
     * KEY MATERIAL.** A directory that would not open was an `if let` with no
     * else, a `flatten()` dropped unreadable entries, and a failed unlink was
     * `let _ =`. Once a key has left the calendar this pass is the ONLY thing
     * that will ever look at it again, so a failure that says nothing is a key
     * kept for ever with no record that it exists. Reported at every step;
     * absence is still the expected outcome of a retry, and the sweep still
     * does not fail over one file. */
    match std::fs::read_dir(retired_dir(root)) {
        Ok(entries) => {
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) => {
                        log::warn!("peer: a retired voice entry could not be read: {err}");
                        continue;
                    }
                };
                let name = entry.file_name();
                let Some(name) = name.to_str().and_then(|n| n.strip_suffix(".key")) else {
                    continue;
                };
                if is_voice(name) && !state.retired.iter().any(|one| one.voice == name) {
                    match std::fs::remove_file(entry.path()) {
                        Ok(()) => {}
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                        Err(err) => log::warn!(
                            "peer: key material for a forgotten voice is still on disk at {}: {err}",
                            entry.path().display()
                        ),
                    }
                }
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::warn!(
            "peer: the retired voice directory could not be listed, so orphaned key material \
             cannot be collected: {err}"
        ),
    }
    Ok(gone.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    const HOUR: i64 = 60 * 60 * 1000;

    #[test]
    fn a_fresh_root_gets_a_voice_that_survives_a_reload() {
        let dir = ScratchDir::new("voice-fresh");
        let first = status(dir.path()).unwrap();
        assert_eq!(first.voice.len(), 64);
        assert_eq!(first.seq, 0);
        assert_eq!(status(dir.path()).unwrap().voice, first.voice);
    }

    #[test]
    fn the_voice_is_not_the_endpoint_key() {
        /* ⚠️ **THE WHOLE POINT OF THE KEY BEING SEPARATE.** A voice that WAS
        the endpoint key would link every public annotation to the circle
        identity that serves the reader's books. */
        let dir = ScratchDir::new("voice-distinct");
        let endpoint = crate::identity::load_or_create(dir.path()).unwrap();
        assert_ne!(
            status(dir.path()).unwrap().voice,
            endpoint.public().to_string()
        );
    }

    #[test]
    fn the_sequence_climbs_and_survives_a_restart() {
        let dir = ScratchDir::new("voice-seq");
        assert_eq!(next_seq(dir.path()).unwrap(), 1);
        assert_eq!(next_seq(dir.path()).unwrap(), 2);
        /* A "restart" is a fresh read of the file — there is no process state
        to lose, which is the property being asserted. */
        assert_eq!(status(dir.path()).unwrap().seq, 2);
        assert_eq!(next_seq(dir.path()).unwrap(), 3);
    }

    #[test]
    fn a_state_file_that_will_not_read_is_an_error_and_not_a_reset() {
        /* ⚠️ **THE ONE READING THAT LOSES THE SEQUENCE.** A voice that
        restarted at one would have its own annotations dropped by every reader
        who saw both — `order.ts` treats a reused sequence as equivocation. */
        let dir = ScratchDir::new("voice-corrupt");
        std::fs::create_dir_all(dir.path().join(PEER_DIR)).unwrap();
        std::fs::write(state_path(dir.path()), b"{ not json").unwrap();
        assert_eq!(next_seq(dir.path()).unwrap_err().kind(), "shareMalformed");
        assert_eq!(status(dir.path()).unwrap_err().kind(), "shareMalformed");
    }

    #[test]
    fn a_voice_signs_public_envelopes_and_nothing_else() {
        /* ⚠️ **A SIGNING ORACLE REACHABLE FROM THE RENDERER**, confined the way
        `identity::sign_page` is confined, one domain over. */
        let dir = ScratchDir::new("voice-domain");
        assert!(sign(dir.path(), "paper.public.1.envelope\n{}", None).is_ok());
        for refused in [
            /* The circle's domain — the key that must never sign these. */
            "paper.circle.1.page\n{}",
            "paper.circle.1.roster\n{}",
            /* Another public kind, which does not exist and must not be
            mintable before it is designed. */
            "paper.public.1.roster\n{}",
            "paper.public.1.binding\n{}",
            /* The prefix without the structure. */
            "",
            "paper.public.",
            "paper.public.envelope\n{}",
            "paper.public..envelope\n{}",
            "paper.public.1.envelope",
            "paper.public.x.envelope\n{}",
            /* And buried rather than leading, which a `contains` would take. */
            "x paper.public.1.envelope\n{}",
        ] {
            assert!(
                sign(dir.path(), refused, None).is_err(),
                "signed something that is not a public envelope: {refused:?}"
            );
        }
    }

    #[test]
    fn a_signature_verifies_under_the_voice_it_names() {
        let dir = ScratchDir::new("voice-verify");
        let message = "paper.public.1.envelope\n{\"v\":1}";
        let sig = sign(dir.path(), message, None).unwrap();
        let voice = status(dir.path()).unwrap().voice;
        let key: iroh::EndpointId = voice.parse().unwrap();
        assert_eq!(sig.len(), 128);
        assert!(key.verify(message.as_bytes(), &parse_sig(&sig)).is_ok());
        assert!(key
            .verify(b"paper.public.1.envelope\n{}", &parse_sig(&sig))
            .is_err());
    }

    #[test]
    fn rotation_keeps_the_old_key_and_can_still_withdraw_with_it() {
        /* WI-26.3: retaining an old key must happen before rotation destroys
        it, and the reason to retain one is to withdraw what it published. */
        let dir = ScratchDir::new("voice-rotate");
        let before = status(dir.path()).unwrap().voice;
        let after = rotate(dir.path(), 10 * HOUR).unwrap();
        assert_ne!(after.voice, before);
        assert_eq!(after.retired.len(), 1);
        assert_eq!(after.retired[0].voice, before);

        let message = "paper.public.1.envelope\n{\"op\":\"unnote\"}";
        let sig = sign(dir.path(), message, Some(&before)).unwrap();
        let key: iroh::EndpointId = before.parse().unwrap();
        assert!(key.verify(message.as_bytes(), &parse_sig(&sig)).is_ok());
    }

    #[test]
    fn rotation_does_not_reset_the_sequence() {
        let dir = ScratchDir::new("voice-rotate-seq");
        next_seq(dir.path()).unwrap();
        next_seq(dir.path()).unwrap();
        assert_eq!(rotate(dir.path(), HOUR).unwrap().seq, 2);
        assert_eq!(next_seq(dir.path()).unwrap(), 3);
    }

    #[test]
    fn a_voice_this_device_never_held_cannot_be_signed_with() {
        let dir = ScratchDir::new("voice-unknown");
        let message = "paper.public.1.envelope\n{}";
        assert!(sign(dir.path(), message, Some(&"ab".repeat(32))).is_err());
        /* And a name that is not a voice at all is refused before it becomes a
        path segment. */
        assert!(sign(dir.path(), message, Some("../../identity")).is_err());
        assert!(sign(dir.path(), message, Some("")).is_err());
    }

    #[test]
    fn a_retired_key_goes_when_nothing_it_signed_can_still_be_valid() {
        let dir = ScratchDir::new("voice-sweep");
        let before = status(dir.path()).unwrap().voice;
        rotate(dir.path(), 5 * HOUR).unwrap();
        assert_eq!(sweep(dir.path(), 4 * HOUR).unwrap(), 0, "swept too early");
        assert_eq!(sweep(dir.path(), 5 * HOUR).unwrap(), 1);
        assert!(status(dir.path()).unwrap().retired.is_empty());
        assert!(
            sign(dir.path(), "paper.public.1.envelope\n{}", Some(&before)).is_err(),
            "a swept key still signed"
        );
        assert_eq!(
            sweep(dir.path(), 9 * HOUR).unwrap(),
            0,
            "sweeping nothing is not an error"
        );
    }

    #[test]
    fn the_retired_directory_is_bounded_and_says_what_it_forfeits() {
        let dir = ScratchDir::new("voice-retired-cap");
        let mut first = String::new();
        for round in 0..(MAX_RETIRED as i64 + 3) {
            let voice = status(dir.path()).unwrap().voice;
            if round == 0 {
                first = voice;
            }
            rotate(dir.path(), (round + 1) * HOUR).unwrap();
        }
        let held = status(dir.path()).unwrap().retired;
        assert_eq!(held.len(), MAX_RETIRED);
        assert!(
            !held.iter().any(|one| one.voice == first),
            "the oldest retirement was kept past the cap"
        );
        assert!(
            sign(dir.path(), "paper.public.1.envelope\n{}", Some(&first)).is_err(),
            "a dropped retirement left its key file behind"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_key_files_are_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScratchDir::new("voice-mode");
        let old = status(dir.path()).unwrap().voice;
        rotate(dir.path(), HOUR).unwrap();
        for path in [
            key_path(dir.path()),
            retired_dir(dir.path()).join(format!("{old}.key")),
        ] {
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{} was {mode:o}", path.display());
        }
    }

    #[test]
    fn concurrent_callers_never_get_the_same_sequence() {
        /* ⚠️ **AN UNLOCKED READ-MODIFY-WRITE HANDED OUT THE SAME NUMBER
        TWICE** — found by audit. A reused sequence is an equivocation by the
        public fold's own rule, which DROPS BOTH ENVELOPES: the voice erases
        its own annotations from every reader who saw them. */
        let dir = ScratchDir::new("voice-seq-race");
        let root = dir.path().to_path_buf();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut hands = Vec::new();
        for _ in 0..8 {
            let root = root.clone();
            let seen = std::sync::Arc::clone(&seen);
            hands.push(std::thread::spawn(move || {
                for _ in 0..25 {
                    let n = next_seq(&root).unwrap();
                    seen.lock().unwrap().push(n);
                }
            }));
        }
        for hand in hands {
            hand.join().unwrap();
        }
        let mut all = seen.lock().unwrap().clone();
        all.sort_unstable();
        let unique = {
            let mut copy = all.clone();
            copy.dedup();
            copy
        };
        assert_eq!(all.len(), 200);
        assert_eq!(unique.len(), 200, "two callers were handed one sequence");
        assert_eq!(
            all,
            (1..=200).collect::<Vec<_>>(),
            "the sequence skipped or repeated"
        );
    }

    #[test]
    fn a_key_with_no_counter_is_refused_rather_than_restarted_at_one() {
        /* ⚠️ **A PRESENT FILE WITH NO `seq` READ AS ZERO, AND A MISSING FILE
        BESIDE AN EXISTING KEY DID TOO** — found by audit. Either way the voice
        reuses every sequence it has published at. The reader's remedy is to
        rotate, which mints a voice with no history to collide with. */
        let dir = ScratchDir::new("voice-lost-counter");
        status(dir.path()).unwrap();
        next_seq(dir.path()).unwrap();
        std::fs::remove_file(state_path(dir.path())).unwrap();
        assert_eq!(status(dir.path()).unwrap_err().kind(), "shareMalformed");
        assert_eq!(next_seq(dir.path()).unwrap_err().kind(), "shareMalformed");
    }

    /// ⚠️ **THE TEST ABOVE ASSERTS THE REFUSAL AND ITS COMMENT NAMES THE
    /// REMEDY, AND NOTHING CHECKED THE REMEDY WORKED.** It did not: `rotate`
    /// went through `ensure`, which reads the state, which is the very thing
    /// that refuses — so the error told the reader to do the one thing that
    /// could not be done, and the device was stuck for good. Found by audit.
    /// An error message naming a recovery is a claim, and a claim needs a test.
    #[test]
    fn the_remedy_the_refusal_names_actually_works() {
        let dir = ScratchDir::new("voice-lost-counter-recovers");
        let before = status(dir.path()).unwrap().voice;
        next_seq(dir.path()).unwrap();
        std::fs::remove_file(state_path(dir.path())).unwrap();
        assert!(status(dir.path()).is_err(), "the refusal did not fire");

        let after = rotate(dir.path(), 8 * HOUR).unwrap();
        assert_ne!(after.voice, before, "rotation did not mint a new voice");
        /* And the device WORKS again afterwards: this is the whole point. */
        assert_eq!(status(dir.path()).unwrap().voice, after.voice);
        assert!(
            next_seq(dir.path()).is_ok(),
            "the device still cannot publish"
        );
        /* The old key is retained, so what it published can still be
        withdrawn — the retain-before-replace guarantee is not sacrificed to
        the recovery. */
        assert!(
            retired_dir(dir.path())
                .join(format!("{before}.key"))
                .exists(),
            "recovery threw away the old key"
        );
    }

    /// ⚠️ **RETAIN-FIRST IS ONLY A GUARANTEE IF A FAILED RETENTION STOPS THE
    /// ROTATION.** The ordering was right and the error handling undid it: a
    /// directory sync that failed was logged, and the code went on to destroy
    /// the current key — producing precisely the outcome the ordering exists to
    /// prevent, a key gone with no copy, and every publication it signed
    /// permanently unwithdrawable. Found by audit.
    ///
    /// The failure is induced by making the retirement directory unwritable,
    /// which is a different step from the sync but the same rule: nothing has
    /// been destroyed yet, so refusing costs a retry and continuing can cost
    /// the reader everything.
    #[cfg(unix)]
    #[test]
    fn a_rotation_that_cannot_retain_the_old_key_does_not_destroy_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScratchDir::new("voice-retain-fails");
        let before = status(dir.path()).unwrap().voice;

        std::fs::create_dir_all(retired_dir(dir.path())).unwrap();
        let readonly = std::fs::Permissions::from_mode(0o500);
        std::fs::set_permissions(retired_dir(dir.path()), readonly).unwrap();

        let outcome = rotate(dir.path(), 8 * HOUR);
        /* Restored before any assertion, so a failure here cannot leave the
        scratch directory undeletable. */
        std::fs::set_permissions(
            retired_dir(dir.path()),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();

        assert!(
            outcome.is_err(),
            "rotation reported success it did not have"
        );
        assert_eq!(
            status(dir.path()).unwrap().voice,
            before,
            "the current key was destroyed after the retention failed"
        );
        /* And the device still works: it can still publish under that voice. */
        assert!(next_seq(dir.path()).is_ok());
    }

    /// ⚠️ **THE COUNTER CROSSES INTO JAVASCRIPT AND `u64` DOES NOT FIT.** A
    /// sequence past `Number.MAX_SAFE_INTEGER` is one this device can persist
    /// and hand over, and which `envelope.ts` then refuses for ever — the
    /// number is safely on disk and nothing can publish under it again.
    #[test]
    fn the_sequence_stops_at_what_the_transport_can_carry() {
        let dir = ScratchDir::new("voice-seq-ceiling");
        status(dir.path()).unwrap();
        let mut state = read_state(dir.path()).unwrap();
        state.seq = MAX_SAFE_SEQ - 1;
        write_state(dir.path(), &state).unwrap();

        assert_eq!(next_seq(dir.path()).unwrap(), MAX_SAFE_SEQ);
        let refused = next_seq(dir.path()).expect_err("a sequence past the safe range was minted");
        assert!(
            refused.to_string().contains("no sequence numbers left"),
            "refused for the wrong reason: {refused}"
        );
    }

    /// ⚠️ **AND ROTATION IS THE WAY OUT, SO IT MUST WORK FROM THERE.** The
    /// refusal names rotating; a ceiling that also blocked the remedy would be
    /// the `ensure` deadlock again under a different number.
    #[test]
    fn a_voice_at_the_ceiling_can_still_rotate() {
        let dir = ScratchDir::new("voice-seq-ceiling-rotate");
        status(dir.path()).unwrap();
        let mut state = read_state(dir.path()).unwrap();
        state.seq = MAX_SAFE_SEQ;
        write_state(dir.path(), &state).unwrap();
        assert!(next_seq(dir.path()).is_err());

        rotate(dir.path(), 8 * HOUR).expect("the remedy the refusal names did not work");
        /* ⚠️ **THE SEQUENCE IS CARRIED, NOT RESET** — see `rotate` — so the
        fresh voice is still at the ceiling and still refuses. That is honest
        rather than convenient: resetting would be one lost state file away
        from reusing a number the OLD voice already published under. */
        assert!(next_seq(dir.path()).is_err());
    }

    #[test]
    fn a_retirement_that_is_not_a_voice_refuses_the_whole_file() {
        /* ⚠️ **RETIREMENT RECORDS BECAME DELETION PATHS UNVALIDATED**, so
        `../identity` targeted the CIRCLE's key — found by audit. Validated
        where they enter, not where they are used. */
        let dir = ScratchDir::new("voice-bad-retirement");
        status(dir.path()).unwrap();
        std::fs::write(
            state_path(dir.path()),
            br#"{"v":1,"seq":3,"retired":[{"voice":"../identity","until":9}]}"#,
        )
        .unwrap();
        assert_eq!(status(dir.path()).unwrap_err().kind(), "shareMalformed");
        /* And the circle's own key is untouched, because nothing ever joined
        that name onto a path. */
        assert!(crate::identity::load_or_create(dir.path()).is_ok());
    }

    #[test]
    fn a_swept_key_left_on_disk_cannot_still_sign() {
        /* ⚠️ **`sign` READ THE DIRECTORY AND THE SWEEP WROTE THE CALENDAR**, so
        a key whose file survived a failed unlink went on signing for ever
        while `status` reported it forgotten — found by audit. */
        let dir = ScratchDir::new("voice-swept-file");
        let before = status(dir.path()).unwrap().voice;
        rotate(dir.path(), 5 * HOUR).unwrap();
        sweep(dir.path(), 5 * HOUR).unwrap();
        /* Put the file back, as a failed unlink would have left it. */
        std::fs::create_dir_all(retired_dir(dir.path())).unwrap();
        std::fs::write(
            retired_dir(dir.path()).join(format!("{before}.key")),
            [7u8; 32],
        )
        .unwrap();
        assert!(
            sign(dir.path(), "paper.public.1.envelope\n{}", Some(&before)).is_err(),
            "a key with no calendar entry still signed"
        );
        /* And the next sweep takes the orphan away rather than leaving key
        material on the disk for ever. */
        sweep(dir.path(), 9 * HOUR).unwrap();
        assert!(!retired_dir(dir.path())
            .join(format!("{before}.key"))
            .exists());
    }

    fn parse_sig(hex: &str) -> iroh::Signature {
        let mut bytes = [0u8; 64];
        for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
            bytes[i] = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
        }
        iroh::Signature::from_bytes(&bytes)
    }
}

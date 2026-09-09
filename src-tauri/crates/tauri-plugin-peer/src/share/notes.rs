//! Public annotations, served to strangers — WI-25.9.
//!
//! ⚠️ **THIS IS A DIFFERENT SERVICE FROM THE BYTES, NOT A MODE OF IT.** Phase
//! 26 assumed that whatever resolves *"who has book X"* also serves that
//! book's public annotations. It does not follow, and the common case is the
//! opposite: a reader wants to publish notes on a book while **never serving
//! its bytes**, which is the whole reason `SharePolicy` defaults byte-serving
//! to off. So the two have separate ALPNs, separate DHT topics (`topic.rs`)
//! and separate switches (`policy.rs`), and a provider may answer this one
//! while refusing the other.
//!
//! ## What this module knows about an annotation: nothing
//!
//! A record is an opaque line. This plugin is policy-free — *"it knows nothing
//! of books, journals or services"* — and the envelope, its signature, its
//! ordering and its withdrawal rules are phase 26's, in TypeScript, where the
//! rest of the circle's crypto already lives. What is here is the transport,
//! the storage and the bounds: the three things a stranger-facing service
//! cannot delegate to a webview.
//!
//! ⚠️ **AND IT CANNOT DELEGATE THEM, WHICH IS WHY THE FILE IS READ IN RUST.**
//! `AGENTS.md` §"When the MCP screenshot does not work" measures what an
//! occluded or post-lock webview does: it fires no timer for minutes at a
//! time and `pgrep` cannot see the difference. A public service that answered
//! only while the reader was looking at the window would be down most of the
//! time, and up in a way nothing could observe.

use std::path::{Path, PathBuf};

use iroh::endpoint::{Connection, VarInt};
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use tokio::time::{timeout, Duration};

use crate::error::{Error, Result};
use crate::frame;
use crate::share::bounds::ShareBounds;
use crate::share::policy::{share_dir, SharePolicy, ShareService};
use crate::share::ContentHash;

/// The share endpoint's annotation protocol.
///
/// ⚠️ **NOT UNDER `paper/circle/`.** Phase 26's rule is that public and circle
/// share no authorization, no storage and no wire type; an ALPN under the
/// circle's own prefix would be the first of those three to blur, and it is
/// the one a reviewer is least likely to look at.
pub const NOTES_ALPN: &[u8] = b"paper/share-notes/1";

/// How long a stranger has to open a stream.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// How long ONE exchange has, end to end — the request, the work and the reply.
///
/// ⚠️ **THE TIMEOUT COVERED ONLY `accept_bi`, AND EVERYTHING AFTER IT HAD
/// NONE.** Found by audit: a stranger sending a partial frame held the stream
/// open indefinitely, occupying a connection slot and a transfer permit. A
/// deadline on the door is not a deadline on the room.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

/// The most a request frame may be — far smaller than `MAX_FRAME`.
///
/// A door a stranger may open must not be willing to allocate four megabytes
/// because a stranger said it would send that much; `frame::read_capped` takes
/// the cap for exactly this, and `circle::CIRCLE_HELLO_ALPN` sets the
/// precedent one endpoint over.
const MAX_REQUEST: u32 = 4 * 1024;

/// The most one annotation record may be.
///
/// ⚠️ **A CAP ON WHAT IS STORED, NOT ONLY ON WHAT MOVES.** WI-26.7's finding
/// is that traffic limits are not storage limits; this is the storage one, at
/// the only place that can enforce it — the write.
pub const MAX_RECORD: usize = 16 * 1024;

/// The most records one book's file may hold.
pub const MAX_RECORDS_PER_BOOK: usize = 4_096;

/// The most BYTES one book's file may hold.
///
/// ⚠️ **THE RECORD COUNT ALONE IS NOT WHAT MAKES THE REWRITE AFFORDABLE, AND
/// THIS COMMENT USED TO SAY IT WAS.** [`append`] publishes the whole file
/// through `write_atomic`, so the cost of one append is the size of the file —
/// and `MAX_RECORDS_PER_BOOK * MAX_RECORD` is sixty-four megabytes, which is
/// not a size to rewrite on every published annotation. Two mebibytes is the
/// bound that actually holds it down, and it is the same number the TypeScript
/// side keeps for what it RETAINS from strangers (`MAX_HELD_BYTES_PER_BOOK`) —
/// one book's public annotations are the same order of thing on both sides.
pub const MAX_NOTES_BYTES_PER_BOOK: usize = 2 * 1024 * 1024;

/// The most records one response carries.
///
/// A cursor makes the rest reachable in another round trip, which is what
/// keeps one request from being an unbounded amount of work.
pub const MAX_RECORDS_PER_ANSWER: usize = 256;

/// The most bytes one response carries, whatever the record count.
pub const MAX_ANSWER_BYTES: usize = 512 * 1024;

/// `<root>/peer/share/notes/`.
fn notes_dir(root: &Path) -> PathBuf {
    share_dir(root).join("notes")
}

/// One lock per `(root, book)`, so a publication is one transaction.
///
/// ⚠️ **IT LEAKED ONE MUTEX PER BOOK, FOR EVER, AND IT WAS COPIED FROM A CASE
/// WHERE THAT IS FINE.** `voice.rs` and `circle.rs` keep the same map keyed by
/// ROOT — one entry per data root, which is one in production and a handful in
/// tests, and their comments say so. This one is keyed by `(root, BOOK)`, so
/// the bound is "every book this device has ever touched" — including a book
/// it refused, since the entry was allocated before the record was validated,
/// and including one it merely forgot. Nothing was ever released. Found by
/// audit.
///
/// An `Arc` handed to the caller with a `Weak` left in the map: while anybody
/// holds it, everybody gets the SAME mutex — which is the whole point — and
/// when the last holder drops it the entry becomes dead and the next call
/// sweeps it. Two callers that do not overlap get different mutexes, which
/// costs nothing: there was no contention to serialise.
fn book_lock(root: &Path, hash: &ContentHash) -> std::sync::Arc<std::sync::Mutex<()>> {
    /// The map, named so the type reads and clippy is satisfied at once.
    type BookLocks = std::sync::Mutex<
        std::collections::HashMap<(PathBuf, String), std::sync::Weak<std::sync::Mutex<()>>>,
    >;
    static LOCKS: std::sync::OnceLock<BookLocks> = std::sync::OnceLock::new();
    let locks = LOCKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut held = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = (root.to_path_buf(), hash.as_str().to_owned());
    if let Some(live) = held.get(&key).and_then(std::sync::Weak::upgrade) {
        return live;
    }
    /* Swept here rather than on drop: a `Drop` impl would need the map's lock
    while the last `Arc` is going, which is a lock taken from inside a drop
    — and the sweep is a walk over a map bounded by what is CURRENTLY in
    flight plus whatever has just finished. */
    held.retain(|_, weak| weak.strong_count() > 0);
    let fresh = std::sync::Arc::new(std::sync::Mutex::new(()));
    held.insert(key, std::sync::Arc::downgrade(&fresh));
    fresh
}

/// `<root>/peer/share/notes/<hash>.jsonl`.
///
/// ⚠️ **THE NAME IS A PARSED [`ContentHash`] AND NOT A `&str`.** Sixty-four
/// lower-case hex digits cannot contain a separator, a `..` or a NUL, so the
/// join below cannot leave the directory — by the type, not by a check
/// somewhere up the call chain that a later caller might skip.
fn notes_path(root: &Path, hash: &ContentHash) -> PathBuf {
    notes_dir(root).join(format!("{}.jsonl", hash.as_str()))
}

/// What a stranger asks for.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesRequest {
    /// The wire version. Refused rather than ignored when unknown.
    pub v: u32,
    /// The book, by its `contentHash`.
    pub hash: String,
    /// How many records the asker already holds. A plain count, because the
    /// file is append-only and records are never rewritten in place.
    #[serde(default)]
    pub since: u64,
    /// The history this count belongs to — see [`NotesAnswer::generation`].
    ///
    /// ⚠️ **OPTIONAL, SO AN OLDER CLIENT IS NOT BROKEN BY THIS FIELD.** Absent
    /// means "I am not tracking which history my count came from", and that
    /// client is served exactly as it was before the field existed. Sending it
    /// is what buys the reset after a `forget`.
    #[serde(default, rename = "gen")]
    pub generation: Option<u64>,
}

/// The version this build speaks.
pub const NOTES_VERSION: u32 = 1;

/// Which history a count belongs to, derived from the first record.
///
/// ⚠️ **DERIVED, NOT STORED, AND THAT IS WHAT MAKES IT FREE.** A sidecar
/// counter would be a second file to keep consistent with the first and a new
/// way for the two to disagree. The file is APPEND-ONLY, so its first record
/// never changes while the history lives — and a `forget` followed by fresh
/// publications almost always begins with different bytes. When it does not,
/// the histories genuinely share that prefix and the client's count is still
/// correct, so answering "same generation" is right rather than lucky.
///
/// Zero for an empty history: there is nothing to be a cursor into.
fn generation_of(records: &[Vec<u8>]) -> u64 {
    let Some(first) = records.first() else {
        return 0;
    };
    let digest = blake3::hash(first);
    u64::from_le_bytes(digest.as_bytes()[..8].try_into().expect("8 of 32 bytes"))
}

/// The header that precedes the records, or the refusal that replaces them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesAnswer {
    pub v: u32,
    pub ok: bool,
    /// Which history `next` counts within.
    ///
    /// ⚠️ **A COUNT ALONE IS NOT A CURSOR ACROSS A `forget`.** Deleting a
    /// book's notes starts a new history at zero, and a client holding a count
    /// from the old one skipped that many of the new records permanently. Echo
    /// this back as `gen` and a mismatch resets the count instead.
    #[serde(rename = "gen")]
    pub generation: u64,
    /// How many record frames follow.
    pub count: u64,
    /// What the next request should send as `since`.
    pub next: u64,
    /// Whether more records exist past `next`.
    pub more: bool,
    /// ⚠️ **ONE SENTENCE, WHATEVER THE REASON.** `answerCover` in the circle
    /// capability carries the same rule and the same reason: a refusal that
    /// names which check failed is an oracle, and here the checks include
    /// "does this machine hold that book at all", which is precisely what a
    /// stranger must not be able to enumerate.
    ///
    /// ⚠️ **A `String` AND NOT A `&'static str`, SO THE ASKER CAN READ IT.**
    /// The client half of this protocol deserialises the same type — one
    /// definition, because a second one is a definition that can drift — and a
    /// borrowed static cannot be deserialised from a transient frame. One
    /// allocation per refusal, and refusals are the cheap path anyway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

impl NotesAnswer {
    fn refused() -> Self {
        Self {
            v: NOTES_VERSION,
            ok: false,
            /* ⚠️ **ZERO, WHICH IS THE EMPTY HISTORY'S OWN GENERATION.** A
             * refusal must not carry the real one: it says the same thing
             * whatever the reason, and a generation that changed with the
             * book's contents would let a stranger tell "no such book" from
             * "withdrawn since you last looked" by watching it move. See
             * `why`. */
            generation: 0,
            count: 0,
            next: 0,
            more: false,
            why: Some("nothing here".into()),
        }
    }
}

/// Append one record for a book, under the storage caps.
///
/// The caller is the app, over a command — this is the only writer.
pub fn append(root: &Path, hash: &ContentHash, record: &[u8]) -> Result<u64> {
    /* ⚠️ **THE WHOLE TRANSACTION IS SERIALISED, AND IT WAS AN UNLOCKED
     * READ-MODIFY-WRITE.** Found by audit: two publication commands run on two
     * blocking workers, both read the same file, both rewrite a different
     * successor, and both report success — one record silently lost. An append
     * racing a `forget` could also recreate deleted history. Per BOOK, because
     * two books share nothing; the same shape `voice.rs` takes per root. */
    let _held = book_lock(root, hash);
    let _guard = _held
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    append_locked(root, hash, record)
}

/// Everything [`append`] does, once the book's lock is held.
fn append_locked(root: &Path, hash: &ContentHash, record: &[u8]) -> Result<u64> {
    if record.is_empty() || record.len() > MAX_RECORD {
        return Err(Error::ShareRefused(format!(
            "a public annotation is 1..={MAX_RECORD} bytes, not {}",
            record.len()
        )));
    }
    /* ⚠️ **A NEWLINE IN A RECORD WOULD SPLIT IT INTO TWO RECORDS**, and the
     * second half would be served as an annotation nobody wrote. The format is
     * one record per line, so the line separator is the one byte a record may
     * not contain. Refused rather than escaped: the writer is our own app
     * sending canonical JSON, which has no raw newline in it. */
    if record.contains(&b'\n') {
        return Err(Error::ShareRefused(
            "a public annotation record may not contain a newline".into(),
        ));
    }
    let path = notes_path(root, hash);
    let held = read_records(&path)?;
    if held.len() >= MAX_RECORDS_PER_BOOK {
        return Err(Error::ShareRefused(format!(
            "this book already holds the {MAX_RECORDS_PER_BOOK} public annotations one book may have"
        )));
    }
    /* The byte bound as well as the count — see `MAX_NOTES_BYTES_PER_BOOK`.
     * Each record costs its own length plus the newline that separates it. */
    let bytes_held: usize = held.iter().map(|one| one.len() + 1).sum();
    if bytes_held + record.len() + 1 > MAX_NOTES_BYTES_PER_BOOK {
        return Err(Error::ShareRefused(format!(
            "this book's public annotations already fill the {MAX_NOTES_BYTES_PER_BOOK} bytes one book may have"
        )));
    }
    /* Rewritten whole rather than appended in place: `write_atomic` is what
     * every other store in this plugin publishes through, and an append that
     * is interrupted mid-line leaves a record that parses as a shorter one.
     * The cap above is what makes rewriting affordable. */
    let mut bytes =
        Vec::with_capacity(held.iter().map(|r| r.len() + 1).sum::<usize>() + record.len() + 1);
    for held_record in &held {
        bytes.extend_from_slice(held_record);
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(record);
    bytes.push(b'\n');
    crate::store::write_atomic(&path, &bytes)?;
    Ok(held.len() as u64 + 1)
}

/// Forget every public annotation for a book — what turning `notes` off does
/// to what is already on disk.
pub fn forget(root: &Path, hash: &ContentHash) -> Result<()> {
    /* On the same lock as `append`, so a publication racing a withdrawal
     * cannot recreate what was just deleted. */
    let held = book_lock(root, hash);
    let _guard = held.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match std::fs::remove_file(notes_path(root, hash)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// How many records a book holds here.
pub fn count(root: &Path, hash: &ContentHash) -> Result<u64> {
    Ok(read_records(&notes_path(root, hash))?.len() as u64)
}

/// The records, in file order. Absent is empty; unreadable throws.
///
/// ⚠️ **ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER** — `readMarks` names
/// this as the most destructive line it ever had, and [`append`] rewrites the
/// file from what this returns, so collapsing the two here would publish an
/// empty file over everything the reader had written.
/// The records, and the size that was charged for reading them.
///
/// ⚠️ **ONE OPEN, NOT A `metadata` THEN A `read`.** The serve path took the
/// size from one lookup, charged it, SLEPT for the rate limit, and then reopened
/// the path — so an append landing in between made the actual read larger than
/// the charge, and a file that was absent at the first lookup was read for
/// nothing at all. The handle is the snapshot: its metadata is what is charged,
/// and at most that many bytes are read from it, so what is paid for and what is
/// taken cannot diverge however the file changes underneath.
fn read_snapshot(path: &Path) -> Result<(Vec<Vec<u8>>, u64)> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(err) => return Err(err.into()),
    };
    let size = file.metadata()?.len();
    if size > MAX_NOTES_BYTES_PER_BOOK as u64 {
        return Err(Error::ShareMalformed {
            path: path.to_path_buf(),
            why: format!("{size} bytes is over the cap"),
        });
    }
    /* Bounded by the size that was measured on THIS handle, so an append
     * racing the read cannot make it bigger than what was charged. */
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(size).read_to_end(&mut bytes)?;
    Ok((records_of(path, &bytes)?, size))
}

fn read_records(path: &Path) -> Result<Vec<Vec<u8>>> {
    Ok(read_snapshot(path)?.0)
}

/// One file's bytes, split into records under the bounds.
///
/// ⚠️ **EVERY BOUND RUNS BEFORE THE WORK IT BOUNDS.** The size is refused from
/// the handle's metadata before a byte is read (see [`read_snapshot`]), and the
/// record count is refused AS RECORDS ACCUMULATE rather than once they all
/// have — both used to describe the result while paying for the whole input to
/// reach it. `importLimits.ts` states the rule; `publicStore` follows it on the
/// TypeScript side.
fn records_of(path: &Path, bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    for line in bytes.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_RECORD {
            return Err(Error::ShareMalformed {
                path: path.to_path_buf(),
                why: format!("a record of {} bytes is over the cap", line.len()),
            });
        }
        if out.len() >= MAX_RECORDS_PER_BOOK {
            return Err(Error::ShareMalformed {
                path: path.to_path_buf(),
                why: format!("more than {MAX_RECORDS_PER_BOOK} records is over the cap"),
            });
        }
        out.push(line.to_vec());
    }
    Ok(out)
}

/// Answer one stranger.
///
/// ⚠️ **THE POLICY IS ASKED HERE, INSIDE THE REQUEST, ON EVERY REQUEST.** Not
/// when the connection opened and not when the file was written: WI-25.5's
/// acceptance turns a book off and requires the refusal on a connection that
/// is already open, and a connection may carry many requests.
pub async fn serve(
    root: PathBuf,
    policy: std::sync::Arc<SharePolicy>,
    bounds: ShareBounds,
    conn: Connection,
) {
    let Ok(_connection) = bounds.take_connection() else {
        /* CLOSED WITHOUT AN ANSWER, deliberately distinguishable from a
         * refusal — `circle::serve` carries the reasoning: a caller told
         * "nothing here" should stop asking, and one turned away for load
         * should come back in a second. */
        conn.close(VarInt::from_u32(2), b"busy");
        return;
    };
    loop {
        let Ok(Ok((mut send, mut recv))) = timeout(REQUEST_TIMEOUT, conn.accept_bi()).await else {
            break;
        };
        /* ⚠️ **THE WHOLE EXCHANGE IS UNDER A DEADLINE, INCLUDING THE FLUSH.**
         * A client that never reads leaves the write blocked on flow control
         * for as long as it likes, which holds this connection's slot and its
         * transfer permit — the same denial as the partial frame, from the
         * other end. */
        let exchange = timeout(EXCHANGE_TIMEOUT, async {
            /* ⚠️ **THE PERMIT OUTLIVES THE FLUSH, AND IT USED TO DIE WITH
             * `answer`.** It was a local in `answer`, so it was released the
             * moment the records were written to the stream — while `flush`
             * below still waits for the client to take them. Unacknowledged
             * responses could therefore pile up past
             * `concurrent_transfers`, which is the bound that exists because
             * each one holds buffers. Same defect as the blob path's permit,
             * which was released on connection close rather than on request
             * completion: both had the release point wrong, in opposite
             * directions. `answer` fills the slot and this scope holds it. */
            let mut permit = None;
            let answered = answer(&root, &policy, &bounds, &mut recv, &mut send, &mut permit).await;
            crate::pairing::flush(&mut send).await;
            drop(permit);
            answered
        })
        .await;
        match exchange {
            Ok(Ok(())) => {}
            Ok(Err(err)) => log::debug!("peer: a public annotation request ended: {err}"),
            Err(_) => {
                log::debug!("peer: a public annotation exchange ran out of time");
                break;
            }
        }
    }
    conn.close(VarInt::from_u32(0), b"done");
}

async fn answer(
    root: &Path,
    policy: &SharePolicy,
    bounds: &ShareBounds,
    recv: &mut iroh::endpoint::RecvStream,
    send: &mut iroh::endpoint::SendStream,
    /* Filled with the transfer permit, so the CALLER can hold it across the
     * flush — see the note at the call site. */
    permit: &mut Option<tokio::sync::OwnedSemaphorePermit>,
) -> Result<()> {
    let frame = frame::read_capped(recv, MAX_REQUEST)
        .await?
        .ok_or_else(|| Error::FrameMalformed("the stream ended before the request".into()))?;
    let request: NotesRequest =
        serde_json::from_slice(&frame).map_err(|err| Error::FrameMalformed(err.to_string()))?;

    /* Version, then the hash, then the policy, then the bytes — cheapest
     * refusal first, which is `checkPage`'s ordering and its reason: a
     * stranger who can make us do the expensive step on malformed input has
     * found a cheap way to spend our disk. */
    if request.v != NOTES_VERSION {
        return refuse(send).await;
    }
    let Ok(hash) = ContentHash::parse(&request.hash) else {
        return refuse(send).await;
    };
    if !policy.allows(&hash, ShareService::Notes) {
        return refuse(send).await;
    }
    let Ok(taken) = bounds.take_transfer() else {
        return refuse(send).await;
    };
    *permit = Some(taken);

    /* ⚠️ **THE DISK READ IS CHARGED BEFORE IT HAPPENS, AND IT WAS CHARGED
     * AFTER — BY WHAT WAS SENT.** Found by audit: a request with `since` at or
     * beyond the end read the whole file and charged ZERO, so repeating it was
     * an unbounded disk read at no cost, bypassing the rate protection
     * entirely. What costs the machine is the READ, not the reply. The size
     * comes from the metadata, so the charge precedes the allocation as well
     * as the read — `importLimits.ts`'s rule. */
    let path = notes_path(root, &hash);
    /* ⚠️ **THE SIZE THAT IS CHARGED COMES FROM THE HANDLE THAT IS READ.** A
     * `metadata` here, a sleep, and a reopen there let an append land in
     * between — the read was then larger than the charge, and a file that was
     * absent at the first look was read for nothing. `read_snapshot` opens
     * once and takes at most what it measured, so the two cannot diverge.
     *
     * ⚠️ **OFF THE RUNTIME'S WORKERS.** Synchronous I/O plus a split of up to
     * two mebibytes, on workers shared with the CIRCLE's sessions — a
     * stranger's read blocking one is the public flood starving the circle,
     * which is what `ShareBounds` exists to prevent. */
    let (records, on_disk) = tokio::task::spawn_blocking(move || read_snapshot(&path))
        .await
        .map_err(|err| Error::ShareRefused(format!("that read could not run: {err}")))??;
    if bounds.charge(on_disk).is_err() {
        return refuse(send).await;
    }
    let delay = bounds.read_delay(on_disk);
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    /* ⚠️ **ASKED AGAIN AFTER THE READ AND THE SLEEP, NOT ONLY BEFORE THEM.**
     * WI-25.5's acceptance is that turning a book off refuses on a connection
     * that is ALREADY OPEN, and the rate-limit sleep above can be seconds — so
     * a withdrawal landing during it used to be overtaken by records already in
     * memory. `SharePolicy::allows` says the same thing in its own words: call
     * it per request, not per connection. The records are loaded; what this
     * decides is whether they may still be sent. */
    if !policy.allows(&hash, ShareService::Notes) {
        return refuse(send).await;
    }
    /* The cursor, the generation and the byte cap — see `page_of`. */
    let page = page_of(&records, &request);
    let (carried, next, generation) = (page.carried, page.next, page.generation);
    frame::write_json(
        send,
        &NotesAnswer {
            v: NOTES_VERSION,
            ok: true,
            generation,
            count: carried.len() as u64,
            next,
            more: (next as usize) < records.len(),
            why: None,
        },
    )
    .await?;
    for record in carried {
        frame::write_frame(send, record).await?;
    }
    Ok(())
}

/// What one round of asking a provider brought back.
///
/// ⚠️ **A CURSOR, NOT JUST RECORDS.** The answer is capped at
/// [`MAX_RECORDS_PER_ANSWER`], so a book with more than that takes several
/// rounds — and a count alone is not a cursor across a `forget`, which is what
/// `generation` is for. The caller stores both and sends them back.
#[derive(Debug, Clone)]
pub struct FetchedNotes {
    /// The records, verbatim as they were signed. NEVER parsed here: this
    /// crate has no idea what a public envelope is, and the verification —
    /// signature, expiry, block list, bounds — is the kernel's.
    pub records: Vec<Vec<u8>>,
    /// What to send as `since` next time.
    pub next: u64,
    /// Which history that count belongs to.
    pub generation: u64,
    /// Whether the provider still has more past `next`.
    pub more: bool,
}

/// Ask one provider for a book's public annotations.
///
/// ⚠️ **THIS IS THE HALF THAT WAS MISSING, AND ITS ABSENCE MADE THE WHOLE
/// FEATURE UNREACHABLE.** `serve` above has answered since phase 26 and
/// nothing on any device asked — so `public.jsonl`, the store the overlay
/// reads, had no production writer at all and an ordinary reader never saw a
/// stranger's annotation. Found by audit.
///
/// ⚠️ **EVERY BOUND HERE IS THE ASKER'S OWN.** The header is a claim by a
/// machine we know nothing about: its `count` is capped at what the protocol
/// permits before a single frame is read, each frame is capped at
/// [`MAX_RECORD`], and the read is under a deadline. A provider that promises
/// four billion records must cost us one refusal, not four billion
/// allocations.
pub(crate) async fn ask_one(
    endpoint: &Endpoint,
    provider: EndpointAddr,
    hash: &ContentHash,
    since: u64,
    generation: Option<u64>,
) -> Result<FetchedNotes> {
    let conn = endpoint
        .connect(provider, NOTES_ALPN)
        .await
        .map_err(|err| Error::ShareRefused(format!("that provider would not talk: {err}")))?;
    let exchange = timeout(EXCHANGE_TIMEOUT, async {
        let (mut send, mut recv) = conn.open_bi().await.map_err(|err| {
            Error::ShareRefused(format!("that provider closed the stream: {err}"))
        })?;
        frame::write_json(
            &mut send,
            &NotesRequest {
                v: NOTES_VERSION,
                hash: hash.as_str().to_owned(),
                since,
                generation,
            },
        )
        .await?;
        /* The server reads one request per stream and answers; without the
         * finish it waits for a frame that is never coming. */
        crate::pairing::flush(&mut send).await;
        let header = frame::read_capped(&mut recv, MAX_REQUEST)
            .await?
            .ok_or_else(|| Error::FrameMalformed("the provider sent no answer".into()))?;
        let answer: NotesAnswer = serde_json::from_slice(&header)
            .map_err(|err| Error::FrameMalformed(err.to_string()))?;
        if answer.v != NOTES_VERSION {
            return Err(Error::ShareRefused(format!(
                "that provider speaks version {} of the notes protocol",
                answer.v
            )));
        }
        if !answer.ok {
            /* ⚠️ **ONE SENTENCE, AND IT IS THE PROVIDER'S.** `refuse` says the
             * same thing whatever failed, deliberately — see its own note — so
             * there is nothing here to interpret and nothing to retry
             * differently. */
            return Err(Error::ShareRefused(format!(
                "that provider has nothing for {hash}"
            )));
        }
        /* ⚠️ **THE COUNT IS A STRANGER'S NUMBER.** Capped at what the protocol
         * allows before anything is allocated for it. */
        let promised = usize::try_from(answer.count)
            .unwrap_or(usize::MAX)
            .min(MAX_RECORDS_PER_ANSWER);
        let mut records = Vec::with_capacity(promised);
        for _ in 0..promised {
            let Some(frame) = frame::read_capped(&mut recv, MAX_RECORD as u32).await? else {
                return Err(Error::FrameMalformed(
                    "the provider stopped before the records it promised".into(),
                ));
            };
            records.push(frame.to_vec());
        }
        Ok(FetchedNotes {
            records,
            next: answer.next,
            generation: answer.generation,
            more: answer.more,
        })
    })
    .await;
    conn.close(VarInt::from_u32(0), b"done");
    match exchange {
        Ok(result) => result,
        Err(_) => Err(Error::ShareRefused(
            "that provider did not answer in time".into(),
        )),
    }
}

/// One page of a book's records, chosen from the reader's cursor.
///
/// ⚠️ **EXTRACTED SO PAGINATION CAN BE TESTED WITHOUT A TRANSPORT.** `answer`
/// combined parsing, authorization, rate accounting, the disk read, this, and
/// serialisation — so the only way to ask "what does `since` past the end
/// return?" was to stand up two endpoints. Every rule below is a decision
/// about what a stranger is sent, and each is one line. Found by audit.
struct Page<'a> {
    carried: Vec<&'a Vec<u8>>,
    next: u64,
    generation: u64,
}

fn page_of<'a>(records: &'a [Vec<u8>], request: &NotesRequest) -> Page<'a> {
    /* ⚠️ **A COUNT-ONLY CURSOR SURVIVES A `forget` AND SILENTLY SKIPS.** The
     * file is deleted and a new history begins; a client holding `since: 1`
     * then never sees the new first record, for ever, and nothing anywhere
     * reports it. The generation is derived from the FIRST record — stable
     * across appends by construction, since the file is append-only, and
     * different after a recreation unless the new history genuinely starts
     * with the same bytes, in which case the cursor really is still valid. A
     * client that does not send one is served exactly as before. */
    let generation = generation_of(records);
    let from = match request.generation {
        Some(theirs) if theirs != generation => 0,
        _ => usize::try_from(request.since)
            .unwrap_or(usize::MAX)
            .min(records.len()),
    };
    let mut carried: Vec<&Vec<u8>> = Vec::new();
    let mut carried_bytes = 0usize;
    for record in records.iter().skip(from).take(MAX_RECORDS_PER_ANSWER) {
        /* One record past the byte cap ends the page — unless it is the FIRST,
        because a page of nothing makes no progress and the client would ask
        again for ever. */
        if carried_bytes + record.len() > MAX_ANSWER_BYTES && !carried.is_empty() {
            break;
        }
        carried_bytes += record.len();
        carried.push(record);
    }
    let next = (from + carried.len()) as u64;
    Page {
        carried,
        next,
        generation,
    }
}

/// The one answer a stranger gets when the answer is no.
///
/// ⚠️ **ONE SENTENCE, WHATEVER FAILED.** A bad version, an unparseable hash, a
/// book that is not offered, a book this machine has never held and a machine
/// at its limits are five different facts and one reply. Distinguishing them
/// would let a stranger enumerate a reader's library by asking.
async fn refuse(send: &mut iroh::endpoint::SendStream) -> Result<()> {
    frame::write_json(send, &NotesAnswer::refused()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ScratchDir;

    /// Pagination, without a transport — which is why `page_of` exists.
    ///
    /// ⚠️ **THESE RULES WERE INSIDE AN 88-LINE `answer`**, so asking "what
    /// does a cursor past the end return?" meant standing up two endpoints.
    #[test]
    fn a_page_is_the_cursor_the_caps_and_the_generation() {
        let records: Vec<Vec<u8>> = (0..300)
            .map(|n| format!("{{\"n\":{n}}}").into_bytes())
            .collect();
        let asking = |since: u64, generation: Option<u64>| NotesRequest {
            v: NOTES_VERSION,
            hash: "ab".repeat(32),
            since,
            generation,
        };

        /* At most one answer's worth, whatever is held. */
        let first = page_of(&records, &asking(0, None));
        assert_eq!(first.carried.len(), MAX_RECORDS_PER_ANSWER);
        assert_eq!(first.next, MAX_RECORDS_PER_ANSWER as u64);
        assert_eq!(first.carried[0], &records[0]);

        /* The cursor resumes where it said it would. */
        let second = page_of(&records, &asking(first.next, Some(first.generation)));
        assert_eq!(second.carried.len(), 300 - MAX_RECORDS_PER_ANSWER);
        assert_eq!(second.next, 300);

        /* Past the end is empty, not a panic and not a restart. */
        let past = page_of(&records, &asking(9_999, Some(first.generation)));
        assert!(past.carried.is_empty());
        assert_eq!(past.next, 300);

        /* ⚠️ **A COUNT-ONLY CURSOR SURVIVES A `forget` AND SILENTLY SKIPS.** A
        generation that disagrees resets to the beginning rather than
        skipping that many records of a history it never saw. */
        let other = page_of(&records, &asking(200, Some(first.generation ^ 1)));
        assert_eq!(
            other.carried[0], &records[0],
            "a stale cursor skipped a new history"
        );

        /* An empty history has generation zero — there is nothing to be a
        cursor into. */
        assert_eq!(page_of(&[], &asking(0, None)).generation, 0);
    }

    /// ⚠️ **ONE MUTEX PER BOOK WAS LEAKED FOR EVER**, and an entry was
    /// allocated before the record was even validated — so a flood of refused
    /// appends grew the map without publishing anything.
    ///
    /// Measured on the LOCK ITSELF rather than on the map's size: the tests in
    /// this module run in parallel and legitimately hold locks of their own,
    /// so a count is somebody else's business. What this asserts is the
    /// property the map is supposed to have — that it keeps nothing alive.
    #[test]
    fn a_finished_book_does_not_keep_its_lock() {
        let dir = crate::testutil::scratch("notes-lock-map");
        let one = hash(21);
        let watching = {
            let held = book_lock(&dir, &one);
            std::sync::Arc::downgrade(&held)
        };
        assert!(
            watching.upgrade().is_none(),
            "the lock map kept a book's mutex alive after the last holder finished"
        );
        /* And the entry itself goes on the next call, rather than sitting dead
        in the map for ever. */
        drop(book_lock(&dir, &hash(22)));
    }

    /// And two callers that DO overlap still share one lock, which is the
    /// whole reason the map exists.
    #[test]
    fn two_holders_of_one_book_share_a_lock() {
        let dir = crate::testutil::scratch("notes-lock-shared");
        let one = hash(9);
        let first = book_lock(&dir, &one);
        let second = book_lock(&dir, &one);
        assert!(
            std::sync::Arc::ptr_eq(&first, &second),
            "two publications to one book took different locks"
        );
    }

    fn hash(byte: u8) -> ContentHash {
        ContentHash::parse(&format!("{byte:02x}").repeat(32)).unwrap()
    }

    /// ⚠️ **A BOUND THAT RUNS AFTER THE READ HAS NOT BOUNDED ANYTHING.** The
    /// size cap was consulted once the file was in memory AND every record had
    /// been cloned out of it, so it described what would be kept while the cost
    /// of finding out was twice an attacker-chosen file. `importLimits.ts`
    /// states the rule; this is it in Rust.
    #[test]
    fn an_oversized_notes_file_is_refused_without_being_read() {
        let dir = crate::testutil::scratch("notes-oversized");
        let path = dir.join("notes.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        /* ⚠️ **THE FIRST LINE IS ALSO OVER `MAX_RECORD`, AND THAT IS WHAT
        MAKES THE ORDERING OBSERVABLE.** Both paths refuse, so asserting "it
        refused" proves nothing about when. The two report DIFFERENT things:
        refusing from the file's metadata names the FILE's size, while walking
        the lines first hits the long record and names that. Asserting which
        message arrives is asserting which check ran. */
        let mut bulk = vec![b'x'; MAX_RECORD + 1];
        bulk.push(b'\n');
        while bulk.len() <= MAX_NOTES_BYTES_PER_BOOK {
            bulk.extend_from_slice(&vec![b'y'; 1024]);
            bulk.push(b'\n');
        }
        std::fs::write(&path, &bulk).unwrap();

        let refused = read_records(&path)
            .expect_err("an oversized file was read")
            .to_string();
        assert!(
            refused.contains(&format!("{} bytes is over the cap", bulk.len())),
            "the file was walked before its size was consulted: {refused}"
        );
        assert!(
            !refused.contains("a record of"),
            "the size bound ran after the records were examined: {refused}"
        );
    }

    #[test]
    fn records_append_in_order_and_survive_a_reread() {
        let dir = ScratchDir::new("notes-append");
        assert_eq!(append(dir.path(), &hash(1), b"{\"a\":1}").unwrap(), 1);
        assert_eq!(append(dir.path(), &hash(1), b"{\"a\":2}").unwrap(), 2);
        let held = read_records(&notes_path(dir.path(), &hash(1))).unwrap();
        assert_eq!(held, vec![b"{\"a\":1}".to_vec(), b"{\"a\":2}".to_vec()]);
    }

    #[test]
    fn a_record_with_a_newline_is_refused() {
        /* ⚠️ **IT WOULD BE SERVED AS TWO RECORDS, THE SECOND OF WHICH NOBODY
        WROTE.** One record per line is the format; the separator is the one
        byte a record may not contain. */
        let dir = ScratchDir::new("notes-newline");
        assert!(append(dir.path(), &hash(1), b"{\"a\":1}\n{\"a\":2}").is_err());
        assert_eq!(count(dir.path(), &hash(1)).unwrap(), 0);
    }

    #[test]
    fn an_empty_or_oversized_record_is_refused() {
        let dir = ScratchDir::new("notes-size");
        assert!(append(dir.path(), &hash(1), b"").is_err());
        assert!(append(dir.path(), &hash(1), &vec![b'x'; MAX_RECORD + 1]).is_err());
        assert!(append(dir.path(), &hash(1), &vec![b'x'; MAX_RECORD]).is_ok());
    }

    #[test]
    fn a_book_stops_accepting_records_at_the_cap() {
        /* Traffic limits are not storage limits — WI-26.7's finding, enforced
        at the only place that can: the write. */
        let dir = ScratchDir::new("notes-cap");
        let mut lines = Vec::new();
        for i in 0..MAX_RECORDS_PER_BOOK {
            lines.push(format!("{{\"n\":{i}}}"));
        }
        let bytes = lines.join("\n") + "\n";
        std::fs::create_dir_all(notes_dir(dir.path())).unwrap();
        std::fs::write(notes_path(dir.path(), &hash(2)), bytes).unwrap();
        assert!(append(dir.path(), &hash(2), b"{\"one\":\"more\"}").is_err());
    }

    #[test]
    fn forgetting_a_book_removes_every_record_and_is_idempotent() {
        let dir = ScratchDir::new("notes-forget");
        append(dir.path(), &hash(3), b"{}").unwrap();
        forget(dir.path(), &hash(3)).unwrap();
        assert_eq!(count(dir.path(), &hash(3)).unwrap(), 0);
        forget(dir.path(), &hash(3)).expect("forgetting nothing is not an error");
    }

    #[test]
    fn a_book_stops_accepting_records_at_the_byte_cap_too() {
        /* ⚠️ **THE COUNT ALONE DOES NOT BOUND THE REWRITE.** `append` publishes
        the whole file, so `MAX_RECORDS_PER_BOOK * MAX_RECORD` — sixty-four
        megabytes — would be the cost of one published annotation. */
        /* ⚠️ **`Err(_) => break` ACCEPTED ANY FAILURE AS ENFORCEMENT.** A
        disk error, or an implementation that refused the SECOND record, passed
        this test exactly as the byte cap does — so it could not tell the bound
        working from the bound being unreachable. Found by audit. The count is
        arithmetic, not observation: each append writes the record and one
        newline, so the file holds `MAX_NOTES_BYTES_PER_BOOK / (MAX_RECORD + 1)`
        of them and the next is refused BY THE BYTE CAP, in its own words. */
        let dir = ScratchDir::new("notes-bytes");
        let book = hash(20);
        let big = vec![b'x'; MAX_RECORD];
        let fits = MAX_NOTES_BYTES_PER_BOOK / (MAX_RECORD + 1);
        assert!(
            fits < MAX_RECORDS_PER_BOOK,
            "this fixture would meet the COUNT cap first, so it measures the wrong bound"
        );

        for at in 0..fits {
            append(dir.path(), &book, &big)
                .unwrap_or_else(|err| panic!("record {at} of {fits} was refused: {err}"));
        }
        let refused = append(dir.path(), &book, &big)
            .expect_err("the byte cap did not refuse the record past it");
        assert!(
            refused
                .to_string()
                .contains(&format!("{MAX_NOTES_BYTES_PER_BOOK} bytes")),
            "refused for some other reason than the byte cap: {refused}"
        );

        let on_disk = std::fs::metadata(notes_path(dir.path(), &book))
            .unwrap()
            .len();
        assert_eq!(
            on_disk as usize,
            fits * (MAX_RECORD + 1),
            "the file is not the size {fits} records of this shape make"
        );
        assert!(on_disk as usize <= MAX_NOTES_BYTES_PER_BOOK);
    }

    /// ⚠️ **A COUNT-ONLY CURSOR SURVIVES A `forget` AND SKIPS FOR EVER.** The
    /// file is deleted, a new history begins at zero, and a client still
    /// holding `since: 1` never sees the new first record — silently, with
    /// nothing anywhere reporting it. The generation is what makes the two
    /// histories distinguishable. Found by audit.
    #[test]
    fn the_generation_changes_when_a_history_is_forgotten_and_begun_again() {
        let dir = ScratchDir::new("notes-generation");
        let book = hash(31);
        append(dir.path(), &book, b"the first thing said").unwrap();
        let before = generation_of(&read_records(&notes_path(dir.path(), &book)).unwrap());

        forget(dir.path(), &book).unwrap();
        append(dir.path(), &book, b"something else entirely").unwrap();
        let after = generation_of(&read_records(&notes_path(dir.path(), &book)).unwrap());

        assert_ne!(
            before, after,
            "a recreated history is indistinguishable from the old one, so a stale cursor skips it"
        );
    }

    /// The other direction, and it is not a technicality: a history that
    /// genuinely begins with the same record IS the same prefix, so a client's
    /// count into it is still correct and must not be reset.
    #[test]
    fn the_generation_holds_across_appends_and_across_an_identical_first_record() {
        let dir = ScratchDir::new("notes-generation-stable");
        let book = hash(32);
        append(dir.path(), &book, b"the first thing said").unwrap();
        let first = generation_of(&read_records(&notes_path(dir.path(), &book)).unwrap());
        append(dir.path(), &book, b"and then another").unwrap();
        assert_eq!(
            first,
            generation_of(&read_records(&notes_path(dir.path(), &book)).unwrap()),
            "appending changed the generation, so every client would reset on every publication"
        );

        forget(dir.path(), &book).unwrap();
        append(dir.path(), &book, b"the first thing said").unwrap();
        assert_eq!(
            first,
            generation_of(&read_records(&notes_path(dir.path(), &book)).unwrap()),
            "a history with the same first record is the same prefix and must keep its cursor"
        );
    }

    /// An empty history is not a cursor into anything.
    #[test]
    fn an_empty_history_has_no_generation() {
        assert_eq!(generation_of(&[]), 0);
    }

    #[test]
    fn a_file_already_over_the_byte_cap_is_a_named_error() {
        let dir = ScratchDir::new("notes-bytes-corrupt");
        std::fs::create_dir_all(notes_dir(dir.path())).unwrap();
        /* Lines within `MAX_RECORD`, but too many of them for the file bound —
        which is the state a build with a larger cap would leave behind. */
        let line = vec![b'x'; 1024];
        let mut bytes = Vec::new();
        while bytes.len() <= MAX_NOTES_BYTES_PER_BOOK {
            bytes.extend_from_slice(&line);
            bytes.push(b'\n');
        }
        std::fs::write(notes_path(dir.path(), &hash(21)), bytes).unwrap();
        assert_eq!(
            read_records(&notes_path(dir.path(), &hash(21)))
                .unwrap_err()
                .kind(),
            "shareMalformed"
        );
    }

    #[test]
    fn a_book_with_no_file_holds_no_records_rather_than_failing() {
        let dir = ScratchDir::new("notes-absent");
        assert_eq!(count(dir.path(), &hash(4)).unwrap(), 0);
    }

    #[test]
    fn the_file_name_cannot_leave_the_notes_directory() {
        /* By the type: `ContentHash` is 64 lower-case hex digits, so there is
        no value of it that contains a separator. The test is over the parser,
        because that is where the property is created. */
        let dir = ScratchDir::new("notes-path");
        assert!(ContentHash::parse("../../../etc/passwd").is_err());
        let path = notes_path(dir.path(), &hash(5));
        assert!(path.starts_with(notes_dir(dir.path())));
    }

    #[test]
    fn an_oversized_line_on_disk_is_a_named_error_not_a_short_read() {
        let dir = ScratchDir::new("notes-corrupt");
        std::fs::create_dir_all(notes_dir(dir.path())).unwrap();
        std::fs::write(notes_path(dir.path(), &hash(6)), vec![b'x'; MAX_RECORD + 1]).unwrap();
        let err = read_records(&notes_path(dir.path(), &hash(6))).unwrap_err();
        assert_eq!(err.kind(), "shareMalformed");
    }
}

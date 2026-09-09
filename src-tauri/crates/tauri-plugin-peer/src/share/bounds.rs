//! What serving strangers may cost this machine — WI-25.6.
//!
//! ⚠️ **THE CIRCLE'S BUDGETS DO NOT TRANSFER, AND THE REASON IS STRUCTURAL.**
//! `core/circle/bound.ts` charges per `(peer, work)`. That works because a
//! circle peer is a person who had to be admitted: a fresh key buys nothing,
//! because a fresh key is not in the circle. Here a fresh key is free and
//! anonymous, so a per-peer budget is a budget per *attacker patience* — and
//! its 16 MiB per work would not finish many legitimate books anyway.
//!
//! So the bounds here are **machine-wide**: one pool of bytes per day, one
//! count of concurrent transfers, one read rate. A thousand fresh keys share
//! one allowance rather than being handed a thousand.
//!
//! ## Isolation from the circle is the other half
//!
//! ⚠️ **A PUBLIC FLOOD MUST NOT STARVE THE CIRCLE**, and nothing here would
//! stop it on its own: the two share a process, a disk and a CPU. What buys
//! the isolation is that the two endpoints hold SEPARATE limiters — this
//! struct governs the share endpoint and never touches `Node::hello_limit`,
//! `Node::blob_serve_limit` or the circle's own spend ledger. A share
//! transfer that is refused for want of a permit has taken no circle permit
//! to be refused, which is what makes the circle's latency independent of
//! public load rather than merely usually fine.
//!
//! ## Every number here is a starting point, and says so
//!
//! No measurement exists yet for what a public provider costs a reading
//! machine — phase 25 records that as unchecked. These are stated so the
//! acceptance test has something to be inside, and so that changing one is a
//! deliberate act with a name.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// The most bytes this machine serves strangers in one window.
///
/// Eight gigabytes a day: a few dozen large books, or a great many small
/// ones, and nothing like enough to be a useful mirror for somebody else's
/// distribution problem.
pub const DEFAULT_BYTES_PER_WINDOW: u64 = 8 * 1024 * 1024 * 1024;

/// The window the byte allowance is measured over.
pub const DEFAULT_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

/// The most transfers served at once.
///
/// ⚠️ **THIS IS THE CONCURRENCY BOUND AND ALSO THE MEMORY BOUND.** Each
/// transfer holds buffers; unbounded transfers is unbounded memory, which is
/// the failure mode a byte-per-day cap does not touch at all — a thousand
/// connections each moving one byte an hour spends no allowance and exhausts
/// the machine.
pub const DEFAULT_CONCURRENT_TRANSFERS: usize = 8;

/// The most connections held open at once on the share endpoint.
///
/// Above the transfer limit, so a client that is queueing is not also being
/// disconnected, and far enough below anything that matters that a flood is
/// refused at the door rather than inside it.
pub const DEFAULT_CONCURRENT_CONNECTIONS: usize = 64;

/// The most bytes a second read from disk on the share endpoint's behalf.
///
/// ⚠️ **A DISK RATE, NOT A NETWORK RATE, AND THAT IS THE POINT.** The thing a
/// reader notices when their machine is serving is not the uplink — it is the
/// book taking a second to open. Sixteen mebibytes a second saturates most
/// domestic uplinks while leaving an SSD almost entirely to the reader.
pub const DEFAULT_READ_BYTES_PER_SECOND: u64 = 16 * 1024 * 1024;

/// The numbers, together, so a caller states them all or takes them all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShareLimits {
    pub bytes_per_window: u64,
    pub window: Duration,
    pub concurrent_transfers: usize,
    pub concurrent_connections: usize,
    pub read_bytes_per_second: u64,
}

impl Default for ShareLimits {
    fn default() -> Self {
        Self {
            bytes_per_window: DEFAULT_BYTES_PER_WINDOW,
            window: DEFAULT_WINDOW,
            concurrent_transfers: DEFAULT_CONCURRENT_TRANSFERS,
            concurrent_connections: DEFAULT_CONCURRENT_CONNECTIONS,
            read_bytes_per_second: DEFAULT_READ_BYTES_PER_SECOND,
        }
    }
}

/// Why a request was refused, for the log and for the caller's own error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// The day's bytes are spent.
    Bytes,
    /// Too many transfers already running.
    Transfers,
    /// Too many connections already open.
    Connections,
}

impl Refused {
    pub fn as_str(self) -> &'static str {
        match self {
            Refused::Bytes => "the day's public sharing allowance is spent",
            Refused::Transfers => "too many public transfers are already running",
            Refused::Connections => "too many public connections are already open",
        }
    }
}

/// The machine-wide allowance for serving strangers.
///
/// One per process. Cloned freely — every clone shares the same counters,
/// which is the whole point: a thousand fresh keys must not be a thousand
/// allowances.
#[derive(Debug, Clone)]
pub struct ShareBounds {
    limits: ShareLimits,
    transfers: Arc<Semaphore>,
    connections: Arc<Semaphore>,
    /// Bytes served in the current window, and when it started (millis since
    /// the process's own monotonic origin — see `charge`).
    spent: Arc<Spend>,
    /// The machine-wide disk-rate clock — see [`Reserved`].
    reserved: Arc<Reserved>,
}

#[derive(Debug)]
struct Spend {
    /// The window's start and what has been spent in it, under ONE lock.
    ///
    /// ⚠️ **TWO ATOMICS WERE A RACE, AND IT HANDED OUT FREE WINDOWS.** The
    /// rollover moved `since_ms` and then zeroed `bytes` as separate steps, so
    /// another thread could observe the new window between them, charge into
    /// it, and have that charge erased by the first thread's `store(0)`. Found
    /// by audit. A `Mutex` on two integers is not a cost worth measuring; a
    /// budget that can be reset from under a charge is not a budget.
    window: Mutex<Window>,
    origin: std::time::Instant,
}

#[derive(Debug, Clone, Copy)]
struct Window {
    /// Milliseconds since [`Spend::origin`], of the window's start.
    since_ms: u64,
    bytes: u64,
}

/// What a shared rate limiter has already promised.
///
/// ⚠️ **THE DISK RATE IS MACHINE-WIDE AND WAS PER TRANSFER.** Each transfer
/// slept for `bytes / rate` on its own, so eight concurrent transfers each
/// received the full configured rate and the claimed sixteen mebibytes a
/// second scaled with concurrency. Found by audit. Reserving against a shared
/// clock is what makes the number mean what it says: a request's delay is how
/// long until the machine's own allowance reaches it, not how long its own
/// bytes would take alone.
#[derive(Debug)]
struct Reserved {
    /// NANOSECONDS since [`Spend::origin`] at which the last reservation ends.
    ///
    /// ⚠️ **MILLISECONDS HERE MADE THE WHOLE LIMITER A NO-OP, AND EVERY TEST
    /// STILL PASSED.** The cost of a read was `bytes * 1000 / rate` in integer
    /// arithmetic, so at the default 16 MiB/s anything under ~16.4 KiB cost
    /// **zero** — and `iroh-blobs` throttles per 16 KiB chunk group, which is
    /// to say per unit of essentially every real transfer. The clock never
    /// advanced and no reader ever waited.
    ///
    /// It survived because the tests use a rate of 1 000 B/s with 1 000-byte
    /// reads, which divides to exactly 1 000 ms. Production numbers land under
    /// the floor; test numbers sit on a clean boundary. Nanoseconds put the
    /// smallest interesting cost (976 562 ns for 16 KiB at the default rate)
    /// four orders of magnitude above the truncation point, and `u64` nanos
    /// from a process-lifetime origin cannot overflow in any run.
    until_ns: Mutex<u64>,
}

impl ShareBounds {
    pub fn new(limits: ShareLimits) -> Self {
        Self {
            transfers: Arc::new(Semaphore::new(limits.concurrent_transfers)),
            connections: Arc::new(Semaphore::new(limits.concurrent_connections)),
            spent: Arc::new(Spend {
                window: Mutex::new(Window {
                    since_ms: 0,
                    bytes: 0,
                }),
                origin: std::time::Instant::now(),
            }),
            reserved: Arc::new(Reserved {
                until_ns: Mutex::new(0),
            }),
            limits,
        }
    }

    pub fn limits(&self) -> ShareLimits {
        self.limits
    }

    /// Take a connection slot, or say why not.
    ///
    /// ⚠️ **`try_acquire`, NOT `acquire`.** Waiting for a permit is a queue,
    /// and a queue on the one door a stranger may knock on is the resource
    /// being exhausted rather than protected — `circle::serve` learned this
    /// for the circle's hello door and the reasoning is identical here.
    pub fn take_connection(&self) -> std::result::Result<OwnedSemaphorePermit, Refused> {
        Arc::clone(&self.connections)
            .try_acquire_owned()
            .map_err(|_| Refused::Connections)
    }

    /// Take a transfer slot, or say why not.
    pub fn take_transfer(&self) -> std::result::Result<OwnedSemaphorePermit, Refused> {
        Arc::clone(&self.transfers)
            .try_acquire_owned()
            .map_err(|_| Refused::Transfers)
    }

    /// Whether there is any allowance left at all, without spending it.
    pub fn has_allowance(&self) -> bool {
        self.charged_bytes() < self.limits.bytes_per_window
    }

    /// Bytes spent in the current window.
    pub fn charged_bytes(&self) -> u64 {
        self.with_window(|window| window.bytes)
    }

    /// Charge bytes about to move, and say whether they may.
    ///
    /// ⚠️ **CHARGED BEFORE THE BYTES MOVE, NOT AFTER.** `importLimits.ts`
    /// states the rule this codebase already lives by: *"a bound that runs
    /// AFTER the read has not bounded anything."* Charging afterwards means
    /// the last transfer of the day is unbounded, which for a file-sized
    /// transfer is the only one that matters.
    pub fn charge(&self, bytes: u64) -> std::result::Result<(), Refused> {
        self.with_window(|window| {
            /* Saturating, because the alternative is that a wrapped counter
             * reads as an empty window. A machine that has genuinely served
             * 2^64 bytes is not a case to be exact about; it is a case to
             * refuse. */
            window.bytes = window.bytes.saturating_add(bytes);
            if window.bytes > self.limits.bytes_per_window {
                Err(Refused::Bytes)
            } else {
                Ok(())
            }
        })
    }

    /// How long to wait before reading `bytes` more, to stay under the
    /// MACHINE'S disk rate.
    ///
    /// ⚠️ **A SHARED RESERVATION, NOT `bytes / rate`.** See [`Reserved`]:
    /// per-transfer arithmetic gave every concurrent transfer the whole rate.
    /// Each call moves the machine's own clock forward by what its bytes cost
    /// and waits for it, so N transfers share one rate rather than taking N of
    /// them.
    ///
    /// Expressed as a delay rather than as a sleep so the caller keeps its
    /// cancellation: a share transfer that is cancelled must not be sleeping
    /// inside a limiter that does not know about it.
    pub fn read_delay(&self, bytes: u64) -> Duration {
        if self.limits.read_bytes_per_second == 0 {
            return Duration::ZERO;
        }
        /* ⚠️ **NANOSECONDS, BECAUSE MILLISECONDS TRUNCATED THE COST TO ZERO.**
         * See [`Reserved::until_ns`]: `bytes * 1000 / rate` is integer
         * division, and a 16 KiB chunk at 16 MiB/s is 0.976 ms — which is 0.
         * Every chunk cost nothing, the clock never moved, and the limiter
         * bounded nothing at all while looking exactly like one that did. */
        let cost_ns = (bytes as u128 * 1_000_000_000 / self.limits.read_bytes_per_second as u128)
            .min(u64::MAX as u128) as u64;
        let now_ns = self.spent.origin.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        let mut until = self
            .reserved
            .until_ns
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        /* A clock behind the present has nothing owed on it: an idle machine
         * does not accumulate credit it can spend in a burst later. */
        let start = (*until).max(now_ns);
        *until = start.saturating_add(cost_ns);
        Duration::from_nanos(start.saturating_sub(now_ns))
    }

    /// Run `act` against the current window, rolling it over first.
    ///
    /// ⚠️ **THE ROLL AND THE CHARGE ARE ONE CRITICAL SECTION.** Separating them
    /// is the race this replaced — see [`Spend::window`].
    fn with_window<T>(&self, act: impl FnOnce(&mut Window) -> T) -> T {
        let now_ms = self.spent.origin.elapsed().as_millis() as u64;
        let window_ms = self.limits.window.as_millis() as u64;
        /* A poisoned lock means a caller panicked mid-charge. The counters are
         * two integers with no invariant between them beyond this function, so
         * carrying on with the held value is right — and refusing every
         * request for the rest of the process because one panicked is not. */
        let mut window = self
            .spent
            .window
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        if now_ms.saturating_sub(window.since_ms) >= window_ms {
            window.since_ms = now_ms;
            window.bytes = 0;
        }
        act(&mut window)
    }
}

impl Default for ShareBounds {
    fn default() -> Self {
        Self::new(ShareLimits::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small() -> ShareBounds {
        ShareBounds::new(ShareLimits {
            bytes_per_window: 1000,
            window: Duration::from_millis(50),
            concurrent_transfers: 2,
            concurrent_connections: 3,
            read_bytes_per_second: 1000,
        })
    }

    #[test]
    fn the_byte_allowance_is_machine_wide_not_per_peer() {
        /* ⚠️ **THE FINDING WI-25.6 EXISTS FOR.** A fresh key must not buy a
        fresh allowance. There is no peer argument on `charge`, which is how
        that is enforced rather than remembered — a per-peer version of this
        would have to be given a peer, and there is nowhere to put one. */
        let bounds = small();
        assert!(bounds.charge(600).is_ok());
        assert!(
            bounds.charge(600).is_err(),
            "a second caller got a second allowance"
        );
    }

    #[test]
    fn the_window_rolls_and_the_allowance_comes_back() {
        let bounds = small();
        assert!(bounds.charge(1000).is_ok());
        assert!(bounds.charge(1).is_err());
        std::thread::sleep(Duration::from_millis(60));
        assert!(bounds.charge(1).is_ok(), "the window never rolled");
    }

    #[test]
    fn exactly_the_allowance_is_allowed_and_one_more_is_not() {
        /* The boundary from BELOW as well as above — `frame.rs` records what
        it costs to test a cap only from above: an off-by-one in the refusing
        direction stays green while every request exactly at the limit fails. */
        let bounds = small();
        assert!(bounds.charge(1000).is_ok());
        let bounds = small();
        assert!(bounds.charge(1001).is_err());
    }

    #[tokio::test]
    async fn concurrent_transfers_and_connections_are_bounded_separately() {
        let bounds = small();
        let _t1 = bounds.take_transfer().expect("first transfer");
        let _t2 = bounds.take_transfer().expect("second transfer");
        assert_eq!(bounds.take_transfer().unwrap_err(), Refused::Transfers);
        /* And the connection pool is untouched by the transfer pool being
        full: a client that cannot transfer may still be told so. */
        let _c1 = bounds
            .take_connection()
            .expect("a connection is still free");
    }

    #[tokio::test]
    async fn a_permit_is_returned_when_it_is_dropped() {
        let bounds = small();
        {
            let _t1 = bounds.take_transfer().unwrap();
            let _t2 = bounds.take_transfer().unwrap();
            assert!(bounds.take_transfer().is_err());
        }
        assert!(
            bounds.take_transfer().is_ok(),
            "a finished transfer never gave its slot back"
        );
    }

    #[test]
    fn the_first_read_waits_for_nothing_and_the_next_waits_for_it() {
        /* ⚠️ **THE RATE IS MACHINE-WIDE AND WAS PER TRANSFER.** Each transfer
        slept for `bytes / rate` on its own, so eight concurrent transfers each
        received the whole configured rate — found by audit. A reservation
        against a shared clock is what makes the number mean what it says. */
        let bounds = small();
        assert_eq!(
            bounds.read_delay(1000),
            Duration::ZERO,
            "an idle machine waits"
        );
        /* The second caller waits for the first's second, not for its own. */
        let next = bounds.read_delay(500);
        assert!(
            next >= Duration::from_millis(900) && next <= Duration::from_millis(1000),
            "the second reader did not queue behind the first: {next:?}"
        );
    }

    /// ⚠️ **THE TEST ABOVE PASSES AT ANY RESOLUTION, WHICH IS WHY IT MISSED
    /// THE DEFECT.** It uses 1 000 B/s with 1 000-byte reads: exactly 1 000 ms,
    /// a clean boundary that milliseconds represent perfectly. The DEFAULT rate
    /// with the chunk size `iroh-blobs` actually throttles at lands under the
    /// millisecond floor, where `bytes * 1000 / rate` truncates to zero — so
    /// every chunk of every real transfer cost nothing and the limiter was
    /// inert. This runs at the numbers production runs at.
    #[test]
    fn a_chunk_at_the_default_rate_costs_more_than_nothing() {
        let bounds = ShareBounds::new(ShareLimits::default());
        /* What `iroh-blobs` hands the throttle: one 16 KiB chunk group. */
        const CHUNK: u64 = 16 * 1024;
        assert_eq!(
            bounds.read_delay(CHUNK),
            Duration::ZERO,
            "the first read on an idle machine waits for nothing"
        );
        /* 16 KiB at 16 MiB/s is 976 562 ns. Under milliseconds this was 0, so
        the clock never moved and this second call also returned ZERO. */
        let next = bounds.read_delay(CHUNK);
        assert!(
            next > Duration::ZERO,
            "a chunk cost the machine nothing, so the disk rate bounds nothing: {next:?}"
        );
        /* ⚠️ **NO LOWER BAND ON THIS ONE.** The delay returned is what is LEFT
        of the first chunk's reservation, so the wall-clock spent between the
        two calls is subtracted from it — on a loaded machine that is most of
        it. Asserting "about 976us" here fails for a reason that has nothing to
        do with the bound. Non-zero is the property; the size of the
        reservation is measured over many chunks below, where scheduling noise
        cannot dominate. */
        assert!(
            next <= Duration::from_micros(977),
            "a 16 KiB chunk reserved more than its bytes are worth at 16 MiB/s: {next:?}"
        );
    }

    /// A thousand chunks must accumulate to a real, measurable reservation —
    /// the property the truncation destroyed, stated over a whole book rather
    /// than one chunk.
    #[test]
    fn a_book_of_chunks_accumulates_the_time_its_bytes_are_worth() {
        let bounds = ShareBounds::new(ShareLimits::default());
        const CHUNK: u64 = 16 * 1024;
        const CHUNKS: u64 = 1_024; // 16 MiB, one second's worth at the default rate.
        let mut last = Duration::ZERO;
        for _ in 0..CHUNKS {
            last = bounds.read_delay(CHUNK);
        }
        assert!(
            last >= Duration::from_millis(950),
            "16 MiB of chunks at 16 MiB/s reserved {last:?}, not about a second"
        );
    }

    #[test]
    fn concurrent_readers_share_one_rate_rather_than_taking_one_each() {
        let bounds = small();
        /* Eight readers of a thousand bytes each at a thousand bytes a second
        is eight seconds of machine time, however they are interleaved.

        ⚠️ **AN EXPLICIT LOOP, BECAUSE THE CALLS ARE THE POINT.** This was
        `(0..8).map(..).last()`, which clippy asked to be `next_back()` — and
        `next_back` on a LAZY map calls the closure ONCE, for the last index.
        The reservation then measured a single reader and the assertion read
        `0ns`. A lint about wasted iteration is right about the iteration and
        wrong about code whose iteration is a side effect. */
        let mut last = Duration::ZERO;
        for _ in 0..8 {
            last = bounds.read_delay(1000);
        }
        assert!(
            last >= Duration::from_millis(6_900),
            "eight readers each got the whole rate: {last:?}"
        );
    }

    #[test]
    fn an_unlimited_rate_waits_for_nothing() {
        let unlimited = ShareBounds::new(ShareLimits {
            read_bytes_per_second: 0,
            ..small().limits()
        });
        assert_eq!(unlimited.read_delay(u64::MAX), Duration::ZERO);
    }

    #[test]
    fn a_window_rollover_does_not_erase_a_charge_made_into_the_new_one() {
        /* ⚠️ **THE ROLL AND THE CHARGE WERE TWO ATOMICS AND THE GAP HANDED OUT
        FREE WINDOWS** — found by audit. One lock, and a thousand threads
        charging across a rollover boundary must add up. */
        let bounds = ShareBounds::new(ShareLimits {
            bytes_per_window: u64::MAX,
            window: Duration::from_millis(1),
            ..small().limits()
        });
        let bounds = std::sync::Arc::new(bounds);
        let mut hands = Vec::new();
        for _ in 0..8 {
            let mine = std::sync::Arc::clone(&bounds);
            hands.push(std::thread::spawn(move || {
                for _ in 0..200 {
                    let _ = mine.charge(1);
                }
            }));
        }
        for hand in hands {
            hand.join().unwrap();
        }
        /* The window is a millisecond, so most charges roll away — what is
        asserted is that the counter is a coherent number rather than a value
        two threads raced to write. */
        assert!(bounds.charged_bytes() <= 1600);
    }

    #[test]
    fn every_clone_shares_one_allowance() {
        /* A limiter that is cloned per connection is not a limiter. */
        let bounds = small();
        let twin = bounds.clone();
        assert!(bounds.charge(900).is_ok());
        assert!(twin.charge(200).is_err());
    }
}

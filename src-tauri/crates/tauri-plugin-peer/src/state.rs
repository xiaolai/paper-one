//! The Tauri-managed state: the node, started lazily on the first command
//! that needs it.
//!
//! Starting the node loads the identity, binds UDP sockets and — with relays
//! on — contacts n0's relays to learn a home relay. None of that belongs in
//! plugin setup, where it would cost every launch a network round trip
//! whether or not the reader ever pairs. It happens on the first command,
//! once; every later call gets the same node back. Events go out through
//! `app.emit` under the names in `events.rs`.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::OnceCell;

use crate::data_root::data_root;
use crate::error::Result;
use crate::events::EventSink;
use crate::node::{Node, NodeConfig};
use crate::role::local_role;
use crate::share::{ShareConfig, ShareNode};

/// How long turning the switch off waits for the endpoints to close.
const SWITCH_CLOSE_DEADLINE: Duration = Duration::from_secs(5);

/// Plugin state managed by Tauri; one per app.
///
/// ⚠️ **TWO NODES, STARTED SEPARATELY AND CLOSED TOGETHER — WI-25.1.** The
/// circle node and the share node are two endpoints on two keys and two
/// ports, and neither depends on the other: a share endpoint that will not
/// bind must not cost the reader their circle, and a machine that has never
/// offered a book publicly should never pay for a share endpoint's store.
/// So each is its own `OnceCell`, started on the first command that needs it,
/// and [`PeerState::close`] closes whichever exist.
#[derive(Default)]
pub struct PeerState {
    node: OnceCell<Arc<Node>>,
    /// The share endpoint — phase 25. Started on the first command that
    /// offers, withdraws or resolves publicly, which for most readers is
    /// never.
    share: OnceCell<Arc<ShareNode>>,
    /// The launch sweep of abandoned `.part` files
    /// (`blobs::sweep_abandoned_parts`), awaited once before the node starts.
    /// The node is the only route to a transfer, so ordering the two is what
    /// guarantees no fetch resumes from a file the sweep is about to unlink —
    /// and it lets the sweep leave the main thread at launch. `None` once
    /// awaited, or when setup scheduled nothing.
    before_start: Mutex<Option<JoinHandle<()>>>,
    /// Opened once this process is entitled to touch the library — see
    /// [`PeerState::hold_library`].
    library: Arc<tokio::sync::Notify>,
    /// Whether [`hold_library`](PeerState::hold_library) has been called, so a
    /// waiter arriving after it does not park for ever. `Notify` on its own
    /// only wakes tasks ALREADY waiting, which is the same trap the circle
    /// keeper's `notify_waiters` fell into.
    library_held: Arc<std::sync::atomic::AtomicBool>,
    /// The share-resumption task setup detaches, so exit can stop it.
    ///
    /// ⚠️ **IT WAS DETACHED AND `close()` COULD NOT SEE IT.** The task waits
    /// for the library gate and then starts the share endpoint; `close()`
    /// looks at the `OnceCell`s, so a resumption still INITIALISING at exit
    /// was invisible — it finished binding a UDP port and opening a blob store
    /// after cleanup had run, and nothing ever closed it. Found by audit.
    resuming: Mutex<Option<JoinHandle<()>>>,
    /// Set by [`close`](PeerState::close), so nothing starts an endpoint after
    /// it. Aborting the task above is not enough on its own: abort takes
    /// effect at the next await point, and the one it is inside may be the
    /// bind itself.
    closing: Arc<std::sync::atomic::AtomicBool>,
}

/// What setting the P2P switch did: three facts, because none implies another.
///
/// ⚠️ **THE WEBVIEW USED TO INFER THE FIRST FROM THE SECOND.** A rejected command
/// was read as a closed transport, and a rejection can happen before any of this
/// runs, an IPC failure say, which told the reader the connections had gone while
/// they kept serving. A rejection now means only that this answer never arrived.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchAnswer {
    /// This run refuses transport work and no endpoint of it serves: connections
    /// are closed and new ones refused. Finishing the close, which flushes the
    /// goodbyes and the store, may outlast the answer: see `SWITCH_CLOSE_DEADLINE`.
    pub closed: bool,
    /// Why the choice was not recorded, or `None` when it is durable.
    pub record_error: Option<crate::error::Error>,
    /// What the switch's file reads now, or `None` when nothing could be read from
    /// it. A failed record can have landed: see [`crate::p2p::record`].
    pub file_says_on: Option<bool>,
}

impl std::fmt::Debug for PeerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerState")
            .field("started", &self.node.initialized())
            .finish()
    }
}

impl PeerState {
    /// The node, starting it on first use. Concurrent first callers wait on
    /// the same start rather than each binding their own sockets.
    pub async fn node<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<Node>> {
        let root = data_root(app)?;
        self.node_at(&root, || async {
            let role = local_role(&root)?;
            let sink = tauri_sink(app.clone());
            Node::start(NodeConfig::for_app(root.clone(), role, sink)).await
        })
        .await
    }

    /// [`node`](Self::node)'s gates, apart from how a node is built.
    async fn node_at<F, Fut>(&self, root: &Path, start: F) -> Result<Arc<Node>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Arc<Node>>>,
    {
        crate::p2p::require_on(root)?;
        self.refuse_if_closed()?;
        let started = self
            .node
            .get_or_try_init(|| async {
                self.await_before_start().await;
                /* The sweep can take a while on a large library, and a switch
                that went off during it must not be answered with a bind. */
                self.refuse_if_closed()?;
                start().await
            })
            .await
            .cloned()?;
        /* Checked again on the way out, as `share_node` does: `close()` may have
        run during the sweep or the bind, when the cell it inspected was empty. */
        if let Err(closed) = self.refuse_if_closed() {
            started.close().await;
            return Err(closed);
        }
        Ok(started)
    }

    fn refuse_if_closed(&self) -> Result<()> {
        if self.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::error::Error::PeerClosed);
        }
        Ok(())
    }

    /// Record the reader's P2P switch, and close what is running if it went off.
    ///
    /// ⚠️ **THE DEADLINE BOUNDS THE WAIT, NOT THE CLOSE.** The close chain has
    /// stalled at exit before (`lib.rs`), and an unbounded wait here would hold
    /// the control disabled and reading On after the answer had changed. It runs
    /// as its own task because a `timeout` around it would drop the close part
    /// way, and an endpoint abandoned there goes on answering strangers while
    /// the switch reads off.
    ///
    /// ⚠️ **OFF CLOSES EVEN WHEN THE RECORD FAILED.** A write can fail after its
    /// rename, while syncing the directory, with the file already saying off; and
    /// a reader who asked for off wants the connections gone whatever the disk
    /// says, including a data folder that would not resolve. So the two facts go
    /// back apart: see [`SwitchAnswer`].
    pub async fn apply_switch(&self, root: Result<PathBuf>, on: bool) -> SwitchAnswer {
        self.switch_recording(on, async move {
            let refused = |error| crate::p2p::Recorded {
                error: Some(error),
                file_says_on: None,
            };
            match root {
                Ok(root) => {
                    crate::commands::off_thread(move || Ok(crate::p2p::record(&root, on)))
                        .await
                        .unwrap_or_else(refused)
                }
                Err(unresolved) => refused(unresolved),
            }
        })
        .await
    }

    /// [`apply_switch`](Self::apply_switch), apart from how the choice is recorded.
    ///
    /// ⚠️ **THE CLOSE STARTS BEFORE THE RECORD AND NEITHER WAITS FOR THE OTHER.**
    /// The record is a write and an fsync, and it used to come first, so storage
    /// that stalled left every endpoint serving with the deadline not yet started.
    /// A stalled record now holds the answer and the control, and nothing else.
    async fn switch_recording(
        &self,
        on: bool,
        record: impl Future<Output = crate::p2p::Recorded>,
    ) -> SwitchAnswer {
        let closing = (!on).then(|| self.begin_close());
        let close = async {
            if let Some(closing) = closing {
                if !closed_within(SWITCH_CLOSE_DEADLINE, closing).await {
                    log::warn!("peer: closing after the switch went off passed its deadline");
                }
            }
        };
        let ((), recorded) = tokio::join!(biased; close, record);
        SwitchAnswer {
            closed: self.transport_closed().await,
            record_error: recorded.error,
            file_says_on: recorded.file_says_on,
        }
    }

    /// Whether this run refuses transport work and every endpoint it started has
    /// stopped serving.
    ///
    /// ⚠️ **ASKED OF THE ENDPOINTS, NOT OF THE FLAG.** The flag says a close was
    /// asked for, and a close can pass its deadline. `Endpoint::closed` resolves
    /// once the endpoint's close has begun, which in iroh is the moment it closes
    /// every connection and refuses new ones, whatever that close then waits for.
    /// A zero timeout still polls it once, which makes this a reading, not a wait.
    async fn transport_closed(&self) -> bool {
        if self.refuse_if_closed().is_ok() {
            return false;
        }
        let started = self
            .node
            .get()
            .map(|node| node.endpoint())
            .into_iter()
            .chain(self.share.get().map(|share| share.endpoint()));
        for endpoint in started {
            if tokio::time::timeout(Duration::ZERO, endpoint.closed())
                .await
                .is_err()
            {
                return false;
            }
        }
        true
    }

    /// Start the share endpoint if this device still has something offered.
    ///
    /// ⚠️ **PERSISTED OFFERS DID NOT RESUME SERVING AFTER A RELAUNCH.** Found
    /// by audit, and it is the worst shape a bug of this kind can have: the
    /// policy file survives, so the Publish pane reads it and shows the book as
    /// offered — while no share endpoint is running and nobody can fetch it.
    /// A reader would have had to make an unrelated change to turn their own
    /// library back on.
    ///
    /// ⚠️ **AND IT READS A FILE FIRST, SO AN INSTALLATION THAT HAS NEVER
    /// PUBLISHED STAYS IDLE.** That is the whole reason the endpoint is lazy:
    /// a second UDP port, a second key and a blob store are not a cost a
    /// reader who has offered nothing should pay. `SharePolicy::load` touches
    /// no network and starts nothing.
    pub async fn resume_share<R: Runtime>(&self, app: &AppHandle<R>) -> Result<bool> {
        if !should_resume(&data_root(app)?)? {
            return Ok(false);
        }
        self.share_node(app).await?;
        Ok(true)
    }

    /// The share endpoint, starting it on first use.
    ///
    /// ⚠️ **NOT STARTED BESIDE THE CIRCLE NODE, AND THAT IS DELIBERATE.**
    /// Starting it opens a second UDP port, loads a second key and opens a
    /// blob store; a reader who never publishes anything should pay for none
    /// of that. Every command that reaches it is one a reader asked for — or
    /// [`resume_share`](Self::resume_share), which asks the file first.
    pub async fn share_node<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Arc<ShareNode>> {
        let root = data_root(app)?;
        self.share_node_at(&root, || {
            ShareNode::start(ShareConfig::for_app(root.clone()))
        })
        .await
    }

    /// [`share_node`](Self::share_node)'s gates, apart from how one is built.
    async fn share_node_at<F, Fut>(&self, root: &Path, start: F) -> Result<Arc<ShareNode>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Arc<ShareNode>>>,
    {
        crate::p2p::require_on(root)?;
        /* ⚠️ **NOT AFTER `close()`.** Binding a second UDP port and opening a
         * blob store during shutdown leaves both behind: `close()` has already
         * looked at the cell. Refused rather than started. */
        self.refuse_if_closed()?;
        let started = self
            .share
            .get_or_try_init(|| async {
                /* A caller queued behind a start that failed gets its turn here,
                perhaps after the switch went off. */
                self.refuse_if_closed()?;
                start().await
            })
            .await
            .cloned()?;
        /* Checked again on the way out: `close()` may have run while the bind
        above was in flight, and the cell it inspected was still empty. */
        if let Err(closed) = self.refuse_if_closed() {
            started.close().await;
            return Err(closed);
        }
        Ok(started)
    }

    /// The share-resumption task, so exit can stop it — see [`resuming`].
    pub fn resume_with(&self, task: JoinHandle<()>) {
        let replaced = self
            .resuming
            .lock()
            .expect("resuming is never poisoned")
            .replace(task);
        debug_assert!(replaced.is_none(), "resume_with has ONE caller: setup");
    }

    /// A task the node must not start before. Setup schedules the `.part`
    /// sweep through this, ONCE — a second call would silently detach the
    /// first barrier, so it is a programming error and says so.
    /// Say that this process holds the library and may touch its files.
    ///
    /// ⚠️ **TAURI RUNS PLUGIN SETUP BEFORE THE APPLICATION'S OWN**, so
    /// everything this plugin starts at setup runs BEFORE the desktop app has
    /// tried to take the library lock — including in a second Paper that the
    /// lock is about to refuse. That second process was sweeping abandoned
    /// `.part` files out of the FIRST one's library, which is not a stale-file
    /// cleanup but the deletion of staging files a live fetch is writing into,
    /// and it was opening the shared blob store beside it. Found by audit.
    ///
    /// Idempotent. A build with no library lock — every phone — calls it at
    /// setup, because there is nothing to wait for there and a gate that never
    /// opens is a device that never sweeps.
    pub fn hold_library(&self) {
        self.library_held
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.library.notify_waiters();
    }

    /// Wait until this process is entitled to touch the library.
    pub async fn library_granted(&self) {
        if self.library_held.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let waiting = self.library.notified();
        /* Re-checked after arming the waiter: `hold_library` between the load
         * above and this point would otherwise be missed entirely. */
        if self.library_held.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        waiting.await;
    }

    pub fn start_after(&self, task: JoinHandle<()>) {
        let replaced = self
            .before_start
            .lock()
            .expect("before_start is never poisoned")
            .replace(task);
        debug_assert!(replaced.is_none(), "start_after has ONE caller: setup");
        if replaced.is_some() {
            log::error!("peer: start_after called twice; the first barrier is detached");
        }
    }

    async fn await_before_start(&self) {
        // Taken out under the lock, awaited outside it: a `std::sync::Mutex`
        // guard must not live across an await.
        let pending = self
            .before_start
            .lock()
            .expect("before_start is never poisoned")
            .take();
        let Some(task) = pending else { return };
        /* CANCEL-SAFE: the first `node()` future can be dropped mid-await
         * (a command torn down), and the take() above would then have
         * DETACHED the barrier — the next caller would find `None` and start
         * the node with the sweep still running. The guard puts an
         * unfinished handle back on the way out, so a cancelled waiter
         * leaves the barrier standing for the next one. */
        struct PutBack<'a> {
            slot: &'a Mutex<Option<JoinHandle<()>>>,
            task: Option<JoinHandle<()>>,
        }
        impl Drop for PutBack<'_> {
            fn drop(&mut self) {
                /* Unconditionally: `tauri::async_runtime::JoinHandle` has no
                 * `is_finished`, and re-awaiting a handle whose task already
                 * completed just answers immediately — putting a finished one
                 * back costs the next caller one no-op await. */
                if let Some(task) = self.task.take() {
                    *self.slot.lock().expect("before_start is never poisoned") = Some(task);
                }
            }
        }
        let mut guard = PutBack {
            slot: &self.before_start,
            task: Some(task),
        };
        let outcome = guard.task.as_mut().expect("just set").await;
        guard.task = None; // Completed: nothing to put back.
                           // A sweep that panicked is a logged failure, not a node that never
                           // starts.
        if let Err(err) = outcome {
            log::warn!("peer: the .part sweep did not finish: {err}");
        }
    }

    /// Close the node if it was ever started. Waits for the QUIC close to go
    /// out, so peers see a clean close instead of an idle timeout.
    pub async fn close(&self) {
        self.begin_close().await;
    }

    /// Refuses new work now, and answers a future that closes what is running.
    fn begin_close(&self) -> impl Future<Output = ()> + Send + 'static {
        /* ⚠️ **THE FLAG FIRST, THEN THE TASK, THEN THE CELLS.** A resumption
         * that is still initialising is not in a cell yet, so closing the
         * cells alone left an endpoint that finished starting after cleanup.
         * The flag stops a new one; the abort stops the one in flight; and
         * `share_node` re-checks the flag after its bind so a task that got
         * past the first check closes what it built. Found by audit. */
        self.closing
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(task) = self
            .resuming
            .lock()
            .expect("resuming is never poisoned")
            .take()
        {
            task.abort();
        }
        let node = self.node.get().cloned();
        let share = self.share.get().cloned();
        /* ⚠️ **BOTH, AND THE SECOND ONE IS EASY TO FORGET.** An endpoint that
         * vanishes rather than closing leaves its peers to time out, and a
         * share endpoint that stays bound after the app closes takes 47822
         * with it — the same trap `Node::close` was written for, one port
         * over. */
        async move {
            close_each(
                async {
                    if let Some(node) = node {
                        node.close().await;
                    }
                },
                async {
                    if let Some(share) = share {
                        share.close().await;
                    }
                },
            )
            .await;
        }
    }
}

/// Two closes at once, because the endpoints are independent and one that stalls
/// must not keep the other serving.
async fn close_each(first: impl Future<Output = ()>, second: impl Future<Output = ()>) {
    tokio::join!(first, second);
}

/// Whether a close finished within `deadline`. It carries on regardless.
async fn closed_within(
    deadline: Duration,
    closing: impl Future<Output = ()> + Send + 'static,
) -> bool {
    tokio::time::timeout(deadline, tokio::spawn(closing))
        .await
        .is_ok()
}

/// Whether a launch has offers to resume serving: never while the switch is off.
/// Off is an answer here, not a failure: refused further down, it would tell the
/// reader their offers could not resume.
fn should_resume(root: &Path) -> Result<bool> {
    if !crate::p2p::is_on(root)? {
        return Ok(false);
    }
    let offers = crate::share::policy::SharePolicy::load_or_refuse_all(root);
    Ok(crate::share::policy::ShareService::ALL
        .iter()
        .any(|service| !offers.offered(*service).is_empty()))
}

fn tauri_sink<R: Runtime>(app: AppHandle<R>) -> EventSink {
    Arc::new(move |event| {
        // A failed emit means no webview is listening; the plugin has
        // nothing better to do with it than move on.
        let _ = app.emit(event.name(), event.payload());
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    mod switch {
        use super::*;
        use crate::error::Error;
        use crate::node::testkit::TestNode;
        use crate::role::Role;
        use crate::testutil::ScratchDir;

        fn off(label: &str) -> ScratchDir {
            let scratch = ScratchDir::new(label);
            crate::p2p::set(scratch.path(), false).unwrap();
            scratch
        }

        fn on(label: &str) -> ScratchDir {
            let scratch = ScratchDir::new(label);
            crate::p2p::set(scratch.path(), true).unwrap();
            scratch
        }

        #[tokio::test]
        async fn off_starts_no_node() {
            let scratch = off("state-off-node");
            let refused = PeerState::default()
                .node_at(scratch.path(), || async {
                    panic!("started a node while off")
                })
                .await;
            assert_eq!(refused.err().unwrap().kind(), "p2pOff");
        }

        #[tokio::test]
        async fn off_starts_no_share_endpoint() {
            let scratch = off("state-off-share");
            let refused = PeerState::default()
                .share_node_at(scratch.path(), || async {
                    panic!("started a share endpoint while off")
                })
                .await;
            assert_eq!(refused.err().unwrap().kind(), "p2pOff");
        }

        #[test]
        fn off_resumes_no_offers() {
            let scratch = on("state-off-resume");
            std::fs::create_dir_all(scratch.path().join(crate::identity::PEER_DIR)).unwrap();
            let hash = crate::share::ContentHash::parse(&"a".repeat(64)).unwrap();
            crate::share::policy::SharePolicy::load_or_refuse_all(scratch.path())
                .set(&hash, crate::share::policy::ShareService::Bytes, true)
                .unwrap();
            assert!(should_resume(scratch.path()).unwrap());
            crate::p2p::set(scratch.path(), false).unwrap();
            assert!(!should_resume(scratch.path()).unwrap());
        }

        #[tokio::test]
        async fn turning_off_closes_a_running_node_and_records_it() {
            let scratch = on("state-switch-off");
            let running = TestNode::start("state-switch-off-node", Role::Shelf).await;
            let state = PeerState::default();
            state
                .node_at(scratch.path(), || async { Ok(running.node.clone()) })
                .await
                .unwrap();
            state
                .apply_switch(Ok(scratch.path().to_path_buf()), false)
                .await
                .unwrap();
            assert!(running.node.endpoint().is_closed());
            assert!(!crate::p2p::is_on(scratch.path()).unwrap());
        }

        impl SwitchAnswer {
            /// The answer, having insisted the choice was recorded.
            fn unwrap(self) -> Self {
                if let Some(refused) = &self.record_error {
                    panic!("the choice was not recorded: {refused}");
                }
                self
            }
        }

        /// A file where the data folder should be: the write fails, as a disk
        /// that refuses the sync after the rename would.
        fn unwritable(label: &str) -> ScratchDir {
            let scratch = ScratchDir::new(label);
            let root = scratch.path().join("not-a-folder");
            std::fs::write(&root, b"").unwrap();
            scratch
        }

        #[tokio::test]
        async fn turning_off_closes_a_running_node_even_when_the_record_fails() {
            let scratch = unwritable("state-switch-off-unwritable");
            let running = TestNode::start("state-switch-off-unwritable-node", Role::Shelf).await;
            let state = PeerState::default();
            state.node.set(running.node.clone()).ok().unwrap();
            let answer = state
                .apply_switch(Ok(scratch.path().join("not-a-folder")), false)
                .await;
            assert!(
                answer.record_error.is_some(),
                "the failed record has to reach the reader"
            );
            assert_eq!(answer.file_says_on, None, "no file could be read there");
            assert!(answer.closed);
            assert!(running.node.endpoint().is_closed());
        }

        #[tokio::test]
        async fn turning_off_closes_a_running_node_even_when_the_data_folder_will_not_resolve() {
            let running = TestNode::start("state-switch-off-no-root-node", Role::Shelf).await;
            let state = PeerState::default();
            state.node.set(running.node.clone()).ok().unwrap();
            let answer = state.apply_switch(Err(Error::P2pOff), false).await;
            assert_eq!(answer.file_says_on, None);
            assert_eq!(answer.record_error.unwrap().kind(), "p2pOff");
            assert!(answer.closed);
            assert!(running.node.endpoint().is_closed());
        }

        #[test]
        fn the_answer_says_each_fact_under_the_name_the_webview_reads() {
            let recorded = SwitchAnswer {
                closed: true,
                record_error: None,
                file_says_on: Some(false),
            };
            assert_eq!(
                serde_json::to_value(&recorded).unwrap(),
                serde_json::json!({ "closed": true, "recordError": null, "fileSaysOn": false }),
            );
            let refused = SwitchAnswer {
                closed: false,
                record_error: Some(Error::P2pOff),
                file_says_on: None,
            };
            let answer = serde_json::to_value(&refused).unwrap();
            assert_eq!(answer["closed"], false);
            assert_eq!(answer["recordError"]["kind"], "p2pOff");
            assert_eq!(answer["fileSaysOn"], serde_json::Value::Null);
        }

        /// The record failed and the word landed: the answer carries both.
        #[tokio::test]
        async fn a_record_that_failed_and_landed_says_both() {
            let state = PeerState::default();
            let answer = state
                .switch_recording(true, async {
                    crate::p2p::Recorded {
                        error: Some(Error::P2pOff),
                        file_says_on: Some(true),
                    }
                })
                .await;
            assert!(answer.record_error.is_some());
            assert_eq!(answer.file_says_on, Some(true));
        }

        #[tokio::test]
        async fn a_landed_switch_says_the_word_it_wrote() {
            let scratch = off("state-switch-word");
            let state = PeerState::default();
            let answer = state
                .apply_switch(Ok(scratch.path().to_path_buf()), true)
                .await
                .unwrap();
            assert_eq!(answer.file_says_on, Some(true));
        }

        #[tokio::test]
        async fn a_failed_turn_on_closes_nothing() {
            let scratch = unwritable("state-switch-on-unwritable");
            let running = TestNode::start("state-switch-on-unwritable-node", Role::Shelf).await;
            let state = PeerState::default();
            state.node.set(running.node.clone()).ok().unwrap();
            let answer = state
                .apply_switch(Ok(scratch.path().join("not-a-folder")), true)
                .await;
            assert!(answer.record_error.is_some());
            assert!(!answer.closed);
            assert!(!running.node.endpoint().is_closed());
        }

        #[tokio::test]
        async fn turning_on_records_it_and_closes_nothing() {
            let scratch = off("state-switch-on");
            let running = TestNode::start("state-switch-on-node", Role::Shelf).await;
            let state = PeerState::default();
            state.node.set(running.node.clone()).ok().unwrap();
            state
                .apply_switch(Ok(scratch.path().to_path_buf()), true)
                .await
                .unwrap();
            assert!(!running.node.endpoint().is_closed());
            assert!(crate::p2p::is_on(scratch.path()).unwrap());
        }

        /// Off then on in one run: the switch reads on, the node in the cell is
        /// closed, and the caller must hear that rather than get a dead node.
        #[tokio::test]
        async fn on_again_in_the_same_run_says_closed_rather_than_handing_out_a_dead_node() {
            let scratch = on("state-switch-again");
            let running = TestNode::start("state-switch-again-node", Role::Shelf).await;
            let state = PeerState::default();
            state
                .node_at(scratch.path(), || async { Ok(running.node.clone()) })
                .await
                .unwrap();
            let root = scratch.path().to_path_buf();
            state.apply_switch(Ok(root.clone()), false).await.unwrap();
            state.apply_switch(Ok(root), true).await.unwrap();
            let refused = state
                .node_at(scratch.path(), || async {
                    panic!("started a second node in one run")
                })
                .await;
            assert_eq!(refused.err().unwrap().kind(), "peerClosed");
        }

        /// Off arriving during the bind: `close` saw an empty cell, so only the
        /// check on the way out can stop this node from serving.
        #[tokio::test]
        async fn a_node_still_starting_when_the_switch_goes_off_is_closed() {
            let scratch = on("state-switch-inflight");
            let running = TestNode::start("state-switch-inflight-node", Role::Shelf).await;
            let state = PeerState::default();
            let refused = state
                .node_at(scratch.path(), || async {
                    state
                        .apply_switch(Ok(scratch.path().to_path_buf()), false)
                        .await
                        .unwrap();
                    Ok(running.node.clone())
                })
                .await;
            assert_eq!(refused.err().unwrap().kind(), "peerClosed");
            assert!(running.node.endpoint().is_closed());
        }

        /// Off arriving during the library sweep, before anything has started.
        #[tokio::test]
        async fn a_node_waiting_on_the_sweep_when_the_switch_goes_off_never_starts() {
            let scratch = on("state-switch-sweep");
            let root = scratch.path().to_path_buf();
            let state = Arc::new(PeerState::default());
            let (finish_sweep, sweep) = tokio::sync::oneshot::channel::<()>();
            state.start_after(tauri::async_runtime::spawn(async move {
                let _ = sweep.await;
            }));
            let waiting = {
                let (state, root) = (state.clone(), root.clone());
                tokio::spawn(async move {
                    state
                        .node_at(&root, || async {
                            panic!("bound after the switch went off")
                        })
                        .await
                        .map(|_| ())
                })
            };
            tokio::time::sleep(Duration::from_millis(50)).await;
            state.apply_switch(Ok(root), false).await.unwrap();
            finish_sweep.send(()).unwrap();
            let refused = tokio::time::timeout(Duration::from_secs(5), waiting)
                .await
                .expect("the waiter never finished")
                .expect("the waiter started a node");
            assert_eq!(refused.unwrap_err().kind(), "peerClosed");
        }

        #[tokio::test]
        async fn on_again_refuses_the_share_endpoint_with_the_same_advice() {
            let scratch = on("state-switch-share-again");
            let state = PeerState::default();
            state
                .apply_switch(Ok(scratch.path().to_path_buf()), false)
                .await
                .unwrap();
            state
                .apply_switch(Ok(scratch.path().to_path_buf()), true)
                .await
                .unwrap();
            let refused = state
                .share_node_at(scratch.path(), || async {
                    panic!("started a share endpoint on a closed run")
                })
                .await;
            assert_eq!(refused.err().unwrap().kind(), "peerClosed");
        }

        /// The second caller waited on the cell through the Off that the first
        /// one's failure then let it past.
        #[tokio::test]
        async fn a_share_start_queued_behind_a_failure_does_not_run_after_off() {
            let scratch = on("state-switch-share-queue");
            let root = scratch.path().to_path_buf();
            let state = Arc::new(PeerState::default());
            let (fail_first, first_fails) = tokio::sync::oneshot::channel::<()>();
            let first = {
                let (state, root) = (state.clone(), root.clone());
                tokio::spawn(async move {
                    state
                        .share_node_at(&root, || async {
                            let _ = first_fails.await;
                            Err(crate::error::Error::ShareRefused("would not bind".into()))
                        })
                        .await
                        .map(|_| ())
                })
            };
            tokio::time::sleep(Duration::from_millis(20)).await;
            let second = {
                let (state, root) = (state.clone(), root.clone());
                tokio::spawn(async move {
                    state
                        .share_node_at(&root, || async {
                            panic!("started a share endpoint after the switch went off")
                        })
                        .await
                        .map(|_| ())
                })
            };
            tokio::time::sleep(Duration::from_millis(20)).await;
            state.apply_switch(Ok(root), false).await.unwrap();
            fail_first.send(()).unwrap();
            assert_eq!(first.await.unwrap().unwrap_err().kind(), "shareRefused");
            let refused = tokio::time::timeout(Duration::from_secs(5), second)
                .await
                .expect("the second caller never finished")
                .expect("the second caller started an endpoint");
            assert_eq!(refused.unwrap_err().kind(), "peerClosed");
        }

        /// Off and then quit closes everything a second time.
        #[tokio::test]
        async fn closing_a_running_share_endpoint_twice_finishes() {
            let share = crate::share::testkit::TestShare::start("state-switch-close-twice").await;
            let state = PeerState::default();
            state.share.set(share.node.clone()).ok().unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                state.close().await;
                state.close().await;
            })
            .await
            .expect("the second close stalled");
        }

        /// A write stalled on the disk, its fsync say, is no reason to keep serving.
        #[tokio::test]
        async fn turning_off_stops_serving_before_a_stalled_record_finishes() {
            let running = TestNode::start("state-switch-off-stalled-record", Role::Shelf).await;
            let state = Arc::new(PeerState::default());
            state.node.set(running.node.clone()).ok().unwrap();
            let (release, stall) = tokio::sync::oneshot::channel::<()>();
            let switching = {
                let state = state.clone();
                tokio::spawn(async move {
                    state
                        .switch_recording(false, async move {
                            let _ = stall.await;
                            crate::p2p::Recorded {
                                error: None,
                                file_says_on: Some(false),
                            }
                        })
                        .await
                })
            };
            tokio::time::timeout(Duration::from_secs(5), running.node.endpoint().closed())
                .await
                .expect("the stalled record held the endpoint open");
            assert!(!switching.is_finished(), "the record has not finished");
            release.send(()).unwrap();
            let answer = switching.await.unwrap();
            assert!(answer.closed);
            assert!(answer.record_error.is_none());
        }

        /// Closure begun in this state, and an endpoint that has not heard: only
        /// the endpoint can say.
        #[tokio::test]
        async fn a_flag_without_a_closed_endpoint_is_not_called_closed() {
            let running = TestNode::start("state-switch-flag-node", Role::Shelf).await;
            let state = PeerState::default();
            state.node.set(running.node.clone()).ok().unwrap();
            state
                .closing
                .store(true, std::sync::atomic::Ordering::SeqCst);
            assert!(!state.transport_closed().await);
            running.node.endpoint().close().await;
            assert!(state.transport_closed().await);
        }

        #[tokio::test]
        async fn a_share_endpoint_still_serving_is_not_called_closed() {
            let share = crate::share::testkit::TestShare::start("state-switch-flag-share").await;
            let state = PeerState::default();
            state.share.set(share.node.clone()).ok().unwrap();
            state
                .closing
                .store(true, std::sync::atomic::Ordering::SeqCst);
            assert!(!state.transport_closed().await);
            share.node.close().await;
            assert!(state.transport_closed().await);
        }

        #[tokio::test]
        async fn an_answer_with_nothing_started_says_closed_only_after_off() {
            let state = PeerState::default();
            assert!(!state.transport_closed().await);
            state.close().await;
            assert!(state.transport_closed().await);
        }

        #[tokio::test]
        async fn a_stalled_close_does_not_keep_the_other_endpoint_open() {
            let (closed, other) = tokio::sync::oneshot::channel::<()>();
            let both = close_each(std::future::pending(), async move {
                closed.send(()).unwrap();
            });
            tokio::select! {
                _ = both => panic!("a close that never finishes finished"),
                done = other => done.unwrap(),
                _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("the stall held up the other close"),
            }
        }

        #[tokio::test]
        async fn a_close_past_its_deadline_keeps_going() {
            let (release, stall) = tokio::sync::oneshot::channel::<()>();
            let (finished, done) = tokio::sync::oneshot::channel::<()>();
            let closing = async move {
                let _ = stall.await;
                finished.send(()).unwrap();
            };
            assert!(!closed_within(Duration::from_millis(20), closing).await);
            release.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(5), done)
                .await
                .expect("the deadline dropped the close")
                .unwrap();
        }

        #[tokio::test]
        async fn a_close_inside_its_deadline_says_so() {
            assert!(closed_within(Duration::from_secs(5), async {}).await);
        }
    }

    /// ⚠️ **THE GATE EXISTS BECAUSE PLUGIN SETUP RUNS BEFORE THE LIBRARY
    /// LOCK.** A second Paper that the lock was about to refuse had already
    /// swept `.part` files out of the holder's library — staging files a live
    /// fetch writes into, not stale ones. These assert the two halves that
    /// make the gate correct: it BLOCKS until granted, and it never parks a
    /// waiter that arrives late.
    #[tokio::test]
    async fn the_library_gate_blocks_until_it_is_granted() {
        let state = Arc::new(PeerState::default());
        let waiting = {
            let state = state.clone();
            tokio::spawn(async move { state.library_granted().await })
        };
        /* Not a performance assertion: a liveness one in the other direction.
        If the gate did not block, this would already have finished. */
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(
            !waiting.is_finished(),
            "the gate let a caller through before the library was held"
        );
        state.hold_library();
        tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("the gate never opened")
            .expect("the waiter panicked");
    }

    /// ⚠️ **`Notify::notify_waiters` ONLY WAKES TASKS ALREADY WAITING**, so a
    /// gate built on it alone parks for ever anything that arrives after the
    /// grant — which is every command on a normally ordered launch. The circle
    /// keeper had exactly this defect under its own name; the flag beside the
    /// `Notify` is what removes it here.
    #[tokio::test]
    async fn a_caller_arriving_after_the_grant_does_not_park() {
        let state = PeerState::default();
        state.hold_library();
        tokio::time::timeout(std::time::Duration::from_secs(5), state.library_granted())
            .await
            .expect("a caller that arrived after the grant waited for ever");
    }

    #[tokio::test]
    async fn granting_twice_is_harmless() {
        let state = PeerState::default();
        state.hold_library();
        state.hold_library();
        tokio::time::timeout(std::time::Duration::from_secs(5), state.library_granted())
            .await
            .expect("a second grant closed the gate");
    }
}

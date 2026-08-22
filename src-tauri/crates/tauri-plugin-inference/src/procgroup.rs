//! Killing the whole tree, not just the child Paper can see.
//!
//! **This is the module WI-15.0's fourth acceptance line lives in**, and the
//! line is easy to misread. *"`SIGTERM` leaves no child process"* is not a
//! claim about `lemond`. `lemond` is a supervisor itself: loading a model
//! spawns a backend — `llama-server` and friends, from `resources/` or from
//! the cache — and signalling only the process Paper spawned leaves those
//! backends holding the GPU, the model's several gigabytes of resident
//! memory, and in the observed case a listening socket.
//!
//! So the child is placed in its own process group (unix) or job object
//! (Windows) at spawn, and the signal goes to the GROUP. Two calls, one per
//! platform, kept behind one interface so `daemon.rs` states the lifecycle
//! once instead of twice.
//!
//! # The order, and why there are two signals
//!
//! `terminate` then, after a grace period, `kill`. The grace is not
//! politeness: the daemon's own shutdown unloads models and releases GPU
//! allocations, and the smoke test watched it log `Unload all models` →
//! `Evict all completed` → `Cleanup complete` on the way out. Going straight
//! to SIGKILL skips all of that. Going only as far as SIGTERM and waiting
//! forever hangs the app's exit on a child that has stopped listening.

use std::io;

use tokio::process::{Child, Command};

/// Put the child in its own process group (unix) or job object (Windows), so
/// a later [`terminate`] reaches everything it spawns.
///
/// Called before `spawn`.
#[cfg(unix)]
pub fn configure(cmd: &mut Command) {
    // 0 means "make the child a group leader of a new group whose id is its
    // own pid", which is what makes `killpg(child.id())` well defined below.
    cmd.process_group(0);
}

#[cfg(windows)]
pub fn configure(cmd: &mut Command) {
    use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
    // The job object is attached after spawn (it needs a process handle), so
    // all that happens here is detaching the child from Paper's own console
    // group — otherwise a Ctrl-C delivered to Paper reaches the daemon
    // directly and the ordered shutdown below never runs.
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

/// Ask the whole tree to stop, and give it a chance to unload cleanly.
#[cfg(unix)]
pub fn terminate(child: &Child) -> io::Result<()> {
    let Some(pid) = child.id() else {
        // Already reaped. Nothing to signal, and that is success.
        return Ok(());
    };
    // NEGATIVE pid via killpg: the group, not the process. This is the whole
    // point of the module — `kill(pid, SIGTERM)` here would leave the model
    // backends running.
    let rc = unsafe { libc::killpg(pid as libc::pid_t, libc::SIGTERM) };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    // ESRCH: the group is already gone, which is the outcome asked for.
    if err.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(err)
    }
}

#[cfg(windows)]
pub fn terminate(child: &Child) -> io::Result<()> {
    use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
    let Some(pid) = child.id() else {
        return Ok(());
    };
    // The nearest thing Windows has to SIGTERM for a console process group.
    // A failure here is not fatal: `kill` below is unconditional, so the
    // worst case is the ungraceful path the grace period exists to avoid.
    let ok = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// The group id to signal, captured while the child is still un-reaped.
///
/// ⚠️ **CAPTURE THIS AT SPAWN.** `Child::id()` returns `None` once the child
/// has been reaped — and `try_wait()` reaps it. So a shutdown that polled
/// `try_wait()` until the leader exited and THEN called `kill` had no pid
/// left to signal, sent nothing, and left the leader's descendants running:
/// exactly the case the group kill exists for, silently doing nothing. An
/// audit caught it. The id is a plain number and outliving the handle is the
/// point.
#[cfg(unix)]
pub fn group_of(child: &Child) -> Option<u32> {
    child.id()
}

#[cfg(windows)]
pub fn group_of(child: &Child) -> Option<u32> {
    child.id()
}

/// Force the whole tree down. Runs after the grace period, always.
///
/// On unix this is `killpg(SIGKILL)` rather than tokio's `Child::kill`,
/// which sends SIGKILL to the ONE process — the same gap `terminate`
/// closes, and the reason this function exists at all rather than the
/// caller reaching for the obvious method.
///
/// `group` is the id captured by [`group_of`] at spawn. It is passed in
/// rather than read from `child` because by the time this runs the child may
/// already have been reaped — see [`group_of`].
#[cfg(unix)]
pub async fn kill(child: &mut Child, group: Option<u32>) -> io::Result<()> {
    if let Some(pid) = group.or_else(|| child.id()) {
        let rc = unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
        if rc != 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                return Err(err);
            }
        }
    }
    // Reap, so the child does not become a zombie held by this process.
    let _ = child.wait().await;
    Ok(())
}

#[cfg(windows)]
pub async fn kill(child: &mut Child, _group: Option<u32>) -> io::Result<()> {
    // `Child::kill` on Windows is TerminateProcess on the one handle. Any
    // backend `lemond` spawned is not in it — which is the gap a Job Object
    // closes, and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is what makes the
    // whole tree die with the handle. See `JobHandle` below.
    child.kill().await
}

/// A Windows Job Object holding the daemon's whole process tree.
///
/// Assigned after spawn, because assignment needs a process handle. Dropping
/// it terminates every process still in the job — which is the Windows
/// equivalent of the process-group kill above, and the reason the `Daemon`
/// keeps one alive for exactly as long as it keeps the child.
#[cfg(windows)]
pub struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// SAFETY: a job object handle is not thread-affine; it is a kernel handle
// that may be used and closed from any thread.
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl JobHandle {
    /// Create a job that kills its members when the handle closes, and put
    /// `child` in it.
    pub fn hold(child: &Child) -> io::Result<JobHandle> {
        use std::ptr;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("the child has no handle"))?;

        // SAFETY: null name and null attributes are the documented "create an
        // anonymous job" call; the return is checked against null below.
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` is a correctly sized, zeroed instance of the struct
        // the class expects, and its size is passed alongside.
        let ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let err = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(err);
        }

        // SAFETY: both handles are live — `job` was just created and checked,
        // and `handle` belongs to a child that has not been reaped.
        let ok = unsafe { AssignProcessToJobObject(job, handle as _) };
        if ok == 0 {
            let err = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(err);
        }
        Ok(JobHandle(job))
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        // Closing the last handle to a job with KILL_ON_JOB_CLOSE terminates
        // every process still in it. That is the guarantee, and it holds even
        // if Paper itself is killed — the kernel closes the handle for us.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the module exists for, on the platform that can prove it
    /// here: a grandchild started by the child dies with the group.
    ///
    /// `sh -c 'sleep 30 & ...'` stands in for `lemond` spawning a backend.
    /// Signalling the CHILD alone would leave the `sleep` running, which is
    /// exactly the failure this module closes — so a regression that swaps
    /// `killpg` for `kill` turns this red.
    #[cfg(unix)]
    #[tokio::test]
    async fn terminate_reaches_a_grandchild() {
        let mut cmd = Command::new("/bin/sh");
        // The grandchild writes its pid where the test can read it, then the
        // child waits — so both are alive when the signal arrives.
        let dir = crate::testutil::ScratchDir::new("procgroup");
        let pidfile = dir.path().join("grandchild.pid");
        cmd.arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", pidfile.display()));
        configure(&mut cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn");

        // Wait for the grandchild's pid to appear.
        let mut grandchild = String::new();
        for _ in 0..100 {
            if let Ok(text) = tokio::fs::read_to_string(&pidfile).await {
                if !text.trim().is_empty() {
                    grandchild = text.trim().to_owned();
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let gpid: i32 = grandchild.parse().expect("grandchild pid");
        // Alive before the signal — otherwise the assertion after it proves
        // nothing at all.
        assert_eq!(
            unsafe { libc::kill(gpid, 0) },
            0,
            "grandchild should be running"
        );

        terminate(&child).expect("terminate");
        let _ = child.wait().await;

        // The grandchild is gone too. Poll: signal delivery is not instant.
        let mut gone = false;
        for _ in 0..100 {
            if unsafe { libc::kill(gpid, 0) } != 0 {
                gone = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            gone,
            "the grandchild survived — the signal went to the process, not the group"
        );
    }

    /// ⚠️ THE REAPED-PID CASE, which is the one that silently did nothing.
    /// `try_wait()` reaps the leader, after which `Child::id()` is `None` —
    /// so a `kill` that read the pid off the handle sent no signal at all and
    /// the leader's descendants survived. `group_of` captures it at spawn.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_reaped_child_still_yields_a_group_to_kill() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("exit 0");
        configure(&mut cmd);
        let mut child = cmd.spawn().expect("spawn");
        let group = group_of(&child);
        assert!(
            group.is_some(),
            "the group must be captured before any wait"
        );

        // Reap it, as `Daemon::stop`'s grace loop does.
        let _ = child.wait().await;
        assert!(
            child.id().is_none(),
            "tokio drops the pid on reap — this is the premise of the bug"
        );

        // The captured group is still usable, and killing an empty group is
        // success rather than an error.
        kill(&mut child, group)
            .await
            .expect("killing a reaped group is fine");
    }

    /// Signalling a group that has already exited is success, not an error:
    /// a daemon that crashed on its own must not make `stop` fail.
    #[cfg(unix)]
    #[tokio::test]
    async fn terminating_an_exited_child_is_not_an_error() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("exit 0");
        configure(&mut cmd);
        let mut child = cmd.spawn().expect("spawn");
        let _ = child.wait().await;
        terminate(&child).expect("terminating an exited child is fine");
    }
}

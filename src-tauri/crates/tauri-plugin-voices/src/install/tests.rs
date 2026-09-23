//! What a download does when the network misbehaves.
//!
//! The server here is twenty lines of `TcpListener` rather than a dependency,
//! and it exists to answer the four ways a real one ruins a resume: honouring a
//! `Range`, ignoring it and sending the whole file with `200`, answering `206`
//! from an offset nobody asked for, and serving bytes that are the right length
//! and the wrong contents.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::{install, installed, remove, Progress};
use crate::cancel::Cancel;
use crate::error::Error;
use crate::manifest::{Artifact, Family, Pack, Platform, Role, Voice};
use crate::paths::Layout;

/// How a test server answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Honour `Range`, which is what a resume needs.
    Ranges,
    /// Ignore `Range` and send the whole body with `200` — a proxy, or a host
    /// that does not do partial content.
    IgnoreRange,
    /// Answer `206` from an offset the client did not ask for.
    WrongOffset,
}

struct Server {
    url: String,
    /// How many requests arrived, so a test can prove a resume happened.
    requests: Arc<AtomicUsize>,
    /// The `Range` header of the last request, if there was one.
    ranges: Arc<std::sync::Mutex<Vec<Option<String>>>>,
}

async fn serve(body: Vec<u8>, mode: Mode) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let requests = Arc::new(AtomicUsize::new(0));
    let ranges = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (counter, seen) = (Arc::clone(&requests), Arc::clone(&ranges));
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let body = body.clone();
            let counter = Arc::clone(&counter);
            let seen = Arc::clone(&seen);
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                // Headers end at a blank line; a GET has no body to wait for.
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let text = String::from_utf8_lossy(&request).to_string();
                let range = text
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                    .map(|l| l["range:".len()..].trim().to_owned());
                seen.lock().expect("ranges").push(range.clone());
                let from = range
                    .as_deref()
                    .and_then(|r| r.strip_prefix("bytes="))
                    .and_then(|r| r.split('-').next())
                    .and_then(|start| start.parse::<usize>().ok());
                let (status, start) = match (mode, from) {
                    (Mode::Ranges, Some(from)) => ("206 Partial Content", from),
                    (Mode::WrongOffset, Some(from)) => ("206 Partial Content", from.saturating_sub(1)),
                    _ => ("200 OK", 0),
                };
                let slice = &body[start.min(body.len())..];
                let mut head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n",
                    slice.len()
                );
                if status.starts_with("206") {
                    // `start` already carries the offset this mode answers from,
                    // which for WrongOffset is not the one that was asked for.
                    head.push_str(&format!(
                        "Content-Range: bytes {start}-{}/{}\r\n",
                        body.len().saturating_sub(1),
                        body.len()
                    ));
                }
                head.push_str("\r\n");
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(slice).await;
                let _ = socket.flush().await;
            });
        }
    });
    Server { url: format!("http://127.0.0.1:{port}/artifact.bin"), requests, ranges }
}

fn sha256(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
}

fn scratch() -> std::path::PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "paper-voices-install-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("scratch");
    dir
}

/// A pack of one artifact, served from `url`, declaring `body`'s real size and
/// digest unless a test says otherwise.
fn pack_of(url: &str, body: &[u8], sha: &str) -> Pack {
    Pack {
        id: "english-kokoro".into(),
        family: Family::Kokoro,
        name: "English".into(),
        summary: "reads English".into(),
        languages: vec!["en".into()],
        platforms: vec![Platform::Macos],
        minimum_memory_gb: 4,
        voices: vec![Voice {
            id: "af_heart".into(),
            name: "Heart".into(),
            language: "en-US".into(),
            note: "American.".into(),
        }],
        artifacts: vec![Artifact {
            path: "voices/af_heart.bin".into(),
            url: url.to_owned(),
            bytes: body.len() as u64,
            sha256: sha.to_owned(),
            licence: "Apache-2.0".into(),
            role: Role::Voice,
        }],
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().expect("client")
}

#[tokio::test]
async fn a_pack_installs_and_reports_as_it_goes() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body = vec![7u8; 2048];
    let server = serve(body.clone(), Mode::Ranges).await;
    let pack = pack_of(&server.url, &body, &sha256(&body));
    let mut seen = Vec::new();
    install(&client(), &layout, &pack, &Cancel::never(), |p| seen.push(p))
        .await
        .expect("install");

    let landed = layout.pack_path(&pack.id, "voices/af_heart.bin").expect("path");
    assert_eq!(std::fs::read(&landed).expect("installed file"), body);
    assert!(installed(&layout, &pack).expect("installed"));
    assert!(
        !layout.staging_dir_for(&pack.id).expect("staging").exists(),
        "a finished install leaves no staging behind"
    );
    assert!(seen.contains(&Progress::Verifying) && seen.contains(&Progress::Installed));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn an_interrupted_download_resumes_rather_than_starting_over() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
    let server = serve(body.clone(), Mode::Ranges).await;
    let pack = pack_of(&server.url, &body, &sha256(&body));

    // What a stopped download left behind: the first 1000 bytes, in staging.
    let staged = layout.staging_path(&pack.id, "voices/af_heart.bin").expect("staged");
    std::fs::create_dir_all(staged.parent().expect("parent")).expect("dirs");
    std::fs::write(&staged, &body[..1000]).expect("partial");

    install(&client(), &layout, &pack, &Cancel::never(), |_| {}).await.expect("install");

    let landed = layout.pack_path(&pack.id, "voices/af_heart.bin").expect("path");
    assert_eq!(std::fs::read(&landed).expect("installed"), body, "the file is whole and correct");
    let ranges = server.ranges.lock().expect("ranges").clone();
    assert_eq!(
        ranges,
        vec![Some("bytes=1000-".to_owned())],
        "the download asked for the rest, not the whole file"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_server_that_ignores_the_range_is_restarted_rather_than_appended_to() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body: Vec<u8> = (0..4096u32).map(|i| (i % 241) as u8).collect();
    let server = serve(body.clone(), Mode::IgnoreRange).await;
    let pack = pack_of(&server.url, &body, &sha256(&body));
    let staged = layout.staging_path(&pack.id, "voices/af_heart.bin").expect("staged");
    std::fs::create_dir_all(staged.parent().expect("parent")).expect("dirs");
    std::fs::write(&staged, &body[..1000]).expect("partial");

    install(&client(), &layout, &pack, &Cancel::never(), |_| {}).await.expect("install");

    let landed = layout.pack_path(&pack.id, "voices/af_heart.bin").expect("path");
    assert_eq!(
        std::fs::read(&landed).expect("installed"),
        body,
        "appending a whole body onto a partial is the corruption this guards against"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_resume_from_the_wrong_offset_is_refused_before_a_byte_is_written() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body: Vec<u8> = (0..4096u32).map(|i| (i % 239) as u8).collect();
    let server = serve(body.clone(), Mode::WrongOffset).await;
    let pack = pack_of(&server.url, &body, &sha256(&body));
    let staged = layout.staging_path(&pack.id, "voices/af_heart.bin").expect("staged");
    std::fs::create_dir_all(staged.parent().expect("parent")).expect("dirs");
    std::fs::write(&staged, &body[..1000]).expect("partial");

    let err = install(&client(), &layout, &pack, &Cancel::never(), |_| {})
        .await
        .expect_err("a different range must be refused");
    assert!(matches!(err, Error::Malformed { .. }), "{err}");
    assert_eq!(
        std::fs::read(&staged).expect("partial").len(),
        1000,
        "and nothing may be appended to the partial"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn bytes_that_do_not_match_the_digest_are_refused_and_removed() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body = vec![1u8; 512];
    let server = serve(body.clone(), Mode::Ranges).await;
    // Right length, wrong contents: the catalogue's digest is of something else.
    let pack = pack_of(&server.url, &body, &sha256(&vec![2u8; 512]));

    let err = install(&client(), &layout, &pack, &Cancel::never(), |_| {})
        .await
        .expect_err("a wrong digest must refuse");
    assert!(matches!(err, Error::DigestMismatch { .. }), "{err}");

    let staged = layout.staging_path(&pack.id, "voices/af_heart.bin").expect("staged");
    assert!(
        !staged.exists(),
        "a staged file known to be wrong must go, or every retry skips it as the right size and fails for ever"
    );
    assert!(!installed(&layout, &pack).expect("installed"), "nothing was installed");

    // And the proof that the removal is what makes a retry possible: with the
    // real digest, the same pack installs.
    let good = pack_of(&server.url, &body, &sha256(&body));
    install(&client(), &layout, &good, &Cancel::never(), |_| {}).await.expect("retry");
    assert!(installed(&layout, &good).expect("installed"));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_short_transfer_is_named_a_size_failure() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body = vec![3u8; 100];
    let server = serve(body.clone(), Mode::Ranges).await;
    // The catalogue says the file is longer than what the server has.
    let mut pack = pack_of(&server.url, &body, &sha256(&body));
    pack.artifacts[0].bytes = 200;

    let err = install(&client(), &layout, &pack, &Cancel::never(), |_| {})
        .await
        .expect_err("a short transfer must refuse");
    assert!(
        matches!(err, Error::SizeMismatch { expected: 200, got: 100, .. }),
        "a truncation reported as a digest failure sends the next reader the wrong way: {err}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_stopped_download_keeps_its_partial_and_installs_nothing() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body = vec![5u8; 4096];
    let server = serve(body.clone(), Mode::Ranges).await;
    let pack = pack_of(&server.url, &body, &sha256(&body));
    let (cancel, stopper) = Cancel::new();
    stopper.stop();

    let err = install(&client(), &layout, &pack, &cancel, |_| {})
        .await
        .expect_err("a stopped download does not install");
    assert!(matches!(err, Error::Cancelled), "{err}");
    assert!(!installed(&layout, &pack).expect("installed"));
    assert_eq!(server.requests.load(Ordering::SeqCst), 0, "it stopped before asking");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn removing_a_pack_leaves_no_file_behind() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body = vec![9u8; 256];
    let server = serve(body.clone(), Mode::Ranges).await;
    let pack = pack_of(&server.url, &body, &sha256(&body));
    install(&client(), &layout, &pack, &Cancel::never(), |_| {}).await.expect("install");
    // Something a stopped download left behind, too.
    let staged = layout.staging_path(&pack.id, "voices/af_heart.bin").expect("staged");
    std::fs::create_dir_all(staged.parent().expect("parent")).expect("dirs");
    std::fs::write(&staged, b"partial").expect("partial");

    remove(&layout, &pack.id).await.expect("remove");

    assert!(!layout.pack_dir(&pack.id).expect("dir").exists());
    assert!(!layout.staging_dir_for(&pack.id).expect("staging").exists());
    assert!(!installed(&layout, &pack).expect("installed"));
    assert!(layout.packs_dir.is_dir(), "only this pack goes");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn removing_a_pack_that_was_never_installed_is_not_a_failure() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    layout.ensure().expect("ensure");
    remove(&layout, "english-kokoro").await.expect("removing nothing is fine");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_pack_with_a_missing_or_short_file_does_not_report_as_installed() {
    let dir = scratch();
    let layout = Layout::under(&dir);
    let body = vec![4u8; 300];
    let server = serve(body.clone(), Mode::Ranges).await;
    let pack = pack_of(&server.url, &body, &sha256(&body));
    assert!(!installed(&layout, &pack).expect("nothing yet"));

    install(&client(), &layout, &pack, &Cancel::never(), |_| {}).await.expect("install");
    assert!(installed(&layout, &pack).expect("installed"));

    // A file that lost bytes — a disk that filled, an interrupted copy.
    let landed = layout.pack_path(&pack.id, "voices/af_heart.bin").expect("path");
    std::fs::write(&landed, &body[..10]).expect("truncate");
    assert!(
        !installed(&layout, &pack).expect("installed"),
        "size is what this check is for, and a short file is not the artifact"
    );
    std::fs::remove_dir_all(&dir).ok();
}

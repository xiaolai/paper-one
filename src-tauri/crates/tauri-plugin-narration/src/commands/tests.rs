use super::*;
use crate::limits::{MAX_CHAPTERS, MAX_TEXT_BYTES};
use crate::narrate::apple::tests::tone;

/// Every `#[tauri::command]` in `commands.rs`, by the name it is declared with.
///
/// ⚠️ **A LINE THAT IS THE ATTRIBUTE, NOT A LINE THAT CONTAINS IT.** The voices
/// plugin's copy of this test once found seven commands where there were six,
/// because a doc comment mentioned the attribute. Same parser as the passages
/// plugin's, and the trap is reproduced below.
fn declared(source: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut lines = source.lines();
    while let Some(line) = lines.next() {
        if line.trim() != "#[tauri::command]" {
            continue;
        }
        for next in lines.by_ref() {
            let trimmed = next.trim_start();
            let Some(rest) = trimmed
                .strip_prefix("pub async fn ")
                .or_else(|| trimmed.strip_prefix("pub fn "))
            else {
                continue;
            };
            let end = rest
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(rest.len());
            out.push(rest[..end].to_owned());
            break;
        }
    }
    out
}

#[test]
fn lists_agree() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let plugin = std::fs::read_to_string(root.join("src/plugin.rs")).expect("plugin.rs");
    let build = std::fs::read_to_string(root.join("build.rs")).expect("build.rs");
    let permissions =
        std::fs::read_to_string(root.join("permissions/default.toml")).expect("default.toml");
    let source = std::fs::read_to_string(root.join("src/commands.rs")).expect("commands.rs");

    let names = declared(&source);
    assert_eq!(
        names.len(),
        9,
        "the parse is wrong, not the code: {names:?}"
    );
    /* `narrate_package` keeps the old app command's name, so the window's call
     * site reads the same; every other command carries the plugin's prefix. */
    assert!(
        names
            .iter()
            .all(|name| name.starts_with("narration_") || name == "narrate_package"),
        "a name that is not a command slipped into the parse: {names:?}"
    );

    for name in &names {
        assert!(
            plugin.contains(&format!("commands::{name}")),
            "{name} is declared but not registered in plugin.rs"
        );
        assert!(
            build.contains(&format!("\"{name}\"")),
            "{name} is declared but not in build.rs's COMMANDS, so it has no permission pair"
        );
        let grant = format!("allow-{}", name.replace('_', "-"));
        assert!(
            permissions.contains(&grant),
            "{name} is declared but {grant} is not in permissions/default.toml, so it is refused"
        );
    }

    /* AND THE OTHER DIRECTION: a grant for a command that does not exist is a
     * name somebody later re-adds a different meaning to. */
    for line in build.lines() {
        let Some(quoted) = line.trim().strip_prefix('"') else {
            continue;
        };
        let Some(name) = quoted.strip_suffix("\",") else {
            continue;
        };
        assert!(
            names.iter().any(|declared| declared == name),
            "{name} is in build.rs's COMMANDS and is not declared in commands.rs"
        );
    }
}

#[test]
fn the_parse_does_not_read_a_doc_comment_as_a_command() {
    let source = "\
/// What a `#[tauri::command]` async fn costs.
#[tauri::command]
pub async fn narration_real() {}
";
    assert_eq!(declared(source), ["narration_real"]);
}

/// A data root with a run begun and a destination picked.
struct Fixture {
    _dir: tempfile::TempDir,
    data: PathBuf,
    out: PathBuf,
    ready: Ready,
    run: Begun,
    token: String,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let base = std::fs::canonicalize(dir.path()).expect("canonical");
    let data = base.join("data");
    let out = base.join("out");
    std::fs::create_dir(&out).expect("out");
    let ready = Ready::open(&data).expect("ready");
    let run = ready.runs.begin().expect("begin");
    let token = ready
        .destinations
        .insert(out.join("book.m4b"))
        .expect("picked");
    Fixture {
        _dir: dir,
        data,
        out,
        ready,
        run,
        token,
    }
}

fn scratch(index: u32) -> ChapterIn {
    ChapterIn {
        title: format!("Chapter {index}"),
        source: Source::Scratch { index },
    }
}

fn request(f: &Fixture, chapters: Vec<ChapterIn>) -> Request {
    Request {
        run: f.run.run.clone(),
        destination: f.token.clone(),
        chapters,
        title: "A Measured Book".to_owned(),
        author: "Paper".to_owned(),
    }
}

/// Write a chapter's audio where the voices plugin would have rendered it.
fn render(f: &Fixture, index: u32, seconds: u64) {
    let rate = 22_050u32;
    let path = format!("{}{index}.wav", f.run.chapter_prefix);
    std::fs::write(path, tone(seconds * u64::from(rate), rate)).expect("render");
}

/// The token is still claimable — proved by claiming it — so a refusal spent
/// nothing.
fn still_picked(f: &Fixture) {
    f.ready
        .destinations
        .claim(&f.token)
        .expect("the refusal spent the token");
}

/// One way to spoil a request, and the words its refusal must contain.
type Spoiled = (Box<dyn Fn(&mut Request)>, &'static str);

#[test]
fn a_request_past_any_bound_is_refused_by_name_before_the_token_is_spent() {
    let long = "a".repeat(MAX_TEXT_BYTES + 1);
    let cases: Vec<Spoiled> = vec![
        (Box::new(|r| r.chapters.clear()), "no chapters"),
        (
            Box::new(|r| r.chapters = (0..=MAX_CHAPTERS as u32).map(scratch).collect()),
            "at most 2000",
        ),
        (
            Box::new({
                let long = long.clone();
                move |r| r.title = long.clone()
            }),
            "the title is",
        ),
        (
            Box::new({
                let long = long.clone();
                move |r| r.author = long.clone()
            }),
            "the author is",
        ),
        (
            Box::new(move |r| r.chapters[0].title = long.clone()),
            "the chapter title is",
        ),
        (
            Box::new(|r| r.run = "run-elsewhere".to_owned()),
            "no export called",
        ),
    ];
    for (change, says) in cases {
        let f = fixture();
        let mut request = request(&f, vec![scratch(0)]);
        change(&mut request);
        let error = f.ready.package(&request).expect_err("refused");
        assert!(error.contains(says), "{says}: {error}");
        still_picked(&f);
    }
}

#[test]
fn a_clip_outside_the_voices_store_is_refused() {
    let f = fixture();
    let clips = f.data.join("audio").join("clips");
    std::fs::create_dir_all(&clips).expect("clips");
    let elsewhere = f.out.join("stray.wav");
    std::fs::write(&elsewhere, tone(10, 22_050)).expect("stray");
    for (path, says) in [
        (
            elsewhere.display().to_string(),
            "not in the voices plugin's clip store",
        ),
        (
            clips
                .join("..")
                .join("..")
                .join("stray.wav")
                .display()
                .to_string(),
            "climbs out",
        ),
        ("clips/one.wav".to_owned(), "not an absolute path"),
        (
            clips.join("one.txt").display().to_string(),
            "not a rendered clip",
        ),
    ] {
        let chapter = ChapterIn {
            title: "Heard".to_owned(),
            source: Source::Clip { path },
        };
        let error = f
            .ready
            .package(&request(&f, vec![chapter]))
            .expect_err("refused");
        assert!(error.contains(says), "{says}: {error}");
    }
    still_picked(&f);
}

#[test]
fn a_token_never_picked_is_refused() {
    let f = fixture();
    render(&f, 0, 1);
    let mut request = request(&f, vec![scratch(0)]);
    request.destination = "0".repeat(32);
    let error = f.ready.package(&request).expect_err("refused");
    if SUPPORTED {
        assert!(error.contains("never picked"), "{error}");
    } else {
        assert_eq!(error, UNSUPPORTED);
    }
}

#[test]
fn the_window_cannot_send_a_field_the_plugin_does_not_know() {
    /* A misspelt `index` would otherwise deserialise to an error far from its
     * cause; an extra `path` beside a scratch index would be silently ignored. */
    let extra = serde_json::json!({ "kind": "scratch", "index": 0, "path": "/etc/passwd" });
    assert!(serde_json::from_value::<Source>(extra).is_err());
    let clip = serde_json::json!({ "kind": "clip", "path": "/a.wav" });
    assert_eq!(
        serde_json::from_value::<Source>(clip).expect("clip"),
        Source::Clip {
            path: "/a.wav".to_owned()
        }
    );
}

#[test]
fn a_suggested_name_is_a_bare_file_name() {
    assert_eq!(suggested_name("Moby Dick.m4b"), Ok(()));
    for (name, says) in [
        ("", "empty"),
        ("../up.m4b", "bare name"),
        ("a\\b.m4b", "bare name"),
        ("a\0b", "bare name"),
    ] {
        let error = suggested_name(name).expect_err("refused");
        assert!(error.contains(says), "{name:?}: {error}");
    }
    assert!(suggested_name(&"a".repeat(256))
        .expect_err("refused")
        .contains("at most 255"));
}

#[cfg(target_os = "macos")]
#[test]
fn a_package_that_fails_after_the_claim_spends_its_token() {
    /* Chapter 0 was never rendered, so the read fails inside the join — after
     * the claim, before any encoder runs. */
    let f = fixture();
    let request = request(&f, vec![scratch(0)]);
    let error = f.ready.package(&request).expect_err("nothing to read");
    assert!(error.contains("chapter 1"), "{error}");
    render(&f, 0, 1);
    let again = f.ready.package(&request).expect_err("spent");
    assert!(again.contains("never picked"), "{again}");
    assert!(!f.out.join("book.m4b").exists());
}

#[cfg(target_os = "macos")]
#[test]
fn a_release_during_the_package_means_nothing_is_written() {
    let f = fixture();
    render(&f, 0, 1);
    /* The window's release lands while the book is being made: modelled by
     * claiming as the package would and releasing before the commit. */
    let target = f.ready.destinations.claim(&f.token).expect("claim");
    f.ready.destinations.release(&f.token).expect("release");
    let (staged, _) = crate::staged::Staged::beside(&target, "book").expect("stage");
    let error = f
        .ready
        .destinations
        .commit(&f.token, staged)
        .expect_err("refused");
    assert!(error.contains("cancelled"), "{error}");
    assert!(!target.exists());
}

/// `afinfo`'s report on a file, which is Core Audio's own reading of it.
#[cfg(target_os = "macos")]
fn afinfo(path: &std::path::Path) -> String {
    let out = std::process::Command::new("/usr/bin/afinfo")
        .arg(path)
        .output()
        .expect("afinfo runs");
    assert!(out.status.success(), "afinfo refused the book: {out:?}");
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// AVFoundation's reading of a book's chapters, one `start title` line each.
///
/// ⚠️ **`afinfo` CANNOT SEE A CHAPTER.** It reports the audio track alone, so
/// a book whose chapter track no player understood would pass it. AVFoundation
/// is what Apple's own players read chapters with, and asking it BY LOCALE
/// matters: `bestMatchingPreferredLanguages: []` answers no groups at all for a
/// track whose language is `und`, which is what the muxer writes.
#[cfg(target_os = "macos")]
fn chapters_as_apple_reads_them(path: &std::path::Path, scratch: &std::path::Path) -> Vec<String> {
    const SCRIPT: &str = r#"import AVFoundation
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
for locale in try await asset.load(.availableChapterLocales) {
    let groups = try await asset.loadChapterMetadataGroups(
        withTitleLocale: locale, containingItemsWithCommonKeys: [.commonKeyTitle])
    for group in groups {
        var title = "?"
        for item in group.items where item.commonKey == .commonKeyTitle {
            title = (try? await item.load(.stringValue)) ?? "?"
        }
        print("\(CMTimeGetSeconds(group.timeRange.start)) \(title)")
    }
}
"#;
    let script = scratch.join("chapters.swift");
    std::fs::write(&script, SCRIPT).expect("script");
    let out = std::process::Command::new("/usr/bin/swift")
        .arg(&script)
        .arg(path)
        .output()
        .expect("swift runs");
    assert!(
        out.status.success(),
        "AVFoundation refused the book: {out:?}"
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_owned)
        .collect()
}

/// THE PROOF THE PLAN ASKS FOR: a real M4B, made through the plugin's own
/// command path, that Core Audio reads and plays.
///
/// Ignored because it runs the encoder and the player. Run it with
/// `cargo test -p tauri-plugin-narration -- --ignored --nocapture
/// a_real_m4b_through_the_plugin`. `afinfo` measures it, AVFoundation reads its
/// chapters, and `afplay -v 0` plays it silently, end to end.
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn a_real_m4b_through_the_plugin() {
    let f = fixture();
    render(&f, 0, 2);
    render(&f, 1, 3);
    /* AND ONE CHAPTER THE READER HAD ALREADY HEARD, from the voices store. */
    let clips = f.data.join("audio").join("clips");
    std::fs::create_dir_all(&clips).expect("clips");
    let clip = clips.join("heard.wav");
    std::fs::write(&clip, tone(22_050, 22_050)).expect("clip");
    let chapters = vec![
        scratch(0),
        scratch(1),
        ChapterIn {
            title: "第三章".to_owned(),
            source: Source::Clip {
                path: clip.display().to_string(),
            },
        },
    ];
    let packaged = f
        .ready
        .package(&request(&f, chapters.clone()))
        .expect("packages");
    let book = f.out.join("book.m4b");
    println!("packaged: {packaged:?}");
    assert_eq!(packaged.name, "book.m4b");
    assert_eq!(packaged.chapters, 3);
    assert!(
        (5_900..6_200).contains(&packaged.duration_ms),
        "expected about 6000ms, got {}",
        packaged.duration_ms
    );

    let report = afinfo(&book);
    println!("afinfo:\n{report}");
    let seconds: f64 = report
        .lines()
        .find_map(|line| line.trim().strip_prefix("estimated duration: "))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .expect("afinfo reports a duration");
    assert!((5.9..6.2).contains(&seconds), "afinfo measured {seconds}s");

    let chapters_read = chapters_as_apple_reads_them(&book, &f.out);
    println!("AVFoundation chapters:\n{}", chapters_read.join("\n"));
    assert_eq!(
        chapters_read,
        ["0.0 Chapter 0", "2.0 Chapter 1", "5.0 第三章"],
        "three chapters, each where its audio begins"
    );

    let played = std::process::Command::new("/usr/bin/afplay")
        .args(["-v", "0"])
        .arg(&book)
        .status()
        .expect("afplay runs");
    println!("afplay -v 0: {played}");
    assert!(played.success(), "afplay could not play the book");

    /* THE TOKEN WAS SPENT: a second package to it is refused. */
    let again = f.ready.package(&request(&f, chapters)).expect_err("spent");
    assert!(again.contains("never picked"), "{again}");
    /* A release after the commit changes nothing. */
    f.ready.destinations.release(&f.token).expect("no-op");
    assert!(book.is_file());
    /* Discarded once — nothing was there before it — and only once. */
    f.ready
        .destinations
        .discard_book(&f.token)
        .expect("discard");
    assert!(!book.exists());
    let twice = f
        .ready
        .destinations
        .discard_book(&f.token)
        .expect_err("once");
    assert!(twice.contains("already been removed"), "{twice}");
    /* Nothing of the export is left in its scratch but the chapters, and the
     * run goes with its discard. */
    f.ready.runs.discard(&f.run.run).expect("discard run");
    let left: Vec<_> = std::fs::read_dir(f.ready.roots.scratch())
        .expect("list")
        .collect();
    assert!(left.is_empty(), "scratch left behind: {left:?}");
}

#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn a_book_that_replaced_a_file_is_never_discarded() {
    let f = fixture();
    let book = f.out.join("book.m4b");
    std::fs::write(&book, b"the reader's own").expect("theirs");
    render(&f, 0, 1);
    f.ready
        .package(&request(&f, vec![scratch(0)]))
        .expect("packages");
    let error = f
        .ready
        .destinations
        .discard_book(&f.token)
        .expect_err("kept");
    assert!(error.contains("already at that destination"), "{error}");
    assert!(book.is_file());
}

#[test]
fn the_state_opens_on_the_first_command_and_not_before() {
    /* ⚠️ Setup runs before any webview, so making the scratch directory there
     * would be work the window could not stop — see `NarrationState`. */
    let dir = tempfile::tempdir().expect("tempdir");
    let data = dir.path().join("data");
    let state = NarrationState::new(data.clone());
    assert!(!data.exists(), "nothing is made when the state is made");
    let ready = state.ready().expect("opens");
    assert_eq!(
        ready.roots.scratch(),
        std::fs::canonicalize(&data)
            .expect("made")
            .join(crate::inputs::SCRATCH_DIR)
    );
    assert!(
        std::ptr::eq(ready, state.ready().expect("still open")),
        "opened once, and the same state every time"
    );
}

#[test]
fn a_state_that_cannot_open_says_so_to_every_command() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("not-a-directory");
    std::fs::write(&file, b"x").expect("write");
    let state = NarrationState::new(file);
    let first = state.ready().expect_err("a file is no data root");
    let second = state.ready().expect_err("and stays refused");
    assert_eq!(first, second);
}

#!/usr/bin/env bash
#
# The second half of WI-8.6's scenario, driven by `paper` instead of by the
# MCP bridge (phase 11, WI-11.7).
#
# WHY THIS EXISTS. WI-8.6 is PARTIAL because driving two Macs through the
# automation bridge needs an unoccluded window and Screen Recording permission
# an ssh session does not have, and its own "Harness limits, measured" section
# records that `webview_screenshot` times out on a 1,959-row library and that
# `execute_js` times out whenever the script returns a promise. None of that
# applies to a CLI. Every step below is `paper` on one machine and `paper` on
# the other, over ssh — the same transport `scripts/second-instance.sh` uses,
# and the reason this script takes `<user@host>` rather than a shelf key.
#
# WHAT THIS SCRIPT DOES NOT DO, said plainly because a harness that implied
# otherwise would draw the wrong conclusion the way WI-8.6's first run did:
# IT DOES NOT SYNC. Replication is the app's; `paper` has no transport of its
# own (`src/cli/remote.ts` says why). So the app must be RUNNING AND ITS WINDOW
# UNHIDDEN on both machines — sync is foreground-only on all platforms — and
# this script mutates one side and waits for the other to agree. A step that
# times out is reported as a NAMED FAILURE, never as a pass.
#
# ⚠️ **NOT "FRONTMOST", AND THE DIFFERENCE DECIDES WHETHER A HUMAN HAS TO SIT
# AT EACH MACHINE.** This said FRONTMOST for three runs, which reads as "keep
# clicking on both apps", and it is stronger than what the webview requires.
# The criterion is `document.visibilityState`, and focus does not affect it.
# Measured 2026-08-29 against a 1 s heartbeat in the running app:
#
#   focused, on screen ........ visible, largest gap 1 005 ms over 47 s
#   UNFOCUSED, on screen ...... visible, largest gap 1 005 ms over 47 s
#
# So an unfocused window is not affected in the slightest. Leave both open and
# walk away rather than nursing them.
#
# ⚠️ **AND A HIDDEN WEBVIEW IS THROTTLED, NOT STOPPED — WHICH IS THE OPPOSITE
# OF WHAT THIS COMMENT SAID FOR ONE COMMIT.** A first measurement showed a
# minimised window taking a single 37 165 ms gap with no tick at all, and that
# was written here as fact. It DID NOT REPRODUCE. Three further runs, one of
# them four minutes long and with no contact of any kind:
#
#   minimised, 45 s ........... hidden, 23 ticks, largest gap 2 016 ms
#   minimised, 40 s ........... hidden, 22 ticks, largest gap 2 044 ms
#   minimised, 4 min .......... hidden, 116 ticks, 109 gaps near 2 s,
#                               four excursions, largest 5 271 ms
#
# A 5 s commit debounce absorbs a 2 s throttle without noticing. So the claim
# that sync CANNOT run behind a hidden window is NOT established by anything
# measured here, and the one observation that supported it stands alone and
# unexplained — display sleep and a just-launched app are both candidates and
# neither was ruled out.
#
# AND THE DEBOUNCE ITSELF WAS MEASURED, which is the claim that matters:
#
#   a 5 s setTimeout ARMED WHILE THE WINDOW WAS HIDDEN fired 106 ms late,
#   and fired while the window was STILL HIDDEN
#
# That is the exact mechanism "sync is foreground-only" is about, and it works.
# `lib/scheduler.ts` agrees on the other side: `visibility` there is a TRIGGER
# and never a gate — neither `kick` nor `armDebounce` consults it, so nothing
# in Paper's own code declines to sync while hidden either.
#
# ⚠️ **SO WI-8.6'S EXPLANATION DOES NOT HOLD, AND ITS AUTHOR SAID AS MUCH.**
# That run recorded a satchel — `visibilityState: "hidden"`, `isMinimized():
# false`, occluded behind the Terminal this harness activates — failing to
# fire its debounce for 60 s, and reasoned that "WebKit suspends timers in a
# hidden page … is a sufficient explanation". It is marked **UNVERIFIED** in
# the same paragraph, with "do that at the machine before concluding
# anything", and nobody did. A sufficient-sounding explanation became the
# reason this harness demands a human at two keyboards.
#
# WHAT THIS MEANS FOR A FAILING RUN: do not reach for "the window was hidden".
# Sixty seconds is two orders past a 2 s throttle, the debounce fires hidden,
# and the scheduler does not gate on visibility. Whatever WI-8.6 hit is still
# unidentified — `onLocalCommit` never firing, or a push that failed quietly,
# are both better places to look than the window. A manual "Sync now" worked
# in that same run within 5 s, which points at the trigger and not the run.
#
# THREE STATES, AND THEY ARE NOT ONE. `minimised`, `display asleep` and
# `screen locked` are different conditions, this script's preflight only reads
# the third, and only the first has been measured:
#
#   minimised ......... MEASURED as throttled to ~2 s, not suspended, over
#                       four minutes. One earlier 37 165 ms observation did
#                       not reproduce and is unexplained
#   display asleep .... UNMEASURED. Distinct from a lock, and reached SOONER on
#                       a machine whose `displaysleep` is shorter than its
#                       `screenLock` — so a run can die of this while the
#                       preflight's lock check is still saying yes
#   screen locked ..... refused by preflight [4]/[5]; WI-8.6 attributes six
#                       convergence timeouts to it
#   occluded .......... UNRESOLVED, see below
#
# So `caffeinate -d` on both machines is worth more than it looks: it removes
# the one state that is neither measured nor checked.
#
# AND THE OCCLUSION CASE IS UNRESOLVED, stated rather than smoothed over.
# WI-8.6 measured a satchel BEHIND A TERMINAL WINDOW failing to fire its 5 s
# debounce for 60 s. An attempt to reproduce that on 2026-08-29 — another app's
# window maximised over Paper's — kept `visibilityState` at `visible` and
# ticked for 129 s with no gap, so either that window never truly occluded
# Paper or macOS's occlusion detection needs more than overlap. One of those
# measurements reaches a case the other does not, and until that is settled the
# conservative reading holds: keep the windows UNOBSCURED, not merely
# unminimised.
#
# WHAT IT MUTATES: one book it creates itself (`SCENARIO_BOOK`), one mark on
# it, and one tag. Everything is prefixed `wi-11-7-` so a failed run leaves
# something recognisable rather than something puzzling, and `--clean` removes
# them. It never touches a book it did not make.
#
# AND IT MUTATES THE REAL LIBRARY, on both machines. That is not a choice this
# script can make differently. `paper` honours `PAPER_DATA_DIR`; the APP does
# not — `bookVault.ts`, `appStorage.ts` and `bookFiles.ts` all resolve against
# `BaseDirectory.AppData`, which is the half-moved knob WI-8.6 measured and
# did not repair. So pointing the CLI at a scratch directory would point it at
# a library the app is not syncing, and every step would time out while
# appearing to test something. The scenario needs the app's own data
# directory, and the app's own data directory is the reader's books.
#
# Usage:
#   scripts/sync-scenario.sh <user@host> [--timeout N] [--out FILE] [--dry-run] [--clean]
#
#     --timeout N   seconds to wait for each convergence (default 90)
#     --out FILE    transcript path (default dev-docs/plans/evidence/wi-11-7-<stamp>.md)
#     --dry-run     preflight only: prove both ends answer, change nothing
#     --clean       remove this scenario's book and tag from both sides, then stop
#
#   PAPER_REMOTE_CHECKOUT   remote path, relative to the remote home
#                           (default github/xiaolai/myprojects/paper-one)
#   PAPER_REMOTE_PATH       PATH to use on the remote
#
# The host is an ARGUMENT with no default, for the same reason it is one in
# `second-instance.sh`: this file is committed, and an internal hostname does
# not belong in it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

readonly REMOTE_CHECKOUT="${PAPER_REMOTE_CHECKOUT:-github/xiaolai/myprojects/paper-one}"
# shellcheck disable=SC2016  # $HOME and $PATH are for the REMOTE shell to expand
readonly REMOTE_PATH="${PAPER_REMOTE_PATH:-/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:\$HOME/.cargo/bin:\$PATH}"

# Both overrides are interpolated into shell source that runs on the REMOTE, so
# both are validated against an allowlist rather than quoted through bash → ssh
# → the remote shell. Same reasoning, same allowlist, as `second-instance.sh`.
case "$REMOTE_CHECKOUT" in
  ''|/*|*..*) echo "PAPER_REMOTE_CHECKOUT must be a relative path with no '..': '$REMOTE_CHECKOUT'" >&2; exit 2 ;;
  *[!A-Za-z0-9._/-]*) echo "PAPER_REMOTE_CHECKOUT may use only A-Za-z0-9._/- : '$REMOTE_CHECKOUT'" >&2; exit 2 ;;
esac
case "$REMOTE_PATH" in
  ''|*[!A-Za-z0-9._/:@\$\{\}-]*) echo "PAPER_REMOTE_PATH may use only letters, digits and . _ / : @ \$ { } - — got '$REMOTE_PATH'" >&2; exit 2 ;;
esac

# What this run creates. Fixed rather than random so a second run finds and
# reuses what a failed first run left, and `--clean` always names the same
# things.
readonly SCENARIO_BOOK='wi-11-7-book'
readonly SCENARIO_TAG='wi-11-7-tag'
readonly SCENARIO_TAG_RENAMED='wi-11-7-renamed'
readonly SCENARIO_CFI='epubcfi(/6/4!/4/2/1:0)'
readonly SCENARIO_NOTE='wi-11-7 note from the satchel'

remote=''
timeout_s=90
out=''
dry_run=0
clean=0

die() { echo "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --clean) clean=1 ;;
    --timeout)
      shift; [ $# -gt 0 ] || die '--timeout needs a number of seconds'
      # A POSITIVE DECIMAL, BOUNDED, WITH NO LEADING ZERO.
      #
      # `*[!0-9]*` alone let three values through that are not usable seconds.
      # `08` is digits, so it passed here and then failed far away inside
      # `$((...))`, where bash reads a leading zero as OCTAL and 8 is not an
      # octal digit — an argument error reported as an arithmetic one, in a
      # different step. `0` passed and makes every wait expire immediately, so
      # the run reports non-convergence it never waited for. And a
      # twenty-digit number overflows the comparison itself.
      case "$1" in
        ''|*[!0-9]*) die "--timeout takes seconds, not '$1'" ;;
        0*) die "--timeout takes a positive number of seconds without a leading zero, not '$1'" ;;
      esac
      [ "${#1}" -le 5 ] || die "--timeout is capped at 99999 seconds, not '$1'"
      timeout_s="$1" ;;
    --out)
      shift; [ $# -gt 0 ] || die '--out needs a path'
      out="$1" ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option '$1'" ;;
    *)
      [ -z "$remote" ] || die 'give exactly one <user@host>'
      remote="$1" ;;
  esac
  shift
done

[ -n "$remote" ] || die 'usage: scripts/sync-scenario.sh <user@host> [--timeout N] [--out FILE] [--dry-run] [--clean]'
# THE SHAPE, NOT ONLY THE ALPHABET.
#
# The allowlist below is what keeps a shell metacharacter out of a string that
# reaches `ssh` — that part was right. What it did not do is check the string
# is a `user@host` AT ALL: `localhost`, `@host`, `user@` and `a@b@c` are all
# spelled with permitted characters, and every one of them was accepted here
# and failed later inside ssh with a message about something else.
case "$remote" in
  *[!A-Za-z0-9._@-]*) die "the remote must look like user@host: '$remote'" ;;
esac
case "$remote" in
  *@*@*) die "the remote must look like user@host, with one @: '$remote'" ;;
  @*) die "the remote must look like user@host, and names no user: '$remote'" ;;
  *@) die "the remote must look like user@host, and names no host: '$remote'" ;;
  *@*) : ;;
  *) die "the remote must look like user@host: '$remote'" ;;
esac

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
[ -n "$out" ] || out="$REPO_ROOT/dev-docs/plans/evidence/wi-11-7-$stamp.md"
mkdir -p "$(dirname "$out")"
# TRUNCATED, not appended. `log` writes with `tee -a`, so an explicit `--out`
# pointed at a previous run's file quietly continued it — producing a document
# with two headers, two verdicts, and a claim at the top to be one run. The
# default name carries a timestamp, so nothing is lost by starting clean.
: > "$out"

failures=0
skipped=0
step_no=0

# Everything printed goes to the terminal AND to the transcript, so the
# evidence file is the run rather than a summary written about it.
log() { printf '%s\n' "$*" | tee -a "$out"; }
logf() { printf "$@" | tee -a "$out"; }

# One shelf-side command. The shelf is THIS machine.
shelf() { (cd "$REPO_ROOT" && ./bin/paper.mjs "$@"); }

# One satchel-side command, over ssh. `-o BatchMode=yes` so a missing key
# fails immediately instead of hanging on a password prompt in a harness that
# is supposed to run unattended.
satchel() {
  # EVERY ARGUMENT SINGLE-QUOTED, with embedded single quotes escaped the only
  # way a POSIX shell allows: close the quote, emit an escaped one, reopen.
  # The arguments here are this script's own constants today — but the whole
  # string is shell source the REMOTE evaluates, so "today's callers are safe"
  # is exactly the reasoning that makes tomorrow's caller an injection.
  local joined=''
  local one
  for one in "$@"; do
    joined="$joined '${one//\'/\'\\\'\'}'"
  done
  ssh -o BatchMode=yes "$remote" \
    "export PATH=\"$REMOTE_PATH\"; cd \"\$HOME/$REMOTE_CHECKOUT\" && ./bin/paper.mjs$joined"
}

# A step's outcome, in the transcript and in the exit code.
#
# THREE OUTCOMES, NOT TWO. `skip` exists because this scenario is a CHAIN: if
# the book never reaches the satchel, every later step there is unjudgeable,
# and two of them would otherwise report the wrong thing. "the satchel drops
# the removed book" converges on ABSENCE — which is trivially true of a book
# that never arrived — so the first run of this harness reported it as `ok`
# while proving nothing at all. A skipped step is not a failure and is not a
# pass; it is the harness saying it could not ask.
pass() { step_no=$((step_no + 1)); log "  ok   [$step_no] $*"; }
fail() { step_no=$((step_no + 1)); failures=$((failures + 1)); log "  FAIL [$step_no] $*"; }
skip() { step_no=$((step_no + 1)); skipped=$((skipped + 1)); log "  skip [$step_no] $*"; }

# One MUTATION, recorded either way.
#
# `set -e` is right for the preflight and wrong here: a `paper` that exits
# non-zero mid-scenario would end the script on the spot, with no verdict, no
# transcript tail and no named failure — which is the one thing this harness
# promises never to do. Wrapped, a failed mutation is a named failure and the
# run carries on to the verdict.
# ── the app, around a mutation ────────────────────────────────────────────
#
# WHY A MUTATION QUITS THE APP FIRST, which looks absurd for a sync test and
# is the only sequence that works.
#
# `paper` journals a write only when no Paper process holds the library: two
# processes appending to one `journal.jsonl` would corrupt `nextSeq` and the
# rev CAS, and the app cannot take the advisory lock that would prevent it.
# But replication is the APP's job — it owns the peer transport. So a CLI
# mutation that travels needs both, in order: write with the app down, then
# bring it up to push.
#
# And the satchel is the side that initiates (hello → push → pull, one
# bidirectional pass), so a restart there is what makes a round trip happen
# rather than waiting on a debounce that has no local commit to fire on.
#
# Measured by hand on two Macs before it was written here: add → 2 journal
# lines → both apps restarted → the book on the satchel in under 20 s, and
# the same for the removal.
# The running executable inside the bundle. `-f` and never `-x`: Tauri names
# it `app`, so `pgrep -x Paper` can never match — that mistake once reported
# the app closed on a machine where it was plainly running.
#
# DECLARED HERE, beside its first user. It used to sit with the preflight
# check that greps for it, several hundred lines below `app_quit` — and
# `set -u` turned the first mutation into `APP_PROCESS: unbound variable`.
readonly APP_PROCESS='Paper.app/Contents/MacOS/'
readonly APP_SETTLE_S="${PAPER_APP_SETTLE_S:-14}"

# QUIT THROUGH THE APP'S OWN MENU ITEM, not `quit app "Paper"`.
#
# They are not the same shutdown. An AppleScript `quit` goes straight to
# AppKit's terminate and the run loop reports only `RunEvent::Exit`, which
# cannot be deferred — the webview is destroyed mid-teardown, `journal.close()`
# never finishes, and `journal.dirty` is left up. That is indistinguishable
# from a crash, and the next launch re-verifies the whole shelf.
#
# The app's Quit item routes through `AppHandle::exit`, which DOES emit a
# deferrable `ExitRequested`; the app then waits for the webview to close the
# journal before exiting. Measured: the flag clears every time this way and
# never the other. So the harness quits the way a person does, and a run
# stays representative of what a reader's machine actually does.
readonly QUIT_VIA_MENU='tell application "System Events" to tell process "Paper" to click menu item "Quit Paper" of menu 1 of menu bar item 2 of menu bar 1'

app_quit() {
  case "$1" in
    shelf) osascript -e "$QUIT_VIA_MENU" >/dev/null 2>&1 || true; sleep 8
           pgrep -f "$APP_PROCESS" >/dev/null 2>&1 && { pkill -f "$APP_PROCESS" || true; sleep 3; } ;;
    satchel) ssh -o BatchMode=yes "$remote" \
               "osascript -e '$QUIT_VIA_MENU' >/dev/null 2>&1 || true; sleep 8; pgrep -f '$APP_PROCESS' >/dev/null 2>&1 && { pkill -f '$APP_PROCESS' || true; sleep 3; }; true" ;;
  esac
  return 0
}

# STARTED WITH `PAPER_ROLE`, and that is not decoration. A desktop is a SHELF
# unless the variable says otherwise, and the override is compiled out of
# release builds entirely (`role.rs`) — so a satchel must be a debug build
# launched with it. Deploying a release build to the satchel once silently
# demoted it, and pairing then failed with `expected Satchel, got Shelf`.
app_start() {
  case "$1" in
    shelf) open -a "${PAPER_SHELF_APP:-Paper}" >/dev/null 2>&1 || true ;;
    satchel) ssh -o BatchMode=yes "$remote" \
               "open --env PAPER_ROLE=satchel -a \"\$HOME/${PAPER_SATCHEL_APP:-Applications/Paper.app}\" >/dev/null 2>&1 || true" ;;
  esac
  sleep "$APP_SETTLE_S"
  return 0
}

# One bidirectional pass: the satchel syncs on start, so restarting it is the
# trigger. Cheaper than waiting out a debounce that may never fire.
sync_pass() { app_quit satchel; app_start satchel; }

mutate() {
  local what="$1"; shift
  # The side is the command word — `shelf` or `satchel` — so there is no
  # second list of which step runs where to keep in step with the first.
  local side="$1"
  # NAMED `said`, NOT `out`. `$out` is the TRANSCRIPT PATH, and `log` writes
  # with `tee -a "$out"` — so a local called `out` shadowed it and every log
  # line inside this function was appended to a file named after the command's
  # own output. The first real run left four such files in the repository
  # root, with names like `paper: mark.add: not-found: no book wi-11-7-book`,
  # and the transcript was missing every mutation step. A shell has no scoping
  # to catch that; only the name does.
  local said=''
  app_quit "$side"
  local rc=0
  said="$("$@" 2>&1)" || rc=$?
  app_start "$side"
  # The shelf's own restart does not make a round trip happen; the satchel is
  # the initiator, so it is restarted too. When the satchel IS the mutator its
  # own start already ran the pass.
  [ "$side" = shelf ] && sync_pass
  if [ "$rc" -eq 0 ]; then
    pass "$what"
    return 0
  fi
  fail "$what — the command failed: ${said:-<no output>}"
  return 1
}

# Wait until `$2` (a shell snippet) succeeds, or give up by name.
#
# POLLED rather than watched, because there is nothing to watch: the app's
# sync is a debounce and a session, and the only thing this script can observe
# is the other library's answer changing. The named failure carries the last
# answer, so a timeout says WHAT the other side thought rather than only that
# it disagreed.
converge() {
  local what="$1"; shift
  local deadline=$(( $(date +%s) + timeout_s ))
  local last=''
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if last="$("$@" 2>&1)"; then
      pass "$what"
      return 0
    fi
    sleep 3
  done
  # Trimmed to one line: the far side's answer can be a whole JSON row, and a
  # transcript is easier to read than it is to widen.
  fail "$what — did not converge in ${timeout_s}s; last answer: $(printf '%s' "${last:-<none>}" | tr '\n' ' ' | cut -c1-200)"
  return 1
}

# --- the predicates each step converges on -------------------------------
#
# Each is a command that exits 0 when the far side agrees. Every one reads
# `--json`, never the human table: a table's columns are chosen for a person
# and the CLI's own descriptor decides them, so a harness that matched on one
# would break the first time a column was widened or reordered. `grep` over
# the JSON rather than `jq`, because `jq` is not on a stock macOS and a
# harness that needs an install is a harness that does not run.

# NOT REDIRECTED TO /dev/null. `converge` captures each attempt's output and
# puts the LAST one in its failure message; a predicate that swallowed its own
# output produced "last answer: <none>", which is a named failure carrying no
# evidence — half a check. What `book get` prints on refusal is exactly what
# the operator needs to tell "not replicated yet" from "the ssh died".
satchel_has_book() { satchel book get "$SCENARIO_BOOK" --json 2>&1; }

# ABSENCE HAS TO BE PROVED, not inferred from a non-zero exit.
#
# `! paper book get …` is true for a dropped ssh connection, a remote crash and
# a mistyped host as readily as for a book that is gone — so a negation would
# report the removal as having travelled the moment the network hiccuped. The
# CLI answers a missing book with `not-found` by name and exits 1; anything
# else is a transport failure and must not count as convergence.
satchel_lacks_book() {
  # `said`, not `out` — see `mutate`.
  local said
  said="$(satchel book get "$SCENARIO_BOOK" --json 2>&1)" && { printf '%s\n' "$said"; return 1; }
  case "$said" in
    *"not-found"*) return 0 ;;
    *) printf '%s\n' "$said"; return 1 ;;
  esac
}

shelf_has_mark() {
  local said
  said="$(shelf mark list "$SCENARIO_BOOK" --json 2>&1)"
  case "$said" in
    *"$SCENARIO_NOTE"*) return 0 ;;
    *) printf '%s\n' "$said" | head -c 400; return 1 ;;
  esac
}

# THE LIVE TAG, parsed rather than grepped.
#
# Two failures, both of which passed. It once converged on `satchel_has_book`,
# which the step before had already made true — a predicate true before the
# mutation is a green light with nothing behind it. And grepping the JSON is
# no better: `book.get` answers a `BookDetail`, whose `tagClock` keeps a
# TOMBSTONE for every tag the book has ever carried, spelling included. A
# previous run's cleanup would make the grep match a tag that is switched off.
# `node` is already required on both machines, so the array is read properly.
has_live_tag() {
  local wanted="$1"
  satchel book get "$SCENARIO_BOOK" --json 2>/dev/null | node -e '
    let raw = ""
    process.stdin.on("data", (chunk) => (raw += chunk))
    process.stdin.on("end", () => {
      try {
        const tags = JSON.parse(raw).tags
        process.exit(Array.isArray(tags) && tags.includes(process.argv[1]) ? 0 : 1)
      } catch {
        process.exit(1)
      }
    })
  ' "$wanted"
}
# Each prints the tags it DID find on failure — `has_live_tag` returns only an
# exit code, so without this the timeout said `last answer: <none>`, which is
# the evidence-free failure the other predicates were already fixed for.
satchel_has_tag() { has_live_tag "$SCENARIO_TAG" || { satchel_tags; return 1; }; }
satchel_has_renamed_tag() { has_live_tag "$SCENARIO_TAG_RENAMED" || { satchel_tags; return 1; }; }
satchel_tags() { printf 'satchel tags: '; satchel book get "$SCENARIO_BOOK" --json 2>&1 | tr -d '\n' | cut -c1-200; }

# --- preflight -----------------------------------------------------------

log "# WI-11.7 — sync scenario over \`paper\`"
log ''
log "- run at: $stamp"
log "- shelf:  this machine, $REPO_ROOT"
log "- satchel: $remote:\$HOME/$REMOTE_CHECKOUT"
log "- timeout per convergence: ${timeout_s}s"
log ''
log 'THE APPS MUST BE RUNNING WITH THEIR WINDOWS UNHIDDEN ON BOTH MACHINES.'
log 'This script does not sync; it mutates one side and waits for the other to'
log 'agree. A hidden webview is THROTTLED to about 2 s — measured over four'
log 'minutes — which a 5 s debounce absorbs; an earlier claim that it stops'
log 'outright did not reproduce. Focus is NOT required; leave both'
log 'open and unobscured and walk away. Do not minimise either, and run both'
log 'under `caffeinate -d`: a display asleep is a separate state from a locked'
log 'screen, it is NOT checked below, and on a machine whose display sleeps'
log 'sooner than it locks it is what will end the run.'
log ''
log '## Preflight'

# CHECKED FIRST, and fatal on the spot. Everything after this reaches for
# `paper` — including the ssh call — and a preflight that carried on would
# spend an ssh round trip to discover a local problem it already knew about.
if [ ! -x "$REPO_ROOT/bin/paper.mjs" ]; then
  fail "no ./bin/paper.mjs here — run \`pnpm build:cli\` first"
  log ''
  log 'Preflight failed before anything was changed.'
  log "Transcript: $out"
  exit 1
fi
pass 'the shelf has a built paper'

if shelf_status="$(shelf shelf status --json 2>&1)"; then
  pass 'the shelf answers shelf.status'
  logf '\n```json\n%s\n```\n\n' "$shelf_status"
else
  fail "the shelf could not answer shelf.status: $shelf_status"
fi

if satchel_status="$(satchel shelf status --json 2>&1)"; then
  pass 'the satchel answers shelf.status over ssh'
  logf '\n```json\n%s\n```\n\n' "$satchel_status"
else
  fail "the satchel could not answer shelf.status: $satchel_status"
fi

# IS THE APP ACTUALLY RUNNING, on each side.
#
# This script does not sync — it mutates one library and waits for the other
# to agree — so with the app closed every convergence step times out. Without
# this check that costs `--timeout` seconds SIX TIMES over, and it costs it
# AFTER both libraries have been written to. Refusing here is the difference
# between a named failure in a second and a quarter of an hour of red that
# says nothing about the software.
#
# BY BUNDLE PATH, not by process name.
#
# The first version asked `pgrep -x Paper`, and that can never match: a Tauri
# bundle names its executable after the Cargo target, so the process is
# `Paper.app/Contents/MacOS/app`. The check therefore reported "not running"
# with the app plainly on screen — and it cost an hour of diagnosing a
# perfectly healthy install, up to and including re-signing a copy of it,
# before the process list was read rather than grepped. A guard that cannot
# succeed is worse than no guard: it does not merely fail to catch things, it
# manufactures failures and sends people after them.
#
# `-f` against the bundle path survives the executable being renamed, which is
# the thing that varies. FRONTMOST it still cannot answer: `lsappinfo` needs a
# session an ssh login does not have, and WI-8.6 measured that raising a
# window over ssh does not work either. So the window stays an operator
# precondition, stated loudly above and not pretended to be checked here.
# AND IS THE SCREEN UNLOCKED — the check this harness most needed and did not
# have. A locked screen suspends the webview exactly as an occluded window
# does: `document.visibilityState` goes `hidden`, WebKit stops its timers, and
# the sync debounce never fires. The first real run against two machines spent
# six convergence timeouts on precisely that, and the app was RUNNING on both,
# so every other signal said go.
#
# `second-instance.sh` already refuses against a locked screen and this is its
# reading, kept identical on purpose: the `CGSSessionScreenIsLocked` key out of
# `ioreg -n Root`, with the key ABSENT meaning a session that has never locked,
# and an unreadable answer refused rather than assumed unlocked.
screen_lock_state() {
  local probe='
    if ioreg_out=$(ioreg -n Root -d1 -a 2>/dev/null); then
      case "$ioreg_out" in
        *CGSSessionScreenIsLocked*)
          lock=$(printf "%s" "$ioreg_out" | grep -A1 CGSSessionScreenIsLocked)
          case "$lock" in (*true*) echo yes ;; (*false*) echo no ;; (*) echo unknown ;; esac ;;
        *) echo no ;;
      esac
    else
      echo unknown
    fi'
  if [ "$1" = local ]; then sh -c "$probe"; else ssh -o BatchMode=yes "$remote" "$probe"; fi
}

for side in local remote; do
  where=$([ "$side" = local ] && echo 'this machine' || echo "$remote")
  case "$(screen_lock_state "$side")" in
    no) pass "the screen is unlocked on $where" ;;
    yes) fail "the screen is LOCKED on $where — the webview is suspended behind it and nothing will sync. Unlock it at that Mac." ;;
    *) fail "the screen's lock state on $where could not be read — refused rather than assumed unlocked" ;;
  esac
done

# AND CAN A CLI WRITE REPLICATE AT ALL — the precondition this whole harness
# rests on, and the one it did not check.
#
# MEASURED, 2026-08-21, on two real machines with both screens unlocked and
# both apps frontmost: `paper book add` puts the folder on disk and the sync
# journal records NOTHING. `paper` does not compose the sync capability, so
# its writes never enter the journal — and replication is a journal feed, so a
# change the journal never saw is a change that can never travel. Both runs
# spent every convergence step waiting for something that could not happen.
#
# This is the documented limitation of WI-11.5 (`dev-docs/cli.md`, "the part the
# lock does not cover"), reaching further than the doc claimed: not merely
# "the app may not notice", but "a CLI mutation cannot replicate, ever".
#
# The probe writes one scratch book, asks the journal, and removes it. If the
# journal did not see it, every convergence below is doomed and the run says
# so in a second rather than in six timeouts.
readonly SYNC_DIR_LOCAL="$HOME/Library/Application Support/one.paper.reader/sync"
readonly JOURNAL_FILE="$SYNC_DIR_LOCAL/journal.jsonl"
readonly DIRTY_FILE="$SYNC_DIR_LOCAL/journal.dirty"
readonly PEERS_FILE="$HOME/Library/Application Support/one.paper.reader/peer/peers.json"
readonly PROBE_BOOK='wi-11-7-journal-probe'

# THE FIRST PRECONDITION: a CLI write must reach the journal, or nothing it
# does can replicate. `paper` binds the sync journal at `bindRecorder` now
# (WI-11.7), but only when `journal.dirty` is DOWN — a live journal always has
# it up, and two writers on one `journal.jsonl` would corrupt `nextSeq` and the
# rev CAS. So the probe reports WHICH of the two it is; they need different
# things done about them.
probe_journaling() {
  # THE REAL SEQUENCE, not a proxy for it. `paper` journals only when no Paper
  # process holds the library, so the probe does what every mutation below
  # does: take the app down, write, look, put it back. A probe that instead
  # read `journal.dirty` and refused would be testing a flag that is up on
  # every machine the app has ever run — it would refuse always, and it did.
  app_quit shelf
  local before=0 after=0 seen=0
  [ -f "$JOURNAL_FILE" ] && before=$(wc -c < "$JOURNAL_FILE" | tr -d ' ')
  shelf book add "$PROBE_BOOK" 'journal probe' >/dev/null 2>&1 || true
  [ -f "$JOURNAL_FILE" ] && after=$(wc -c < "$JOURNAL_FILE" | tr -d ' ')
  [ -f "$JOURNAL_FILE" ] && seen=$(grep -c "$PROBE_BOOK" "$JOURNAL_FILE" 2>/dev/null || echo 0)
  shelf book remove "$PROBE_BOOK" >/dev/null 2>&1 || true
  rm -rf "$HOME/Library/Application Support/one.paper.reader/trash/wi_11_7_journal_probe"
  app_start shelf
  if [ "$seen" -gt 0 ]; then
    pass "a CLI write reaches the sync journal ($before -> $after bytes), so it can replicate"
  else
    fail 'a CLI write did NOT reach the sync journal, so nothing below can replicate. `paper` binds the journal only when no Paper process holds it — see WI-11.7 in dev-docs/plans/phase-11-service-api.md.'
  fi
}
probe_journaling

# THE SECOND PRECONDITION, and the one that cost this scenario two full runs
# before anybody checked it: THE TWO MACHINES MUST ACTUALLY BE IN CONTACT.
#
# Every convergence step below waits on replication, and replication needs a
# peer session. `peers.json` records `lastSeenAt` per peer, so the question is
# answerable in a millisecond from a file — and on 2026-08-21 it answered
# "thirty-nine hours ago", with both apps running, both frontmost, both
# screens unlocked and both machines on one LAN. Six sixty-second timeouts
# cannot tell you that; one field can.
#
# Fifteen minutes is deliberately loose. This is not measuring freshness, it
# is separating "these two talk" from "these two have not talked since
# yesterday", and a satchel that synced ten minutes ago will sync again.
readonly CONTACT_MAX_S=900
probe_contact() {
  if [ ! -f "$PEERS_FILE" ]; then
    fail 'no peer records on the shelf — the two machines have never been paired'
    return
  fi
  # CAPTURED WITHOUT TRIPPING `set -e`. A bare `said=$(...)` is a simple
  # command, so a non-zero exit inside the substitution ends the whole script —
  # which it did, silently, after this probe's first failure: the run stopped
  # mid-preflight with two checks never reported. `|| rc=$?` is the difference
  # between a refusal that names everything wrong and one that stops at the
  # first thing wrong.
  local said rc=0
  said=$(/usr/bin/python3 - "$PEERS_FILE" "$CONTACT_MAX_S" <<'PYEOF' 2>&1
import json, sys, time
try:
    peers = json.load(open(sys.argv[1])).get('peers') or []
except Exception as exc:
    print('unreadable: %s' % exc); sys.exit(2)
if not peers:
    print('no peers are paired'); sys.exit(2)
newest = max(p.get('lastSeenAt') or 0 for p in peers)
if newest == 0:
    print('paired, but never seen'); sys.exit(2)
ago = time.time() - newest / 1000
stamp = time.strftime('%Y-%m-%d %H:%M', time.localtime(newest / 1000))
print('last contact %s (%d minutes ago)' % (stamp, ago // 60))
sys.exit(0 if ago <= float(sys.argv[2]) else 2)
PYEOF
) || rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "the two machines are in contact — $said"
  else
    fail "the machines are NOT in contact: $said. Nothing can converge until a peer session is established; this is a network or pairing problem, not a Paper one."
  fi
}
probe_contact

if pgrep -f "$APP_PROCESS" >/dev/null 2>&1; then
  pass 'Paper is running on the shelf'
else
  fail 'Paper is NOT running on this machine — nothing will replicate, and every step below would time out'
fi
if ssh -o BatchMode=yes "$remote" "pgrep -f '$APP_PROCESS' >/dev/null 2>&1"; then
  pass 'Paper is running on the satchel'
else
  fail "Paper is NOT running on $remote — nothing will replicate, and every step below would time out"
fi

if [ "$failures" -gt 0 ]; then
  log ''
  log "Preflight failed with $failures problem(s); nothing was changed."
  log "Transcript: $out"
  exit 1
fi

if [ "$clean" -eq 1 ]; then
  log ''
  log '## Clean'
  shelf tag remove "$SCENARIO_TAG" >/dev/null 2>&1 || true
  shelf tag remove "$SCENARIO_TAG_RENAMED" >/dev/null 2>&1 || true
  shelf book remove "$SCENARIO_BOOK" >/dev/null 2>&1 || true
  satchel book remove "$SCENARIO_BOOK" >/dev/null 2>&1 || true
  log '  removed this scenario’s book and tags from both sides.'
  log "Transcript: $out"
  exit 0
fi

if [ "$dry_run" -eq 1 ]; then
  log ''
  log 'Dry run: both ends answer. Nothing was changed.'
  log "Transcript: $out"
  exit 0
fi

# --- the scenario --------------------------------------------------------
#
# The order is WI-8.6's "Still owed" list, minus the parts that are genuinely
# a human's or a window's: pairing (a SAS two people read aloud), reading a
# downloaded book, and the Local-only packet capture, which K.11 owns and
# which a passing "it still syncs" would not test.

log ''
log '## Cold read — both catalogues, after a relaunch'

shelf_books="$(shelf book list --json | grep -c '"bookId"' || true)"
satchel_books="$(satchel book list --json | grep -c '"bookId"' || true)"
log "  shelf: $shelf_books books · satchel: $satchel_books books"
if [ "$shelf_books" -gt 0 ] && [ "$satchel_books" -gt 0 ]; then
  pass 'both libraries read from a cold process'
else
  fail "a library read as empty — shelf $shelf_books, satchel $satchel_books"
fi

log ''
log '## A book added on the shelf travels to the satchel'

mutate 'the shelf adds the scenario book' shelf book add "$SCENARIO_BOOK" 'WI-11.7 scenario book' 'The Harness' || true
satchel_saw_book=0
if converge 'the satchel sees the new book' satchel_has_book; then satchel_saw_book=1; fi

log ''
log '## A highlight made on the satchel travels to the shelf'

mutate 'the satchel makes a highlight' satchel mark add "$SCENARIO_BOOK" "$SCENARIO_CFI" 'a marked passage' --note "$SCENARIO_NOTE" || true
converge 'the shelf sees the satchel’s mark' shelf_has_mark || true

log ''
log '## A tag rename on the shelf fans out'

mutate 'the shelf tags the book' shelf tag add "$SCENARIO_TAG" --book "$SCENARIO_BOOK" || true
converge 'the satchel sees the tag' satchel_has_tag || true
mutate 'the shelf renames the tag' shelf tag rename "$SCENARIO_TAG" "$SCENARIO_TAG_RENAMED" || true
converge 'the satchel sees the renamed tag' satchel_has_renamed_tag || true

log ''
log '## A removal travels'

mutate 'the shelf removes the book' shelf book remove "$SCENARIO_BOOK" || true
# ONLY IF IT EVER ARRIVED. Absence is trivially true of a book the satchel
# never had, so without this the step passes hardest exactly when the
# scenario has failed worst.
if [ "$satchel_saw_book" -eq 1 ]; then
  converge 'the satchel drops the removed book' satchel_lacks_book || true
else
  skip 'the satchel drops the removed book — it never received it, so absence proves nothing'
fi

log ''
log '## The hub edits, then goes quiet'
#
# The property is that a settled pair pushes NOTHING: after the removal has
# converged, neither side's journal should grow again with nothing editing it.
# It is the cheapest observable form of "the next session pushes nothing", and
# it is the one this harness can take without a packet capture.

# THE JOURNAL FILE, not `shelf.status`.
#
# The obvious version of this step read the sequence number out of
# `shelf.status`, and it could never have passed: `paper` does not compose the
# sync capability, so that field is `null` in every CLI answer on every
# machine. Two nulls compare equal, so the first draft reported quiet without
# reading anything — and the fix that demanded a NUMBER turned it into a step
# that can only ever fail. Neither is a test.
#
# What the harness CAN observe is the file the journal appends to. Its size
# not moving across a quiet window is the same claim — nothing was committed —
# taken from the thing that would actually move. Read on both machines,
# because "the pair has settled" is a fact about both.
#
# The path is the app's own data directory and is NOT overridable: the app
# resolves `BaseDirectory.AppData` and ignores `PAPER_DATA_DIR` (see the
# header). Hard-coding it here states that rather than assuming it.
readonly JOURNAL='Library/Application Support/one.paper.reader/sync/journal.jsonl'
shelf_journal_size() { wc -c < "$HOME/$JOURNAL" 2>/dev/null || echo missing; }
satchel_journal_size() { ssh -o BatchMode=yes "$remote" "wc -c < \"\$HOME/$JOURNAL\" 2>/dev/null || echo missing"; }

first_shelf="$(shelf_journal_size | tr -d ' ')"
first_satchel="$(satchel_journal_size | tr -d ' ')"
sleep 10
second_shelf="$(shelf_journal_size | tr -d ' ')"
second_satchel="$(satchel_journal_size | tr -d ' ')"
if [ "$first_shelf" = missing ] || [ "$first_satchel" = missing ]; then
  fail "a journal file is missing — shelf=$first_shelf satchel=$first_satchel; this pair has never synced"
elif [ "$first_shelf" = "$second_shelf" ] && [ "$first_satchel" = "$second_satchel" ]; then
  pass "both journals are unchanged over 10 quiet seconds (shelf $first_shelf B, satchel $first_satchel B)"
else
  fail "a journal grew while nothing was editing: shelf $first_shelf->$second_shelf, satchel $first_satchel->$second_satchel"
fi

# --- the verdict ---------------------------------------------------------

log ''
log '## Verdict'
if [ "$failures" -eq 0 ] && [ "$skipped" -eq 0 ]; then
  log "  PASS — $step_no steps, 0 failures."
elif [ "$failures" -eq 0 ]; then
  # SKIPS ARE NOT A PASS. Every step ran that could, and some could not be
  # asked — which is a different answer from "the pair replicates", and the
  # exit code says so.
  log "  INCOMPLETE — $step_no steps, 0 failures, $skipped could not be judged. Named above."
else
  log "  FAIL — $step_no steps, $failures failure(s)$([ "$skipped" -gt 0 ] && echo ", $skipped skipped"). Each is named above."
fi
log ''
log "Transcript: $out"
[ "$failures" -eq 0 ] && [ "$skipped" -eq 0 ]

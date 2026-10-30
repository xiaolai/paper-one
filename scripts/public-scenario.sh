#!/usr/bin/env bash
#
# The public layer, across two machines — the run the ledger says has never
# happened.
#
# WHY THIS EXISTS. Every row of `dev-docs/feature-ledger.md`'s "The public
# layer" section is evidenced by tests in ONE PROCESS. For the transport that
# means two live iroh endpoints inside `share/acceptance.rs`, which is real
# evidence about the protocol and none at all about the app. Part 4 named this
# as its first-ranked gap, and noted it was the THIRD time a gap of exactly
# this shape had appeared: sync's convergence and the circle's first crossing
# were both blocked by an absent harness run rather than by absent code, and
# both produced a real defect the day somebody ran them.
#
# ## ⚠️ THE FIRST WORK ITEM WAS NOT THIS SCRIPT
#
# `ShareConfig::for_app` hardcoded `dht: true`, so the very first thing an
# end-to-end run would do is announce a real machine, against a real book's
# content hash, into a global and permanently queryable index. `AGENTS.md` has
# a whole section forbidding `cargo test` from touching the real DHT — and the
# app gave a harness no way to obey the same rule. `PAPER_TEST_NO_DHT` is that
# way, debug builds only, on `PAPER_TEST_DATA_DIR`'s precedent.
#
# ⚠️ **AND THIS SCRIPT DOES NOT TRUST IT.** A missing or misspelled variable
# announces, because the default must be what a reader gets. So the plugin LOGS
# the resolved state and the preflight below greps `Paper.log` for `dht=off` on
# BOTH machines and refuses to press Offer without it. A flag nobody reads back
# is a flag that is assumed, and this one cannot be undone.
#
# ⚠️ **AND THE LINE IS LOGGED AT PLUGIN INIT, NOT AT `ShareNode::start`, WHICH
# IS A DISTINCTION THIS SCRIPT PAID FOR.** The share endpoint starts LAZILY, on
# the first command that offers or resolves — and the Publish pane renders its
# whole state without starting it. So the only line available came AFTER the
# very act the gate exists to prevent. Measured 2026-09-11 while building this
# file: the pane reported `not-offered` / `not-published` correctly and the log
# held nothing. A gate that can only be read after the irreversible step is not
# a gate.
#
# ## ⚠️ WHAT THIS SCRIPT DOES NOT DO
#
# IT DOES NOT WRITE `public.jsonl`. Every mutation goes through the app's own
# UI over the MCP bridge (`public-drive.mjs`), because a public annotation is
# SIGNED by the voice key and only the app can sign one. A harness that wrote
# the store itself would be testing its own JSON writer — `circle-drive.mjs`
# states the same rule and is the reason this one has the shape it has.
#
# ## ⚠️ BOTH MACHINES NEED THE SAME BOOK, BY BYTES
#
# The network name is the content hash, so a book that differs by one byte is a
# different book to this layer. The preflight compares digests rather than
# titles. On the pair this was written against, three books of 1 962 hold bytes
# on both ends.
#
# Usage:
#   scripts/public-scenario.sh <user@host> --title <book title>
#                              [--far-port N] [--port N] [--timeout SECONDS]
#                              [--falsify]
#
# `--far-port` is the local end of a tunnel to the far machine's bridge:
#   ssh -N -L 31416:127.0.0.1:31415 <user@host>
#
set -uo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DATA_DIR='Library/Application Support/one.paper.reader'

die() { echo "$*" >&2; exit 2; }

# ── arguments ──────────────────────────────────────────────────────────────

remote=''
title=''
port=31415
far_port=''
timeout=120
falsify=no

while [ $# -gt 0 ]; do
  case "$1" in
    --title)    title="${2:-}"; shift 2 || die 'usage: --title <book title>' ;;
    --port)     port="${2:-}"; shift 2 || die 'usage: --port N' ;;
    --far-port) far_port="${2:-}"; shift 2 || die 'usage: --far-port N' ;;
    --timeout)  timeout="${2:-}"; shift 2 || die 'usage: --timeout SECONDS' ;;
    --falsify)  falsify=yes; shift ;;
    -*)         die "unknown argument '$1'" ;;
    *)          [ -z "$remote" ] || die 'give exactly one <user@host>'; remote="$1"; shift ;;
  esac
done

[ -n "$remote" ] || die 'usage: scripts/public-scenario.sh <user@host> --title <book title> [--far-port N]'
[ -n "$title" ]  || die '--title <book title> is required: the network name is the content hash, so the run needs one named book'
[ -n "$far_port" ] || die "--far-port N is required: the far end must be DRIVEN to ask, because asking is on a control and never on a timer. Tunnel its bridge first:
  ssh -N -L 31416:127.0.0.1:31415 $remote"

case "$remote" in
  *@*) : ;;
  *) die "'$remote' is not a user@host" ;;
esac
case "$port$far_port$timeout" in
  *[!0-9]*) die 'ports and the timeout must be numbers' ;;
esac

# ── reporting ──────────────────────────────────────────────────────────────

steps=0
failures=0
pass() { steps=$((steps + 1)); printf 'ok   [%02d] %s\n' "$steps" "$1"; }
fail() { steps=$((steps + 1)); failures=$((failures + 1)); printf 'FAIL [%02d] %s\n' "$steps" "$1"; }
note() { printf '     %s\n' "$1"; }

remote_sh() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 "$remote" "$@"
}

here() { node "$REPO_ROOT/scripts/public-drive.mjs" "$@" --port "$port"; }
there() { node "$REPO_ROOT/scripts/public-drive.mjs" "$@" --port "$far_port"; }

# `sync-scenario.sh`'s reading, unchanged on purpose: the key ABSENT means a
# session that has never locked, and an unreadable answer is REFUSED rather
# than assumed unlocked. A one-line `grep -q ...=Yes` fails OPEN on both.
readonly LOCK_PROBE='
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

echo "public-scenario: $remote, book $(printf '%q' "$title")"
echo

# ── preflight ──────────────────────────────────────────────────────────────

for side in local remote; do
  where=$([ "$side" = local ] && echo 'this machine' || echo "$remote")
  state=$([ "$side" = local ] && sh -c "$LOCK_PROBE" || remote_sh "$LOCK_PROBE")
  case "$state" in
    no)  pass "the screen is unlocked on $where" ;;
    yes) fail "the screen is LOCKED on $where — the webview is suspended behind it and nothing will happen. Unlock it at that Mac." ;;
    *)   fail "the screen's lock state on $where could not be read — refused rather than assumed unlocked" ;;
  esac
done

# ⚠️ `pgrep -x app`, and neither `-x Paper` nor `-f <path>`. The executable is
# `Paper.app/Contents/MacOS/app`, so `-x Paper` matches NOTHING and reports a
# stopped app whether or not one is running.
if pgrep -x app >/dev/null 2>&1; then pass 'Paper is running on this machine'
else fail 'Paper is not running on this machine'; fi
if remote_sh 'pgrep -x app' >/dev/null 2>&1; then pass "Paper is running on $remote"
else fail "Paper is not running on $remote"; fi

# ⚠️ THE ANNOUNCE GATE. Read back from the RUNNING PROCESS, never assumed.
#
# ⚠️ **THIS GREPPED `Paper.log` FOR ONE RUN AND THAT WAS WRONG.** The plugin
# logs `peer: share endpoint dht=off` at boot and the line is real — but
# `tauri_plugin_log` ROTATES BY SIZE, and iroh logs at INFO so heavily that the
# boot line had aged out of a 124 KB file within SEVEN MINUTES. `AGENTS.md`
# says the log is "TRUNCATED AT EACH LAUNCH", which is true and not the whole
# truth; measured 2026-09-11, the far end's second run failed this gate against
# a process that had been started correctly and was still running.
#
# The process ENVIRONMENT is the ground truth: it is what `ShareConfig::for_app`
# reads, it cannot rotate away, and `ps eww` shows it over ssh. The log line
# stays in the app as corroboration for anyone reading a transcript.
announcing_state() {
  local probe='
    pid=$(pgrep -x app | head -1)
    [ -n "$pid" ] || { echo no-app; exit 0; }
    if ps eww -p "$pid" | tr " " "\n" | grep -q "^PAPER_TEST_NO_DHT="; then echo off; else echo on; fi'
  if [ "$1" = local ]; then sh -c "$probe"; else remote_sh "$probe"; fi
}

for side in local remote; do
  where=$([ "$side" = local ] && echo 'this machine' || echo "$remote")
  case "$(announcing_state "$side")" in
    off) pass "the share endpoint on $where is NOT announcing (PAPER_TEST_NO_DHT is set on the running process)" ;;
    on)  fail "the app on $where was NOT started with PAPER_TEST_NO_DHT — it will announce to the global DHT, which cannot be undone. Quit it and relaunch with:
       open --env PAPER_TEST_NO_DHT=1 ~/Applications/Paper.app" ;;
    *)   fail "no running app on $where to read an environment from" ;;
  esac
done

# ⚠️ THE BOOK MUST BE THE SAME BYTES, because the network name is its hash.
# ⚠️ **THE TITLE IS DATA, AND IT USED TO BE SOURCE.** It was interpolated
# straight into the probe here and into `arrived_probe` below, on both machines
# — so a book called `a$(rm -rf ~)b` executed, locally and over ssh. An
# independent audit reproduced it on 2026-09-11. It now travels as a positional
# argument, which no shell re-parses, and the remote side is given it the same
# way rather than spliced into the command string.
readonly TITLE_PROBE='
  want="$1"; root="$2"
  for d in "$root"/books/*/; do
    t=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[\"title\"])" "$d/book.json" 2>/dev/null) || continue
    [ "$t" = "$want" ] || continue
    f=$(ls "$d"/content.* 2>/dev/null | head -1) || continue
    [ -n "$f" ] && shasum -a 256 "$f" | cut -d" " -f1
  done'

digest_of() {
  if [ "$1" = local ]; then
    sh -c "$TITLE_PROBE" _ "$title" "$HOME/$DATA_DIR"
  else
    # `ssh host sh -s -- ARGS` sends the script on stdin and the arguments as
    # argv; nothing is concatenated, so nothing is re-parsed.
    printf '%s' "$TITLE_PROBE" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$remote" \
      "sh -s -- $(printf '%q' "$title") \"\$HOME/$DATA_DIR\""
  fi
}
# The book's CONTENT HASH — its name on this network, and not the same thing as
# the digest above. The digest proves the two copies are the same bytes; this is
# what the layer files records under, and the run needs it to read the
# publisher's own store.
hash=$(python3 - "$HOME/$DATA_DIR/books" "$title" <<'PY_HASH'
import json, pathlib, sys
root, want = pathlib.Path(sys.argv[1]), sys.argv[2]
for folder in root.iterdir():
    try:
        record = json.loads((folder / 'book.json').read_text())
    except Exception:
        continue
    if record.get('title') == want and record.get('contentHash'):
        print(record['contentHash'])
        break
PY_HASH
)

mine=$(digest_of local)
theirs=$(digest_of remote)
if [ -z "$mine" ]; then
  fail "this machine holds no bytes for a book titled $(printf '%q' "$title") — the layer can only offer a file it has"
elif [ -z "$theirs" ]; then
  fail "$remote holds no bytes for that title — it would be asking about a hash it cannot compute"
elif [ "$mine" != "$theirs" ]; then
  fail "the two copies differ by bytes, so they are different books to this layer: ${mine:0:16}… here, ${theirs:0:16}… there"
else
  pass "both machines hold the same bytes for that book (${mine:0:16}…)"
fi

if [ "$failures" -gt 0 ]; then
  echo
  echo "public-scenario: $failures of $steps preflight steps failed — refusing to run"
  exit 1
fi

# ── the run ────────────────────────────────────────────────────────────────

# ⚠️ `--falsify` STOPS THE FAR END FIRST, and the converge step below must then
# FAIL. A harness that has never seen its own assertion fail is asserting a
# file it wrote itself — WI-8.6's first run did exactly that and read the
# result as a pass.
if [ "$falsify" = yes ]; then
  remote_sh 'osascript -e '"'"'tell application "System Events" to tell process "app" to click menu item "Quit Paper" of menu 1 of menu bar item 2 of menu bar 1'"'"'' >/dev/null 2>&1
  sleep 6
  if remote_sh 'pgrep -x app' >/dev/null 2>&1; then
    note 'the far app did not quit for --falsify; the negative below proves less than it claims'
  else
    pass '--falsify: the far app is stopped, so the converge step below MUST fail'
  fi
  # ⚠️ **A HARNESS THAT STOPS AN APP MUST START BOTH AGAIN** — AGENTS.md, and it
  # is not optional: the peer session does not survive one end vanishing, and
  # the end that KEPT RUNNING holds the dead session indefinitely. This ran
  # without it and left the pair for a human to repair by hand.
  # ⚠️ **THE RESTART CARRIES THE NO-ANNOUNCE FLAG, AND THE FIRST VERSION OF
  # THIS TRAP DID NOT.** `PAPER_TEST_NO_DHT` is a per-LAUNCH override, so an
  # app restarted without it comes back ANNOUNCING — and `resume_share` reads
  # the persisted offers and republishes them. A cleanup step that undoes the
  # gate the whole script exists to enforce is worse than no cleanup. Found by
  # the verification pass on this very fix, 2026-09-11.
  #
  # It also REPORTS rather than claims: a restart that did not take is said so,
  # because "restarted both" printed unconditionally is the same always-success
  # shape this file refuses everywhere else.
  restore_both() {
    remote_sh 'open --env PAPER_TEST_NO_DHT=1 ~/Applications/Paper.app' >/dev/null 2>&1
    osascript -e 'tell application "System Events" to tell process "app" to click menu item "Quit Paper" of menu 1 of menu bar item 2 of menu bar 1' >/dev/null 2>&1
    sleep 5
    open --env PAPER_TEST_NO_DHT=1 ~/Applications/Paper.app >/dev/null 2>&1
    sleep 8
    local here_up=no there_up=no
    pgrep -x app >/dev/null 2>&1 && here_up=yes
    remote_sh 'pgrep -x app' >/dev/null 2>&1 && there_up=yes
    if [ "$here_up" = yes ] && [ "$there_up" = yes ]; then
      echo "     --falsify: restarted BOTH apps with announcing off"
    else
      echo "     --falsify: RESTART INCOMPLETE (this machine: $here_up, $remote: $there_up) — the peer session does not survive one end vanishing; restart by hand"
    fi
  }
  trap restore_both EXIT
fi

run() {
  local what="$1"; shift
  local out
  out="$("$@" 2>&1)"
  local rc=$?
  if [ $rc -eq 0 ]; then
    pass "$what"
    note "$(printf '%s' "$out" | tail -1 | cut -c1-200)"
  else
    fail "$what"
    note "$(printf '%s' "$out" | tail -2 | cut -c1-400)"
  fi
  return $rc
}

# ⚠️ **NOTES BEFORE THE PASSAGE, AND THE ORDER IS NOT COSMETIC.** `Publish
# notes` offers the SERVICE; `say` publishes one passage INTO it. The first run
# of this file had them the other way round and the passage step failed with a
# bare timeout — the same passage published in under two seconds once the
# service existed. Driven by hand to confirm the control itself was sound.
# ⚠️ **READ BEFORE THE ACT, WHICH IS WHERE THIS WAS NOT.** The far end's
# count was captured AFTER its own fetch step, so a delivery that had just
# happened was counted as "already held" and every run reported "converged,
# nothing new to carry" — including one where the store had been deleted
# seconds earlier and genuinely refilled. A before-and-after that reads
# `before` after the after is not a measurement.
# Same rule as `TITLE_PROBE`: the title is argv, never source.
readonly ARRIVED_PROBE='
  want="$1"; root="$2"; found=no
  # ⚠️ **AN UNREADABLE ROOT IS NOT AN EMPTY ONE.** A missing or unreadable
  # library answered "no", which the caller read as zero — and zero satisfies
  # --falsify. Named so the caller can refuse it.
  [ -d "$root/books" ] || { echo unreadable; exit 0; }
  command -v python3 >/dev/null 2>&1 || { echo unreadable; exit 0; }
  for d in "$root"/books/*/; do
    t=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[\"title\"])" "$d/book.json" 2>/dev/null) || continue
    [ "$t" = "$want" ] || continue
    if [ -s "$d/public.jsonl" ]; then found=$(wc -l < "$d/public.jsonl" | tr -d " "); fi
  done
  echo "$found"'

far_count() {
  printf '%s' "$ARRIVED_PROBE" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$remote" \
    "sh -s -- $(printf '%q' "$title") \"\$HOME/$DATA_DIR\"" 2>/dev/null | tail -1
}

# ⚠️ **A COUNT THAT COULD NOT BE READ IS NOT ZERO.** An ssh failure, a changed
# path or a python that would not run all became `0`, and under `--falsify`
# that is a PASS — the control reporting success precisely when it learned
# nothing. Fails closed now: unreadable is a named failure, not a number.
before=$(far_count)
case "$before" in
  no) before=0 ;;
  unreadable) fail "$remote's library could not be read at all — refusing to treat it as empty"; before='' ;;
  ''|*[!0-9]*) fail "could not read $remote's public record count — refusing to treat an unreadable far end as an empty one"; before='' ;;
esac

# ⚠️ **CONVERGENCE IS THE ASSERTION, NOT GROWTH — AND "GREW" WAS WRONG TWICE.**
# First it was "the file exists", which passes forever after one good run. Then
# it was "the count went up", which fails on a REPEAT run for a reason that is
# not a defect: `PublishControl`'s "Published." is React state, so after a
# relaunch every control offers to publish again, `say` re-publishes a passage
# the store already holds, and the publisher dedupes it. Both ends then sit at
# the same number and nothing is wrong.
#
# What must be true either way is that the far end ends up holding what this
# machine SERVES. Read from the publisher's own store, so the target is a fact
# rather than this script's arithmetic.

run 'this machine opened the book'                here open  --title "$title"
run 'this machine offered the file itself'        here offer --title "$title"
run 'this machine published the notes about it'   here notes --title "$title"
run 'this machine published a passage'            here say   --title "$title"
# ⚠️ **UNDER `--falsify` THE FAR STEPS ARE EXPECTED TO FAIL, AND COUNTING THEM
# AS FAILURES MADE THE NEGATIVE CONTROL USELESS.** With the far app stopped the
# driver cannot connect, so the run always exited 1 and a REAL failure was
# indistinguishable from the control working. Measured by running it.
run_far() {
  local what="$1"; shift
  if [ "$falsify" = yes ]; then
    local out; out="$("$@" 2>&1)"
    if [ $? -eq 0 ]; then
      fail "--falsify: \"$what\" SUCCEEDED against a stopped app — the far end is not stopped, so the control proves nothing"
    else
      pass "--falsify: \"$what\" could not reach the stopped far end, as it must not"
    fi
    return 0
  fi
  run "$what" "$@"
}

run_far "$remote opened the same book"            there open --title "$title"

# ⚠️ **THE FAR END IS TOLD WHO TO ASK, AND THAT IS THE ONLY ROUTE THERE IS.**
# `resolve` is the DHT and nothing else turns a content hash into a provider, so
# with announcing off an un-named ask reaches nobody — measured 2026-09-11, this
# harness's first run failed exactly there with every other step green. The id
# is read off the publisher's own pane rather than computed here, so what the
# far end is given is what this machine actually shows a reader.
mine="$(here whoami --title "$title" 2>/dev/null | tail -1 | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
if [ -n "$mine" ]; then
  pass "this machine says it can be asked at ${mine:0:16}…"
else
  fail 'this machine would not say where it can be asked — without it the far end has only the index, which is the DHT'
fi
run_far "$remote asked for other people's notes"  there look --title "$title" --at "$mine"

# ── did it arrive ──────────────────────────────────────────────────────────
#
# Read from the STORE, not from the driver. The pane reports what ARRIVED; the
# store is what the app actually kept and what the overlay draws from, and the
# two are deliberately different numbers — a record can be refused for a bad
# signature, an expiry or a silenced voice.


# ⚠️ **A COUNT THAT MUST INCREASE, NOT A FILE THAT MUST EXIST.** The first
# version asserted `public.jsonl` was absent or empty, which is true exactly
# once: the run after a successful one finds the PREVIOUS run's records and
# calls them today's. Worse, `--falsify` then reports a pass for a far end that
# was stopped before it could receive anything — the harness's own negative
# control, inverted. Caught by running the positive twice.

served=$(wc -l < "$HOME/$DATA_DIR/peer/share/notes/${hash}.jsonl" 2>/dev/null | tr -d ' ')
case "$served" in ''|*[!0-9]*) served=0 ;; esac
note "this machine serves $served record(s); the far end held $before before this run"

deadline=$(( $(date +%s) + timeout ))
got="$before"
while [ "$(date +%s)" -lt "$deadline" ]; do
  got=$(far_count)
  case "$got" in no) got=0 ;; ''|unreadable|*[!0-9]*) got='' ;; esac
  [ -z "$got" ] && { sleep 4; continue; }
  [ "$got" -ge "$served" ] 2>/dev/null && [ "$served" -gt 0 ] && break
  sleep 4
done

if [ -z "$before" ] || [ -z "$got" ]; then
  fail "the far end's record count could not be read, so this run proves nothing either way"
  gained=0
  got='?'
else
  gained=$(( got - before ))
fi
if [ "$falsify" = yes ]; then
  if [ "$gained" -le 0 ]; then
    pass "--falsify: nothing NEW arrived on $remote with its app stopped, so the converge step CAN fail"
  else
    fail "--falsify: $gained new record(s) arrived on $remote while its app was stopped — the converge step proves nothing"
  fi
elif [ "$served" -eq 0 ]; then
  fail "this machine serves NOTHING for that book — the publish steps reported success and its own store is empty"
elif [ "$got" -ge "$served" ]; then
  if [ "$gained" -gt 0 ]; then
    pass "$gained new public record(s) landed on $remote — it now holds $got of the $served this machine serves"
  else
    pass "$remote already held all $served record(s) this machine serves — converged, nothing new to carry"
  fi
else
  fail "$remote holds $got of the $served record(s) this machine serves, after ${timeout}s"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "public-scenario: $failures of $steps steps failed"
  exit 1
fi
echo "public-scenario: $steps steps, 0 failures"

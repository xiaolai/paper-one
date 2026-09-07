#!/usr/bin/env bash
#
# WI-24.C2 — the circle, crossed, and repeatably.
#
# The circle's equivalent of `sync-scenario.sh`, and it exists for the same
# reason that one did: on 2026-09-07 a passage crossed between two machines for
# the first time, BY HAND, and the run that finally happened found two defects
# that a green `tsc`, a cross-language golden vector and a camelCase audit
# aimed at that exact class had all passed over. A thing driven by hand once is
# not evidence that it works; it is evidence that it worked once.
#
# ⚠️ **THIS IS NOT `sync-scenario.sh` WITH DIFFERENT NOUNS, AND THE DIFFERENCE
# IS THE POINT.** Sync is shelf ⇄ satchel and is driven by `paper`, which
# composes no circle capability and has no circle commands — checked, not
# assumed: `serviceTable.ts` declares `book.*` and `mark.*` and nothing else.
# So every mutation here goes through the MCP BRIDGE against the running app,
# which means THIS machine must be a DEBUG build. A release build answers
# nothing on the bridge port, and this script says so by name rather than
# timing out.
#
# ## The shape
#
#   preflight   both apps up, both screens unlocked, BOTH ROLED SHELF, the
#               circle pairing present on both, the fixture book on both, a
#               publishing identity here, and the bridge answering
#   mutate      share a passage on THIS machine, through the bridge
#   converge    poll `books/<book>/circle/<person>.json` on the remote for the
#               `pub` this run published
#   negative    hold a person back through the Circle screen's own switch and
#               confirm the record says so while their files stay — the half a
#               transport test cannot see
#
# ## ⚠️ Two things that are not the same, and a harness that conflates them
# ## proves the smaller one
#
# **A file appearing proves TRANSPORT.** It does not prove the relationship
# record was consulted. `drawsEntry` is the half a transport test cannot see:
# a build that ignored relationships entirely would pass every converge step
# here and still draw the passages of somebody the reader has muted. That is
# why the negative below is not optional garnish.
#
# **And the converge step must be able to FAIL.** `--falsify` quits the app on
# the far end first and expects the convergence NOT to happen. A harness that
# has never seen its own assertion fail is asserting a file it wrote itself —
# WI-8.6's first run did exactly that and read the result as a pass.
#
# ## ⚠️ The bound is not a matter of taste
#
# The circle's fetch cadence is **half a minute after start, then every five
# minutes** (`lib/cadence.ts`), and it subscribes to nothing — deliberately:
# pull-on-open would leak the reader's sequence to the peer. So a timeout under
# one full period measures this script's impatience and nothing else. The floor
# below is compile-time, not advice.
#
# ## ⚠️ What a locked screen does, and why this refuses on it
#
# A locked far end suspends the webview: rounds report `skipped` with
# `why: "asleep"`, the peer answers nothing, and every other signal says go.
# Two evenings went into that before it was written down. The lock check is
# `sync-scenario.sh`'s, unchanged on purpose — see `screen_lock_state` there
# and `second-instance.sh`, which refuses on the same reading.
#
# Usage:
#   scripts/circle-scenario.sh <user@host> [--timeout SECONDS] [--book ID]
#                                          [--falsify] [--port N]
#
set -uo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DATA_DIR='Library/Application Support/one.paper.reader'
readonly DIAGNOSTICS="$DATA_DIR/diagnostics.jsonl"
readonly SATCHEL_APP="${PAPER_SATCHEL_APP:-Applications/Paper.app}"

die() { echo "$*" >&2; exit 2; }

# ── arguments ──────────────────────────────────────────────────────────────

remote=''
book=''
falsify=no
shelf_half=no
far_port=''
port=31415
# ⚠️ **THE DEFAULT SPANS TWO ROUNDS, NOT ONE, AND THAT IS A MEASURED CORRECTION.**
# It was 420 s — one 300 s period plus slack — and a run failed on 2026-09-07
# with the far end reporting `circle.pages: timeout: nothing for 30000 ms`. One
# round fell inside the window and that round transiently failed, so the harness
# reported the passage as not crossing when it had never been answered for. A
# bound of one period turns any single flaky round into a red run, which is the
# fastest way to make a harness nobody believes.
#
# Two periods plus slack: a transient costs a delay rather than a failure, and a
# real defect still fails because it fails EVERY round. The floor below stays at
# one period, because `--timeout 400` is a legitimate deliberate question —
# *did it arrive within a single round?* — and refusing it would be this script
# deciding what the operator is allowed to measure.
timeout_s=780
readonly CADENCE_PERIOD_S=300
readonly TIMEOUT_FLOOR_S=330

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) timeout_s="${2:-}"; shift 2 || die 'usage: --timeout SECONDS' ;;
    --book) book="${2:-}"; shift 2 || die 'usage: --book ID' ;;
    --port) port="${2:-}"; shift 2 || die 'usage: --port N' ;;
    --falsify) falsify=yes; shift ;;
    --shelf) shelf_half=yes; shift ;;
    --far-port) far_port="${2:-}"; shift 2 || die 'usage: --far-port N' ;;
    -h|--help) sed -n '2,66p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -n "$remote" ] && die 'one <user@host>, please'; remote="$1"; shift ;;
  esac
done

[ -n "$remote" ] || die 'usage: scripts/circle-scenario.sh <user@host> [--timeout SECONDS] [--book ID] [--falsify]'
case "$timeout_s" in (''|*[!0-9]*) die "--timeout takes whole seconds, not '$timeout_s'" ;; esac
case "$port" in (''|*[!0-9]*) die "--port takes a number, not '$port'" ;; esac

# ⚠️ **REFUSED, NOT CLAMPED.** Silently raising the number would leave the
# operator believing they had bounded the run at what they asked for, and the
# whole reason this floor exists is that the failure it prevents looks exactly
# like a real defect.
if [ "$timeout_s" -lt "$TIMEOUT_FLOOR_S" ]; then
  die "--timeout $timeout_s is under the ${TIMEOUT_FLOOR_S}s floor: the circle's fetch cadence is one round every ${CADENCE_PERIOD_S}s, so a shorter bound measures this script's impatience rather than the app. Raise it, or accept that a failure here means nothing."
fi

# ── transcript ─────────────────────────────────────────────────────────────

readonly RUN_ID="$$-$(date +%s)"
mkdir -p "$REPO_ROOT/dev-docs/plans/evidence" 2>/dev/null || true
out="$REPO_ROOT/dev-docs/plans/evidence/wi-24-c2-$(date -u +%Y%m%dT%H%M%SZ).md"
: > "$out" 2>/dev/null || out=/dev/null

log() { printf '%s\n' "$*" | tee -a "$out"; }

step_no=0
failures=0
skipped=0
pass() { step_no=$((step_no + 1)); log "  ok   [$step_no] $*"; }
fail() { step_no=$((step_no + 1)); failures=$((failures + 1)); log "  FAIL [$step_no] $*"; }
skip() { step_no=$((step_no + 1)); skipped=$((skipped + 1)); log "  skip [$step_no] $*"; }
note() { log "  note  $*"; }

log "# WI-24.C2 — the circle, crossed"
log ""
log "run       $RUN_ID"
log "started   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "remote    $remote"
log "timeout   ${timeout_s}s (cadence period ${CADENCE_PERIOD_S}s)"
log "mode      $([ "$falsify" = yes ] && echo 'FALSIFIER — the convergence is expected to FAIL' || echo 'normal')"
log ""

# ── the two machines ───────────────────────────────────────────────────────

remote_sh() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 "$remote" "$@"
}

# The bridge, against the app on THIS machine.
#
# ⚠️ **`circle-drive.mjs` IS THE ONLY THING THAT TOUCHES THE APP'S STATE.** This
# script reads files and asks questions; every mutation goes through the app's
# own UI over the bridge, because a harness that wrote `shared.json` itself
# would be testing its own JSON writer. The one exception is `--falsify`, which
# quits an app rather than changing one.
drive() { node "$REPO_ROOT/scripts/circle-drive.mjs" --port "$port" "$@"; }

# Whether the app is running, by process NAME.
#
# ⚠️ **`pgrep -x app`, AND NEITHER `-x Paper` NOR `-f <path>`.** The executable
# is `Paper.app/Contents/MacOS/app`, so `pgrep -x Paper` matches NOTHING and
# reports a stopped app whether or not one is running — which reads as a clean
# result and, on 2026-09-07, let a deploy replace a bundle under two live
# processes while `open` merely activated them. Fifteen minutes of a
# two-machine run went to that. `-f` is safe here only because these are simple
# commands that exec; inside a compound command it matches the shell asking.
app_pids_local() { pgrep -x app 2>/dev/null; }
app_pids_remote() { remote_sh 'pgrep -x app' 2>/dev/null; }

# `sync-scenario.sh`'s reading, unchanged: the key ABSENT means a session that
# has never locked, and an unreadable answer is refused rather than assumed
# unlocked. A one-line `grep -q ...=Yes` fails OPEN on every one of those.
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
screen_lock_state() {
  if [ "$1" = local ]; then sh -c "$LOCK_PROBE"; else remote_sh "$LOCK_PROBE"; fi
}

# A JSON field out of a file on either machine, without assuming `jq`.
read_json_local() { python3 -c "$1" 2>/dev/null; }
read_json_remote() { remote_sh "python3 -c '$1'" 2>/dev/null; }

# ── preflight ──────────────────────────────────────────────────────────────
#
# ⚠️ **REFUSES EARLY, AND EVERY ONE OF THESE COST A RUN.** A harness whose
# preconditions are unchecked spends its timeout on them and then reports the
# feature broken.

log "## Preflight"

if remote_sh true 2>/dev/null; then
  pass "$remote answers over ssh"
else
  fail "$remote does not answer over ssh — nothing below can run"
  log ""
  log "**$failures failed**, $skipped skipped, $step_no steps."
  exit 1
fi

local_pids="$(app_pids_local)"
if [ -n "$local_pids" ]; then
  pass "the app is running on this machine (pid $(echo "$local_pids" | head -1), up $(ps -o etime= -p "$(echo "$local_pids" | head -1)" | tr -d ' '))"
else
  fail "the app is NOT running on this machine — start it and re-run"
fi

remote_pids="$(app_pids_remote)"
if [ -n "$remote_pids" ]; then
  pass "the app is running on $remote (pid $(echo "$remote_pids" | head -1))"
elif [ "$falsify" = yes ]; then
  pass "the app is NOT running on $remote — which is what --falsify wants"
else
  fail "the app is NOT running on $remote — start it and re-run"
fi

# ⚠️ **RAISED, NOT MERELY CHECKED — AN UNLOCKED SCREEN IS NOT ENOUGH.** An app
# that was running while its Mac's screen was LOCKED does not resume when the
# screen is unlocked: it keeps every timer suspended until its window is raised,
# and `pgrep` reports it healthy throughout. Measured on the sync run of
# 2026-09-06 (no timer of any kind for two minutes after unlock, its 30 s round
# 6½ minutes overdue) and again here on 2026-09-07. `sync-scenario.sh` raises
# for exactly this reason; a circle run that skipped it would spend its whole
# 420 s bound against an app that will not fetch, and report the protocol
# broken.
#
# The remote AppleScript is SINGLE-quoted so its own double quotes survive ssh,
# and `$pid` is resolved on the far side — the trap `app_raise` in
# `sync-scenario.sh` records, which cost an hour there and produced a raise that
# silently did nothing.
raise_window() {
  case "$1" in
    local)
      local pid; pid="$(pgrep -x app | head -1)"
      [ -n "$pid" ] && osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" >/dev/null 2>&1
      ;;
    remote)
      remote_sh 'pid=$(pgrep -x app | head -1); [ -n "$pid" ] && osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true"' >/dev/null 2>&1
      ;;
  esac
}

for side in local remote; do
  where=$([ "$side" = local ] && echo 'this machine' || echo "$remote")
  case "$(screen_lock_state "$side")" in
    no) pass "the screen is unlocked on $where" ;;
    yes) fail "the screen is LOCKED on $where — the webview is suspended behind it, its fetch cadence does not run, and nothing will cross. Unlock it at that Mac." ;;
    *) fail "the screen's lock state on $where could not be read — refused rather than assumed unlocked" ;;
  esac
done

# ⚠️ **BOTH SHELF, AND THIS CONFLICTS WITH SYNC'S PRECONDITION.** The circle is
# shelf ↔ shelf; sync is shelf ⇄ satchel. The same pair of machines cannot
# satisfy both at once, which is why phase 24 runs Stage C after Stage B.
local_role="$(cat "$HOME/$DATA_DIR/peer/role" 2>/dev/null || echo unset)"
remote_role="$(remote_sh "cat \"\$HOME/$DATA_DIR/peer/role\" 2>/dev/null || echo unset")"
[ "$local_role" = shelf ] && pass "this machine is roled shelf" \
  || fail "this machine is roled '$local_role', and the circle is shelf ↔ shelf"
[ "$remote_role" = shelf ] && pass "$remote is roled shelf" \
  || fail "$remote is roled '$remote_role', and the circle is shelf ↔ shelf — sync's satchel role is the one that conflicts"

# The pairing, and the grant that distinguishes a CIRCLE pairing from a device
# one. A device pairing grants the sync services; only a circle pairing grants
# `circle:read`, and both circle services are gated on it.
readonly GRANT_PROBE='import json,sys;d=json.load(open(sys.argv[1]));print("yes" if any("circle:read" in (p.get("grants") or []) for p in d.get("peers",[])) else "no")'
local_grant="$(python3 -c "$GRANT_PROBE" "$HOME/$DATA_DIR/peer/peers.json" 2>/dev/null || echo unreadable)"
remote_grant="$(remote_sh "python3 -c '$GRANT_PROBE' \"\$HOME/$DATA_DIR/peer/peers.json\"" 2>/dev/null || echo unreadable)"
[ "$local_grant" = yes ] && pass "this machine holds a circle pairing (circle:read)" \
  || fail "this machine holds no circle pairing — grants say '$local_grant'. Pair as a circle first (WI-24.C1, once, by hand)"
[ "$remote_grant" = yes ] && pass "$remote holds a circle pairing (circle:read)" \
  || fail "$remote holds no circle pairing — grants say '$remote_grant'"

# Both awake, both unlocked: wake the webviews before anything is measured.
for side in local remote; do
  where=$([ "$side" = local ] && echo 'this machine' || echo "$remote")
  if raise_window "$side"; then
    pass "raised the app's window on $where, so its timers are running"
  else
    fail "could not raise the app's window on $where — its fetch cadence may stay suspended and every wait below would then be measuring nothing"
  fi
done

log ""
log "**$failures failed**, $skipped skipped, $step_no steps so far."
log ""
if [ "$failures" -gt 0 ]; then
  log "Refused before mutating anything: a run against unmet preconditions reports the feature broken when the harness was."
  exit 1
fi

log "Preflight clean."
log ""

# ── the bridge, and who we publish as ───────────────────────────────────────

log "## Identity"

identity="$(drive identity 2>&1)"
if printf '%s' "$identity" | grep -q '"ok":true'; then
  person="$(printf '%s' "$identity" | python3 -c 'import json,sys; print(json.load(sys.stdin)["person"])')"
  pass "this device publishes as ${person:0:12}… (the bridge answers, so this is a debug build)"
else
  fail "the bridge could not say who this device publishes as: $(printf '%s' "$identity" | tr -d '\n' | cut -c1-220)"
  log ""
  log "**$failures failed**, $skipped skipped, $step_no steps."
  exit 1
fi

# ── the falsifier ──────────────────────────────────────────────────────────
#
# ⚠️ **A HARNESS THAT HAS NEVER SEEN ITS OWN ASSERTION FAIL IS ASSERTING A FILE
# IT WROTE ITSELF.** WI-8.6's first run did exactly that and read the result as
# a pass. `--falsify` stops the far end and expects the convergence NOT to
# happen; a green run in this mode is a BROKEN harness, and it says so.

if [ "$falsify" = yes ]; then
  note "falsifier: quitting the app on $remote so the converge step has nothing to answer it"
  remote_sh 'osascript -e "quit app \"Paper\"" >/dev/null 2>&1 || true'
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$(app_pids_remote)" ] && break
    sleep 1
  done
  if [ -z "$(app_pids_remote)" ]; then
    pass "the app on $remote is stopped — nothing over there can answer"
  else
    fail "could not stop the app on $remote; the falsifier cannot be trusted"
  fi
fi

# ── mutate ─────────────────────────────────────────────────────────────────

log ""
log "## Mutate — share a passage on this machine, through the app's own control"

[ -n "$book" ] || book='Uncovering The Logic of English'

shared="$(drive share --title "$book" 2>&1)"
quote="$(printf '%s' "$shared" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("quote",""))
except Exception: print("")' 2>/dev/null)"
if printf '%s' "$shared" | grep -q '"ok":true'; then
  pass "shared a passage of $book through the Share control"
else
  fail "could not share a passage: $(printf '%s' "$shared" | tr -d '\n' | cut -c1-260)"
  log ""
  log "**$failures failed**, $skipped skipped, $step_no steps."
  exit 1
fi

# The `pub` is the stable publication id, and it is what the far end must end
# up holding. Read from the store rather than from the driver: the store is
# what the app actually wrote, and a driver that reported an id the app never
# persisted is the exact self-confirmation this harness exists to avoid.
readonly PUB_PROBE='
import json,pathlib,sys
root = pathlib.Path.home()/"Library/Application Support/one.paper.reader/books"
newest = None
for f in root.glob("*/shared.json"):
    d = json.load(open(f))
    for pub in d.get("publications", []):
        if newest is None or pub["at"] > newest[0]:
            newest = (pub["at"], pub["pub"], f.parent.name)
print(json.dumps({"pub": newest[1], "book": newest[2]}) if newest else "{}")'
pub_row="$(python3 -c "$PUB_PROBE" 2>/dev/null)"
pub="$(printf '%s' "$pub_row" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("pub",""))' 2>/dev/null)"
pub_book="$(printf '%s' "$pub_row" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("book",""))' 2>/dev/null)"
if [ -n "$pub" ]; then
  pass "the store holds the publication: pub ${pub:0:12}… in $pub_book"
else
  fail "the app reported a share and the store holds no publication — nothing to converge on"
  log ""
  log "**$failures failed**, $skipped skipped, $step_no steps."
  exit 1
fi

# ── converge ───────────────────────────────────────────────────────────────

log ""
log "## Converge — the far end must end up holding that pub"

# ⚠️ **SEARCHED, NOT ADDRESSED BY BOOK ID.** The plan says to poll
# `books/<bookId>/circle/<person>.json`, which assumes both machines call the
# book the same thing. Matching in the circle is by WORK CLAIM and not by
# `bookId` — two copies of one work can legitimately carry different ids — so
# addressing the far end's file by THIS machine's id would report a defect on
# any pair whose ids differ. The `pub` is unique, so looking for it under this
# person's file is both stricter and portable.
converged_probe() {
  remote_sh "grep -rl '$pub' \"\$HOME/$DATA_DIR/books\"/*/circle/'$person'.json 2>/dev/null | head -1"
}

# ⚠️ **THE FALSIFIER NEEDS ONE PERIOD, NOT TWO, AND WAITING TWO IS NOT FREE.**
# A normal run spans two rounds so a single flaky one costs a delay rather than
# a failure. The falsifier asserts the OPPOSITE — that nothing arrives — and a
# second round adds no confidence to a negative while adding five minutes to
# every run of it. Thirteen minutes to learn nothing new is how a check stops
# being run, and an unrun falsifier is the same as not having one.
watch_s="$timeout_s"
if [ "$falsify" = yes ] && [ "$watch_s" -gt "$((CADENCE_PERIOD_S + 120))" ]; then
  watch_s=$((CADENCE_PERIOD_S + 120))
  note "falsifier: watching ${watch_s}s — one full round, which is all a negative needs"
fi

deadline=$(( $(date +%s) + watch_s ))
found=''
while [ "$(date +%s)" -lt "$deadline" ]; do
  found="$(converged_probe 2>/dev/null)"
  [ -n "$found" ] && break
  sleep 10
done

# ⚠️ **THE FALSIFIER LEAVES THE PAIR UNUSABLE UNLESS IT RESTARTS *BOTH* ENDS.**
# Measured 2026-09-07: after a `--falsify` run the next two normal runs failed
# at this step — `circle.pages: timeout` one way, `asleep — timed out: session
# hello` the other. Nothing to do with the circle; the peer session does not
# survive one end vanishing and does not re-establish on its own.
#
# ⚠️ **AND THE FIRST FIX FOR THIS RESTARTED ONLY THE FAR END, WHICH IS HALF OF
# IT.** That was written from watching the RESTARTED machine start fetching
# again — which it does, within about 280 s — and concluding the pair had
# recovered. It had not. The end that kept RUNNING is the one holding the dead
# session, and it stays wedged: measured 2026-09-08, this machine timed out on
# `session hello` for seventeen minutes after the far end was replaced and had
# itself recovered. Restarting THIS end cleared it in 100 s.
#
# The note in `dev-docs` that both ends must restart was therefore right, and
# the "narrower claim" recorded against it here was an over-read of one side's
# recovery. Watching the side you just restarted tells you nothing about the
# side you did not.
restore_session() {
  local ok=yes
  remote_sh "open \"\$HOME/$SATCHEL_APP\" >/dev/null 2>&1 || open -a Paper >/dev/null 2>&1 || true"
  for _ in $(seq 1 15); do
    [ -n "$(app_pids_remote)" ] && break
    sleep 2
  done
  [ -n "$(app_pids_remote)" ] || ok=no

  # ⚠️ **AND THIS END TOO, WHICH MEANS THE BRIDGE GOES AWAY AND COMES BACK.**
  # Every later step drives the app through it, so the restart is not complete
  # until the port answers again — returning early here would fail the negative
  # step against an app that is merely still booting.
  osascript -e 'quit app "Paper"' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    [ -z "$(app_pids_local)" ] && break
    sleep 1
  done
  open "$HOME/${PAPER_LOCAL_APP:-Applications/Paper.app}" >/dev/null 2>&1 || open -a Paper >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && break
    sleep 2
  done
  nc -z 127.0.0.1 "$port" >/dev/null 2>&1 || ok=no
  raise_window local
  raise_window remote
  [ "$ok" = yes ]
}

if [ -n "$found" ]; then
  if [ "$falsify" = yes ]; then
    fail "THE FALSIFIER FAILED: the pub reached $remote with the app stopped over there. This harness is asserting something it wrote itself — do not trust a green run from it until this is explained."
  else
    pass "the passage crossed: $remote holds pub ${pub:0:12}… at ${found##*/books/}"
  fi
else
  if [ "$falsify" = yes ]; then
    pass "the passage did NOT cross with the far end stopped — the converge step can fail, so a pass from it means something"
  else
    fail "the passage did not reach $remote within ${watch_s}s (cadence period ${CADENCE_PERIOD_S}s, so that is $((watch_s / CADENCE_PERIOD_S)) full round(s))"
    # ⚠️ **THE PREFLIGHT'S LOCK CHECK IS A SNAPSHOT, AND A RUN IS LONG ENOUGH TO
    # OUTLIVE IT.** A screen that was unlocked at step 5 can idle out during a
    # 13-minute converge; the far end then stops fetching, and the failure above
    # reads as a protocol defect. Measured 2026-09-08 — the far screen re-locked
    # mid-run and a shelf that should have crossed simply did not.
    #
    # Asked again ONLY on failure: it costs nothing on the happy path, and it is
    # the difference between "the circle is broken" and "nobody is at that Mac".
    case "$(screen_lock_state remote)" in
      yes) note "AND THE SCREEN ON $remote IS LOCKED NOW — it was unlocked at preflight. Its webview is suspended, so this failure says nothing about the circle. Unlock it, and keep it awake (caffeinate -d) for a run this long." ;;
      no)  note "the screen on $remote is still unlocked, so this failure is not that" ;;
      *)   note "the screen's lock state on $remote could not be re-read" ;;
    esac
    note "the far end's last rounds, if it is recording them:"
    remote_sh "tail -3 \"\$HOME/$DIAGNOSTICS\" 2>/dev/null" | while IFS= read -r line; do
      log "        $(printf '%s' "$line" | cut -c1-260)"
    done
    note "turn its diagnostics on with: ssh $remote 'touch \"\$HOME/$DATA_DIR/diagnostics.on\"' and relaunch the app"
  fi
fi

# Whatever the verdict, the far end goes back the way it was found.
if [ "$falsify" = yes ]; then
  if restore_session; then
    pass "restarted BOTH apps and the bridge answered again — the end that kept running holds the dead session, so restarting only the far one leaves the pair broken"
  else
    fail "could not restart both apps. THE PAIR IS LEFT BROKEN: every later run will fail at the converge step with 'session hello' timing out, for a reason that is this run's and not the circle's."
  fi
fi

# ── the negative ───────────────────────────────────────────────────────────

log ""
log "## The negative — a muted person's passage stops being DRAWN, file intact"

# ⚠️ **A FILE APPEARING PROVES TRANSPORT AND NOTHING ELSE.** A build that
# ignored relationships entirely would pass every converge step above and still
# draw the passages of somebody the reader has held back. `drawsEntry` is the
# half a transport test cannot see, and this is what reaches it.
#
# ⚠️ **THE CONTROL THIS DRIVES DID NOT EXIST UNTIL THIS HARNESS ASKED FOR IT.**
# `'muted'` was modelled from the start — parsed, admitted by
# `acceptsTransport`, and given `retain: 'keep'` on its own stated reasoning —
# and nothing in the product ever wrote it. The only reachable transition was
# `forget`, which purges the passages AND the pairing. Trying to run this step
# is what found that; the mute is WI-24.C2's, not a pre-existing feature.
#
# WHAT THIS PROVES, said exactly: the reader's own control writes the record,
# the record says `muted` with `retain: keep`, and anything already received
# stays on disk. WHAT IT DOES NOT: that the painter omits it on the page. That
# is `drawsOverlays`, held by unit tests, and reaching it from here would mean
# counting painted marks in an open book — worth doing, not done.

friend_name="$(python3 -c '
import json, pathlib, sys
p = pathlib.Path.home()/"Library/Application Support/one.paper.reader/peer/circle-people.json"
try:
    d = json.load(open(p))
except Exception:
    sys.exit(0)
people = d.get("people", d) if isinstance(d, dict) else d
print(people[0]["displayName"] if people else "")' 2>/dev/null)"

if [ -z "$friend_name" ]; then
  fail "this machine names nobody in its circle, so there is no relationship to hold back"
else
  before="$(ls "$HOME/$DATA_DIR/books"/*/circle/*.json 2>/dev/null | wc -l | tr -d ' ')"

  held="$(drive mute --person "$friend_name" 2>&1)"
  if printf '%s' "$held" | grep -q '"ok":true'; then
    pass "held $friend_name back, through the switch on the Circle screen"
  else
    fail "could not hold $friend_name back: $(printf '%s' "$held" | tr -d '\n' | cut -c1-220)"
  fi

  # The record is the assertion — `retain: keep` is what separates this from
  # Remove, and reading it here is reading what the APP wrote.
  state="$(python3 -c '
import json, pathlib
root = pathlib.Path.home()/"Library/Application Support/one.paper.reader/circle"
for f in root.glob("*/relationship.json"):
    d = json.load(open(f))
    print(d.get("state"), d.get("retain"))
    break' 2>/dev/null)"
  case "$state" in
    "muted keep") pass "the record says muted, retain keep — the passages are held, not discarded" ;;
    *) fail "the record says '${state:-nothing}' and should say 'muted keep'" ;;
  esac

  after="$(ls "$HOME/$DATA_DIR/books"/*/circle/*.json 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$before" -eq 0 ]; then
    note "this machine holds no received passages, so 'the file stays' had nothing to stay: the state above is what this run proves. Publish from $remote once to make this step whole."
  elif [ "$before" -eq "$after" ]; then
    pass "all $before received passage file(s) are still on disk — held back, not deleted"
  else
    fail "holding back DELETED files: $before before, $after after. That is Remove's behaviour, not a mute's"
  fi

  back="$(drive unmute --person "$friend_name" 2>&1)"
  if printf '%s' "$back" | grep -q '"ok":true'; then
    pass "let $friend_name back — a mute is reversible, which is the whole difference from Remove"
  else
    fail "could not let $friend_name back, and the harness has left them held: $(printf '%s' "$back" | tr -d '\n' | cut -c1-200)"
  fi
fi

# ── the shelf, and a jacket verified against its digest — WI-24.C3 ─────────
#
# Runs only with --shelf, because it changes a DISCLOSURE: the switch shows the
# far end every book in this library, including ones nothing has been shared
# from. That is a decision a reader makes, not one a harness makes on every run.
#
# ⚠️ **AN EMPTY SHELF AND A SWITCH THAT IS OFF ARE THE SAME ANSWER**, on purpose
# — `fetchShelf`'s own note: *"a person the switch is off for answers exactly as
# a reader who owns nothing does … an empty answer is an empty shelf, and
# nothing is written for it."* So the ABSENCE of `shelf.json` proves nothing,
# and this asserts a non-empty one landed.
#
# ⚠️ **AND A JACKET IS FETCHED WHEN A ROW IS SEEN, NOT DURING THE ROUND.**
# `covers.ts` asks the publishing device only for a row that is actually drawn,
# so waiting for covers after flipping a switch waits for ever. The far end has
# to be driven to OPEN the friend's shelf — which needs a bridge over there, and
# is why `--shelf` also needs `--far-port`.

if [ "$shelf_half" = yes ]; then
  log ""
  log "## The shelf, and a jacket — WI-24.C3"

  if [ -z "$far_port" ]; then
    fail "--shelf needs --far-port N: a jacket is fetched only for a row that is DRAWN, so the far end must be driven to open the friend's shelf. Tunnel its bridge first: ssh -N -L N:127.0.0.1:31415 $remote"
  else
    ours="$(printf '%s' "$identity" | python3 -c 'import json,sys; print(json.load(sys.stdin)["person"])' 2>/dev/null)"
    far_dir="\$HOME/$DATA_DIR/circle/$ours"

    on="$(drive shelf --person "$friend_name" 2>&1)"
    if printf '%s' "$on" | grep -q '"ok":true'; then
      pass "turned the shelf switch on for $friend_name, through the control on the Circle screen"
    else
      fail "could not turn the shelf switch on: $(printf '%s' "$on" | tr -d '\n' | cut -c1-200)"
    fi

    deadline=$(( $(date +%s) + timeout_s ))
    landed=''
    while [ "$(date +%s)" -lt "$deadline" ]; do
      landed="$(remote_sh "python3 -c \"
import json,sys,pathlib
p = pathlib.Path('$far_dir'.replace('\\\$HOME', str(pathlib.Path.home())))/'shelf.json'
if not p.exists(): sys.exit(1)
d = json.load(open(p))
w = d.get('works') or []
print(len(w))
sys.exit(0 if w else 1)\"" 2>/dev/null)" && [ -n "$landed" ] && break
      landed=''
      sleep 15
    done

    if [ -n "$landed" ]; then
      pass "the shelf crossed: $remote holds circle/<us>/shelf.json with $landed work(s) — a NON-EMPTY one, because an empty answer is indistinguishable from the switch being off"
    else
      fail "the shelf did not reach $remote within ${timeout_s}s, or arrived empty (which is the same answer as the switch being off)"
      case "$(screen_lock_state remote)" in
        yes) note "AND THE SCREEN ON $remote IS LOCKED NOW — its webview is suspended, so this says nothing about the circle" ;;
        *) : ;;
      esac
    fi

    # The jacket. Drawn rows are what trigger the fetch, so the far end opens
    # the friend's shelf; then a verified cover appears under its own digest.
    seen="$(node "$REPO_ROOT/scripts/circle-drive.mjs" --port "$far_port" friend 2>&1)"
    if printf '%s' "$seen" | grep -q '"ok":true'; then
      pass "opened our shelf on $remote, which is what asks for a jacket at all"
    else
      fail "could not open our shelf on $remote: $(printf '%s' "$seen" | tr -d '\n' | cut -c1-200)"
    fi

    deadline=$(( $(date +%s) + 240 ))
    digest=''
    while [ "$(date +%s)" -lt "$deadline" ]; do
      digest="$(remote_sh "ls \"$far_dir/covers\" 2>/dev/null | head -1")"
      [ -n "$digest" ] && break
      sleep 10
    done

    if [ -z "$digest" ]; then
      fail "no jacket was kept on $remote within 240s — nothing under circle/<us>/covers/"
    else
      # ⚠️ **THE FILENAME IS THE DIGEST, so re-hashing the bytes is what turns
      # "a file appeared" into "it was VERIFIED".** A build that kept whatever
      # arrived would put a file here too, named for the digest it was promised
      # rather than the one it has.
      # ⚠️ **BASE64 THROUGH ssh, NOT scp, AND THE REASON IS THE PATH.** Every
      # remote path here carries a literal `$HOME` for the REMOTE shell to
      # expand — which `remote_sh` does and `scp` does not: OpenSSH 9 moved scp
      # onto SFTP, where nothing expands a shell variable. The first version
      # copied nothing and failed as "could not read the kept jacket back",
      # which reads as a missing file rather than a broken command. Piping the
      # bytes through the same shell that resolves the path cannot disagree
      # with it.
      remote_sh "base64 < \"$far_dir/covers/$digest\"" 2>/dev/null | base64 -d > /tmp/paper-jacket.bin 2>/dev/null
      if [ -s /tmp/paper-jacket.bin ]; then
        got="$(node -e "
import('@noble/hashes/blake3.js').then(async ({ blake3 }) => {
  const { readFileSync } = await import('node:fs')
  const b = blake3(new Uint8Array(readFileSync('/tmp/paper-jacket.bin')))
  process.stdout.write(Buffer.from(b).toString('hex'))
})" 2>/dev/null)"
        if [ "$got" = "$digest" ]; then
          pass "the jacket is VERIFIED, not merely present: blake3 of the kept bytes is ${digest:0:16}…, which is the name it is filed under"
        else
          fail "the kept jacket does NOT hash to its own name: filed as ${digest:0:16}…, hashes to ${got:0:16}…"
        fi
      else
        fail "could not read the kept jacket back to hash it"
      fi
      rm -f /tmp/paper-jacket.bin
    fi
  fi
fi

# ── put it back ────────────────────────────────────────────────────────────
#
# ⚠️ **A HARNESS THAT CANNOT BE RUN TWICE IS ONE NOBODY RUNS.** Each run
# consumes an unshared mark; the fourth reported *"no unshared mark of the open
# book"* and read like a defect in the app. Withdrawing what this run published
# leaves the library as it was found — and exercises `unshare`, which is real
# behaviour and had no harness either.
#
# AFTER the converge, never before: withdrawing first would race the far end's
# round and prove nothing about either.

log ""
log "## Put it back"

if [ -z "$quote" ]; then
  skip "nothing to withdraw — the share step did not name a passage"
elif printf '%s' "$(drive withdraw --title "$book" --quote "$quote" 2>&1)" | grep -q '"ok":true'; then
  pass "withdrew this run's publication, so the next run has a mark to use"
else
  fail "could not withdraw this run's publication — the next run will find one fewer unshared mark, and eventually none"
fi

log ""
log "---"
log ""
log "**$failures failed**, $skipped skipped, $step_no steps."
log ""
log "transcript: $out"
[ "$failures" -eq 0 ] || exit 1
exit 0

#!/usr/bin/env bash
#
# Stand a satchel up on a SECOND MAC and forward its automation bridge here, so
# the shelf ⇄ satchel scenario (WI-8.6) can be driven from one place.
#
# THE RUNBOOK IS `dev-docs/sync.md`. It carries why this is two machines rather than
# two processes, why the satchel runs from a checkout rather than a shipped
# bundle, and what `PAPER_TEST_DATA_DIR` does and does not move. Those facts are
# operational and belong where an operator looks; repeating them here produced a
# third source of truth that drifted. The comments below cover only what this
# file does, and the traps live next to the lines that avoid them.
#
# Usage:
#   scripts/second-instance.sh <user@host> [--sync] [--local-port N] [--stop]
#
#     --sync         push this working tree to the remote checkout first
#                    (also creates the checkout if it is not there yet)
#     --local-port   where the remote bridge surfaces here (default 31416)
#     --stop         stop the satchel and close the tunnel
#
#   PAPER_REMOTE_CHECKOUT   remote path, relative to the remote home
#                           (default github/xiaolai/myprojects/paper-one)
#   PAPER_REMOTE_PATH       PATH to use on the remote
#
# The host is an ARGUMENT with no default on purpose: this file is committed,
# and an internal hostname or private address does not belong in it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

# Where the checkout lives on the remote, relative to its home. Relative so the
# remote shell resolves it and this file never has to know a home directory.
readonly REMOTE_CHECKOUT="${PAPER_REMOTE_CHECKOUT:-github/xiaolai/myprojects/paper-one}"

# Homebrew's node@24 is keg-only, so it is not on a non-interactive PATH; cargo
# is under ~/.cargo. Set explicitly rather than editing the remote's ~/.zshrc —
# a harness should not leave footprints in somebody's shell profile. Overridable
# because these paths are Apple-Silicon Homebrew's, and the `user@host` argument
# otherwise promises a generality the constant does not deliver.
# shellcheck disable=SC2016  # $HOME and $PATH are for the REMOTE shell to expand
readonly REMOTE_PATH="${PAPER_REMOTE_PATH:-/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:\$HOME/.cargo/bin:\$PATH}"

# BOTH OVERRIDES ARE VALIDATED, not quoted-through.
#
# They are interpolated into shell source that runs on the REMOTE (the preflight
# command, the `cd` in the launch file), and quoting a value correctly through
# bash → ssh → the remote shell is exactly the layered-quoting problem this
# script has already been bitten by twice. A character allowlist is something
# one can check by reading. `$` and `{}` stay legal because the PATH default
# deliberately carries `$HOME` and `$PATH` for the remote to expand; quotes,
# backticks, `;`, `&`, `|`, parentheses, spaces and newlines do not.
case "$REMOTE_CHECKOUT" in
  ''|/*|*..*) echo "PAPER_REMOTE_CHECKOUT must be a relative path with no '..': '$REMOTE_CHECKOUT'" >&2; exit 2 ;;
  *[!A-Za-z0-9._/-]*) echo "PAPER_REMOTE_CHECKOUT may use only A-Za-z0-9._/- : '$REMOTE_CHECKOUT'" >&2; exit 2 ;;
esac
case "$REMOTE_PATH" in
  ''|*[!A-Za-z0-9._/:@\$\{\}-]*) echo "PAPER_REMOTE_PATH may use only letters, digits and . _ / : @ \$ { } - — got '$REMOTE_PATH'" >&2; exit 2 ;;
esac

# The bridge's pinned port (`src-tauri/src/lib.rs`). The remote instance keeps
# it — it is alone over there — and the tunnel gives it a different number HERE
# so it cannot collide with the local shelf's.
readonly BRIDGE_PORT_REMOTE=31415
BRIDGE_PORT_LOCAL=31416

readonly LAUNCH_FILE='$HOME/.paper-satchel-launch.sh'

remote=''
sync=0
stop=0

die() { echo "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --sync) sync=1 ;;
    --stop) stop=1 ;;
    --local-port)
      BRIDGE_PORT_LOCAL="${2:?--local-port needs a number}"
      # Validated, because this value is interpolated into ssh's -L spec. A
      # value containing a colon does not select a port — it rewrites the
      # forward's destination, quietly pointing the tunnel somewhere else.
      case "$BRIDGE_PORT_LOCAL" in
        ''|*[!0-9]*) die "--local-port must be a number, got '$BRIDGE_PORT_LOCAL'" ;;
      esac
      [ "$BRIDGE_PORT_LOCAL" -ge 1 ] && [ "$BRIDGE_PORT_LOCAL" -le 65535 ] \
        || die "--local-port must be 1-65535, got '$BRIDGE_PORT_LOCAL'"
      shift
      ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --)
      # End of options — everything after is positional, and still subject to
      # the one-host rule below. `break` here silently DROPPED the rest, so
      # `host -- other-host` was accepted and the second host ignored.
      shift
      while [ $# -gt 0 ]; do
        [ -z "$remote" ] || die "one host only, got '$remote' and '$1'"
        remote="$1"
        shift
      done
      break
      ;;
    -*) die "unknown option: $1" ;;
    *)
      # Refused rather than overwritten: silently taking the last of two hosts
      # is how a harness ends up driving a machine nobody named.
      [ -z "$remote" ] || die "one host only, got '$remote' and '$1'"
      remote="$1"
      ;;
  esac
  shift
done

[ -n "$remote" ] \
  || die "usage: scripts/second-instance.sh <user@host> [--sync] [--local-port N] [--stop]"

readonly SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { echo "REFUSING: $*" >&2; exit 1; }

# The forward is found by the socket it holds, not by its command line.
#
# Matching the command line broke the moment the tunnel gained `-o` options:
# the pattern looked for a contiguous `ssh -f -N -L …` and the real argv is
# `ssh -o … -f -N -L …`, so `--stop` printed "tunnel closed" over a tunnel that
# was still up. The listener on the local port IS the forward; ask the port.
close_tunnel() {
  local pid
  pid="$(lsof -nP -iTCP:"$BRIDGE_PORT_LOCAL" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] || return 0
  # Only if it really is an ssh forward — this port is ours by convention, not
  # by reservation, and killing whatever happens to hold it is the mistake the
  # remote side already taught us.
  # `ssh` exactly, by basename. A trailing-glob `*ssh` also matched `autossh`,
  # `notssh` and anything else ending in those three letters.
  case "$(basename "$(ps -o comm= -p "$pid" 2>/dev/null)" 2>/dev/null)" in
    ssh) kill "$pid" 2>/dev/null || true ;;
    *) echo "127.0.0.1:$BRIDGE_PORT_LOCAL is held by pid $pid, which is not ssh — leaving it" >&2 ;;
  esac
}

# ---------------------------------------------------------------------------
# Stopping the remote instance — one definition, used by --stop and by the
# pre-launch sweep, because two copies of a kill are two chances to scope it
# differently.
# ---------------------------------------------------------------------------
#
# EVERY KILL IS SCOPED TO THIS CHECKOUT. `pkill -f 'tauri dev'` would take out
# every Tauri dev session that remote user has, including projects that have
# nothing to do with Paper; and the app's own command line is the RELATIVE
# `target/debug/app` (that is how `tauri dev` execs it), so matching it by name
# is both too narrow to find and too broad to trust. The listening socket
# identifies the process, and its working directory proves whose it is.
#
# Returns 0 when nothing is left listening, 1 when it could not be confirmed.
remote_stop() {
  ssh "${SSH_OPTS[@]}" "$remote" "
    checkout=\"\$HOME/$REMOTE_CHECKOUT\"

    pid=\$(lsof -nP -iTCP:$BRIDGE_PORT_REMOTE -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
    if [ -n \"\$pid\" ]; then
      cwd=\$(lsof -a -p \"\$pid\" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
      # EXACT directory or a subdirectory of it — not a prefix. A bare
      # \"\$checkout\"* also matches a SIBLING like paper-one-copy, which is
      # somebody else's app and not ours to kill.
      case \"\$cwd\" in
        \"\$checkout\"|\"\$checkout\"/*) kill \"\$pid\" 2>/dev/null || true ;;
        *) echo \"port $BRIDGE_PORT_REMOTE is held by pid \$pid from \$cwd — not ours, leaving it\" >&2; exit 3 ;;
      esac
    fi

    # \`pkill -f\` takes an ERE, so the path's dots would match any character —
    # another way to reach a sibling directory. Escaped to literals.
    esc=\$(printf '%s' \"\$checkout\" | sed 's/[.[\\*^\$()+?{|]/\\\\&/g')
    pkill -f \"\$esc/node_modules/.*tauri\\.js dev\" 2>/dev/null || true
    pkill -f \"\$esc/node_modules/.*vite\" 2>/dev/null || true

    # WAIT for the port to actually close. A SIGTERM that has been delivered is
    # not a process that has exited, and an old instance still holding the
    # socket is exactly what makes the later readiness check lie.
    for _ in \$(seq 1 30); do
      lsof -nP -iTCP:$BRIDGE_PORT_REMOTE -sTCP:LISTEN -t >/dev/null 2>&1 || exit 0
      sleep 1
    done
    echo \"port $BRIDGE_PORT_REMOTE still held after 30s\" >&2
    exit 4
  "
}

# ---------------------------------------------------------------------------
# --stop
# ---------------------------------------------------------------------------

if [ "$stop" -eq 1 ]; then
  say "Stopping the satchel on $remote"
  # Reported honestly. "Already absent" is success; an unreachable host or a
  # process that would not die is NOT, and saying "stopped" either way is how a
  # harness leaves an instance running and tells you it did not.
  if remote_stop; then
    close_tunnel
    ssh "${SSH_OPTS[@]}" "$remote" "rm -f \"$LAUNCH_FILE\"" 2>/dev/null || true
    echo "satchel stopped, tunnel closed"
    exit 0
  fi
  close_tunnel
  fail "could not confirm the satchel stopped on $remote (see the message above).
The tunnel here was closed regardless."
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

say "Preflight: $remote"

# One round trip, so a machine that is asleep costs one timeout and not six.
preflight="$(ssh "${SSH_OPTS[@]}" "$remote" "
  export PATH=\"$REMOTE_PATH\"
  printf 'console_user=%s\n' \"\$(stat -f%Su /dev/console 2>/dev/null)\"
  printf 'ssh_user=%s\n' \"\$(id -un)\"
  # THREE outcomes, kept apart. A count cannot distinguish 'unlocked' from 'the
  # query failed', and the first attempt at this collapsed a failed \`ioreg\`
  # into 'unlocked' — the one state the preflight exists to refuse. So the
  # command's own exit status is checked BEFORE its text is read: only a
  # successful query with no key means 'never locked'.
  if ioreg_out=\$(ioreg -n Root -d1 -a 2>/dev/null); then
    case \"\$ioreg_out\" in
      *CGSSessionScreenIsLocked*)
        lock=\$(printf '%s' \"\$ioreg_out\" | grep -A1 CGSSessionScreenIsLocked)
        case \"\$lock\" in
          *true*) printf 'locked=yes\n' ;;
          *false*) printf 'locked=no\n' ;;
          *) printf 'locked=unknown\n' ;;
        esac
        ;;
      # Key absent on a successful query: the session has never locked.
      *) printf 'locked=no\n' ;;
    esac
  else
    printf 'locked=unknown\n'
  fi
  printf 'os=%s\n' \"\$(sw_vers -productVersion)\"
  printf 'node=%s\n' \"\$(command -v node >/dev/null 2>&1 && node -v || echo MISSING)\"
  printf 'pnpm=%s\n' \"\$(command -v pnpm >/dev/null 2>&1 && pnpm -v || echo MISSING)\"
  # command -v FIRST. A bare \`cargo --version | cut\` yields an EMPTY string
  # when cargo is absent — cut succeeds on empty input — and empty then passed
  # the 'is it MISSING' check on a machine with no cargo at all.
  printf 'cargo=%s\n' \"\$(command -v cargo >/dev/null 2>&1 && cargo --version | cut -d' ' -f2 || echo MISSING)\"
  printf 'checkout=%s\n' \"\$([ -d \"\$HOME/$REMOTE_CHECKOUT\" ] && echo yes || echo MISSING)\"
")" || fail "cannot reach $remote over ssh"

# PARSED, NOT EVAL'D. `eval` on this would execute whatever the remote sent —
# a login banner, a shell rc that prints, or a crafted version string carrying
# a newline and a command. Only these keys are recognised and each value is
# assigned as data.
console_user=''; ssh_user=''; locked=''; os=''; node=''; pnpm=''; cargo=''; checkout=''
while IFS='=' read -r key value; do
  case "$key" in
    console_user) console_user="$value" ;;
    ssh_user) ssh_user="$value" ;;
    locked) locked="$value" ;;
    os) os="$value" ;;
    node) node="$value" ;;
    pnpm) pnpm="$value" ;;
    cargo) cargo="$value" ;;
    checkout) checkout="$value" ;;
    *) ;;  # anything unrecognised is noise from the remote's shell, not data
  esac
done <<< "$preflight"

[ -n "$ssh_user" ] || fail "preflight returned nothing usable from $remote"

echo "  macOS $os · node $node · pnpm $pnpm · cargo $cargo"

[ "$console_user" = "$ssh_user" ] \
  || fail "the console user on $remote is '$console_user' but this connects as '$ssh_user'.
An app launched into another user's session gets no window, and WebKit suspends
a webview that has no window: it would answer the bridge and never render."

[ "$locked" = "no" ] \
  || fail "$remote's screen is $([ "$locked" = "unknown" ] && echo 'lock state UNKNOWN' || echo 'LOCKED').
Unlock it at that Mac — a locked screen suspends the webview exactly as an
occluded window does, and every bridge call then fails after the session
connects. An unknown state is refused rather than assumed unlocked."

[ "$node" != "MISSING" ] || fail "no node on $remote (expected Homebrew node@24)."
[ "$pnpm" != "MISSING" ] || fail "no pnpm on $remote (corepack prepare pnpm@10.33.0 --activate)."
[ "$cargo" != "MISSING" ] || fail "no cargo on $remote."

# Checked AFTER --sync is considered, because --sync is what creates it. The
# earlier order refused a missing checkout while telling the operator to pass
# the flag that would have made one.
if [ "$checkout" = "MISSING" ] && [ "$sync" -eq 0 ]; then
  fail "no checkout at ~/$REMOTE_CHECKOUT on $remote — run with --sync to create it."
fi

# ---------------------------------------------------------------------------
# Push the tree
# ---------------------------------------------------------------------------

if [ "$sync" -eq 1 ]; then
  say "Syncing the working tree"
  ssh "${SSH_OPTS[@]}" "$remote" "mkdir -p \"\$HOME/$REMOTE_CHECKOUT\""

  # Build outputs are excluded, not copied: `src-tauri/target` alone is several
  # GB and the remote's own is warm. --delete so a file removed here cannot
  # survive there and be imported by a stale path.
  #
  # `.git/` IS EXCLUDED, and that matters more than it looks: with --delete, a
  # sync into a path that happens to be somebody's real checkout would rewrite
  # its refs, config and objects. The remote needs a working tree to run
  # `pnpm app`, not a repository.
  rsync -a --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' --exclude 'src-tauri/target/' --exclude 'dist/' \
    --exclude 'coverage/' --exclude '.types/' --exclude '*.tsbuildinfo' \
    -e "ssh ${SSH_OPTS[*]}" \
    "$REPO_ROOT/" "$remote:$REMOTE_CHECKOUT/"

  ssh "${SSH_OPTS[@]}" "$remote" "
    export PATH=\"$REMOTE_PATH\"
    cd \"\$HOME/$REMOTE_CHECKOUT\" && pnpm install --frozen-lockfile
  " >/dev/null
  echo "  tree and dependencies in place"
fi

# ---------------------------------------------------------------------------
# Launch the satchel
# ---------------------------------------------------------------------------

say "Launching the satchel"

# Anything already listening is stopped and CONFIRMED GONE before launching, so
# that "the port is now occupied" below means this launch and not a survivor.
remote_stop || fail "could not clear $remote:$BRIDGE_PORT_REMOTE before launching."

# From here on an interrupt would otherwise leave the remote app, its Terminal
# window, the launch file and a half-open tunnel behind.
launched=0
cleanup() {
  local code=$?
  if [ "$launched" -eq 1 ] && [ "$code" -ne 0 ]; then
    echo "" >&2
    echo "cleaning up the half-started satchel on $remote…" >&2
    remote_stop || true
    close_tunnel
    # The launch file too — leaving it behind is how the next run's operator
    # finds a script nobody remembers writing.
    ssh "${SSH_OPTS[@]}" "$remote" "rm -f \"$LAUNCH_FILE\"" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ARMED BEFORE THE FIRST REMOTE WRITE, not after. The launch file is the first
# thing this script leaves on the other machine, so if its own pipeline fails
# half-way the cleanup has to already be responsible for it.
launched=1

# The command is written to a file on the remote rather than threaded through
# bash → ssh → osascript → AppleScript → sh as one string. Four levels of
# quoting is how a harness ends up running something nobody wrote.
#
# BUILT WITH printf, NOT A HEREDOC. An unquoted heredoc performs command
# substitution on its body, and `$REMOTE_PATH` is settable from the environment
# — so `PAPER_REMOTE_PATH='$(…)'` would have run locally, right here, before
# ssh ever saw it. printf takes each line as a single argument and a parameter
# expansion's RESULT is never rescanned, so the values arrive as text.
printf '%s\n' \
  '#!/bin/sh' \
  '# Written by scripts/second-instance.sh. Safe to delete.' \
  "export PATH=\"$REMOTE_PATH\"" \
  "cd \"\$HOME/$REMOTE_CHECKOUT\" || exit 1" \
  'PAPER_ROLE=satchel exec pnpm app' \
  | ssh "${SSH_OPTS[@]}" "$remote" "cat > \"$LAUNCH_FILE\" && chmod +x \"$LAUNCH_FILE\""

ssh "${SSH_OPTS[@]}" "$remote" \
  'osascript -e "tell application \"Terminal\" to do script \"$HOME/.paper-satchel-launch.sh\"" -e "tell application \"Terminal\" to activate"' \
  >/dev/null

# Readiness = a listener on the bridge port WHOSE WORKING DIRECTORY IS OUR
# CHECKOUT. The port alone proves only that something is listening, which is
# how a stale instance once satisfied this check while the real launch had
# already died. The port was confirmed free above, so an owner match here is
# this launch.
#
# It still does not prove the webview answers or that PAPER_ROLE took — that
# needs the MCP bridge, which is not reachable from bash. Assert
# `peer_local_role()` over the bridge before trusting the run; the banner below
# says so.
#
# A MONOTONIC deadline, not an iteration count: each failed probe costs up to
# ConnectTimeout on top of the sleep, so 900 iterations was somewhere between
# 15 minutes and hours, and the "after N s" it printed was neither.
say "Waiting for the satchel's bridge (a cold build compiles iroh first)"
readonly WAIT_SECONDS=900
started_at=$SECONDS
while :; do
  # THE MATCH IS MADE ON THE REMOTE, against its own `$HOME`, because only the
  # remote knows what `~/$REMOTE_CHECKOUT` resolves to. Comparing here with a
  # `*/relative/path` suffix accepted the same relative path under ANY home —
  # a different user's identical checkout would have passed.
  # The verdict is trusted only if the probe SUCCEEDED. `$(… || true)` keeps
  # whatever was printed before a non-zero exit, so a probe that emitted `ours`
  # and then died would have been read as a clean match — the same
  # partial-output-looks-like-success shape this script exists to avoid.
  if ! owner="$(ssh "${SSH_OPTS[@]}" "$remote" "
    checkout=\"\$HOME/$REMOTE_CHECKOUT\"
    pid=\$(lsof -nP -iTCP:$BRIDGE_PORT_REMOTE -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
    [ -n \"\$pid\" ] || exit 0
    cwd=\$(lsof -a -p \"\$pid\" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    [ -n \"\$cwd\" ] || exit 0
    case \"\$cwd\" in
      \"\$checkout\"|\"\$checkout\"/*) printf 'ours %s\n' \"\$cwd\" ;;
      *) printf 'other %s\n' \"\$cwd\" ;;
    esac
  " 2>/dev/null)"; then
    owner=''
  fi

  case "$owner" in
    ours\ *)
      echo "  bridge up after $((SECONDS - started_at))s (owner cwd: ${owner#ours })"
      break
      ;;
    other\ *)
      fail "$remote:$BRIDGE_PORT_REMOTE is held by a process in '${owner#other }',
which is not ~/$REMOTE_CHECKOUT. Refusing to drive somebody else's app."
      ;;
  esac

  # The deadline bounds when we stop STARTING probes, not total elapsed time: a
  # probe begun just under it still runs to its own end, so the worst case
  # before this reports failure is WAIT_SECONDS + one probe + this sleep.
  # Checked after the sleep so the next iteration cannot start a probe past the
  # line.
  sleep 1
  if [ $((SECONDS - started_at)) -ge "$WAIT_SECONDS" ]; then
    fail "the satchel's bridge never came up on $remote:$BRIDGE_PORT_REMOTE
within ${WAIT_SECONDS}s. Look at the Terminal window on that Mac — the build's
output is in it."
  fi
done

# ---------------------------------------------------------------------------
# Forward the bridge
# ---------------------------------------------------------------------------

say "Forwarding the bridge"

close_tunnel

# The local port must be FREE first. Without that, ssh can come up having failed
# to install the forward and a probe of the port then succeeds against whatever
# unrelated service already owned it — a tunnel that tests green and carries
# nothing.
if lsof -nP -iTCP:"$BRIDGE_PORT_LOCAL" -sTCP:LISTEN -t >/dev/null 2>&1; then
  fail "127.0.0.1:$BRIDGE_PORT_LOCAL is already in use here. Pass --local-port N."
fi

# The plugin binds 127.0.0.1 on purpose (`lib.rs`), so the port is not reachable
# across the network and a tunnel is the only way in. This does not widen that:
# the forward terminates on THIS machine's loopback.
#
# ExitOnForwardFailure is what makes the failure loud — without it ssh happily
# stays up with no forward installed. The same BatchMode/ConnectTimeout as every
# other call, so this one cannot sit at a password prompt either.
ssh "${SSH_OPTS[@]}" \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -f -N -L "${BRIDGE_PORT_LOCAL}:127.0.0.1:${BRIDGE_PORT_REMOTE}" "$remote" \
  || fail "the tunnel to $remote could not be established."

nc -z 127.0.0.1 "$BRIDGE_PORT_LOCAL" \
  || fail "the tunnel did not come up on 127.0.0.1:$BRIDGE_PORT_LOCAL"

# Got here: the run is good, so the EXIT trap must not tear it down.
launched=0

cat <<EOF

  Satchel   $remote — role satchel, its own \$APPDATA, bridge $BRIDGE_PORT_REMOTE there
  Reachable here at 127.0.0.1:$BRIDGE_PORT_LOCAL
  Output    the Terminal window on that Mac

  The shelf is this machine's own Paper — \`pnpm app\` (bridge $BRIDGE_PORT_REMOTE).

  Drive both:
    driver_session({action: "start", port: $BRIDGE_PORT_REMOTE})   # shelf, here
    driver_session({action: "start", port: $BRIDGE_PORT_LOCAL})   # satchel, over the tunnel

  ASSERT FIRST, before pairing. On one machine each the data-root STRINGS are
  identical (\$APPDATA resolves the same under the same username), so the
  one-machine plan's "distinct data roots" becomes "distinct hosts" here. What
  must differ: host · peer_status().endpointId · peer_local_role() · bridge port.

  This script proved the bridge's OWNER, not that its webview answers. Check
  peer_local_role() reads "satchel" before trusting anything the run reports.

  Take it down with:  scripts/second-instance.sh $remote --stop
EOF

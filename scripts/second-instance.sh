#!/usr/bin/env bash
#
# Stand a satchel up on a SECOND MAC and make its automation bridge reachable
# from this one, so the shelf ⇄ satchel scenario (WI-8.6) can be driven from a
# single place.
#
# ---------------------------------------------------------------------------
# WHY A SECOND MACHINE, and not two processes on this one
# ---------------------------------------------------------------------------
#
# The plan originally called for two instances here, separated by
# `PAPER_TEST_DATA_DIR`. That variable moves only HALF the app, and not the half
# holding the books:
#
#   * `tauri-plugin-peer` honours it — `peer/identity.key`, blob landings and
#     `fs_fsync` all resolve through `paper_data_root`;
#   * the kernel does not — `bookVault.ts`, `appStorage.ts` and `bookFiles.ts`
#     pass `BaseDirectory.AppData`, so `index.json`, every book folder, the flat
#     store AND `sync/journal.*` land in the real `$APPDATA` regardless.
#
# Measured 2026-08-20, not inferred: launched with the override set, the app put
# `peer/identity.key` under the override and everything else under `$APPDATA`.
# Two instances started that way SHARE ONE BOOK VAULT while holding separate
# identities — they would appear to sync and would be proving nothing. And they
# look healthy while doing it: the journal writes its meta file and only
# diverges at the first append, when `fs_fsync` is handed a path built from the
# peer root for a file the kernel wrote somewhere else.
#
# Two machines have two `$APPDATA`s by construction, need no override, and
# exercise the real LAN path instead of loopback — which phase D's device e2e
# needs anyway. That is the harness. The one-machine variant is not repaired
# here; `PAPER_TEST_DATA_DIR` remains a knob that moves half the app.
#
# ---------------------------------------------------------------------------
# WHY A DEV CHECKOUT, and not a bundle shipped over
# ---------------------------------------------------------------------------
#
# Shipping `Paper.app` would be far simpler and does not work: THE MCP BRIDGE
# ONLY FUNCTIONS AGAINST `tauri dev`. Against a bundled debug build every
# webview call — `execute_js`, `dom_snapshot`, `screenshot`, `read_logs` —
# fails identically with "Resolve-ref helper was not available in the webview
# after registration", while the bridge still binds its port and accepts a
# session. A satchel that connects and cannot be driven is the worst outcome
# available, because it looks like the harness working.
#
# Three explanations were tested and refuted (2026-08-20), so nobody repeats
# them:
#
#   * `withGlobalTauri` false in a bundle — rebuilt with `--config
#     src-tauri/tauri.dev.conf.json`, which sets it true. Still fails.
#   * the bundle's CSP blocking the injected helper — widened to
#     `'unsafe-eval' 'unsafe-inline'`, verified single fresh process. Still
#     fails. (The widening was reverted; it bought nothing.)
#   * the window occluded, WebKit suspending the webview — app confirmed
#     frontmost. Still fails.
#
# The control passes: `pnpm app` returns `hasTauri: "object"` and
# `visibility: "visible"`. The cause inside the plugin was not isolated. Until
# it is, the satchel runs from a checkout.
#
# ---------------------------------------------------------------------------
# WHY `osascript`, and not ssh or launchctl
# ---------------------------------------------------------------------------
#
# An app started from an ssh session lands in that session, not the Aqua one:
# no window, and WebKit suspends a webview that has no window, so the app
# answers the bridge and never renders a frame. `launchctl asuser <uid>` is the
# documented crossing and needs root — as the console user over ssh it fails
# with `Could not switch to audit session … Operation not permitted` (measured,
# macOS 26.6.2). Asking Terminal.app — already in the session — to run the
# command needs no privilege. macOS may prompt once, at that Mac's screen, to
# allow the automation.
#
# The remote screen must also be UNLOCKED. A locked screen is an invisible
# window by another name, and the same suspension follows.
#
# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#
#   scripts/second-instance.sh <user@host> [--sync] [--local-port N] [--stop]
#
#     --sync         push this working tree to the remote checkout first
#     --local-port   where the remote bridge surfaces here (default 31416)
#     --stop         stop the satchel and close the tunnel
#
# The host is an ARGUMENT with no default on purpose: this file is committed,
# and an internal hostname or private address does not belong in it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

# Where the checkout lives on the remote, relative to its home. Relative so the
# remote shell resolves it and this file never has to know a home directory.
readonly REMOTE_CHECKOUT='github/xiaolai/myprojects/paper-one'

# Homebrew's node@24 is keg-only, so it is not on a non-interactive PATH; cargo
# is under ~/.cargo. Set explicitly rather than editing the remote's ~/.zshrc —
# a harness should not leave its footprints in somebody's shell profile.
readonly REMOTE_PATH='/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$PATH'

# The bridge's pinned port (`src-tauri/src/lib.rs`). The remote instance keeps
# it — it is alone over there — and the tunnel gives it a different number HERE
# so it cannot collide with the local shelf's.
readonly BRIDGE_PORT_REMOTE=31415
BRIDGE_PORT_LOCAL=31416

remote=''
sync=0
stop=0

while [ $# -gt 0 ]; do
  case "$1" in
    --sync) sync=1 ;;
    --stop) stop=1 ;;
    --local-port) BRIDGE_PORT_LOCAL="${2:?--local-port needs a number}"; shift ;;
    -h|--help) sed -n '2,95p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) remote="$1" ;;
  esac
  shift
done

if [ -z "$remote" ]; then
  echo "usage: scripts/second-instance.sh <user@host> [--sync] [--local-port N] [--stop]" >&2
  exit 2
fi

readonly SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

close_tunnel() {
  pkill -f "ssh -f -N -L ${BRIDGE_PORT_LOCAL}:127.0.0.1:${BRIDGE_PORT_REMOTE} ${remote}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# --stop
# ---------------------------------------------------------------------------

if [ "$stop" -eq 1 ]; then
  say "Stopping the satchel on $remote"
  # The app is killed BY PORT, not by name.
  #
  # `tauri dev` execs the binary with a RELATIVE command line —
  # `target/debug/app` — so a pattern written against the absolute path matches
  # nothing and silently leaves the instance running. That is how a stale app
  # from an earlier run kept answering on the bridge while a fresh `pnpm app`
  # had already died on "port 14201 in use": the readiness check passed, against
  # the wrong process. The listening socket is unambiguous; the command line is
  # not.
  #
  # vite is named separately because killing `tauri dev` alone orphans it, and
  # it then holds 14201 against the next run — the other half of that same
  # failure.
  ssh "${SSH_OPTS[@]}" "$remote" "
    pid=\$(lsof -nP -iTCP:$BRIDGE_PORT_REMOTE -sTCP:LISTEN -t 2>/dev/null || true)
    [ -n \"\$pid\" ] && kill \$pid 2>/dev/null || true
    pkill -f 'tauri.js dev' 2>/dev/null || true
    pkill -f 'paper-one/node_modules/.*vite' 2>/dev/null || true
    exit 0
  " || true
  close_tunnel
  echo "satchel stopped, tunnel closed"
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

say "Preflight: $remote"

# One round trip, so a machine that is asleep costs one timeout and not six.
preflight="$(ssh "${SSH_OPTS[@]}" "$remote" "
  export PATH=\"$REMOTE_PATH\"
  printf 'console_user=%s\n' \"\$(stat -f%Su /dev/console)\"
  printf 'ssh_user=%s\n' \"\$(id -un)\"
  printf 'locked=%s\n' \"\$(ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked | grep -c true)\"
  printf 'os=%s\n' \"\$(sw_vers -productVersion)\"
  printf 'node=%s\n' \"\$(node -v 2>/dev/null || echo MISSING)\"
  printf 'pnpm=%s\n' \"\$(pnpm -v 2>/dev/null || echo MISSING)\"
  # cut, not awk: \$2 has to survive bash → ssh → the remote shell, and an awk
  # program is one more level of quoting than that trip can carry. It arrived as
  # a syntax error and read as a MISSING cargo on a machine that had one.
  printf 'cargo=%s\n' \"\$(cargo --version 2>/dev/null | cut -d' ' -f2 || echo MISSING)\"
  printf 'checkout=%s\n' \"\$([ -d \"\$HOME/$REMOTE_CHECKOUT\" ] && echo yes || echo MISSING)\"
")" || { echo "cannot reach $remote over ssh" >&2; exit 1; }

# These names arrive through the eval, which is why shellcheck cannot see them
# assigned (SC2154).
# shellcheck disable=SC2154
eval "$preflight"

echo "  macOS $os · node $node · pnpm $pnpm · cargo $cargo"

fail() { echo "REFUSING: $*" >&2; exit 1; }

[ "$console_user" = "$ssh_user" ] \
  || fail "the console user on $remote is '$console_user' but this connects as '$ssh_user'.
An app launched into another user's session gets no window, and WebKit suspends
a webview that has no window: it would answer the bridge and never render."

[ "$locked" = "0" ] \
  || fail "$remote's screen is LOCKED. Unlock it at that Mac — a locked screen
suspends the webview exactly as an occluded window does, and every bridge call
then fails after the session connects."

[ "$node" != "MISSING" ] || fail "no node on $remote (expected Homebrew node@24)."
[ "$pnpm" != "MISSING" ] || fail "no pnpm on $remote (corepack prepare pnpm@10.33.0 --activate)."
[ "$cargo" != "MISSING" ] || fail "no cargo on $remote."
[ "$checkout" != "MISSING" ] || fail "no checkout at ~/$REMOTE_CHECKOUT on $remote — run with --sync."

# ---------------------------------------------------------------------------
# Push the tree
# ---------------------------------------------------------------------------

if [ "$sync" -eq 1 ]; then
  say "Syncing the working tree"
  # Build outputs are excluded, not copied: `src-tauri/target` alone is several
  # GB and the remote's own is warm. --delete so a file removed here cannot
  # survive there and be imported by a stale path.
  rsync -a --delete \
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

# Same by-port kill as `--stop`, and for the same reason: a leftover instance
# answering the bridge is indistinguishable from a fresh one that came up.
ssh "${SSH_OPTS[@]}" "$remote" "
  pid=\$(lsof -nP -iTCP:$BRIDGE_PORT_REMOTE -sTCP:LISTEN -t 2>/dev/null || true)
  [ -n \"\$pid\" ] && kill \$pid 2>/dev/null || true
  pkill -f 'tauri.js dev' 2>/dev/null || true
  pkill -f 'paper-one/node_modules/.*vite' 2>/dev/null || true
  exit 0
" || true

# The command is written to a file on the remote rather than threaded through
# bash → ssh → osascript → AppleScript → sh as one string. Four levels of
# quoting is how a harness ends up running something nobody wrote.
ssh "${SSH_OPTS[@]}" "$remote" "cat > \$HOME/.paper-satchel-launch.sh" <<EOF
#!/bin/sh
# Written by scripts/second-instance.sh. Safe to delete.
export PATH="$REMOTE_PATH"
cd "\$HOME/$REMOTE_CHECKOUT" || exit 1
PAPER_ROLE=satchel exec pnpm app
EOF
ssh "${SSH_OPTS[@]}" "$remote" 'chmod +x $HOME/.paper-satchel-launch.sh'

ssh "${SSH_OPTS[@]}" "$remote" \
  'osascript -e "tell application \"Terminal\" to do script \"$HOME/.paper-satchel-launch.sh\"" -e "tell application \"Terminal\" to activate"' \
  >/dev/null

# The bridge listening is the readiness signal, not the process existing — a
# process that died on launch still satisfies `pgrep` for a moment. The wait is
# long because a cold `tauri dev` compiles the Rust side first.
say "Waiting for the satchel's bridge (a cold build compiles iroh first)"
for attempt in $(seq 1 900); do
  if ssh "${SSH_OPTS[@]}" "$remote" "nc -z 127.0.0.1 $BRIDGE_PORT_REMOTE" 2>/dev/null; then
    echo "  bridge up after ${attempt}s"
    break
  fi
  if [ "$attempt" -eq 900 ]; then
    fail "the satchel's bridge never came up on $remote:$BRIDGE_PORT_REMOTE.
Look at the Terminal window on that Mac — the build's output is in it."
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# Forward the bridge
# ---------------------------------------------------------------------------

say "Forwarding the bridge"

close_tunnel
# The plugin binds 127.0.0.1 on purpose (`lib.rs`), so the port is not reachable
# across the network and a tunnel is the only way in. This does not widen that:
# the forward terminates on THIS machine's loopback.
ssh -f -N -L "${BRIDGE_PORT_LOCAL}:127.0.0.1:${BRIDGE_PORT_REMOTE}" "$remote"

nc -z 127.0.0.1 "$BRIDGE_PORT_LOCAL" \
  || fail "the tunnel did not come up on 127.0.0.1:$BRIDGE_PORT_LOCAL"

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
  must differ: host · peer_status().id · peer_local_role() · bridge port.

  Take it down with:  scripts/second-instance.sh $remote --stop
EOF

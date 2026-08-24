#!/usr/bin/env bash
#
# Compile `src-tauri/icons/Paper.icon` into the `Assets.car` that macOS 26 needs
# in order to draw the Dock icon with the Liquid Glass treatment.
#
# Why this exists at all: a `.icns` is a bag of flat bitmaps, so macOS 26 has
# nothing to light and renders it exactly as drawn. The glass — the squircle
# mask, the drop shadow, the background gradient, the specular highlight on each
# layer — is applied by the system at composite time, and the system will only
# do that for a layered `.icon` compiled into an asset catalogue. There is no
# flag, plist key or image trick that gets it out of a `.icns`.
#
# The output is committed to the repo on purpose. Compiling it needs Xcode, and
# `cargo build` should not: this mirrors `icon.icns` and the PNG set, which are
# generated once and checked in. Re-run this script whenever `Paper.icon`
# changes, which is the same rule those files already follow.
#
# `actool`'s failure modes, re-measured on Xcode 26.4.1 (2026-08-24). An earlier
# note here claimed it fails silently on any bad input; that is NOT true on this
# toolchain, and believing it aims the guard below at the wrong hazard:
#
#   bad enum ("kind": "bogus-value")   exit 1, no catalogue, 3 error lines
#   missing asset (image-name absent)  exit 1, no catalogue, 3 error lines
#   malformed fill colour              exit 1, no catalogue, 3 error lines
#   UNKNOWN KEY                        exit 0, catalogue written, NO error
#
# So the three loud cases are already caught by `set -e`. The one that still
# slips through is an unknown key: actool ignores it, exits 0, and emits a
# catalogue byte-identical to the correct one — verified by diffing sizes. That
# means a mistyped key silently has no effect, and NO existence check can catch
# it. Only rendering the compiled icon and inspecting pixels can.
#
# The check below is kept anyway: it costs nothing, and it still fires if a
# future toolchain regresses to the silent behaviour, or on an older Xcode.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icon_src="$repo_root/src-tauri/icons/Paper.icon"
out_file="$repo_root/src-tauri/icons/Assets.car"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos-glass-icon: macOS only — nothing to do on $(uname -s)." >&2
  exit 0
fi

actool="$(xcrun --find actool 2>/dev/null || true)"
if [[ -z "$actool" ]]; then
  echo "build-macos-glass-icon: actool not found. Install Xcode 26 or newer" >&2
  echo "  (the Command Line Tools alone do not ship actool)." >&2
  exit 1
fi

[[ -f "$icon_src/icon.json" ]] || { echo "missing $icon_src/icon.json" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The input is the `.icon` itself, not a directory containing it and not an
# `.xcassets`. Both of those are accepted and silently compile nothing.
#
# --minimum-deployment-target 26.0 is what selects the glass renderer;
# --output-partial-info-plist is not optional even though we discard the plist,
# because actool refuses to compile app icons without it.
"$actool" "$icon_src" \
  --compile "$work" \
  --output-partial-info-plist "$work/partial.plist" \
  --app-icon Paper \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --minimum-deployment-target 26.0 \
  --platform macosx \
  --output-format human-readable-text --notices --warnings --errors

if [[ ! -s "$work/Assets.car" ]]; then
  echo "build-macos-glass-icon: actool produced no Assets.car." >&2
  echo "  On Xcode 26.4.1 actool normally exits non-zero and set -e catches it" >&2
  echo "  first, so reaching here means it exited 0 and still wrote nothing —" >&2
  echo "  an older or regressed toolchain." >&2
  echo "  Check icon.json against the keys actool accepts, and confirm every" >&2
  echo "  image-name resolves to a file in Paper.icon/Assets/." >&2
  exit 1
fi

# actool will also emit a Paper.icns, but it carries only the 16pt and 128pt
# representations — no 512@2x, so a Retina Dock would upscale it. The
# hand-built icons/icon.icns keeps the full ladder and stays the legacy
# fallback; this script deliberately does not touch it.
cp "$work/Assets.car" "$out_file"
echo "build-macos-glass-icon: wrote $out_file ($(wc -c <"$out_file" | tr -d ' ') bytes)"

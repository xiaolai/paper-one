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
# `actool` fails SILENTLY. Given a manifest with a bad enum, a missing asset or
# an unknown key it prints nothing, exits 0, and writes no catalogue — verified
# by feeding it `"kind": "bogus-value"`. So every check below is load-bearing:
# without them a broken icon looks exactly like a successful build.

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
  echo "  It exits 0 on a malformed icon.json, so this is the real error." >&2
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

#!/usr/bin/env node
/**
 * Stage the inference runtime — llama.cpp's `llama-server` and the libraries
 * beside it — into `vendor/inference/current/`, under a per-file manifest.
 *
 * WI-15.0's missing half, and WI-20.24's. `tauri-plugin-inference` resolves
 * the runtime from the bundle — `resource_dir()/runtime/`, never from `PATH`,
 * because a `PATH` lookup is the reader's shell deciding which binary Paper
 * supervises, and that one is handed a bearer token and the reader's model.
 * So something has to put it there, and this is it.
 *
 * # One program, and it is llama.cpp's
 *
 * Until 2026-09-18 the tree held Lemonade's `lemond` as well: a daemon Paper
 * launched, which in turn launched the llama.cpp server on Paper's behalf.
 * The plugin launches `llama-server` DIRECTLY now, in single-model mode
 * (`spawn.rs` has the flag table and the reasons), so the Lemonade archive is
 * not fetched at all and nothing in the tree is Lemonade's. What is staged is
 * one llama.cpp release, unpacked under `backend/llamacpp/<backend>/`, and the
 * manifest that vouches for every byte of it.
 *
 * # Why the llama.cpp release is staged at all — WI-20.24
 *
 * The staged tree once held `lemond` alone. The backend it actually ran —
 * `llama-server` and the ten `@rpath` libraries beside it, sixty-one files on
 * macOS — was fetched by the daemon from GitHub inside the FIRST GLOSS, with
 * no hash Paper controlled, needing the network, and `spawn.rs` called it
 * "the vetted builtin". Upstream publishes neither signatures nor a codesign
 * step, and a file libcurl downloads carries no quarantine flag, so
 * Gatekeeper never looks at it. Only a hash Paper records itself stands
 * between GitHub and `exec`. That is why the archive pinned below is staged
 * here — and with the daemon gone, it is now the whole of what is staged.
 *
 * # Why a download rather than a committed binary
 *
 * Four platforms × ~40 MB of compiled artifact is not a thing to keep in git
 * history, and `vendor/pdfjs/` sets the precedent for staged-not-committed
 * (see `.gitignore`). The safety that a committed binary would buy — you can
 * see exactly what ships — is bought instead by the DIGEST TABLE below,
 * which is committed, reviewable, and checked on every run.
 *
 * # Two digests, two jobs
 *
 * Each ARCHIVE is verified against a pinned SHA-256 before anything is
 * unpacked. A mismatch FAILS THE BUILD rather than warning: this is an
 * executable Paper will launch with a credential, and "the download looked
 * different today" is the one case where carrying on is indefensible. Every
 * archive digest below was computed from the bytes actually fetched from the
 * GitHub release on 2026-08-28, and each also matches the per-asset digest
 * GitHub publishes.
 *
 * Then every FILE of the unpacked tree is recorded in `runtime.manifest.json`
 * — size and SHA-256 each — which the plugin reads back and checks against
 * the tree BEFORE EVERY SPAWN (`runtime.rs`). A byte flipped in a library, a
 * file missing, or a file the manifest never heard of, refuses the launch
 * and names itself. The manifest is what the reader's machine can verify;
 * the archive digest is what this build could.
 *
 * # No symlinks, and the reason is measured
 *
 * The llama.cpp archives carry each library as a versioned file plus
 * bare-name symlinks to it (`libggml.dylib → libggml.0.dylib`). The first
 * draft recorded a link by its target — and `tauri-build` copies resources
 * with `fs::copy`, which DEREFERENCES: `target/debug/runtime/` held a
 * 59 872-byte regular file where the staged tree held a link, and would have
 * failed its own manifest on the first spawn. So every link is turned into
 * the file it named before the manifest is built (`dereferenceLinks`), the
 * manifest lists regular files only, and the plugin refuses a link anywhere
 * in the tree. The bundle is byte-for-byte what it would have been; only
 * `vendor/` grows, by the copies the bundle would have made anyway.
 *
 * # Only what the server needs — decided by a rule, not a list
 *
 * The release is llama.cpp's whole toolbox: 61 files and 57.3 MB on macOS,
 * of which Paper runs one program. The rest — `llama-cli`, `llama-bench`,
 * `llama-quantize`, `llama-tts`, the `llama` multicall binary, and
 * `ggml-rpc-server`, which is a NETWORK SERVER — would ship inside the app
 * for nothing to launch. `trimToServer` keeps the server and its own `-impl`
 * library (the program's body; the executable is a stub that calls it),
 * every other shared library, and anything that cannot be run at all (the
 * licence). It drops every other program and every OTHER tool's `-impl`.
 *
 * A rule rather than a per-platform file list because three of the four
 * platforms cannot be run from here, and a list read off their archives
 * would be a guess about their loaders. And "every shared library" rather
 * than a dependency closure because the closure is not the whole story: the
 * Linux and Windows builds carry the CPU backend as fourteen
 * per-instruction-set libraries that ggml's registry finds by SCANNING the
 * server's directory at startup (`ggml-backend-reg.cpp`), and no dependency
 * list names any of them.
 *
 * ## `ggml-rpc` stays, deliberately
 *
 * The RPC backend lets a process offload work to a remote machine. It stays
 * on every platform. On macOS the server links it directly, and removing it
 * stops dyld from loading the server at all: MEASURED 2026-09-18, `Library
 * not loaded: @rpath/libggml-rpc.0.dylib`, exit 134. On Linux and Windows it
 * is scanned for and could go, but that would make this a per-platform rule,
 * and the library is dormant client code: it dials out only to servers named
 * by `--rpc` or `LLAMA_ARG_RPC` (`common/arg.cpp`). Paper never passes the
 * flag, and `spawn.rs` clears every inherited `LLAMA_` variable. The
 * network-facing half, `ggml-rpc-server`, is a program, so the rule drops it.
 *
 * ## One name per library, where the loader asks for one
 *
 * Each library arrives under three names — `libggml.0.19.0.dylib`, plus the
 * links `libggml.0.dylib` and `libggml.dylib` — and since links become
 * copies (above), keeping all three shipped every library three times: about
 * 30 MB of the macOS tree. The loader asks for ONE name, the one the binary
 * that depends on the library recorded (`@rpath/libggml.0.dylib` in a Mach-O
 * load command, `libggml.so.0` in ELF's `DT_NEEDED`). So a library keeps the
 * names that some kept binary records as a NUL-terminated string. That is
 * how all three formats store a dependency's name. A library that no kept
 * binary names keeps EVERY name, because nothing in the bytes says which one
 * a scan will look for. A library's record of its OWN name (`LC_ID_DYLIB`,
 * `DT_SONAME`) does not count, or every library would vouch for itself.
 *
 * # Replaced by rename, never in place
 *
 * macOS caches a Mach-O's signature in the kernel by inode and does not
 * flush it when the bytes change (Apple, "Updating Mac software"), so
 * overwriting a staged binary is how a "killed: 9" appears after a re-stage.
 * The new tree is built whole under `current.staging`, the old one is moved
 * to `current.previous`, the new one takes the name, and only then is the
 * old one removed. An interrupted run leaves one or both behind; they are
 * swept before the next run begins, so a stale `.previous` cannot outlive
 * the run that made it.
 *
 * # It is not fatal to be unable to fetch
 *
 * A build with no network, or a platform with no published artifact, leaves
 * the directory empty and says so. That is F2's rule reaching the build:
 * ABSENT IS A NORMAL STATE. The plugin reports `Absent`, the settings section
 * says `Not installed`, and the Codex and Claude routes — which need no
 * download at all — go on working. A sync script that failed the build here
 * would do exactly what F2 spends a page forbidding.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Where the runtime is staged — PLATFORM-NEUTRAL, deliberately.
 *
 * `tauri.conf.json` names its resources as literal paths and has no way to
 * interpolate the host platform, so a per-platform directory would have meant
 * a hardcoded `darwin-arm64` in the bundle config that silently shipped
 * nothing on Windows. One path, whose CONTENTS are the host's artifact, and a
 * `.version` stamp recording which — so switching platforms invalidates the
 * stamp and re-stages rather than shipping the wrong binary.
 */
export const VENDOR = path.join('vendor', 'inference', 'current')

/**
 * The llama.cpp build the runtime is pinned to — PAPER'S OWN PIN.
 *
 * It started as `lemond`'s: `llamacpp.metal` and `llamacpp.cpu` in Lemonade
 * 11.7.0's `resources/backend_versions.json`, copied here so that what
 * shipped was the build the daemon would otherwise have fetched. With the
 * daemon gone nothing else holds an opinion about it, and it is free to move.
 *
 * ⚠️ **MOVING IT IS NOT A ONE-LINE CHANGE.** Every asset name in `BACKENDS`
 * carries the tag, so every `sha256` there changes with it — each computed
 * from the bytes actually fetched, never copied off a release page, or the
 * table vouches for nothing. And the server has to be measured again under
 * the new build: `spawn.rs`'s flag table and its `LLAMA_API_KEY` were read off
 * `llama-server --help` for this tag, and the health and streaming shapes the
 * plugin parses were captured from it. A new tag that renames a flag fails at
 * launch, not here.
 */
export const LLAMACPP_TAG = 'b10375'

/**
 * One backend per platform: the build that runs everywhere the platform does.
 *
 * `metal` on Apple silicon is the whole story there. `cpu` on Linux and
 * Windows is a decision rather than an oversight: llama.cpp also publishes
 * `vulkan` and `cuda` builds for a machine with the GPU for them — `lemond`'s
 * `auto` used to pick those — and each would be a second staged directory
 * (32–35 MB for Vulkan, 250 MB for CUDA) behind a detection Paper does not
 * make at build time. Adding one is a row here and nothing else; until then a
 * GPU on those platforms is not used.
 *
 * `sha256` is of the ARCHIVE, computed from the bytes fetched on 2026-08-28,
 * and equal to the digest GitHub publishes for the asset. `server` is the
 * executable the plugin launches — the manifest's `llamacpp.server` names it,
 * relative to the runtime directory, and `runtime.rs` hands out its path only
 * after the whole tree has verified.
 */
export const BACKENDS = Object.freeze({
  'darwin-arm64': {
    backend: 'metal',
    asset: `llama-${LLAMACPP_TAG}-bin-macos-arm64.tar.gz`,
    sha256: 'ebbeed128cde32077c5b430feafe57ce20b1bca545f430ff142472014f03bcec',
    server: 'llama-server',
  },
  'linux-x64': {
    backend: 'cpu',
    asset: `llama-${LLAMACPP_TAG}-bin-ubuntu-x64.tar.gz`,
    sha256: 'b6a7ed005240eccd61e1af42debd75b876c639c1416bfa90985fd02618919a88',
    server: 'llama-server',
  },
  'linux-arm64': {
    backend: 'cpu',
    asset: `llama-${LLAMACPP_TAG}-bin-ubuntu-arm64.tar.gz`,
    sha256: '36fb8a1d1836f575db78e56a875d040ddcd19694a60b67f4cce8bb6531d872ac',
    server: 'llama-server',
  },
  'win32-x64': {
    backend: 'cpu',
    asset: `llama-${LLAMACPP_TAG}-bin-win-cpu-x64.zip`,
    sha256: 'c18ad6aa9cef9d119e957472d71e34eb5183848eb9c57f51647fd18692a456c7',
    server: 'llama-server.exe',
  },
})

const LLAMACPP_RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMACPP_TAG}`

/**
 * The manifest the plugin verifies the tree against, at the root of the
 * runtime directory. Its presence is also what `paths::bundled_runtime` takes
 * to mean "a runtime is installed" — no manifest, `Absent`.
 */
export const MANIFEST_FILE = 'runtime.manifest.json'

/**
 * The manifest format; `runtime.rs` reads the same number.
 *
 * 2 since 2026-09-18, when the `lemonade` field left the manifest and `lemond`
 * the tree. `runtime.rs` refuses a version-1 manifest rather than verifying,
 * and shipping, a daemon nothing launches — and it refuses any field it does
 * not read, so `buildManifest` writes these four keys and no other.
 */
export const MANIFEST_VERSION = 2

/**
 * Files that may sit in the tree without a manifest entry: the stamp, the
 * manifest's own slot, and the Finder's droppings. `runtime.rs` ignores the
 * same three by name; none is loadable.
 */
const UNLISTED_BY_DESIGN = new Set(['.version', MANIFEST_FILE, '.DS_Store'])

/** Where a backend's files go under the runtime directory. */
export function backendDir(backend) {
  return path.join('backend', 'llamacpp', backend)
}

/** The key for a platform/arch pair, or null when Paper ships no runtime. */
export function artifactKey(platform, arch) {
  const key = `${platform}-${arch}`
  return Object.hasOwn(BACKENDS, key) ? key : null
}

/** Lowercase hex SHA-256 of a buffer. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Which rule decided what of the release is kept — `trimToServer`'s.
 *
 * It is in the stamp because the stamp is the only thing `isStaged` reads: a
 * tree staged under another rule describes itself perfectly in its own
 * manifest, and the plugin's check would pass it. Without this word, a tree
 * staged before the trim — every tool, every library three times — would
 * read as current and never be replaced. **Change this whenever
 * `trimToServer` would keep a different set.** The pin test puts it beside
 * the rule's own output for that reason.
 */
export const KEEP_RULE = 'server-only-1'

/**
 * What the stamp says for a fully staged tree: the llama.cpp pin, the
 * platform, the backend, and the rule that chose what was kept.
 *
 * ⚠️ **THE SHAPE CHANGED ON 2026-09-18, AND THAT IS WHAT RE-STAGES AN OLD
 * TREE.** A `lemond`-era stamp read `11.7.0 darwin-arm64 llamacpp-b10375
 * metal` — Lemonade's version first. That tree carries the daemon and a
 * version-1 manifest the plugin now refuses, so it must read as NOT staged,
 * or `predev` would keep it and every launch would fail verification. A stamp
 * that begins with `llamacpp-` cannot equal one that begins with a Lemonade
 * version, whatever the pins are. The same day, the trim added `KEEP_RULE`
 * to the end, so a tree staged whole reads as not staged either.
 */
export function stampFor(key) {
  return `llamacpp-${LLAMACPP_TAG} ${key} ${BACKENDS[key].backend} ${KEEP_RULE}`
}

/**
 * Whether `dir` already holds this pin's runtime.
 *
 * Keyed on the STAMP file rather than on the server's presence: a
 * half-unpacked directory has the server and not all of its libraries, and
 * re-running is cheap next to shipping a tree the manifest cannot vouch for.
 */
export function isStaged(dir, key) {
  const stamp = path.join(dir, '.version')
  if (!existsSync(stamp)) return false
  try {
    return readFileSync(stamp, 'utf8').trim() === stampFor(key)
  } catch {
    return false
  }
}

/**
 * Turn every symbolic link under `root` into the regular file it names —
 * see the header. A link that resolves outside the tree, or to nothing, is
 * refused: it is not something the archive was expected to contain, and a
 * manifest must not be built over it.
 */
export function dereferenceLinks(root) {
  const top = realpathSync(root)
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isSymbolicLink()) {
        const target = linkTarget(full, top)
        rmSync(full)
        copyFileSync(target, full)
      }
    }
  }
  walk(root)
}

/**
 * The regular file the link at `full` resolves to — which must exist and
 * sit inside `top` — or a refusal naming it.
 */
function linkTarget(full, top) {
  let target
  try {
    target = realpathSync(full)
  } catch (cause) {
    throw new Error(`${full} links to nothing (${readlinkSync(full)})`, { cause })
  }
  if (!target.startsWith(`${top}${path.sep}`) || !lstatSync(target).isFile()) {
    throw new Error(`${full} links outside the staged tree, to ${target}`)
  }
  return target
}

/**
 * A shared library, by its name, as the three platforms spell one: `.dylib`,
 * `.dll`, and `.so` with or without a version after it (`libggml.so.0.19.0`).
 */
const LIBRARY = /\.(?:dylib|dll|so(?:\.\d+)*)$/i

/**
 * The first bytes of something that can be RUN rather than only loaded: ELF,
 * Mach-O in each byte order, universal Mach-O, PE (an `.exe`, and a `.dll`
 * too — which is why a library is recognised by its name first), and a
 * script with an interpreter line.
 */
const RUNNABLE_MAGIC = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from('MZ'),
  Buffer.from('#!'),
]

/**
 * Cut the unpacked release in `dir` down to what `server` needs — see the
 * header for the rule and why it is a rule. Returns the names kept and
 * dropped, sorted.
 *
 * Every link that survives becomes a regular file here, holding the bytes
 * it named, and every link that does not is removed; so nothing is left for
 * `dereferenceLinks` to do.
 *
 * Refuses, before touching anything, a release that is not flat — a
 * directory, or anything that is neither a file nor a link. llama.cpp's
 * releases are flat, and a new shape is a new decision about what to keep,
 * not something to guess at.
 */
export function trimToServer(dir, server) {
  const top = realpathSync(dir)
  /* Every name, and the regular file it is — or, for a link, the one it
     resolves to. The names that share a file are one library. */
  const fileOf = new Map()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      fileOf.set(entry.name, path.relative(top, linkTarget(full, top)))
    } else if (entry.isFile()) {
      fileOf.set(entry.name, entry.name)
    } else {
      throw new Error(
        `${full} is not a file; the keep rule was written for a flat release, so decide what this is before staging it`,
      )
    }
  }
  /* The server's own body, as Windows (`llama-server-impl.dll`) and
     everything else (`libllama-server-impl.dylib`, `.so`) spell it. Matched
     exactly, so an unexpected capitalisation keeps a library rather than
     dropping one: the safe way to be wrong. */
  const { name: serverStem } = path.parse(server)
  const ownImpl = new Set([`${serverStem}-impl`, `lib${serverStem}-impl`])
  const keeps = (name) => {
    if (name === server) return true
    if (LIBRARY.test(name)) {
      const stem = name.replace(LIBRARY, '')
      return !stem.endsWith('-impl') || ownImpl.has(stem)
    }
    const head = readFileSync(path.join(dir, fileOf.get(name)))
    return !RUNNABLE_MAGIC.some((magic) => head.subarray(0, magic.length).equals(magic))
  }

  const namesOf = new Map()
  for (const name of fileOf.keys()) {
    if (!keeps(name)) continue
    const file = fileOf.get(name)
    namesOf.set(file, [...(namesOf.get(file) ?? []), name])
  }
  /* Asked for BY SOMETHING ELSE THAT IS KEPT: a dropped tool's load
     commands say nothing about what the server needs, and a library's record
     of its own name says nothing about who needs it. The NUL is what makes
     it a whole name: `libggml.so` is the start of `libggml.so.0`. */
  const contents = new Map([...namesOf.keys()].map((file) => [file, readFileSync(path.join(dir, file))]))
  const recorded = (name, own) => {
    const needle = Buffer.from(`${name}\0`)
    return [...contents].some(([file, content]) => file !== own && content.includes(needle))
  }
  const kept = new Set()
  for (const [file, names] of namesOf) {
    const asked = names.filter((name) => recorded(name, file))
    for (const name of asked.length > 0 ? asked : names) kept.add(name)
  }

  /* Copies first, removals after: a kept link may name a file that goes. */
  for (const name of kept) {
    const full = path.join(dir, name)
    if (lstatSync(full).isSymbolicLink()) {
      rmSync(full)
      copyFileSync(path.join(dir, fileOf.get(name)), full)
    }
  }
  const dropped = [...fileOf.keys()].filter((name) => !kept.has(name)).sort()
  for (const name of dropped) rmSync(path.join(dir, name))
  return { kept: [...kept].sort(), dropped }
}

/**
 * The manifest for the tree under `root`: every regular file by size and
 * SHA-256, paths forward-slashed and sorted, and nothing that is unlisted
 * by design. Pure over the directory.
 *
 * Throws on a symbolic link — `dereferenceLinks` runs first, and a link that
 * reaches here is a tree the plugin would refuse — and when the server
 * executable the pin names is not in the tree: a manifest that vouches for
 * a runtime with no server is a manifest for a runtime that cannot answer.
 *
 * The result is built from named fields rather than spread from the caller's
 * object, so nothing the caller passes beyond `platform` and `llamacpp`
 * reaches the file — `runtime.rs` reads the top level and every file entry
 * with `deny_unknown_fields`, and one stray key refuses every spawn.
 */
export function buildManifest(root, { platform, llamacpp }) {
  const files = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, relative)
      } else if (entry.isSymbolicLink()) {
        throw new Error(`${relative} is a symbolic link; the manifest lists regular files only`)
      } else if (entry.isFile()) {
        if (UNLISTED_BY_DESIGN.has(relative)) continue
        const bytes = readFileSync(full)
        files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) })
      }
    }
  }
  walk(root, '')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (!files.some((f) => f.path === llamacpp.server)) {
    throw new Error(`the staged tree has no ${llamacpp.server}; a runtime without its server cannot answer`)
  }
  const { tag, backend, server } = llamacpp
  return { version: MANIFEST_VERSION, platform, llamacpp: { tag, backend, server }, files }
}

/**
 * Recover, then remove, what an interrupted run may have left: a
 * half-unpacked `.staging` and a displaced `.previous`. Both are named for
 * `dir`, both are ours, and neither is the live tree — EXCEPT in the one
 * window `promote` documents, a kill between its two renames, where
 * `.previous` is the ONLY complete runtime and the live name is empty.
 * Deleting it there destroyed a working installation and then bet on the
 * network to replace it; restored by rename instead, which also means a
 * recovered tree short-circuits at the stamp check rather than re-downloading.
 */
export function sweepStale(dir) {
  const previous = `${dir}.previous`
  if (!existsSync(dir) && existsSync(previous)) {
    renameSync(previous, dir)
  }
  rmSync(`${dir}.staging`, { recursive: true, force: true })
  rmSync(previous, { recursive: true, force: true })
}

/**
 * Leave the vendor directory PRESENT but empty, saying why.
 *
 * ⚠️ **`tauri.conf.json` REQUIRES THIS PATH, AND THREE EXITS USED TO LEAVE IT
 * ABSENT.** `bundle.resources` maps `../vendor/inference/current/` to
 * `runtime/`, and Tauri refuses to build when a declared resource does not
 * exist — `resource path `..\vendor\inference\current` doesn't exist`, which
 * names a path and not a cause. So every message in this file promising that
 * "the companion's local route will report Absent" was describing an app that
 * could not be built at all: the runtime being unavailable turned a graceful
 * degradation into a hard bundle failure.
 *
 * MEASURED ON WINDOWS, 2026-08-30, the first time this repository was ever
 * bundled for that platform. It is not a Windows defect — the same thing
 * happens on any host where the fetch fails, and on any platform with no
 * published artifact. It survived because CI's Windows leg is `cargo check`,
 * which never bundles, and because the macOS fetch had always succeeded.
 *
 * The Rust side already handles an empty tree exactly as intended:
 * `paths::bundled_runtime` looks for `runtime/runtime.manifest.json` (it
 * looked for `runtime/lemond[.exe]` until 2026-09-18) and answers
 * `RuntimeMissing`, which is the `Absent` those messages promise. What was
 * missing was the DIRECTORY, not the contents.
 *
 * The marker is for whoever opens the bundle and wonders where the runtime
 * went. Its name is deliberately neither of the two files that mean
 * "staged": not `.version`, which `isStaged` reads, and not `MANIFEST_FILE`,
 * which the plugin now takes to mean a runtime is installed. A marker
 * mistaken for either would claim a runtime that is not there.
 */
export function leaveEmpty(dir, why) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'RUNTIME-ABSENT.txt'),
    `No local inference runtime was staged for this build.\n\n${why}\n\n` +
      'The app runs normally; Settings → Local models reports the runtime as\n' +
      'not installed, and the gloss and the companion\u2019s local route are\n' +
      'unavailable. Re-run `pnpm run runtime:sync` on a machine that can reach\n' +
      'the release assets and rebuild to include it.\n',
  )
}

/**
 * Remove a live tree the pin no longer describes. `true` when there was one.
 *
 * ⚠️ **A FAILED FETCH USED TO LEAVE THE OLD RUNTIME WHERE IT WAS.** The
 * header promises that "switching platforms invalidates the stamp and
 * re-stages rather than shipping the wrong binary", and that held only while
 * the download succeeded: with the pin bumped and the network down, the stamp
 * check said "not staged", the fetches answered null, and `main` returned
 * having touched nothing — so `tauri.conf.json` copied the PREVIOUS pin's
 * tree into the bundle and the app shipped it. Silently, because the old
 * tree's manifest describes the old tree perfectly and the plugin's
 * before-every-spawn check has nothing to object to. A digest table nobody
 * can bump is worse than no digest table.
 *
 * Absent is the documented alternative and it is a safe one: the plugin
 * reports `Absent`, settings says `Not installed`, and the Codex and Claude
 * routes go on working. Shipping an executable the build did not choose is
 * not.
 *
 * The stamp is re-checked here rather than assumed, so this is safe to call
 * from anywhere: a tree that MATCHES the pin is never the stale one.
 *
 * `key === null` — no artifact published for this host at all — makes EVERY
 * tree stale. `VENDOR` is platform-neutral by name, so a directory staged on
 * another machine is one `tauri.conf.json` would copy into this bundle
 * regardless of whether anything in it can run here.
 */
export function discardStale(dir, key) {
  if (!existsSync(dir)) return false
  if (key !== null && isStaged(dir, key)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * Whether a process is still running. `signal 0` delivers nothing and only
 * asks; `EPERM` means it exists and belongs to somebody else, which is still
 * running.
 */
function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * ONE SYNC AT A TIME, or `.staging` belongs to nobody.
 *
 * `.staging` and `.previous` are named for `dir` and shared by every run, and
 * `sweepStale` deletes both before it begins. Two overlapping runs — `predev`
 * in one terminal and `prebuild` in another, which is an ordinary morning —
 * therefore delete each other's work: the second's sweep removes the first's
 * half-unpacked tree, and the first goes on to build a manifest over whatever
 * is left and promote it. The manifest would MATCH that tree, so the plugin's
 * before-every-spawn check would pass a runtime missing half its libraries.
 *
 * So a run takes an exclusive lock or does nothing. `mkdir` is the exclusive
 * create — it fails atomically on a directory that exists, which
 * `writeFileSync` with `wx` also does but without somewhere to record who
 * holds it.
 *
 * A LOCK NOBODY HOLDS MUST NOT BLOCK EVERY LATER RUN. A run killed hard
 * leaves the directory behind, and a sync that refused forever after one
 * `ctrl-c` would be worse than the race it prevents — so the holder's pid is
 * written inside and a lock whose holder is gone is reclaimed. Returns the
 * release, or null when another live run holds it.
 */
export function takeStagingLock(dir, pid = process.pid) {
  const at = `${dir}.lock`
  mkdirSync(path.dirname(at), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(at)
      writeFileSync(path.join(at, 'pid'), `${pid}\n`)
      return () => rmSync(at, { recursive: true, force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let holder = Number.NaN
      try {
        holder = Number.parseInt(readFileSync(path.join(at, 'pid'), 'utf8').trim(), 10)
      } catch {
        /* Killed between the mkdir and the write: no pid, so no holder. */
      }
      if (Number.isInteger(holder) && holder !== pid && isRunning(holder)) return null
      /* RECLAIMED BY RENAME, not by delete-then-create. Two runs finding the
         same abandoned lock would both delete it and both believe they took
         it — the race this exists to prevent, reintroduced by its own
         recovery. A rename can only succeed once; the loser gets ENOENT and
         meets the winner's fresh lock on the retry. */
      const aside = `${at}.abandoned.${pid}`
      try {
        renameSync(at, aside)
      } catch {
        return null
      }
      rmSync(aside, { recursive: true, force: true })
    }
  }
  return null
}

/**
 * Make `staging` the live tree at `dir`, by rename — see the header. The
 * displaced tree is removed only once the new one has the name; a failure
 * between the two renames leaves the old tree under `.previous`, which the
 * next run sweeps.
 */
export function promote(staging, dir) {
  const previous = `${dir}.previous`
  rmSync(previous, { recursive: true, force: true })
  const hadPrevious = existsSync(dir)
  if (hadPrevious) renameSync(dir, previous)
  try {
    renameSync(staging, dir)
  } catch (cause) {
    if (hadPrevious) renameSync(previous, dir)
    throw cause
  }
  rmSync(previous, { recursive: true, force: true })
}

/**
 * Fetch a release asset and verify it against its pinned digest.
 *
 * Unreachable is `null` — absent is a normal state. A digest that does not
 * match is FATAL, and the one case in this file that is: the bytes were
 * meant to be executed with a credential.
 */
async function fetchVerified(url, expected, label) {
  let bytes
  try {
    /* Bounded: an unresponsive connection used to hang every `predev` and
       `prebuild` for as long as the kernel kept the socket. Five minutes is
       generous for the ~40 MB worst case; a timeout lands in the same catch
       as unreachable, which is the state it is. */
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    console.warn(
      `sync-inference-runtime: could not fetch ${label} (${cause instanceof Error ? cause.message : cause}) — the local route will report Absent`,
    )
    return null
  }
  const digest = sha256(bytes)
  if (digest !== expected) {
    console.error(
      `sync-inference-runtime: ${label} does not match its pinned digest\n  expected ${expected}\n  got      ${digest}`,
    )
    process.exit(1)
  }
  return bytes
}

/**
 * Windows's own `tar`, which is bsdtar and reads zip archives.
 *
 * Resolved through `SystemRoot` rather than trusted to PATH — see the note in
 * `unpack`. Refused loudly if it is not there: an unpack that silently used a
 * different tar would stage a runtime that is subtly not what the manifest
 * hashes describe, and the failure would surface as a missing executable much
 * later.
 */
export function bsdtar() {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  const at = path.join(root, 'System32', 'tar.exe')
  if (!existsSync(at)) {
    throw new Error(
      `sync-inference-runtime: ${at} is missing, and plain \`tar\` on Windows may be Git's GNU tar, ` +
        'which cannot read a zip and reads a drive letter as a remote host.',
    )
  }
  return at
}

/**
 * Unpack an archive into `into`, flattening the single wrapper directory
 * llama.cpp's tarballs put at the top (`llama-b…/`). A zip has no
 * `--strip-components`, so a wrapper there is moved up by hand; llama.cpp's
 * Windows zips have no wrapper at all, which the same code handles by finding
 * nothing to flatten.
 */
function unpack(archive, into) {
  mkdirSync(into, { recursive: true })
  if (archive.endsWith('.zip')) {
    /* Windows has no `unzip`; its `tar` is bsdtar, which reads zip archives.
       Not `tar` everywhere: Linux's GNU tar does not, and macOS and the
       Ubuntu CI image both ship `unzip`.

       ⚠️ **BY ABSOLUTE PATH, BECAUSE `tar` ON WINDOWS IS NOT NECESSARILY THAT
       ONE.** Git for Windows ships a GNU tar in its `usr\bin`, and where that
       is earlier on PATH — which it is on `windows-latest` — plain `tar` is
       GNU's. It cannot read a zip, and it fails in a way that names neither
       problem: GNU tar reads `host:path` as a REMOTE archive, so a perfectly
       ordinary `D:\a\paper-one\…` argument came back as
       `tar: Cannot connect to D: resolve failed`, exit 128, from a build step
       that had nothing to do with the network. Naming the binary settles which
       `tar` this is; the check below makes a wrong one say so plainly instead
       of failing four frames later. */
    if (process.platform === 'win32') execFileSync(bsdtar(), ['-xf', archive, '-C', into], { stdio: 'inherit' })
    else execFileSync('unzip', ['-q', '-o', archive, '-d', into], { stdio: 'inherit' })
    /* The listing must not count the archive itself if it sits INSIDE `into`.
       Lemonade's zip was written to staging and unpacked over it; counted,
       it made a wrapped zip read as "two entries", the wrapper stayed, and
       the executable check failed on a tree that was actually fine. Nothing
       unpacks over its own archive now, but `unpack` cannot know where its
       caller put the file, so the guard stays with it. */
    const entries = readdirSync(into, { withFileTypes: true }).filter(
      (entry) => path.resolve(into, entry.name) !== path.resolve(archive),
    )
    if (entries.length === 1 && entries[0].isDirectory()) {
      const wrapper = path.join(into, entries[0].name)
      for (const name of readdirSync(wrapper)) {
        renameSync(path.join(wrapper, name), path.join(into, name))
      }
      rmSync(wrapper, { recursive: true, force: true })
    }
  } else {
    execFileSync('tar', ['xzf', archive, '-C', into, '--strip-components', '1'], { stdio: 'inherit' })
  }
}

/**
 * The whole sync, for this checkout and this host — or, for a test, for a
 * scratch root and a host it names. Only the defaults ever run from `predev`.
 */
export async function main({ root = REPO_ROOT, platform = process.platform, arch = process.arch } = {}) {
  const key = artifactKey(platform, arch)
  const dir = path.join(root, VENDOR)
  /* EXCLUSIVE, before the sweep: `sweepStale` deletes `.staging`, and a
     second run reaching it while the first is unpacking there is the whole
     race. See `takeStagingLock`. */
  const release = takeStagingLock(dir)
  if (release === null) {
    console.log('sync-inference-runtime: another sync is staging the runtime; leaving it to that one')
    return
  }
  try {
    if (key === null) {
      /* AND A TREE STAGED FOR SOMEBODY ELSE'S HOST GOES WITH THAT ANSWER.
         `VENDOR` is platform-neutral by name (`tauri.conf.json` cannot
         interpolate a platform), so whatever is in it would be copied into
         this build's bundle whether or not it can run here. `key === null`
         means no artifact exists for this host, so nothing in there was
         staged for it. */
      if (discardStale(dir, key)) {
        console.log('sync-inference-runtime: removed a runtime staged for another host')
      }
      /* PRESENT BUT EMPTY, or the bundle cannot be built at all — see
         `leaveEmpty`. This message promised a degraded app and delivered a
         failed build until 2026-08-30. */
      leaveEmpty(dir, `No runtime is published for ${platform}-${arch}.`)
      console.log(
        `sync-inference-runtime: no runtime published for ${platform}-${arch} — the companion's local route will report Absent`,
      )
      return
    }
    await stage(dir, key, BACKENDS[key])
  } finally {
    release()
  }
}

/**
 * Stage `backend`'s archive into `dir` for the host `key`, unless the stamp
 * says it is already there. Exported for the tests, which hand it a pin whose
 * archive they built themselves: the real archives are tens of megabytes, and
 * a test that fetched one would need the network to pass.
 */
export async function stage(dir, key, backend) {
  const pin = `${key} llama.cpp ${LLAMACPP_TAG} (${backend.backend})`
  /* The sweep runs BEFORE the stamp check, for two reasons an interrupted
     run taught: a kill inside `promote` leaves the only complete tree under
     `.previous` (the sweep restores it, and the stamp check then says
     staged); and a kill after promotion leaves a `.previous` the early
     return would otherwise keep on disk forever. */
  sweepStale(dir)
  if (isStaged(dir, key)) {
    console.log(`sync-inference-runtime: ${pin} already staged`)
    return
  }
  const bytes = await fetchVerified(`${LLAMACPP_RELEASE}/${backend.asset}`, backend.sha256, backend.asset)
  if (bytes === null) {
    /* AND THE TREE THE PIN NO LONGER DESCRIBES GOES WITH THE FAILURE. See
       `discardStale`: leaving it bundled the previous pin's executable. */
    if (discardStale(dir, key)) {
      console.log(
        `sync-inference-runtime: removed the tree staged for an older pin — ${pin} could not be fetched, so the companion's local route will report Absent`,
      )
    }
    /* AFTER `discardStale`, which removes the directory whole — see
       `leaveEmpty` for why it has to exist even with nothing in it. */
    leaveEmpty(dir, `${pin} could not be fetched.`)
    return
  }

  const staging = `${dir}.staging`
  mkdirSync(staging, { recursive: true })
  /* Written to the staging root and unpacked into the backend directory
     below it, so `unpack` never lists its own archive — and removed whatever
     happens, before the manifest is built, which would otherwise record it
     as a file of the runtime. */
  const archive = path.join(staging, backend.asset)
  try {
    writeFileSync(archive, bytes)
    unpack(archive, path.join(staging, backendDir(backend.backend)))
  } finally {
    rmSync(archive, { force: true })
  }

  const serverRelative = `${backendDir(backend.backend).split(path.sep).join('/')}/${backend.server}`
  const server = path.join(staging, backendDir(backend.backend), backend.server)
  /* A regular file, not merely a name: a directory called `llama-server`
     would otherwise stamp a runtime nothing can launch. */
  if (!existsSync(server) || !lstatSync(server).isFile()) {
    console.error(`sync-inference-runtime: ${backend.asset} unpacked without ${backend.server}`)
    process.exit(1)
  }

  const { kept, dropped } = trimToServer(path.join(staging, backendDir(backend.backend)), backend.server)
  console.log(
    `sync-inference-runtime: kept ${kept.length} of the ${kept.length + dropped.length} files ${backend.asset} ships — ${backend.server}, its libraries and what cannot run`,
  )
  /* A no-op after the trim, which leaves no link behind; kept as the guard
     it has always been, over the whole staging tree. */
  dereferenceLinks(staging)
  const manifest = buildManifest(staging, {
    platform: key,
    llamacpp: { tag: LLAMACPP_TAG, backend: backend.backend, server: serverRelative },
  })
  writeFileSync(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(path.join(staging, '.version'), `${stampFor(key)}\n`)
  promote(staging, dir)
  console.log(`sync-inference-runtime: staged ${pin}, ${manifest.files.length} files, into ${VENDOR}`)
}

if (isProcessEntry(import.meta)) {
  await main()
}

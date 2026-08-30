#!/usr/bin/env node
/**
 * Stage the inference runtime — `lemond` AND its llama.cpp backend — into
 * `vendor/inference/current/`, under a per-file manifest.
 *
 * WI-15.0's missing half, and WI-20.24's. `tauri-plugin-inference` resolves
 * the daemon from the bundle — `resource_dir()/runtime/lemond`, never from
 * `PATH`, because a `PATH` lookup is the reader's shell deciding which binary
 * Paper supervises and that one is handed a bearer token and a backend
 * installer. So something has to put it there, and this is it.
 *
 * # The backend is staged too, and that is the point of WI-20.24
 *
 * The staged tree used to hold `lemond` alone. The backend it actually runs
 * — `llama-server` and the ten `@rpath` libraries beside it, sixty-two files
 * on macOS — was fetched by the daemon from GitHub inside the FIRST GLOSS,
 * with no hash Paper controlled, needing the network, and `spawn.rs` called
 * it "the vetted builtin". Upstream publishes neither signatures nor a
 * codesign step; `lemond`'s own checksum table has no llama.cpp entry; and a
 * file libcurl downloaded carries no quarantine flag, so Gatekeeper never
 * looks at it. Only a hash Paper records itself stands between GitHub and
 * `exec`. So the archive pinned below is unpacked beside `lemond`, and the
 * plugin is told `no_fetch_executables: true` and where the executable is.
 *
 * # Why a download rather than a committed binary
 *
 * Four platforms × ~40 MB of compiled artifact is not a thing to keep in git
 * history, and `vendor/pdfjs/` sets the precedent for staged-not-committed
 * (see `.gitignore`). The safety that a committed binary would buy — you can
 * see exactly what ships — is bought instead by the DIGEST TABLES below,
 * which are committed, reviewable, and checked on every run.
 *
 * # Two digests, two jobs
 *
 * Each ARCHIVE is verified against a pinned SHA-256 before anything is
 * unpacked. A mismatch FAILS THE BUILD rather than warning: this is an
 * executable Paper will launch with a credential, and "the download looked
 * different today" is the one case where carrying on is indefensible. Every
 * archive digest below was computed from the bytes actually fetched from the
 * GitHub release — `lemond` on 2026-08-23, the backend on 2026-08-28 — and
 * the backend's also match the per-asset digests GitHub now publishes.
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
 * would do exactly what F2 spends a page forbidding. A runtime staged WITHOUT
 * its backend is not staged at all: with fetching forbidden it could not
 * answer, and a stamp that said otherwise would be a lie the plugin cannot
 * see through.
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

/** The upstream release this build is pinned to. */
export const VERSION = '11.7.0'

/**
 * One entry per platform Paper ships the runtime for, by Node's
 * `${process.platform}-${process.arch}`.
 *
 * `sha256` is of the ARCHIVE, computed from the bytes fetched on 2026-08-23.
 * `exe` is what the plugin looks for (`paths::runtime_exe_name`).
 */
export const ARTIFACTS = Object.freeze({
  'darwin-arm64': {
    asset: `lemonade-embeddable-${VERSION}-macos-arm64.tar.gz`,
    sha256: 'dc4aca78ebef83cadcaa3a49d483dad17db7b80216416dadd9c14a12bdee50ff',
    exe: 'lemond',
  },
  'linux-x64': {
    asset: `lemonade-embeddable-${VERSION}-ubuntu-x64.tar.gz`,
    sha256: '6253558fbdd4b1b6ee058af4c099f2aea5eda9df0f415ceea5e7bfe166d74b12',
    exe: 'lemond',
  },
  'linux-arm64': {
    asset: `lemonade-embeddable-${VERSION}-ubuntu-arm64.tar.gz`,
    sha256: '2e3192a745da2b7bd66b7fbb18a54537bdc29ee28ff27cabb86a675569583697',
    exe: 'lemond',
  },
  'win32-x64': {
    asset: `lemonade-embeddable-${VERSION}-windows-x64.zip`,
    sha256: '670d7d9b6b4d145c213f195f3a8d1225c5babb7ca0494dc6f415dfec377a6c4d',
    exe: 'lemond.exe',
  },
})

const RELEASE = `https://github.com/lemonade-sdk/lemonade/releases/download/v${VERSION}`

/**
 * The llama.cpp build the backend is pinned to.
 *
 * `lemond`'s OWN pin for the metal and cpu backends — `llamacpp.metal` and
 * `llamacpp.cpu` in the staged `resources/backend_versions.json` — so what
 * ships is the build the daemon would have fetched, not a different version
 * that happened to be current when this was written. Bump it with `VERSION`,
 * and read it off the new runtime's file rather than off a release page.
 */
export const LLAMACPP_TAG = 'b10375'

/**
 * One backend per platform: the one `lemond` picks on a machine with no
 * GPU, which is the one that runs everywhere the platform does.
 *
 * `metal` on Apple silicon is the whole story there. `cpu` on Linux and
 * Windows is a decision rather than an oversight: `lemond`'s `auto` would
 * pick `vulkan` or `cuda` on a machine with the GPU for it, and those would
 * be a second staged directory each (32–35 MB for Vulkan, 250 MB for CUDA)
 * behind a detection Paper does not make at build time. Adding one is a row
 * here and nothing else; until then a GPU on those platforms is not used.
 *
 * `sha256` is of the ARCHIVE, computed from the bytes fetched on 2026-08-28,
 * and equal to the digest GitHub publishes for the asset. `server` is the
 * executable `lemond` is pointed at — `llamacpp.<backend>_bin` takes the
 * executable's path and execs it directly.
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

/** The manifest the plugin verifies the tree against, beside `lemond`. */
export const MANIFEST_FILE = 'runtime.manifest.json'

/** The manifest format; `runtime.rs` reads the same number. */
export const MANIFEST_VERSION = 1

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
  return Object.hasOwn(ARTIFACTS, key) && Object.hasOwn(BACKENDS, key) ? key : null
}

/** Lowercase hex SHA-256 of a buffer. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * What the stamp says for a fully staged tree. It names the backend pin as
 * well as the runtime's, so a tree staged before the backend was part of it
 * reads as NOT staged and `predev` re-stages it rather than shipping a
 * runtime that cannot answer under `no_fetch_executables`.
 */
export function stampFor(key) {
  return `${VERSION} ${key} llamacpp-${LLAMACPP_TAG} ${BACKENDS[key].backend}`
}

/**
 * Whether `dir` already holds this version's runtime and backend.
 *
 * Keyed on the STAMP file rather than on the executable's presence: a
 * half-unpacked directory has the executable and the wrong `resources/`, and
 * re-running is cheap next to shipping a mismatched pair.
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
        let target
        try {
          target = realpathSync(full)
        } catch (cause) {
          throw new Error(`${full} links to nothing (${readlinkSync(full)})`, { cause })
        }
        if (!target.startsWith(`${top}${path.sep}`) || !lstatSync(target).isFile()) {
          throw new Error(`${full} links outside the staged tree, to ${target}`)
        }
        rmSync(full)
        copyFileSync(target, full)
      }
    }
  }
  walk(root)
}

/**
 * The manifest for the tree under `root`: every regular file by size and
 * SHA-256, paths forward-slashed and sorted, and nothing that is unlisted
 * by design. Pure over the directory.
 *
 * Throws on a symbolic link — `dereferenceLinks` runs first, and a link that
 * reaches here is a tree the plugin would refuse — and when the server
 * executable the pin names is not in the tree: a manifest that vouches for
 * a backend with no server is a manifest for a runtime that cannot answer.
 */
export function buildManifest(root, { platform, lemonade, llamacpp }) {
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
  return { version: MANIFEST_VERSION, platform, lemonade, llamacpp: { ...llamacpp }, files }
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
 * Remove a live tree the pin no longer describes. `true` when there was one.
 *
 * ⚠️ **A FAILED FETCH USED TO LEAVE THE OLD RUNTIME WHERE IT WAS.** The
 * header promises that "switching platforms invalidates the stamp and
 * re-stages rather than shipping the wrong binary", and that held only while
 * the download succeeded: with the pin bumped and the network down, the stamp
 * check said "not staged", both fetches answered null, and `main` returned
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
 * `paths::bundled_runtime` looks for `runtime/lemond[.exe]` and answers
 * `RuntimeMissing`, which is the `Absent` those messages promise. What was
 * missing was the DIRECTORY, not the contents.
 *
 * The marker is for whoever opens the bundle and wonders where the runtime
 * went. Its name is deliberately not `.version`: `isStaged` reads that stamp,
 * and a marker mistaken for one would claim a runtime that is not there.
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
 * Unpack an archive into `into`, flattening the single wrapper directory
 * both upstreams put at the top (`lemonade-embeddable-…/`, `llama-b…/`).
 * A zip has no `--strip-components`, so the wrapper is moved up by hand;
 * llama.cpp's Windows zips have no wrapper at all, which the same code
 * handles by finding nothing to flatten.
 */
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
    /* The archive itself may sit INSIDE `into` (the runtime zip is written
       to staging and unpacked over it), so the listing must not count it —
       counted, a wrapped zip read as "two entries", the wrapper stayed, and
       the executable check below failed on a tree that was actually fine. */
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

async function main() {
  const key = artifactKey(process.platform, process.arch)
  const dir = path.join(REPO_ROOT, VENDOR)
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
      leaveEmpty(dir, `No runtime is published for ${process.platform}-${process.arch}.`)
      console.log(
        `sync-inference-runtime: no runtime published for ${process.platform}-${process.arch} — the companion's local route will report Absent`,
      )
      return
    }
    await stage(dir, key, ARTIFACTS[key], BACKENDS[key])
  } finally {
    release()
  }
}

async function stage(dir, key, runtime, backend) {
  /* The sweep runs BEFORE the stamp check, for two reasons an interrupted
     run taught: a kill inside `promote` leaves the only complete tree under
     `.previous` (the sweep restores it, and the stamp check then says
     staged); and a kill after promotion leaves a `.previous` the early
     return would otherwise keep on disk forever. */
  sweepStale(dir)
  if (isStaged(dir, key)) {
    console.log(`sync-inference-runtime: ${key} ${VERSION} + llama.cpp ${LLAMACPP_TAG} (${backend.backend}) already staged`)
    return
  }
  const runtimeBytes = await fetchVerified(`${RELEASE}/${runtime.asset}`, runtime.sha256, runtime.asset)
  /* Short-circuited: no point asking for the backend once the runtime is
     unreachable, and the two failures want the same answer anyway. */
  const backendBytes = runtimeBytes === null ? null : await fetchVerified(`${LLAMACPP_RELEASE}/${backend.asset}`, backend.sha256, backend.asset)
  if (runtimeBytes === null || backendBytes === null) {
    /* AND THE TREE THE PIN NO LONGER DESCRIBES GOES WITH THE FAILURE. See
       `discardStale`: leaving it bundled the previous pin's executable. */
    if (discardStale(dir, key)) {
      console.log(
        `sync-inference-runtime: removed the tree staged for an older pin — ${key} ${VERSION} could not be fetched, so the companion's local route will report Absent`,
      )
    }
    /* AFTER `discardStale`, which removes the directory whole — see
       `leaveEmpty` for why it has to exist even with nothing in it. */
    leaveEmpty(dir, `${key} ${VERSION} could not be fetched.`)
    return
  }

  const staging = `${dir}.staging`
  mkdirSync(staging, { recursive: true })
  const runtimeArchive = path.join(staging, runtime.asset)
  const backendArchive = path.join(staging, backend.asset)
  try {
    writeFileSync(runtimeArchive, runtimeBytes)
    unpack(runtimeArchive, staging)
    rmSync(runtimeArchive, { force: true })
    /* The embeddable zip's wrapper carries more than the four names the old
       flatten moved; `unpack` moves everything, which is what a manifest
       over the whole tree wants. */
    writeFileSync(backendArchive, backendBytes)
    unpack(backendArchive, path.join(staging, backendDir(backend.backend)))
    rmSync(backendArchive, { force: true })
  } finally {
    rmSync(runtimeArchive, { force: true })
    rmSync(backendArchive, { force: true })
  }

  const exe = path.join(staging, runtime.exe)
  /* A regular file, not merely a name — the same bar the server below is
     held to; a directory called `lemond` would otherwise stamp a runtime
     nothing can spawn. */
  if (!existsSync(exe) || !lstatSync(exe).isFile()) {
    console.error(`sync-inference-runtime: ${runtime.asset} unpacked without ${runtime.exe}`)
    process.exit(1)
  }
  const serverRelative = `${backendDir(backend.backend).split(path.sep).join('/')}/${backend.server}`
  const server = path.join(staging, backendDir(backend.backend), backend.server)
  if (!existsSync(server) || !lstatSync(server).isFile()) {
    console.error(`sync-inference-runtime: ${backend.asset} unpacked without ${backend.server}`)
    process.exit(1)
  }

  dereferenceLinks(staging)
  const manifest = buildManifest(staging, {
    platform: key,
    lemonade: VERSION,
    llamacpp: { tag: LLAMACPP_TAG, backend: backend.backend, server: serverRelative },
  })
  writeFileSync(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(path.join(staging, '.version'), `${stampFor(key)}\n`)
  promote(staging, dir)
  console.log(
    `sync-inference-runtime: staged ${key} ${VERSION} + llama.cpp ${LLAMACPP_TAG} (${backend.backend}, ${manifest.files.length} files) into ${VENDOR}`,
  )
}

if (isProcessEntry(import.meta)) {
  await main()
}

#!/usr/bin/env node
/**
 * Stage the inference runtime (`lemond`) into `vendor/inference/current/`.
 *
 * WI-15.0's missing half. `tauri-plugin-inference` resolves the daemon from
 * the bundle — `resource_dir()/runtime/lemond`, never from `PATH`, because a
 * `PATH` lookup is the reader's shell deciding which binary Paper supervises
 * and that one is handed a bearer token and a backend installer. So something
 * has to put it there, and this is it.
 *
 * # Why a download rather than a committed binary
 *
 * Four platforms × ~6 MB of compiled artifact is not a thing to keep in git
 * history, and `vendor/pdfjs/` sets the precedent for staged-not-committed
 * (see `.gitignore`). The safety that a committed binary would buy — you can
 * see exactly what ships — is bought instead by the DIGEST TABLE below, which
 * is committed, reviewable, and checked on every run.
 *
 * # The digest is the whole point
 *
 * Each archive is verified against a pinned SHA-256 before anything is
 * unpacked. A mismatch FAILS THE BUILD rather than warning: this is an
 * executable Paper will launch with a credential, and "the download looked
 * different today" is the one case where carrying on is indefensible.
 *
 * Every digest below was computed from the bytes actually fetched from the
 * GitHub release on 2026-08-23, not read off a release page.
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** The key for a platform/arch pair, or null when Paper ships no runtime. */
export function artifactKey(platform, arch) {
  const key = `${platform}-${arch}`
  return Object.hasOwn(ARTIFACTS, key) ? key : null
}

/** Lowercase hex SHA-256 of a buffer. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Whether `dir` already holds this version's runtime.
 *
 * Keyed on the STAMP file rather than on the executable's presence: a
 * half-unpacked directory has the executable and the wrong `resources/`, and
 * re-running is cheap next to shipping a mismatched pair.
 */
export function isStaged(dir, key) {
  const stamp = path.join(dir, '.version')
  if (!existsSync(stamp)) return false
  try {
    return readFileSync(stamp, 'utf8').trim() === `${VERSION} ${key}`
  } catch {
    return false
  }
}

async function main() {
  const key = artifactKey(process.platform, process.arch)
  if (key === null) {
    console.log(
      `sync-inference-runtime: no runtime published for ${process.platform}-${process.arch} — the companion's local route will report Absent`,
    )
    return
  }
  const entry = ARTIFACTS[key]
  const dir = path.join(REPO_ROOT, VENDOR)
  if (isStaged(dir, key)) {
    console.log(`sync-inference-runtime: ${key} ${VERSION} already staged`)
    return
  }

  const url = `${RELEASE}/${entry.asset}`
  let bytes
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    /* NOT FATAL. See the header: absent is a normal state, and a build with
       no network must still produce an app whose agent routes work. */
    console.warn(
      `sync-inference-runtime: could not fetch ${entry.asset} (${cause instanceof Error ? cause.message : cause}) — the local route will report Absent`,
    )
    return
  }

  const digest = sha256(bytes)
  if (digest !== entry.sha256) {
    /* FATAL, and the one case in this file that is. This is an executable
       Paper launches with a credential and a control plane that installs
       backends; "the download looked different today" is not something to
       carry on from. */
    console.error(
      `sync-inference-runtime: ${entry.asset} does not match its pinned digest\n  expected ${entry.sha256}\n  got      ${digest}`,
    )
    process.exit(1)
  }

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = path.join(dir, entry.asset)
  writeFileSync(archive, bytes)
  try {
    if (entry.asset.endsWith('.zip')) {
      /* `--strip-components` for zip does not exist, so the wrapper directory
         is flattened after the fact. */
      execFileSync('unzip', ['-q', '-o', archive, '-d', dir], { stdio: 'inherit' })
      const inner = path.join(dir, entry.asset.replace(/\.zip$/, ''))
      if (existsSync(inner)) {
        for (const name of ['lemond.exe', 'lemonade.exe', 'LICENSE', 'resources']) {
          const from = path.join(inner, name)
          if (existsSync(from)) execFileSync('mv', [from, path.join(dir, name)])
        }
        rmSync(inner, { recursive: true, force: true })
      }
    } else {
      execFileSync('tar', ['xzf', archive, '-C', dir, '--strip-components', '1'], { stdio: 'inherit' })
    }
  } finally {
    rmSync(archive, { force: true })
  }

  const exe = path.join(dir, entry.exe)
  if (!existsSync(exe)) {
    console.error(`sync-inference-runtime: ${entry.asset} unpacked without ${entry.exe}`)
    process.exit(1)
  }
  writeFileSync(path.join(dir, '.version'), `${VERSION} ${key}\n`)
  console.log(`sync-inference-runtime: staged ${key} ${VERSION} into ${VENDOR}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}

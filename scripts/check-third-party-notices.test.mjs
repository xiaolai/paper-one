import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_LIBRARIES,
  BUNDLED_PACKAGES,
  BUNDLED_PLUGINS,
  BUNDLED_TRANSITIVE,
  NOT_BUNDLED,
  cell,
  copyrightFrom,
  crateLicenseFor,
  fenceFor,
  licenseBodyFrom,
  lockedVersions,
  packageDirFor,
  readCrates,
  readPackage,
  renderNotices,
} from './lib/notices.mjs'
import { RUST_LICENSES_DIR, absentFromLock, readRustCrates, spdxIdsOf } from './lib/rustNotices.mjs'
import { DELETED_ENV } from './verify-without.mjs'
import { NOTICES, committedNotices, currentNotices } from './write-third-party-notices.mjs'

/**
 * THE FONTS' LICENCES HAVE TO TRAVEL WITH THE BUILD.
 *
 * Four typefaces are bundled into every copy of Paper, all four under SIL Open
 * Font License 1.1. OFL §2 permits redistribution — bundled or sold — only if
 * each copy carries the above copyright notice and the licence itself. Nothing
 * carried either, so every build relied on terms it did not meet, and the
 * failure is exactly the kind nothing surfaces: no test fails, no build breaks,
 * and the app works perfectly.
 *
 * AND THE FONTS WERE ONLY HALF OF IT. Every build also shipped React,
 * react-dom, pdf.js, foliate-js, Lucide and three Tauri JavaScript packages —
 * MIT, ISC and Apache-2.0, each of which conditions redistribution on the
 * licence and the copyright notice travelling with the copy, in the same
 * words the OFL uses. The notice named none of them for as long as it
 * existed. The failure had exactly the shape described above: nothing broke,
 * because nothing compared the notice against what the build contains.
 *
 * Four things are gated here, and each closes a different way for it to rot:
 *
 *   1. The committed notice IS what the installed packages say. An upgrade
 *      that changes a copyright line cannot leave the notice describing the
 *      old one.
 *   2. The notice's package list IS what `src/main.tsx` actually imports. A
 *      font added to the app and not to the list would ship unnoticed; one
 *      removed from the app and left in the list would claim a licence
 *      obligation that no longer exists.
 *   3. The lists together ACCOUNT FOR every runtime dependency. This is the
 *      one that would have caught the gap: `package.json`'s `dependencies` is
 *      the closest thing there is to a statement of what ships, and a new one
 *      must now be named in a table or excused in writing before the suite
 *      goes green.
 *   4. The file is IN the bundle. A notice that exists only in the repository
 *      satisfies nobody: the requirement is on the copies.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), 'utf8')

describe('the committed notice', () => {
  it('is exactly what the installed packages say', () => {
    const committed = committedNotices()
    expect(committed).not.toBeNull()
    expect((committed ?? '').split('\n')).toEqual(currentNotices().split('\n'))
  })

  it('names every bundled package, with its version and licence', () => {
    const text = committedNotices() ?? ''
    for (const name of BUNDLED_PACKAGES) {
      expect(text, name).toContain(`\`${name}\``)
    }
    expect(text).toContain('OFL-1.1')
  })

  it('carries the licence text itself, not merely its name', () => {
    const text = committedNotices() ?? ''
    /* The clauses the obligation actually rests on. */
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(text).toContain('PERMISSION & CONDITIONS')
    expect(text).toContain('TERMINATION')
  })
})

/**
 * THE LIST AND THE APP MUST AGREE.
 *
 * `BUNDLED_PACKAGES` is a decision — what ships — and cannot be derived from
 * the dependency tree, because a dev dependency's licence has no place here.
 * So it is checked against the one file that decides it: the composition
 * root's font imports.
 */
describe('what is bundled', () => {
  const imports = [...read('src/main.tsx').matchAll(/^import '([^']+)'$/gm)].map((match) => match[1])
  const fonts = imports.filter((one) => one.startsWith('@fontsource'))

  it('finds the font imports it is checking, so this is not vacuous', () => {
    expect(fonts.length).toBeGreaterThan(0)
  })

  it('lists every font the app imports', () => {
    /* `@fontsource/ibm-plex-mono/400.css` names the package plus a path. */
    const packages = new Set(
      fonts.map((one) => {
        const parts = one.split('/')
        return `${parts[0]}/${parts[1]}`
      }),
    )
    expect([...packages].sort()).toEqual([...BUNDLED_PACKAGES].sort())
  })
})

/**
 * EVERY RUNTIME DEPENDENCY IS ACCOUNTED FOR — the check the gap got past.
 *
 * `dependencies` is the closest thing this repository has to a declaration of
 * what a build contains, and the two bundled lists are the claim about which
 * of them carry an attribution obligation. A partition, not a subset: a
 * dependency is either named in a table or excused in `NOT_BUNDLED` with a
 * written reason. Adding one and shipping it unnamed is now a red suite
 * rather than a quiet licence breach.
 */
describe('every runtime dependency is accounted for', () => {
  const dependencies = Object.keys(JSON.parse(read('package.json')).dependencies ?? {})
  const named = [...BUNDLED_PACKAGES, ...BUNDLED_LIBRARIES.map((one) => one.name)]

  it('finds the dependencies it is checking, so this is not vacuous', () => {
    expect(dependencies.length).toBeGreaterThan(0)
    expect(named.length).toBe(dependencies.length - Object.keys(NOT_BUNDLED).length)
  })

  it('names each one, or says in writing why it ships nothing', () => {
    expect([...named, ...Object.keys(NOT_BUNDLED)].sort()).toEqual([...dependencies].sort())
    /* Once each. A name in both lists is a claim and its own denial. */
    expect(new Set(named).size).toBe(named.length)
    for (const [name, why] of Object.entries(NOT_BUNDLED)) {
      expect(named, `${name} is both bundled and excused`).not.toContain(name)
      expect(typeof why === 'string' && why.length > 0, `${name} needs a reason, not a blank`).toBe(true)
    }
  })

  /**
   * AND "BUNDLED" IS A FACT ABOUT THE SOURCE, not a label. A package listed
   * here that nothing imports would claim an obligation Paper does not have.
   *
   * The detector is checked against a KNOWN NEGATIVE as well as the eight
   * positives, because a regex that matches everything looks exactly like a
   * clean result — `check-browser-safe` shipped two confident wrong answers
   * for that reason. It reads whole files rather than line by line, for the
   * other half of that finding: a newline-forbidding pattern misses every
   * multi-line import, and `session.ts` has one.
   */
  describe('what the source actually imports', () => {
    const sources = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const at = path.join(dir, entry)
        if (statSync(at).isDirectory()) walk(at)
        /* Declaration files describe types and ship nothing; test files are
           not the build. */
        else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          sources.push(readFileSync(at, 'utf8'))
        }
      }
    }
    walk(path.join(REPO_ROOT, 'src'))
    const source = sources.join('\n')
    const imported = (name) =>
      new RegExp(String.raw`(?:from|import)\s*\(?\s*['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/[^'"]*)?['"]`).test(source)

    it('does not answer yes to a package nothing imports', () => {
      expect(sources.length).toBeGreaterThan(0)
      expect(imported('a-package-that-is-not-here')).toBe(false)
      expect(imported('vitest')).toBe(false)
    })

    it('finds every bundled library in an import', () => {
      for (const { name } of BUNDLED_LIBRARIES) expect(imported(name), `${name} is imported by src/`).toBe(true)
    })
  })

  /**
   * AND THE PARTITION ABOVE CAN ONLY ACCOUNT FOR WHAT IT PARTITIONS.
   *
   * `dependencies` names what Paper asked for; a bundle carries what those
   * packages asked for too. `react-dom` is one entry in `package.json` and
   * two libraries in `dist/`: it requires `scheduler`, MIT, Meta's, whose
   * `unstable_scheduleCallback` is in the desktop bundle and the web bundle
   * alike — and which the notice named nowhere while three tests about
   * "every runtime dependency" passed. A check whose input stops one level
   * too early is green for exactly the omission it was bought to catch.
   *
   * So this follows each listed package's OWN `dependencies`, transitively,
   * and demands every name it reaches be listed or excused.
   *
   * `peerDependencies` and `optionalDependencies` are deliberately not
   * walked, and the reason is the same for both: neither can be relied on to
   * be there, so an importer has to work without it. `lucide-react`'s peer is
   * `react`, which is listed anyway. `pdfjs-dist`'s optional
   * `@napi-rs/canvas` is reached through
   * `createRequire(import.meta.url)('@napi-rs/canvas')` inside its Node-only
   * canvas factory — a runtime require Vite cannot and does not bundle. Only
   * the STRING is in `dist/`; none of the package's code is (measured
   * 2026-08-28).
   */
  it('accounts for every package those packages themselves pull in', () => {
    const named = new Set([...BUNDLED_PACKAGES, ...BUNDLED_LIBRARIES.map((one) => one.name), ...BUNDLED_TRANSITIVE.map((one) => one.name)])
    const accounted = new Set([...named, ...Object.keys(NOT_BUNDLED)])
    /* Breadth-first over an explicit queue with a visited set: a dependency
       graph has cycles (`react-dom` ↔ its peers do not, but the walk must not
       depend on that), and a `for…of` over a growing array would follow one
       forever. */
    const queue = [...BUNDLED_PACKAGES.map((name) => ({ name })), ...BUNDLED_LIBRARIES, ...BUNDLED_TRANSITIVE]
    const visited = new Set(queue.map((one) => one.name))
    const brings = new Map()
    for (let i = 0; i < queue.length; i++) {
      const { name, via } = queue[i]
      const manifest = JSON.parse(readFileSync(path.join(packageDirFor(REPO_ROOT, name, via), 'package.json'), 'utf8'))
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (!brings.has(dep)) brings.set(dep, name)
        if (visited.has(dep)) continue
        visited.add(dep)
        queue.push({ name: dep, via: name })
      }
    }
    /* NOT VACUOUS, and this is the assertion that makes the rest mean
       something: the walk must actually reach one level down. `scheduler` is
       the package it failed to reach for as long as it did not exist. */
    expect(brings.get('scheduler'), 'the walk must reach what react-dom brings').toBe('react-dom')
    for (const [dep, from] of brings) {
      expect(accounted, `${from} depends on ${dep}, and no table in notices.mjs names or excuses it`).toContain(dep)
    }
  })
})

/**
 * THE LIBRARIES' TERMS TRAVEL TOO, and each is a different licence with a
 * different copyright holder — so this asserts the clause each obligation
 * actually rests on, not merely that a name appears.
 */
describe('the JavaScript libraries', () => {
  const committed = () => committedNotices() ?? ''

  it('names every one, with the version installed and the terms it ships under', () => {
    const text = committed()
    for (const entry of BUNDLED_LIBRARIES) {
      const one = readPackage(REPO_ROOT, entry)
      expect(text, one.name).toContain(`| \`${one.name}\` | ${one.version} | ${one.license} |`)
    }
  })

  it('carries each licence text, not merely its name', () => {
    const text = committed()
    /* MIT and ISC each say the notice must accompany the copy; Apache-2.0
       says it in §4. Three licences, three distinct sentences. */
    expect(text).toContain('Permission is hereby granted, free of charge')
    expect(text).toContain('Permission to use, copy, modify, and/or distribute this software')
    expect(text).toContain('Apache License')
    expect(text).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
  })

  it('keeps each MIT copyright line apart, rather than folding three holders into one', () => {
    const text = committed()
    /* Meta, John Factotum and the Tauri Apps Contributors all ship MIT here.
       Grouping by the licence NAME would have printed whichever came first
       and attributed the other two to it. */
    expect(text).toContain('Copyright (c) Meta Platforms, Inc. and affiliates.')
    expect(text).toContain('Copyright (c) 2022 John Factotum')
    expect(text).toContain('Copyright (c) 2017 - Present Tauri Apps Contributors')
    expect(text).toContain('Copyright (c) 2026 Lucide Icons and Contributors')
  })

  /**
   * A GIT DEPENDENCY HAS NO VERSION. `foliate-js` is Paper's fork, and its
   * manifest says `0.0.0` — a number that names nothing, in the one document
   * whose job is to say exactly what was redistributed. The spec resolves it.
   */
  it('names the fork by the commit it is pinned to, not by 0.0.0', () => {
    const spec = JSON.parse(read('package.json')).dependencies['foliate-js']
    expect(spec).toMatch(/^github:/)
    expect(committed()).toContain(`| \`foliate-js\` | ${spec} |`)
    expect(committed()).not.toContain('| `foliate-js` | 0.0.0 |')
  })

  /**
   * THE TWO PACKAGES THAT PUBLISH NO LICENCE TEXT. `@tauri-apps/plugin-dialog`
   * and `@tauri-apps/plugin-fs` ship a `LICENSE.spdx` — metadata ABOUT the
   * terms — and nothing else, so their MIT text is vendored from the crate
   * half of the same plugin at the same version. Compared against the cargo
   * registry when one is checked out, so the vendored copy cannot be a text
   * somebody typed.
   */
  it('vendors the Tauri packages’ text from the crate half of the same release', (context) => {
    const registry = path.join(process.env.HOME ?? '', '.cargo', 'registry', 'src')
    if (!existsSync(registry)) return context.skip('no cargo registry checkout on this machine')
    for (const [npm, crate] of [
      ['@tauri-apps/plugin-dialog', 'tauri-plugin-dialog'],
      ['@tauri-apps/plugin-fs', 'tauri-plugin-fs'],
    ]) {
      const { version, text } = readPackage(REPO_ROOT, BUNDLED_LIBRARIES.find((one) => one.name === npm))
      const found = readdirSync(registry)
        .map((one) => path.join(registry, one, `${crate}-${version}`, 'LICENSE_MIT'))
        .filter((one) => existsSync(one))
      if (found.length === 0) return context.skip(`${crate} ${version} is not checked out here`)
      expect(readFileSync(found[0], 'utf8'), `${npm}: vendored licence drifted from ${crate} ${version}`).toBe(text)
    }
  })
})

/**
 * AND IT FAILS LOUDLY. A notices generator that skips what it cannot read
 * produces a document that looks complete and is not — which is the failure
 * this whole file exists for, in its most deniable form.
 */
describe('readPackage on a package it cannot account for', () => {
  const scratch = (build) => {
    const root = mkdtempSync(path.join(tmpdir(), 'paper-notices-'))
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    try {
      return build(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  const install = (root, name, manifest, files = {}) => {
    const at = path.join(root, 'node_modules', name)
    mkdirSync(at, { recursive: true })
    writeFileSync(path.join(at, 'package.json'), JSON.stringify(manifest))
    for (const [file, body] of Object.entries(files)) writeFileSync(path.join(at, file), body)
    return at
  }

  it('says the package is not installed, rather than reporting undefined', () => {
    scratch((root) => {
      expect(() => readPackage(root, 'nowhere')).toThrow(/nowhere: not installed at/)
    })
  })

  it('names the path it looked for a licence at, and how to point it elsewhere', () => {
    scratch((root) => {
      install(root, 'quiet', { version: '1.0.0', license: 'MIT' }, { 'LICENSE.spdx': 'SPDXVersion: SPDX-2.1\n' })
      expect(() => readPackage(root, 'quiet')).toThrow(/quiet: no licence text at .*LICENSE/)
      expect(() => readPackage(root, 'quiet')).toThrow(/vendor one under scripts\/lib\/licenses/)
      /* And it is READ once pointed at the file the package really publishes. */
      expect(readPackage(root, { name: 'quiet', file: 'LICENSE.spdx' }).text).toContain('SPDXVersion')
    })
  })

  it('refuses a package that declares no licence at all', () => {
    scratch((root) => {
      install(root, 'silent', { version: '1.0.0' }, { LICENSE: 'some terms' })
      expect(() => readPackage(root, 'silent')).toThrow(/silent: declares no licence/)
      /* Unless the declaration is made here, which is a decision on record. */
      expect(readPackage(root, { name: 'silent', license: 'MIT' }).license).toBe('MIT')
    })
  })

  /**
   * A TRANSITIVE PACKAGE IS NOT AT `node_modules/<name>`.
   *
   * Under pnpm's default linker only direct dependencies get a symlink at the
   * root; `scheduler` is reachable from `react-dom` and from nowhere else. So
   * `via` sends the lookup up from the parent the way Node itself would —
   * which also works under a hoisted or npm-shaped tree, and does not go
   * through `require.resolve`, whose `ERR_PACKAGE_PATH_NOT_EXPORTED` is what
   * every `@tauri-apps/plugin-*` answers for a `package.json` subpath.
   */
  it('finds a package installed for its parent, and names what it could not find', () => {
    scratch((root) => {
      install(root, path.join('parent', 'node_modules', 'child'), { version: '2.0.0', license: 'MIT' }, { LICENSE: 'child terms' })
      install(root, 'parent', { version: '1.0.0', license: 'MIT' }, { LICENSE: 'parent terms' })
      const found = readPackage(root, { name: 'child', via: 'parent' })
      expect(found).toMatchObject({ name: 'child', version: '2.0.0', license: 'MIT', text: 'child terms' })
      /* Both ways it can fail, each naming which half is missing — a resolver
         that answered "not installed" for an absent PARENT would send the
         next reader looking for the wrong thing. */
      expect(() => readPackage(root, { name: 'child', via: 'nowhere' })).toThrow(/its parent nowhere is not installed/)
      expect(() => readPackage(root, { name: 'orphan', via: 'parent' })).toThrow(/orphan: not installed anywhere parent can see it/)
    })
  })
})

/**
 * THE SIBLING TABLE: the desktop's platform plugins, recorded as the
 * dependency decision they are (phase 20, D5). Held to the two things that
 * make the record true — the lockfile's version, and a registration in
 * `lib.rs` — so a plugin dropped from the app cannot go on being listed, and
 * one listed cannot be a crate the app merely depends on and never wires.
 */
describe('the desktop platform plugins', () => {
  const lock = read('src-tauri/Cargo.lock')
  const libRs = read('src-tauri/src/lib.rs')
  const crates = readCrates(REPO_ROOT)

  it('names each with the version the lockfile pins', () => {
    expect(crates.map((one) => one.name)).toEqual(BUNDLED_PLUGINS)
    const declared = new Map(readRustCrates().map((one) => [`${one.name}@${one.version}`, one]))
    for (const one of crates) {
      /* The parse checked against the file's own literal text: `lockedVersions`
         reads eight thousand lines of TOML by hand, and a substring match on
         the raw bytes is what says the parse and the file agree. */
      expect(lock, `${one.name} ${one.version} in Cargo.lock`).toContain(`name = "${one.name}"\nversion = "${one.version}"`)
      /* And the same version in the crate manifest, so the two halves this
         reads from cannot drift apart unnoticed. */
      expect(declared.get(`${one.name}@${one.version}`)?.license, `${one.name} in rust-crates.json`).toBe(one.license)
      expect(one.license).toMatch(/[A-Za-z]/)
    }
  })

  it('is registered in lib.rs, every one', () => {
    for (const name of BUNDLED_PLUGINS) {
      expect(libRs, `${name} is wired`).toContain(`${name.replaceAll('-', '_')}::Builder`)
    }
  })

  it('is in the committed notice', () => {
    const committed = committedNotices() ?? ''
    for (const one of crates) expect(committed).toContain(`| \`${one.name}\` | ${one.version} | ${one.license} |`)
  })
})

/**
 * AND IT HAS TO BE IN THE COPIES. A notice sitting in the repository is not a
 * notice on the build; the requirement is on what is redistributed.
 */
describe('the bundle', () => {
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'))

  it('ships the notice as a bundled resource', () => {
    const resources = tauri.bundle?.resources ?? []
    const listed = Array.isArray(resources) ? resources : Object.keys(resources)
    expect(listed.some((one) => String(one).endsWith(NOTICES))).toBe(true)
  })
})

/**
 * THE RUST CRATES — item A of the phase-20 audit, and the largest thing the
 * notice was ever wrong about.
 *
 * The desktop binary statically links five hundred and ninety-two third-party
 * crates, overwhelmingly MIT and Apache-2.0. Both condition permission to
 * redistribute on the licence and the copyright notice travelling with the
 * copy — the same words the OFL uses about the typefaces, and the same words
 * MIT uses about React. The notice named two of them, and said so in its own
 * prose: "the wider Rust dependency graph is not enumerated here." A document
 * that describes its own omission is still a document that has one.
 *
 * ⚠️ NOTHING HERE RUNS CARGO. `scripts/refresh-rust-notices.mjs` asks the
 * registry and commits the answer; these three checks hold that answer against
 * `src-tauri/Cargo.lock`, against the committed texts, and against the
 * rendered notice — all of which are files, present in every clone. See
 * `readCrates` above for what a cargo call in this file cost.
 */
describe('the Rust crates the binary links', () => {
  const crates = readRustCrates()
  const locked = lockedVersions(read('src-tauri/Cargo.lock'))

  it('is the whole closure and not a sample, so the checks below are not vacuous', () => {
    /* Four hundred is well under the measured 592 and well over any plausible
       truncation. A manifest that quietly became a handful of crates would
       pass every other assertion in this file. */
    expect(crates.length).toBeGreaterThan(400)
    expect(crates.some((one) => one.name === 'serde')).toBe(true)
    for (const name of BUNDLED_PLUGINS) expect(crates.some((one) => one.name === name), name).toBe(true)
  })

  it('declares a licence and carries a text for every crate it names', () => {
    for (const one of crates) {
      expect(one.license, `${one.name} declares no licence`).toMatch(/[A-Za-z]/)
      expect(one.texts.length, `${one.name} has no licence text`).toBeGreaterThan(0)
    }
  })

  /**
   * ⚠️ SKIPPED, AND ONLY, INSIDE A `pnpm verify:without` COPY.
   *
   * `capability:remove` prunes `Cargo.lock` with `cargo metadata --offline`,
   * so cutting `peer` takes iroh and its whole subtree out of the lockfile
   * — while `rust-crates.json`, which only `pnpm docs:rust-notices` rewrites,
   * still names them. In that copy the notice is over-inclusive, which is the
   * safe direction and not a defect of the removal. `verify-without` sets
   * `PAPER_VERIFY_WITHOUT` to the id it cut, and nothing else does; on the real
   * tree the variable is unset and this is a hard assertion.
   *
   * The comparison itself is `absentFromLock`, tested against a known positive
   * beside its own module — a skip whose subject is never proved to fire is a
   * skip that hides a check nobody has run.
   */
  it('names every crate at a version src-tauri/Cargo.lock actually pins', (context) => {
    const absent = absentFromLock(crates, locked)
    const cut = process.env[DELETED_ENV]
    if (cut !== undefined && absent.length > 0) {
      return context.skip(`${cut} was cut from this copy and its crates pruned from Cargo.lock; the manifest is regenerated by a separate command`)
    }
    expect(absent).toEqual([])
  })

  it('has a committed text for every sha it references, and none it references for nothing', () => {
    const referenced = new Set(crates.flatMap((one) => one.texts))
    for (const sha of referenced) {
      expect(existsSync(path.join(RUST_LICENSES_DIR, `${sha}.txt`)), `${sha}.txt`).toBe(true)
    }
    const onDisk = readdirSync(RUST_LICENSES_DIR).filter((name) => name.endsWith('.txt')).map((name) => name.slice(0, -4))
    expect([...onDisk].sort()).toEqual([...referenced].sort())
  })

  /* The fallback for a crate that declares terms and publishes none. Its
     `standard` flag is RECORDED rather than inferred, because the vendored
     Apache-2.0 text and a crate's own LICENSE-APACHE are routinely
     byte-identical — so "did this crate ship its own text" cannot be
     recovered from the shas afterwards. */
  it('reproduces a standard text only where a crate ships none, and names the holders it has', () => {
    const standard = crates.filter((one) => one.standard)
    expect(standard.length).toBeGreaterThan(0)
    for (const one of standard) {
      expect(one.texts.length, one.name).toBe(new Set(spdxIdsOf(one.license)).size)
      if (one.authors !== undefined) expect(one.authors.every((author) => author.length > 0), one.name).toBe(true)
    }
    /* And a crate that DOES ship its own text is never marked standard. */
    expect(crates.find((one) => one.name === 'serde')?.standard).toBeUndefined()
  })

  it('is in the committed notice: every crate row, and the terms behind it', () => {
    const committed = committedNotices() ?? ''
    for (const one of crates) {
      expect(committed, one.name).toContain(`| \`${one.name}\` | ${one.version} | ${one.license} |`)
    }
    expect(committed).toContain('## Rust crates')
    /* The basis, stated in the document rather than only in the code that
       produced it — a reader cannot check a closure they are not told about. */
    expect(committed).toContain('aarch64-apple-darwin, x86_64-apple-darwin, x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu')
    expect(committed).toContain(`${crates.length} crates,`)
    /* The MPL's §3.2 and Apache §4 obligations are in the file, not merely
       named: two of the licences whose text the fonts and the JavaScript
       sections never carried. */
    expect(committed).toContain('Mozilla Public License Version 2.0')
    expect(committed).toContain('APPENDIX: How to apply the Apache License to your work')
  })
})

describe('the renderer', () => {
  const ONE = {
    name: 'pkg',
    version: '1.0.0',
    license: 'OFL-1.1',
    text: 'Copyright 2020 Somebody (https://example.test) Thing.ttf: Copyright 2020 Somebody\n\nLICENCE BODY\n\nmore body\n',
  }

  /**
   * VERBATIM, and this is the case that made it so. The first version split
   * the block on the word `Copyright`, which turned this exact shape into two
   * entries — one ending in a dangling filename, the other a duplicate. A
   * notice whose job is to satisfy "reproduce the copyright notice" is the one
   * document where tidying the text is a defect.
   */
  it('reproduces a copyright block exactly as the package states it', () => {
    expect(copyrightFrom(ONE.text)).toBe(
      'Copyright 2020 Somebody (https://example.test) Thing.ttf: Copyright 2020 Somebody',
    )
  })

  it('keeps the whole licence body, including its later paragraphs', () => {
    expect(licenseBodyFrom(ONE.text)).toBe('LICENCE BODY\n\nmore body')
  })

  /* EMITTED ONCE when shared, so four identical OFL bodies do not make a
   * seven-hundred-line file out of a two-hundred-line one — and grouped by
   * body, so a package arriving under DIFFERENT terms gets its own heading
   * rather than being folded silently into the others. */
  it('groups a shared licence body and separates a different one', () => {
    const other = { ...ONE, name: 'other', text: 'Copyright 2021 Else\n\nLICENCE BODY\n\nmore body\n' }
    const shared = renderNotices([ONE, other])
    expect(shared.match(/^```$/gm)?.length).toBe(2 * 2 + 2)
    expect(shared).toContain('Applies to: `pkg`, `other`.')

    const different = renderNotices([ONE, { ...other, license: 'MIT', text: 'Copyright 2021 Else\n\nMIT BODY\n' }])
    expect(different).toContain('### OFL-1.1')
    expect(different).toContain('### MIT')
    expect(different).toContain('MIT BODY')
  })

  it('ends with exactly one newline, so the file is diff-stable', () => {
    const text = renderNotices([ONE])
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })

  /**
   * ⚠️ A LICENCE TEXT IS NOT MARKDOWN-INERT, and assuming it was broke this
   * document the moment the Rust crates went in. `aws-lc-sys`'s licence body
   * contains twenty-six lines beginning with three backticks; inside a
   * three-backtick fence the third of them ENDS the block, and the rest of
   * that licence — and the two hundred and ninety-six texts after it — render
   * as prose. Nothing errors. The file is the right bytes and the wrong
   * document.
   */
  it('opens a fence longer than anything inside the text it is reproducing', () => {
    expect(fenceFor('nothing special')).toBe('```')
    expect(fenceFor('a\n```\nb')).toBe('````')
    /* Indented up to three spaces still closes a fence, per CommonMark. */
    expect(fenceFor('a\n   ````\nb')).toBe('`````')
    /* A backtick run that is not at the start of a line closes nothing. */
    expect(fenceFor('see `x` for more')).toBe('```')
  })

  it('reproduces a text containing a fence without ending the block early', () => {
    const withFence = { ...ONE, text: 'Copyright 2020 Somebody\n\nExample:\n\n```\ncode\n```\n\nend of terms' }
    const rendered = renderNotices([withFence])
    expect(rendered).toContain('````\nExample:')
    expect(rendered).toContain('end of terms\n````')
  })

  /**
   * A CRATE'S DECLARED AUTHOR IS `Mads Marquart <mads@marquart.dk>` — angle
   * brackets a markdown renderer reads as a tag, in a table cell. A code span
   * makes them the characters they are, which is the whole requirement for a
   * copyright holder's name.
   */
  it('puts a copyright holder in a table cell verbatim, brackets, pipes and all', () => {
    expect(cell('Mads Marquart <mads@marquart.dk>')).toBe('`Mads Marquart <mads@marquart.dk>`')
    expect(cell('A | B')).toBe('`A \\| B`')
    /* A backtick in a name takes a longer fence, and one at either end takes
       the padding space CommonMark requires. */
    expect(cell('a`b')).toBe('``a`b``')
    expect(cell('`quoted`')).toBe('`` `quoted` ``')
  })

  /**
   * THE RUST SECTION, driven with fakes — the committed corpus is asserted
   * against elsewhere in this file; these are the shapes it does not have
   * today and would silently render wrong when it does.
   */
  describe('the Rust crates section', () => {
    const RUST = [
      { name: 'a', version: '1.0.0', license: 'MIT', texts: ['aaaaaaaaaaaa'] },
      { name: 'b', version: '2.0.0', license: 'MIT', texts: ['aaaaaaaaaaaa'] },
      { name: 'c', version: '3.0.0', license: 'Zlib', texts: ['bbbbbbbbbbbb'], standard: true, authors: ['Someone <s@example.test>'] },
    ]
    const textFor = (sha) => (sha === 'aaaaaaaaaaaa' ? 'SHARED TERMS' : 'ZLIB TERMS')
    const rendered = renderNotices([ONE], [], [], { crates: RUST, textFor })

    it('emits a shared text once, with every crate it covers named above it', () => {
      expect(rendered).toContain('Applies to 2 crates: `a` 1.0.0, `b` 2.0.0.')
      expect(rendered.match(/SHARED TERMS/g)?.length).toBe(1)
      expect(rendered).toContain('3 crates, 2 distinct licence and notice texts.')
    })

    it('says "1 crate" for a text one crate carries, rather than "1 crates"', () => {
      expect(rendered).toContain('Applies to 1 crate: `c` 3.0.0.')
    })

    it('names the copyright holders of a crate that ships no licence text', () => {
      expect(rendered).toContain('| `c` | 3.0.0 | Zlib | `Someone <s@example.test>` |')
    })

    it('says so in the table where a crate declares no authors either', () => {
      const anonymous = renderNotices([ONE], [], [], { crates: [{ ...RUST[2], authors: undefined }], textFor })
      expect(anonymous).toContain('| `c` | 3.0.0 | Zlib | *the crate declares none* |')
    })

    /* Every crate shipping its own text means no fallback table at all — a
       heading with nothing under it would read as an omission. */
    it('omits the no-licence-text table entirely when every crate ships one', () => {
      const all = renderNotices([ONE], [], [], { crates: RUST.slice(0, 2), textFor })
      expect(all).toContain('## Rust crates')
      expect(all).not.toContain('Crates that declare terms and publish no licence text')
    })

    it('omits the whole section when there are no crates, rather than an empty heading', () => {
      expect(renderNotices([ONE], [], [], { crates: [] })).not.toContain('## Rust crates')
      expect(renderNotices([ONE])).not.toContain('## Rust crates')
    })
  })
})

/**
 * `readCrates` ANSWERS FROM THE LOCKFILE NOW, AND NOTHING HERE SPAWNS CARGO.
 *
 * ⚠️ IT USED TO RUN `cargo metadata --offline --locked`, from inside this
 * suite. `--offline` exits 101 when any package in the lockfile is missing
 * from the local registry — the shape of a fresh clone, and the shape of a CI
 * runner restoring a `Swatinem/rust-cache` keyed on an older lockfile
 * (measured by holding `zbus-4.4.0` out of the registry). This file runs under
 * `test:coverage`, which is step eleven of `pnpm verify` and comes BEFORE
 * every cargo step, so a pull request touching `Cargo.lock` could redden CI
 * for a reason having nothing to do with the change, at the step least likely
 * to be suspected.
 *
 * `Cargo.lock` is committed and always present; the licence half comes from
 * `scripts/lib/rust-crates.json`, written by `pnpm docs:rust-notices` where a
 * registry exists. These drive both with values in hand.
 */
describe('readCrates and a lockfile it cannot answer from', () => {
  const LOCK = [
    '# This file is automatically @generated by Cargo.',
    'version = 4',
    '',
    '[[package]]',
    'name = "tauri-plugin-window-state"',
    'version = "2.4.1"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'dependencies = [',
    ' "serde",',
    ']',
    '',
    '[[package]]',
    'name = "serde"',
    'version = "1.0.230"',
    '',
    '[metadata]',
    'name = "not-a-package"',
    'version = "0.0.0"',
  ].join('\n')
  const DECLARED = [
    { name: 'tauri-plugin-window-state', version: '2.4.1', license: 'Apache-2.0 OR MIT', texts: [] },
    { name: 'serde', version: '1.0.230', license: 'MIT OR Apache-2.0', texts: [] },
  ]

  /* The `[metadata]` table at the end carries a `name` and a `version` too —
     a scan that did not track which table it was in would report a package
     called `not-a-package`. */
  it('reads name and version out of every [[package]] and out of no other table', () => {
    const found = lockedVersions(LOCK)
    expect([...found.keys()].sort()).toEqual(['serde', 'tauri-plugin-window-state'])
    expect(found.get('serde')).toEqual(['1.0.230'])
  })

  it('answers from the lockfile and the manifest together, without spawning anything', () => {
    expect(readCrates('/nowhere', ['tauri-plugin-window-state'], LOCK, DECLARED)).toEqual([
      { name: 'tauri-plugin-window-state', version: '2.4.1', license: 'Apache-2.0 OR MIT' },
    ])
  })

  it('names the crate that is no longer a dependency, rather than writing a notice without it', () => {
    expect(() => readCrates('/nowhere', ['tauri-plugin-single-instance'], LOCK, DECLARED)).toThrow(
      /tauri-plugin-single-instance is not in src-tauri\/Cargo.lock/,
    )
  })

  it('refuses a crate the resolver holds two versions of, rather than notifying whichever came first', () => {
    const twice = `${LOCK}\n\n[[package]]\nname = "serde"\nversion = "1.0.229"\n`
    expect(() => readCrates('/nowhere', ['serde'], twice, DECLARED)).toThrow(/serde resolves to 2 versions \(1\.0\.230, 1\.0\.229\)/)
  })

  /* The manifest is regenerated by a different command from the one that
     bumps the lockfile, so this is the disagreement that actually happens. */
  it('names the command to run when the lockfile has moved and the manifest has not', () => {
    expect(() => readCrates('/nowhere', ['serde'], LOCK, [DECLARED[0]])).toThrow(
      /serde 1\.0\.230 is in Cargo.lock and not in scripts\/lib\/rust-crates.json — run `pnpm docs:rust-notices`/,
    )
  })

  /* Dropping a half-written block silently would make the crate look absent,
     and the caller would then say "is it still a dependency?" about a crate
     that is right there in the file. */
  it('refuses a [[package]] with no version rather than reporting the crate absent', () => {
    expect(() => lockedVersions('[[package]]\nname = "half-written"\n')).toThrow(/half-written with no version/)
  })
})

describe('the plugins’ licence text travels with the notice', () => {
  it('carries each crate’s own copyright line and the MIT permission text', () => {
    const committed = committedNotices() ?? ''
    expect(committed).toContain('Copyright (c) 2017 - Present The Tauri Programme in the Commons Conservancy')
    expect(committed).toContain('Copyright (c) 2017 - Present Tauri Apps Contributors')
    /* Once per crate — the two MIT bodies are identical past the copyright
       line, and each crate's section reproduces its own whole. */
    expect(committed.match(/Permission is hereby granted, free of charge/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('vendors the text byte-for-byte from the published crate, when a registry is here to ask', (context) => {
    /* `context.skip`, not `it.skipIf`: the ledger reads what vitest COLLECTS,
       and a statically-skipped case vanishes from collection (WI-20.38). The
       registry's src/ exists only once a build compiled the crate. */
    const home = process.env.HOME ?? ''
    const registry = path.join(home, '.cargo', 'registry', 'src')
    if (!existsSync(registry)) return context.skip('no cargo registry checkout on this machine')
    for (const { name, version } of [
      { name: 'tauri-plugin-single-instance', version: '2.4.3' },
      { name: 'tauri-plugin-window-state', version: '2.4.1' },
    ]) {
      const dirs = readdirSync(registry)
        .map((one) => path.join(registry, one, `${name}-${version}`, 'LICENSE_MIT'))
        .filter((one) => existsSync(one))
      if (dirs.length === 0) return context.skip(`${name} ${version} is not checked out here`)
      expect(readFileSync(dirs[0], 'utf8'), `${name}: vendored licence drifted from the published crate`).toBe(
        crateLicenseFor(name, version),
      )
    }
  })
})

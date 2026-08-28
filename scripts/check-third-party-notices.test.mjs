import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUNDLED_PACKAGES, BUNDLED_PLUGINS, copyrightFrom, crateLicenseFor, licenseBodyFrom, readCrates, renderNotices } from './lib/notices.mjs'
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
 * Three things are gated here, and each closes a different way for it to rot:
 *
 *   1. The committed notice IS what the installed packages say. An upgrade
 *      that changes a copyright line cannot leave the notice describing the
 *      old one.
 *   2. The notice's package list IS what `src/main.tsx` actually imports. A
 *      font added to the app and not to the list would ship unnoticed; one
 *      removed from the app and left in the list would claim a licence
 *      obligation that no longer exists.
 *   3. The file is IN the bundle. A notice that exists only in the repository
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
    for (const one of crates) {
      expect(lock, `${one.name} ${one.version} in Cargo.lock`).toContain(`name = "${one.name}"\nversion = "${one.version}"`)
      expect(one.license).not.toBe('unknown')
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
})

describe('readCrates and a cargo that misbehaves', () => {
  /* The three failure branches, each through the injected spawn — the real
   * cargo is exercised by the cases above; these are the roads it can go
   * wrong on, which a green metadata run never walks. */
  const metadata = (packages) => () => ({ status: 0, stdout: JSON.stringify({ packages }), stderr: '' })

  it('throws with cargo’s own words when metadata fails', () => {
    const spawn = () => ({ status: 101, stdout: '', stderr: 'the lock file needs to be updated' })
    expect(() => readCrates('/nowhere', ['tauri-plugin-window-state'], spawn)).toThrow(/lock file needs to be updated/)
  })

  it('names the crate that is no longer a dependency, rather than writing a notice without it', () => {
    const spawn = metadata([{ name: 'something-else', version: '1.0.0', license: 'MIT' }])
    expect(() => readCrates('/nowhere', ['tauri-plugin-window-state'], spawn)).toThrow(
      /tauri-plugin-window-state is not in the resolved workspace/,
    )
  })

  it('says unknown for a crate that declares no licence, instead of undefined', () => {
    const spawn = metadata([{ name: 'tauri-plugin-window-state', version: '2.4.1', license: null }])
    expect(readCrates('/nowhere', ['tauri-plugin-window-state'], spawn)).toEqual([
      { name: 'tauri-plugin-window-state', version: '2.4.1', license: 'unknown' },
    ])
  })

  it('names the licence FILE when the crate uses license-file, which Cargo allows in place of an id', () => {
    const spawn = metadata([{ name: 'tauri-plugin-window-state', version: '2.4.1', license: null, license_file: 'LICENCE.txt' }])
    expect(readCrates('/nowhere', ['tauri-plugin-window-state'], spawn)).toEqual([
      { name: 'tauri-plugin-window-state', version: '2.4.1', license: 'see LICENCE.txt' },
    ])
  })

  it('refuses a crate the resolver holds two versions of, rather than notifying whichever came first', () => {
    const spawn = metadata([
      { name: 'tauri-plugin-window-state', version: '2.4.1', license: 'MIT' },
      { name: 'tauri-plugin-window-state', version: '2.3.0', license: 'MIT' },
    ])
    expect(() => readCrates('/nowhere', ['tauri-plugin-window-state'], spawn)).toThrow(/2 versions \(2\.4\.1, 2\.3\.0\)/)
  })

  it('carries the spawn failure itself when cargo never ran, not "failed: null"', () => {
    const spawn = () => ({ status: null, signal: null, stdout: '', stderr: '', error: new Error('spawn cargo ENOENT') })
    expect(() => readCrates('/nowhere', ['tauri-plugin-window-state'], spawn)).toThrow(/could not run: spawn cargo ENOENT/)
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

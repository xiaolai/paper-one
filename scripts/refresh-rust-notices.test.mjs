import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RUST_CRATES_PATH,
  RUST_LICENSES_DIR,
  SHIPPED_TARGETS,
  SPDX_DIR,
  absentFromLock,
  byNameThenVersion,
  collectRustNotices,
  committedTexts,
  digestOf,
  driftBetween,
  isLicenseFile,
  licenseFilesIn,
  normaliseLicense,
  readRustCrates,
  rustLicenseText,
  serialiseCrates,
  shippedCrates,
  spdxIdsOf,
  spdxText,
} from './lib/rustNotices.mjs'
import { cargoMetadata, collectFromCargo, committedState, main, writeState } from './refresh-rust-notices.mjs'

/**
 * THE RUST HALF OF THE NOTICE, and the two failures it was bought for.
 *
 * ITEM A: the shipped binary statically links five hundred and ninety-two
 * third-party crates, overwhelmingly MIT and Apache-2.0, and the notice named
 * two of them. Both licences make permission to redistribute conditional on
 * the licence and the copyright line travelling with the copy, in the same
 * words the OFL uses for the typefaces. The document even said so about
 * itself: "the wider Rust dependency graph is not enumerated here".
 *
 * ITEM B: the answer used to be fetched by `cargo metadata --offline --locked`
 * from inside `check-third-party-notices.test.mjs`, which runs under
 * `test:coverage` — BEFORE any cargo step in `pnpm verify`. `--offline` exits
 * 101 when a lockfile package is missing from the local registry, which is the
 * shape of a fresh clone and of a CI runner restoring a rust-cache keyed on an
 * older lockfile, so any pull request touching `Cargo.lock` could redden CI at
 * the step least likely to be suspected.
 *
 * Everything here runs with a fake cargo over a scratch directory. The one
 * suite that reads the real committed corpus is in
 * `check-third-party-notices.test.mjs`, where the rest of the document's gates
 * live, and it reads files rather than spawning anything.
 */

/** A `cargo metadata` output: `deps` is `[pkgId, kindOrNull]` pairs. */
const metadata = (root, packages, edges = {}) => ({
  packages: packages.map((one) => ({ id: one.id, name: one.name, version: one.version, license: one.license, authors: one.authors ?? [], source: 'source' in one ? one.source : 'registry+x', manifest_path: one.manifest_path ?? `/crates/${one.id}/Cargo.toml` })),
  resolve: {
    root,
    nodes: packages.map((one) => ({
      id: one.id,
      deps: (edges[one.id] ?? []).map(([pkg, kind]) => ({ pkg, dep_kinds: [{ kind: kind ?? null }] })),
    })),
  },
})

const APP = { id: 'app', name: 'app', version: '0.1.0', license: 'ISC', source: null }

describe('what a cargo metadata closure says ships', () => {
  it('walks normal dependencies only, and leaves build and dev behind', () => {
    const meta = metadata(
      'app',
      [APP, { id: 'a', name: 'a', version: '1.0.0', license: 'MIT' }, { id: 'b', name: 'b', version: '1.0.0', license: 'MIT' }, { id: 'c', name: 'c', version: '1.0.0', license: 'MIT' }],
      { app: [['a', null], ['b', 'build'], ['c', 'dev']] },
    )
    expect(shippedCrates(meta).map((one) => one.name)).toEqual(['a'])
  })

  it('follows a normal dependency through a normal dependency, and stops at a cycle', () => {
    const meta = metadata(
      'app',
      [APP, { id: 'a', name: 'a', version: '1.0.0', license: 'MIT' }, { id: 'b', name: 'b', version: '1.0.0', license: 'MIT' }],
      { app: [['a', null]], a: [['b', null]], b: [['a', null]] },
    )
    expect(shippedCrates(meta).map((one) => one.name).sort()).toEqual(['a', 'b'])
  })

  /* A crate reachable both ways is SHIPPED — the build-dependency edge does
     not disqualify what a normal edge also reaches. */
  it('keeps a crate that is both a normal dependency and a build dependency', () => {
    const meta = metadata('app', [APP, { id: 'a', name: 'a', version: '1.0.0', license: 'MIT' }], { app: [['a', null], ['a', 'build']] })
    expect(shippedCrates(meta).map((one) => one.name)).toEqual(['a'])
  })

  it('drops this repository’s own crates, which its LICENSE already covers', () => {
    const meta = metadata('app', [APP, { id: 'mine', name: 'paper-data-root', version: '0.1.0', license: 'ISC', source: null }], { app: [['mine', null]] })
    expect(shippedCrates(meta)).toEqual([])
  })

  /**
   * THE THREE WAYS TRUNCATED METADATA WOULD PRODUCE AN EMPTY NOTICE, each
   * refused rather than rendered. A notice with nothing in it looks exactly
   * like a build with no dependencies, and is the one failure this whole
   * document exists to prevent.
   */
  it('refuses metadata with no root package, rather than describing nothing', () => {
    expect(() => shippedCrates(metadata(null, [APP]))).toThrow(/reported no root package/)
  })

  it('refuses metadata whose resolve graph is missing a node', () => {
    const meta = metadata('app', [APP, { id: 'a', name: 'a', version: '1.0.0', license: 'MIT' }], { app: [['a', null]] })
    meta.resolve.nodes = meta.resolve.nodes.filter((one) => one.id !== 'a')
    expect(() => shippedCrates(meta)).toThrow(/no resolve node for a/)
  })

  it('refuses metadata that resolves a package it does not describe', () => {
    const meta = metadata('app', [APP, { id: 'a', name: 'a', version: '1.0.0', license: 'MIT' }], { app: [['a', null]] })
    meta.packages = meta.packages.filter((one) => one.id !== 'a')
    expect(() => shippedCrates(meta)).toThrow(/resolved a and does not describe it/)
  })

  /* `dep_kinds` arrived in cargo 1.41. A cargo without it would answer "no
     normal dependencies" for every edge — an empty notice, green. */
  it('refuses a cargo too old to report dep_kinds, rather than reading it as no dependencies', () => {
    const meta = metadata('app', [APP, { id: 'a', name: 'a', version: '1.0.0', license: 'MIT' }], { app: [['a', null]] })
    meta.resolve.nodes[0].deps[0].dep_kinds = undefined
    expect(() => shippedCrates(meta)).toThrow(/no dep_kinds for a/)
  })
})

describe('an SPDX expression', () => {
  it('yields every identifier it names, whatever the operator', () => {
    expect(spdxIdsOf('MIT')).toEqual(['MIT'])
    expect(spdxIdsOf('MIT OR Apache-2.0')).toEqual(['MIT', 'Apache-2.0'])
    expect(spdxIdsOf('Zlib OR Apache-2.0 OR MIT')).toEqual(['Zlib', 'Apache-2.0', 'MIT'])
    /* Cargo's older spelling, still in the `unic-*` crates. */
    expect(spdxIdsOf('MIT/Apache-2.0')).toEqual(['MIT', 'Apache-2.0'])
    expect(spdxIdsOf('Apache-2.0 / MIT')).toEqual(['Apache-2.0', 'MIT'])
    expect(spdxIdsOf('(MIT OR Apache-2.0) AND Unicode-3.0')).toEqual(['MIT', 'Apache-2.0', 'Unicode-3.0'])
  })

  it('names a repeated identifier once', () => {
    expect(spdxIdsOf('(MIT OR Apache-2.0) AND Apache-2.0')).toEqual(['MIT', 'Apache-2.0'])
  })

  /* `WITH` is deliberately not understood: reproducing plain `Apache-2.0` for
     `Apache-2.0 WITH LLVM-exception` would drop the exception, which is the
     whole difference. It survives as one token and fails loudly downstream. */
  it('leaves an exception attached, so it cannot be silently dropped', () => {
    expect(spdxIdsOf('Apache-2.0 WITH LLVM-exception OR MIT')).toEqual(['Apache-2.0 WITH LLVM-exception', 'MIT'])
  })
})

describe('a licence text as it is stored', () => {
  it('loses CRLF, trailing whitespace and surrounding blank lines, and nothing else', () => {
    expect(normaliseLicense('\n\nMIT License  \r\n\r\nline two\t\n\n')).toBe('MIT License\n\nline two')
  })

  it('keeps two texts apart when they differ by a copyright line, which is the whole point', () => {
    expect(digestOf(normaliseLicense('MIT\n\nCopyright (c) A'))).not.toBe(digestOf(normaliseLicense('MIT\n\nCopyright (c) B')))
  })

  it('is identified by twelve lowercase hex digits, stable across runs', () => {
    expect(digestOf('anything')).toMatch(/^[0-9a-f]{12}$/)
    expect(digestOf('anything')).toBe(digestOf('anything'))
  })

  /* `NOTICE` is not a licence and is owed anyway: Apache-2.0 §4(d) requires a
     NOTICE file's attribution text to be reproduced in every derivative
     distribution. One crate in the union has one (`moka`), which a hand-kept
     list would never have acquired. */
  it('is what a crate ships under any of the licence or notice filenames, and never SPDX metadata', () => {
    for (const name of ['LICENSE', 'LICENCE', 'COPYING', 'LICENSE-MIT', 'LICENSE-APACHE.md', 'license-mit', 'LICENSE.txt', 'COPYING.LESSER', 'NOTICE']) {
      expect(isLicenseFile(name), name).toBe(true)
    }
    /* `LICENSE.spdx` is a declaration ABOUT the terms. Eleven crates in the
       union ship one beside their real texts; reproducing it would put a
       `SPDXVersion:` header into the notice under a licence heading. */
    for (const name of ['LICENSE.spdx', 'README.md', 'Cargo.toml', 'AUTHORS']) {
      expect(isLicenseFile(name), name).toBe(false)
    }
  })

  it('orders crates by name then version, by code unit and not by locale', () => {
    const rows = [
      { name: 'b', version: '1.0.0' },
      { name: 'a', version: '0.9.5' },
      { name: 'a', version: '0.10.1' },
    ]
    expect([...rows].sort(byNameThenVersion).map((one) => `${one.name}@${one.version}`)).toEqual(['a@0.10.1', 'a@0.9.5', 'b@1.0.0'])
    expect(byNameThenVersion({ name: 'a', version: '1' }, { name: 'a', version: '1' })).toBe(0)
  })
})

describe('reading a crate’s licence files', () => {
  const scratch = (build) => {
    const root = mkdtempSync(path.join(tmpdir(), 'paper-rust-notices-'))
    try {
      return build(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('reads every licence file it ships, in a stable order, and skips everything else', () => {
    scratch((root) => {
      for (const [name, body] of [['LICENSE-MIT', 'mit'], ['LICENSE-APACHE', 'apache'], ['README.md', 'no'], ['LICENSE.spdx', 'no']]) {
        writeFileSync(path.join(root, name), body)
      }
      mkdirSync(path.join(root, 'LICENSES'))
      expect(licenseFilesIn(root)).toEqual([
        { name: 'LICENSE-APACHE', text: 'apache' },
        { name: 'LICENSE-MIT', text: 'mit' },
      ])
    })
  })

  it('names the directory it could not read, rather than reporting a crate with no terms', () => {
    expect(() => licenseFilesIn('/nowhere/at/all')).toThrow(/no crate source at \/nowhere\/at\/all/)
  })
})

describe('a vendored standard text', () => {
  it('is on disk for every identifier the committed manifest needs', () => {
    const needed = new Set()
    for (const one of readRustCrates()) {
      if (one.standard) for (const id of spdxIdsOf(one.license)) needed.add(id)
    }
    expect(needed.size).toBeGreaterThan(0)
    for (const id of needed) expect(existsSync(path.join(SPDX_DIR, `${id}.txt`)), id).toBe(true)
  })

  it('names the crate when there is no vendored text, rather than skipping it', () => {
    expect(() => spdxText('Beerware', 'quirky 1.0.0')).toThrow(/quirky 1\.0\.0: no vendored text for SPDX id Beerware/)
  })

  /* The id comes out of a third party's `Cargo.toml` and is joined to a path
     this process can read. Refused before it becomes one. */
  it('refuses an identifier that is a path rather than an identifier', () => {
    expect(() => spdxText('../../../etc/passwd', 'hostile 1.0.0')).toThrow(/is not an SPDX identifier/)
    expect(() => rustLicenseText('../../secrets')).toThrow(/is not a licence text id/)
    expect(() => rustLicenseText('0123456789ab', '/nowhere')).toThrow(/no licence text at/)
  })
})

describe('collecting the union of the shipped targets', () => {
  const files = (map) => (dir) => (map[dir] ?? []).map(([name, text]) => ({ name, text }))
  const standard = (id) => `standard ${id} text`
  const one = (id, over = {}) => ({ id, name: id, version: '1.0.0', license: 'MIT', manifest_path: `/crates/${id}/Cargo.toml`, ...over })

  it('unions the closures, so a crate only one target links is still named', () => {
    const mac = metadata('app', [APP, one('only-mac')], { app: [['only-mac', null]] })
    const win = metadata('app', [APP, one('only-win')], { app: [['only-win', null]] })
    const { crates } = collectRustNotices([mac, win], files({ '/crates/only-mac': [['LICENSE', 'm']], '/crates/only-win': [['LICENSE', 'w']] }), standard)
    expect(crates.map((c) => c.name)).toEqual(['only-mac', 'only-win'])
  })

  it('keeps one crate at two versions apart, because they are different code', () => {
    const meta = metadata('app', [APP, one('objc2', { id: 'old', version: '0.5.2', manifest_path: '/crates/old/Cargo.toml' }), one('objc2', { id: 'new', version: '0.6.4', manifest_path: '/crates/new/Cargo.toml' })], { app: [['old', null], ['new', null]] })
    const { crates } = collectRustNotices([meta], files({ '/crates/old': [['LICENSE', 'old']], '/crates/new': [['LICENSE', 'new']] }), standard)
    expect(crates.map((c) => `${c.name}@${c.version}`)).toEqual(['objc2@0.5.2', 'objc2@0.6.4'])
    expect(crates[0].texts).not.toEqual(crates[1].texts)
  })

  it('stores one copy of a text two crates share, and one of a text one crate ships twice', () => {
    const meta = metadata('app', [APP, one('a'), one('b')], { app: [['a', null], ['b', null]] })
    const { crates, texts } = collectRustNotices(
      [meta],
      files({ '/crates/a': [['LICENSE', 'same terms'], ['LICENSE.md', 'same terms']], '/crates/b': [['LICENSE', 'same terms']] }),
      standard,
    )
    expect(texts.size).toBe(1)
    expect(crates[0].texts.length).toBe(1)
    expect(crates[0].texts).toEqual(crates[1].texts)
  })

  it('reproduces the standard text for a crate that ships none, and records its authors', () => {
    const meta = metadata('app', [APP, one('objc2', { license: 'Zlib OR Apache-2.0 OR MIT', authors: ['Mads Marquart <mads@marquart.dk>', ''] })], { app: [['objc2', null]] })
    const { crates, texts } = collectRustNotices([meta], files({}), standard)
    expect(crates[0]).toEqual({
      name: 'objc2',
      version: '1.0.0',
      license: 'Zlib OR Apache-2.0 OR MIT',
      texts: [digestOf('standard Zlib text'), digestOf('standard Apache-2.0 text'), digestOf('standard MIT text')],
      standard: true,
      authors: ['Mads Marquart <mads@marquart.dk>'],
    })
    expect(texts.size).toBe(3)
  })

  /* Twenty-seven of the fifty-four declare no authors. The row says so; it
     does not invent a holder. */
  it('omits the authors of a crate that declares none, rather than inventing one', () => {
    const meta = metadata('app', [APP, one('objc2-metal', { authors: [] })], { app: [['objc2-metal', null]] })
    const { crates } = collectRustNotices([meta], files({}), standard)
    expect(crates[0].standard).toBe(true)
    expect(crates[0].authors).toBeUndefined()
  })

  it('refuses a crate that declares no licence at all', () => {
    const meta = metadata('app', [APP, one('mystery', { license: null })], { app: [['mystery', null]] })
    expect(() => collectRustNotices([meta], files({ '/crates/mystery': [['LICENSE', 'x']] }), standard)).toThrow(/mystery 1\.0\.0: declares no licence at all/)
  })

  it('refuses an expression that names no identifier, rather than listing a crate with no terms', () => {
    const meta = metadata('app', [APP, one('odd', { license: '( )' })], { app: [['odd', null]] })
    expect(() => collectRustNotices([meta], files({}), standard)).toThrow(/names no licence/)
  })
})

describe('the manifest and the texts on disk', () => {
  const scratch = (build) => {
    const root = mkdtempSync(path.join(tmpdir(), 'paper-rust-state-'))
    try {
      return build(root, path.join(root, 'rust-crates.json'), path.join(root, 'licenses'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const collected = (crates, texts) => ({ crates, texts: new Map(texts) })

  it('is two-space JSON with one trailing newline, so the diff is a diff', () => {
    expect(serialiseCrates([{ name: 'a', version: '1.0.0', license: 'MIT', texts: [] }])).toBe(
      '[\n  {\n    "name": "a",\n    "version": "1.0.0",\n    "license": "MIT",\n    "texts": []\n  }\n]\n',
    )
  })

  it('writes every text once and the manifest beside them', () => {
    scratch((root, cratesAt, textsDir) => {
      const sha = digestOf('terms')
      const result = writeState(collected([{ name: 'a', version: '1.0.0', license: 'MIT', texts: [sha] }], [[sha, 'terms']]), cratesAt, textsDir)
      expect(result).toEqual({ written: 1, removed: 0 })
      expect(readFileSync(path.join(textsDir, `${sha}.txt`), 'utf8')).toBe('terms\n')
      expect(JSON.parse(readFileSync(cratesAt, 'utf8'))[0].name).toBe('a')
    })
  })

  /**
   * THE PRUNE IS THE HALF THAT IS EASY TO LEAVE OUT AND IMPOSSIBLE TO NOTICE
   * MISSING. An upgraded crate's old text stays committed, still readable,
   * still describing a version that no longer ships, and every gate stays
   * green because nothing asks whether a file is still needed.
   */
  it('deletes a text nothing references any more', () => {
    scratch((root, cratesAt, textsDir) => {
      mkdirSync(textsDir, { recursive: true })
      writeFileSync(path.join(textsDir, '000000000000.txt'), 'gone\n')
      writeFileSync(path.join(textsDir, 'not-a-text.md'), 'left alone\n')
      const sha = digestOf('terms')
      expect(writeState(collected([{ name: 'a', version: '1.0.0', license: 'MIT', texts: [sha] }], [[sha, 'terms']]), cratesAt, textsDir)).toEqual({ written: 1, removed: 1 })
      expect(readdirSync(textsDir).sort()).toEqual([`${sha}.txt`, 'not-a-text.md'].sort())
    })
  })

  it('reads back what is committed, normalised, and ignores a filename that is not a text id', () => {
    scratch((root, cratesAt, textsDir) => {
      mkdirSync(textsDir, { recursive: true })
      writeFileSync(path.join(textsDir, '0123456789ab.txt'), 'terms  \r\n')
      writeFileSync(path.join(textsDir, 'notes.txt'), 'ignored')
      expect([...committedTexts(textsDir)]).toEqual([['0123456789ab', 'terms']])
    })
  })

  it('reports nothing committed where the directory does not exist yet, rather than throwing', () => {
    expect(committedTexts('/nowhere/at/all').size).toBe(0)
  })

  it('treats a missing manifest as nothing committed, and a broken one as broken', () => {
    scratch((root, cratesAt, textsDir) => {
      expect(committedState(cratesAt, textsDir)).toEqual({ crates: [], texts: new Map() })
      writeFileSync(cratesAt, '{ not json')
      expect(() => committedState(cratesAt, textsDir)).toThrow(SyntaxError)
    })
  })
})

/**
 * DRIFT IS REPORTED AS A LIST, NOT AS A BOOLEAN. A lockfile bump that adds
 * four crates and upgrades two should say which six; a bare "drifted" sends
 * the reader to `git diff` on an eight-hundred-row JSON file.
 */
describe('drift between the registry and what is committed', () => {
  const crate = (name, over = {}) => ({ name, version: '1.0.0', license: 'MIT', texts: ['0123456789ab'], ...over })
  const state = (crates, texts) => ({ crates, texts: new Map(texts) })

  it('finds nothing when the two agree', () => {
    const both = state([crate('a')], [['0123456789ab', 'terms']])
    expect(driftBetween(both, both)).toEqual([])
  })

  it('names a crate that now ships and is not in the manifest', () => {
    const fresh = state([crate('a'), crate('newcomer', { license: 'MPL-2.0' })], [['0123456789ab', 'terms']])
    const held = state([crate('a')], [['0123456789ab', 'terms']])
    expect(driftBetween(fresh, held)).toEqual(['newcomer@1.0.0 is linked into the binary and is not in the manifest (MPL-2.0)'])
  })

  it('names a crate that is in the manifest and no longer ships', () => {
    const fresh = state([crate('a')], [['0123456789ab', 'terms']])
    const held = state([crate('a'), crate('departed')], [['0123456789ab', 'terms']])
    expect(driftBetween(fresh, held)).toEqual(['departed@1.0.0 is in the manifest and is no longer linked into the binary'])
  })

  it('names a crate whose licence or texts changed under the same version', () => {
    const fresh = state([crate('a', { license: 'MIT OR Apache-2.0' })], [['0123456789ab', 'terms']])
    const held = state([crate('a')], [['0123456789ab', 'terms']])
    expect(driftBetween(fresh, held)[0]).toMatch(/^a@1\.0\.0 has changed: the manifest says .*"MIT".*the registry says .*"MIT OR Apache-2\.0"/s)
  })

  it('names a referenced text that is not committed, and a committed text nothing references', () => {
    const fresh = state([crate('a')], [['0123456789ab', 'terms']])
    const held = state([crate('a')], [['ffffffffffff', 'orphan']])
    expect(driftBetween(fresh, held).sort()).toEqual([
      'licence text 0123456789ab.txt is referenced and is not committed',
      'licence text ffffffffffff.txt is committed and is referenced by nothing',
    ])
  })

  /* A name-only comparison is blind to this: an edited text keeps its
     filename, so the sha sets match perfectly while the notice reproduces
     something the crate never published. */
  it('names a text that has been edited in place, which its filename alone would hide', () => {
    const fresh = state([crate('a')], [['0123456789ab', 'terms']])
    const held = state([crate('a')], [['0123456789ab', 'terms with a clause somebody added']])
    expect(driftBetween(fresh, held)).toEqual(['licence text 0123456789ab.txt has been edited — its contents no longer hash to its name'])
  })
})

/**
 * THE HALF OF THE CHECK THAT NEEDS NO CARGO: the manifest against
 * `Cargo.lock`, which every clone has. It is what
 * `check-third-party-notices.test.mjs` runs offline; the opposite direction —
 * a crate that ships and is named nowhere — needs cargo and is
 * `--check`'s job.
 */
describe('the manifest against the lockfile', () => {
  const locked = new Map([['serde', ['1.0.230']], ['objc2', ['0.5.2', '0.6.4']]])

  it('finds nothing when every crate is pinned at the version it claims', () => {
    expect(absentFromLock([{ name: 'serde', version: '1.0.230' }, { name: 'objc2', version: '0.6.4' }], locked)).toEqual([])
  })

  it('names a crate the lockfile has never heard of', () => {
    expect(absentFromLock([{ name: 'ghost', version: '1.0.0' }], locked)).toEqual([
      'ghost@1.0.0 is in the manifest and in no [[package]] of Cargo.lock',
    ])
  })

  it('names a crate the lockfile pins at another version, and says which', () => {
    expect(absentFromLock([{ name: 'serde', version: '1.0.229' }], locked)).toEqual([
      'serde@1.0.229 is in the manifest; Cargo.lock pins 1.0.230',
    ])
  })
})

describe('the cargo call', () => {
  const ok = (packages) => (cmd, args) => ({ status: 0, stdout: JSON.stringify(metadata('app', packages, { app: packages.filter((one) => one.id !== 'app').map((one) => [one.id, null]) })), stderr: '', args })

  /**
   * ⚠️ `--offline` IS ABSENT ON PURPOSE. It is what made the old call in
   * `check-third-party-notices.test.mjs` exit 101 on a fresh clone and on a
   * CI runner with a stale rust-cache. `--locked` stays, because a metadata
   * call that quietly rewrites `Cargo.lock` is the corruption
   * `dev-docs/versioning.md` records and nobody watches a metadata call for it.
   */
  it('asks cargo for one target, locked, and never offline', () => {
    let seen
    cargoMetadata('/repo', 'x86_64-pc-windows-msvc', (cmd, args) => {
      seen = { cmd, args }
      return { status: 0, stdout: '{}', stderr: '' }
    })
    expect(seen.cmd).toBe('cargo')
    expect(seen.args).toContain('--locked')
    expect(seen.args).not.toContain('--offline')
    expect(seen.args.slice(-4)).toEqual(['--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', path.join('/repo', 'src-tauri', 'Cargo.toml')])
  })

  it('carries cargo’s own words when it fails, and the spawn failure when it never ran', () => {
    expect(() => cargoMetadata('/repo', 'x', () => ({ status: 101, stdout: '', stderr: 'the lock file needs to be updated' }))).toThrow(/the lock file needs to be updated/)
    expect(() => cargoMetadata('/repo', 'x', () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }))).toThrow(/failed \(exit signal SIGKILL\)/)
    expect(() => cargoMetadata('/repo', 'x', () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn cargo ENOENT') }))).toThrow(/could not run: spawn cargo ENOENT/)
  })

  it('runs one metadata call per shipped target', () => {
    const asked = []
    collectFromCargo('/repo', SHIPPED_TARGETS, (cmd, args) => {
      asked.push(args[args.indexOf('--filter-platform') + 1])
      return ok([APP])(cmd, args)
    })
    expect(asked).toEqual([...SHIPPED_TARGETS])
  })
})

describe('the script itself', () => {
  const scratch = (build) => {
    const root = mkdtempSync(path.join(tmpdir(), 'paper-rust-main-'))
    try {
      return build({ root, cratesAt: path.join(root, 'rust-crates.json'), textsDir: path.join(root, 'licenses') })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  /* One crate shipping one licence file, through a fake cargo and a fake
     registry — the registry directory is real, so `licenseFilesIn` is the
     production one. */
  const fakeCargo = (dir, license = 'MIT') => () => ({
    status: 0,
    stdout: JSON.stringify(metadata('app', [APP, { id: 'a', name: 'a', version: '1.0.0', license, manifest_path: path.join(dir, 'Cargo.toml') }], { app: [['a', null]] })),
    stderr: '',
  })

  it('refuses an argument it does not know, because tolerance here would WRITE', () => {
    const out = []
    /* `--chek` fell through to write mode in `write-third-party-notices` and
       mutated a committed document on what was meant to be a read. */
    expect(main(['--chek'], { fail: (line) => out.push(line) })).toBe(2)
    expect(out.join('')).toMatch(/unknown argument "--chek"/)
  })

  it('writes the manifest and the texts, and says what to run next', () => {
    scratch(({ root, cratesAt, textsDir }) => {
      const crate = path.join(root, 'crate')
      mkdirSync(crate)
      writeFileSync(path.join(crate, 'LICENSE'), 'terms\n')
      const out = []
      expect(main([], { root, cratesAt, textsDir, spawn: fakeCargo(crate), write: (line) => out.push(line) })).toBe(0)
      expect(out.join('')).toMatch(/1 crates, 1 licence texts/)
      expect(out.join('')).toMatch(/now run `pnpm docs:notices`/)
      expect(JSON.parse(readFileSync(cratesAt, 'utf8'))).toEqual([{ name: 'a', version: '1.0.0', license: 'MIT', texts: [digestOf('terms')] }])
    })
  })

  it('says how many orphaned texts it removed, when it removed any', () => {
    scratch(({ root, cratesAt, textsDir }) => {
      const crate = path.join(root, 'crate')
      mkdirSync(crate)
      writeFileSync(path.join(crate, 'LICENSE'), 'terms\n')
      mkdirSync(textsDir, { recursive: true })
      writeFileSync(path.join(textsDir, '000000000000.txt'), 'stale\n')
      const out = []
      expect(main([], { root, cratesAt, textsDir, spawn: fakeCargo(crate), write: (line) => out.push(line) })).toBe(0)
      expect(out.join('')).toMatch(/1 orphaned text removed/)
    })
  })

  it('is idempotent: --check is clean immediately after a write', () => {
    scratch(({ root, cratesAt, textsDir }) => {
      const crate = path.join(root, 'crate')
      mkdirSync(crate)
      writeFileSync(path.join(crate, 'LICENSE'), 'terms\n')
      const io = { root, cratesAt, textsDir, spawn: fakeCargo(crate), write: () => {}, fail: () => {} }
      expect(main([], io)).toBe(0)
      const out = []
      expect(main(['--check'], { ...io, write: (line) => out.push(line) })).toBe(0)
      expect(out.join('')).toMatch(/1 crates and 1 licence texts, all current/)
    })
  })

  it('exits 1 naming the crate that drifted and the command that fixes it', () => {
    scratch(({ root, cratesAt, textsDir }) => {
      const crate = path.join(root, 'crate')
      mkdirSync(crate)
      writeFileSync(path.join(crate, 'LICENSE'), 'terms\n')
      const io = { root, cratesAt, textsDir, write: () => {} }
      expect(main([], { ...io, spawn: fakeCargo(crate) })).toBe(0)
      const out = []
      /* The lockfile bump: the same crate, now dual-licensed. */
      expect(main(['--check'], { ...io, spawn: fakeCargo(crate, 'MIT OR Apache-2.0'), fail: (line) => out.push(line) })).toBe(1)
      expect(out.join('')).toMatch(/a@1\.0\.0 has changed/)
      expect(out.join('')).toMatch(/1 finding — run `pnpm docs:rust-notices`/)
    })
  })
})

describe('the committed corpus', () => {
  it('is where this module says it is, so a move cannot go unnoticed', () => {
    expect(existsSync(RUST_CRATES_PATH)).toBe(true)
    expect(existsSync(RUST_LICENSES_DIR)).toBe(true)
    expect(existsSync(SPDX_DIR)).toBe(true)
  })

  it('is serialised exactly as it is committed, byte for byte', () => {
    expect(readFileSync(RUST_CRATES_PATH, 'utf8')).toBe(serialiseCrates(readRustCrates()))
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * WI-10.1 — the capability fs/storage FOOTPRINT, pinned from source.
 *
 * Phase 10's confinement rules (`docs/plans/phase-10-capability-confinement.md`)
 * are only correct against a KNOWN surface: the set of places a capability
 * touches the kernel's raw filesystem or flat store. This test enumerates that
 * surface from the source tree — every write-shaped fs call, every raw
 * `getItem`/`setItem`, every grab of `services.fs`/`services.storage` — and
 * compares it with the reviewed allowlist below. A new call site, a widened
 * path, or a new raw-storage key fails HERE, at review time, rather than only
 * when the new code happens to run. Precedent: the enumerated-writers test of
 * WI-6.4 (`journal.test.ts`), which pins the KERNEL's writers the same way.
 *
 * The allowlist is a REVIEW ARTIFACT: adding to it is a decision, and the
 * entry's comment says what the site reaches and why that is allowed. It also
 * fails when a listed site DISAPPEARS, so it cannot drift stale.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CAPABILITIES_ROOT = path.join(REPO_ROOT, 'src', 'capabilities')

/* ------------------------------------------------------------- the scan */

/** Every production source under `src/capabilities` — tests and testkits are
 *  not runtime surface. Sorted, so the enumeration is stable. */
function productionSources(dir = CAPABILITIES_ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      productionSources(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.(test|testkit)\.tsx?$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

/** Strip comments so a doc comment MENTIONING a call is not a call. Block
 *  comments whole; line comments only when `//` follows start or whitespace,
 *  so a `https://` inside a string survives. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}

/** The first argument of a call, given the text after its `(` — walks
 *  brackets so a template literal holding a nested call stays whole. */
function firstArg(text) {
  let depth = 0
  let out = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break
      depth--
    } else if (ch === ',' && depth === 0) break
    out += ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** One file's footprint entries, each `"<relative file> <signature>"`. */
function scanFile(file) {
  const relative = path.relative(CAPABILITIES_ROOT, file).split(path.sep).join('/')
  const text = stripComments(readFileSync(file, 'utf8'))
  const entries = new Set()

  /* Write-shaped calls on ANY receiver: raw fs writes, kernel-store removals,
   * and anything a future capability invents that can delete or overwrite.
   * `remove` before `removeDir` would truncate the match — longest first. */
  const write = /([\w$]+)\??\.(writeFile|appendFile|removeDir|remove|rename|mkdir)\(/g
  for (let m; (m = write.exec(text)); ) {
    entries.add(`${relative} ${m[1]}.${m[2]}(${firstArg(text.slice(m.index + m[0].length))})`)
  }

  /* The kernel's path-writing helpers a capability may call with a raw fs. */
  const helper = /\b(atomicWrite|notePresence|writePresence)\(\s*([\w$]+)\s*,\s*/g
  for (let m; (m = helper.exec(text)); ) {
    const second = m[1] === 'atomicWrite' ? firstArg(text.slice(m.index + m[0].length)) : ''
    entries.add(second === '' ? `${relative} ${m[1]}(${m[2]})` : `${relative} ${m[1]}(${m[2]}, ${second})`)
  }

  /* Raw flat-store touches, whatever the handle is called locally. */
  const store = /([\w$]+)\??\.(getItem|setItem|removeItem)\(/g
  for (let m; (m = store.exec(text)); ) {
    entries.add(`${relative} ${m[1]}.${m[2]}(${firstArg(text.slice(m.index + m[0].length))})`)
  }

  /* Every call into the kernel's closed-name delete primitive — after
   * WI-10.5 the ONLY door into books/<id>/ a capability has. */
  const primitive = /\b(?:[\w$]+\.)*removeBlob\(\s*/g
  for (let m; (m = primitive.exec(text)); ) {
    entries.add(`${relative} removeBlob(${firstArg(text.slice(m.index + m[0].length))})`)
  }

  /* Grabs of the kernel's raw handles — direct or by destructuring. */
  const grab = /\bservices\.(fs|storage)\b/g
  for (let m; (m = grab.exec(text)); ) entries.add(`${relative} services.${m[1]}`)
  const destructure = /\{([^}]*)\}\s*=\s*(?:[\w$]+\.)*services\b/g
  for (let m; (m = destructure.exec(text)); ) {
    for (const name of ['fs', 'storage']) {
      if (new RegExp(`\\b${name}\\b`).test(m[1])) entries.add(`${relative} { ${name} } = services`)
    }
  }

  return entries
}

/* -------------------------------------------------- the reviewed surface */

/**
 * The audited footprint (plan §"Current footprint", 2026-08-19), as the
 * phase leaves it. One line per distinct call signature; the comment is the
 * review verdict. The invariant this list now states: every raw-fs write a
 * capability makes resolves under `sync/`, the only `books/<id>/` deletes
 * are `removeBlob` calls — the kernel's closed-name primitive (WI-10.2/10.5)
 * — and NO capability touches the raw flat store: the cards read rides
 * `services.cards.stored()` (WI-10.4).
 */
const REVIEWED_FOOTPRINT = [
  /* -- the kernel handles sync holds -- */
  // `start` takes the fs for the journal, the cover cache and the downloads
  // ledger. No `services.storage` anywhere: the cards read rides
  // `services.cards.stored()` (WI-10.4).
  'sync/index.ts services.fs',
  // The pass-through handing the cover cache the kernel primitive.
  'sync/index.ts removeBlob(book)',
  // The backfill reads books/** to hash; it writes through the library store.
  'sync/lib/backfill.ts { fs } = services',
  // The ledger reads books/** to digest and serve.
  'sync/lib/ledger.ts { fs } = services',
  // The downloads ledger reads its own index under sync/.
  'sync/ui/storageModel.ts { fs } = services',

  /* -- sync/lib/coverCache.ts -- jackets, LRU-tracked under sync/. */
  // The LRU index. `COVER_INDEX_PATH` = sync/covers.json (asserted below).
  'sync/lib/coverCache.ts atomicWrite(fs, COVER_INDEX_PATH)',
  // Eviction's only delete — the kernel's closed-name primitive, which
  // refuses anything but content.<ext> / cover.jpg / the legacy cover.webp.
  'sync/lib/coverCache.ts removeBlob(book)',

  /* -- sync/lib/journal.ts -- the replication spine, all under sync/. */
  'sync/lib/journal.ts atomicWrite(fs, JOURNAL_META_PATH)',
  'sync/lib/journal.ts atomicWrite(fs, JOURNAL_PATH)',
  'sync/lib/journal.ts fs.appendFile(JOURNAL_PATH)',
  'sync/lib/journal.ts fs.mkdir(SYNC_DIR)',
  'sync/lib/journal.ts fs.remove(JOURNAL_DIRTY_PATH)',
  /* The corruption recovery (ADR 0001 Decision 9). A journal that contradicts
   * itself is MOVED ASIDE and rebuilt from the folders rather than refused —
   * refusing left sync dead until someone deleted a file by hand. Both paths
   * are the journal's own, under `sync/`: the rename's destination is built
   * from `SYNC_DIR`, and the meta file goes so `bootstrap` mints a fresh
   * epoch. Nothing is deleted; the evidence keeps its bytes under a new name. */
  'sync/lib/journal.ts fs.remove(JOURNAL_META_PATH)',
  'sync/lib/journal.ts fs.rename(JOURNAL_PATH)',
  'sync/lib/journal.ts fs.writeFile(JOURNAL_DIRTY_PATH)',
  'sync/lib/journal.ts fs.writeFile(JOURNAL_PATH)',
  // Bootstrap notes a trashed book in the presence register —
  // `PRESENCE_PATH` = sync/removed.json (asserted below).
  'sync/lib/journal.ts notePresence(fs)',

  /* -- sync/lib/ledger.ts -- */
  // Remove-download deletes the content blob by CLOSED NAME through the
  // kernel primitive — it cannot be handed a path and cannot name book.json.
  'sync/lib/ledger.ts removeBlob(book)',
  // Remote removals land through the KERNEL STORE, not raw fs.
  'sync/lib/ledger.ts library.remove(book)',
  // Presence writes — sync/removed.json.
  'sync/lib/ledger.ts notePresence(target)',
  'sync/lib/ledger.ts writePresence(target)',

  /* -- sync/ui/storageModel.ts -- the downloads ledger, under sync/. */
  'sync/ui/storageModel.ts atomicWrite(fs, DOWNLOADS_INDEX_PATH)',
].sort()

/** Path constants the footprint above leans on: each must resolve under the
 *  capability's own namespace, or the allowlist would be naming a lie. */
const SYNC_PATH_CONSTANTS = [
  ['src/capabilities/sync/lib/journal.ts', 'SYNC_DIR', 'sync'],
  ['src/capabilities/sync/lib/journal.ts', 'JOURNAL_PATH', 'sync/journal.jsonl'],
  ['src/capabilities/sync/lib/journal.ts', 'JOURNAL_META_PATH', 'sync/journal.meta.json'],
  ['src/capabilities/sync/lib/journal.ts', 'JOURNAL_DIRTY_PATH', 'sync/journal.dirty'],
  ['src/capabilities/sync/lib/coverCache.ts', 'COVER_INDEX_PATH', 'sync/covers.json'],
  ['src/capabilities/sync/ui/storageModel.ts', 'DOWNLOADS_INDEX_PATH', 'sync/downloads.json'],
  ['src/kernel/core/presence.ts', 'PRESENCE_PATH', 'sync/removed.json'],
]

/* --------------------------------------------------------------- the test */

describe('the capability fs/storage footprint (WI-10.1)', () => {
  it('matches the reviewed allowlist exactly — no new raw write, key or handle', () => {
    const actual = new Set()
    for (const file of productionSources()) for (const entry of scanFile(file)) actual.add(entry)
    expect([...actual].sort()).toEqual(REVIEWED_FOOTPRINT)
  })

  it('every path constant the allowlist leans on resolves under sync/', () => {
    for (const [file, name, value] of SYNC_PATH_CONSTANTS) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      const m = new RegExp(`const ${name} = '([^']*)'`).exec(text)
      expect(m, `${name} in ${file}`).not.toBeNull()
      expect(m[1], `${name} in ${file}`).toBe(value)
      expect(m[1] === 'sync' || m[1].startsWith('sync/'), `${name} must stay inside sync/`).toBe(true)
    }
  })

  it('no capability imports the platform fs or reaches for localStorage', () => {
    for (const file of productionSources()) {
      const text = readFileSync(file, 'utf8')
      expect(text.includes('@tauri-apps/plugin-fs'), `${file} imports the platform fs`).toBe(false)
      expect(/\blocalStorage\b/.test(stripComments(text)), `${file} reaches localStorage`).toBe(false)
    }
  })
})

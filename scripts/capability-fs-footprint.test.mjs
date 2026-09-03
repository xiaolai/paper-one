import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * WI-10.1 — the capability fs/storage FOOTPRINT, pinned from source.
 *
 * Phase 10's confinement rules (`dev-docs/plans/phase-10-capability-confinement.md`)
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

/**
 * Strip comments so a doc comment MENTIONING a call is not a call.
 *
 * STRING-AWARE, and it has to be. The first version was two regexes, and a
 * quoted `/*` — in a glob, a URL, a regex written as a string — opened a
 * comment that ran to the next `*\/` ANYWHERE LATER IN THE FILE, deleting
 * every line between. Whatever `writeFile` lived in that stretch was invisible
 * to this gate, which is the one failure a footprint scanner must not have:
 * it does not report a widened surface, it reports a smaller one, silently.
 *
 * So this walks the text once, tracking whether it is inside `'`, `"` or a
 * template, and only treats `/*` and `//` as comments outside them.
 */
function stripComments(text) {
  let out = ''
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote !== null) {
      out += ch === '\n' ? ch : ' '
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ' '
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const skipped = text.slice(i, end === -1 ? text.length : end + 2)
      /* Newlines kept so reported line numbers stay true. */
      out += skipped.replace(/[^\n]/g, ' ')
      i += skipped.length - 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const skipped = text.slice(i, end === -1 ? text.length : end)
      out += ' '.repeat(skipped.length)
      i += skipped.length - 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * Forms this scanner cannot read, which it must REFUSE rather than pass.
 *
 * The call detection is a regex over `receiver.method(`, so a write reached
 * any other way is invisible to it — and invisible means "not in the
 * footprint", which reads as "this capability touches nothing". A gate whose
 * failure mode is a smaller surface than the truth is worse than no gate, so
 * the two forms that defeat it are named and rejected on sight. A capability
 * that genuinely needs one can add it here with the reasoning, exactly as the
 * allowlist works.
 */
const UNREADABLE = [
  {
    what: 'a write method reached by bracket access',
    /* `fs["writeFile"](…)` — the string-literal form, which is the realistic
       way the dotted regex above gets sidestepped.
       DELIBERATELY NOT `receiver[expr](…)`. That arm was written first and
       flagged `handlers[0](x)` — an ordinary array call — so it would have
       refused legitimate code to guard against a form nothing writes. A fully
       dynamic `fs[name](…)` remains outside what this scan can see; the
       honest statement is that it is unhandled, not that it is covered. */
    pattern: /[\w$)\]]\s*\[\s*['"`](?:writeFile|appendFile|removeDir|remove|rename|mkdir)['"`]\s*\]\s*\(/,
  },
  {
    what: 'a write method destructured off its object',
    pattern: /\b(?:const|let|var)\s*\{[^}]*\b(?:writeFile|appendFile|removeDir|remove|rename|mkdir)\b[^}]*\}\s*=/,
  },
]

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
  /* -- circle -- another reader's passages, beside the marks and never in them.
   *
   * ⚠️ **THE REVIEW, since that is what this list is.** The circle writes ONE
   * shape of path and reads one: `books/<id>/circle/<person>.json`, built by
   * the kernel's `circlePathIn`. Three things make that narrow enough to
   * allow:
   *
   *  - **The person id goes through `safeId`**, the same sanitiser
   *    `folderOf` uses — no slash, never empty. That id arrives from ANOTHER
   *    READER and is the least trusted string any capability writes with, so
   *    the check is not incidental. `bookFolder.ts` records what an empty
   *    segment once cost: `trashBook(fs, '')` renamed the whole library.
   *  - **It is never `books/<id>/marks.json`.** A foreign passage in the marks
   *    file is carried by `exportMarks`, by the sync feed and by every one of
   *    the reader's own devices — as THEIR annotation. The separate file IS
   *    the mechanism that prevents it, which is why the write is here rather
   *    than through the marks store.
   *  - **The only delete is that same path.** `purgeForeign` removes one
   *    person's file for one book — `relationships.md`'s `retain: 'purge'` —
   *    and cannot name anything else, because it builds the path the same way.
   *
   * `services.fs` in `index.ts` is the read side: the capability lists the
   * circle folder and reads those files to draw. It writes nothing there. */
  'circle/index.ts services.fs',
  /* ⚠️ `atomicWrite`, and this said `fs.writeFile`. The raw call would have
     failed on the FIRST production write: `circle/` does not exist until
     something creates it and `writeFile` creates no parent. `atomicWrite`
     makes the parent and renames into place, which also means a crash
     mid-write leaves the previous file rather than a truncated one. The path
     it is given is still built the same way, so everything above still holds
     — it is the same one path, written more carefully. */
  /* ⚠️ **THE PUBLISHER'S STORE, AND IT IS DELIBERATELY NOT UNDER `circle/`.**
     `peopleFor` lists the `circle/` folder and reads every `*.json` in it as a
     PERSON, so a publisher's file put there would appear in the reader's own
     circle as somebody called `published` — a person who cannot be removed
     because they do not exist. `sharedPathIn` is the kernel's constant, beside
     `marks.json`, and this capability cannot name any other file with it.

     It is also NOT a field on `Mark`, which `wire.md` argues and refuses: a
     field would ride the existing sync for free and thereby send a SOCIAL fact
     — what you chose to publish — to every one of your own devices whether
     they take part in the circle or not. */
  'circle/lib/publish.ts atomicWrite(fs, sharedPathIn(bookId))',
  'circle/lib/store.ts atomicWrite(fs, circlePathIn(bookId, person))',
  'circle/lib/store.ts fs.remove(path)',

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

  /* -- sync/lib/arrivals.ts -- which books turned up here on their own. */
  /* One index under `sync/`, written the way the covers LRU and the downloads
   * ledger are: read-modify-write through `atomicWrite`, never a raw handle.
   * It holds a device name and a timestamp per book and nothing else — no
   * path, so no path can widen — and the row is dropped once the reader opens
   * the book. `ARRIVALS_INDEX_PATH` = sync/arrivals.json (asserted below). */
  'sync/lib/arrivals.ts atomicWrite(fs, ARRIVALS_INDEX_PATH)',

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
  // Remote removals land through ONE KERNEL VERB — `noteRemoteRemoval`, which
  // does the register write and the folder move on the book's own lane. The
  // ledger no longer touches presence directly (WI-20.1); the three raw calls
  // that used to be here — `library.remove`, `notePresence`, `writePresence`
  // — moved into the library, where the fs footprint is already reviewed.

  /* -- sync/ui/storageModel.ts -- the downloads ledger, under sync/. */
  'sync/ui/storageModel.ts atomicWrite(fs, DOWNLOADS_INDEX_PATH)',
].sort()

/** Path constants the footprint above leans on: each must resolve under the
 *  capability's own namespace, or the allowlist would be naming a lie. */
const SYNC_PATH_CONSTANTS = [
  /* DECLARED in `journalEntry.ts` — the journal's trust boundary, split out of
   * `journal.ts` when that file passed a thousand lines — and re-exported from
   * `journal.ts` so every importer keeps one door. This gate reads the
   * DECLARATION, so it names the file that holds it. */
  ['src/capabilities/sync/lib/journalEntry.ts', 'SYNC_DIR', 'sync'],
  ['src/capabilities/sync/lib/journalEntry.ts', 'JOURNAL_PATH', 'sync/journal.jsonl'],
  ['src/capabilities/sync/lib/journalEntry.ts', 'JOURNAL_META_PATH', 'sync/journal.meta.json'],
  ['src/capabilities/sync/lib/journalEntry.ts', 'JOURNAL_DIRTY_PATH', 'sync/journal.dirty'],
  ['src/capabilities/sync/lib/arrivals.ts', 'ARRIVALS_INDEX_PATH', 'sync/arrivals.json'],
  ['src/capabilities/sync/lib/coverCache.ts', 'COVER_INDEX_PATH', 'sync/covers.json'],
  ['src/capabilities/sync/ui/storageModel.ts', 'DOWNLOADS_INDEX_PATH', 'sync/downloads.json'],
  ['src/kernel/core/presence.ts', 'PRESENCE_PATH', 'sync/removed.json'],
]

/* ------------------------------------------------- capabilities come and go */

/**
 * A CAPABILITY CAN BE DELETED, and this file has to survive that.
 *
 * `capability:remove <id>` deletes `src/capabilities/<id>/` outright — that is
 * the point of it, and `pnpm verify:without <id>` holds the resulting tree to
 * the gates as the physical proof that deletion is an operation (ADR 0001
 * decision 7). This test read the sync sources unconditionally and compared the
 * WHOLE footprint with `toEqual`, so in that tree it failed twice: an ENOENT on
 * `sync/lib/journal.ts`, and an allowlist listing entries no longer in the
 * tree. The proof could not pass while the thing proving it was here.
 *
 * The fix is NOT to skip when the directory is gone — a check that quietly does
 * nothing is the defect this file exists to prevent, wearing a different hat.
 * Both states are asserted instead: a capability that is PRESENT must match its
 * reviewed entries exactly, and one that is ABSENT must contribute none at all.
 * The removed tree therefore checks something stronger than the full tree does
 * — that the removal was complete — rather than checking less.
 */

/** The capability a footprint entry belongs to: the first path segment of
 *  `"<capability>/<file> <signature>"`. */
const ownerOfEntry = (entry) => entry.slice(0, entry.indexOf('/'))

/** The capability a repo-relative file belongs to, or null for a kernel file —
 *  which has no capability to be removed with, so its absence is a defect. */
function ownerOfFile(file) {
  const m = /^src\/capabilities\/([^/]+)\//.exec(file)
  return m ? m[1] : null
}

/** Whether a capability's source is still in the tree. */
const present = (id) => existsSync(path.join(CAPABILITIES_ROOT, id))

/** Every capability the allowlist speaks for, in sorted order. */
const REVIEWED_CAPABILITIES = [...new Set(REVIEWED_FOOTPRINT.map(ownerOfEntry))].sort()

/* --------------------------------------------------------------- the test */

describe('the capability fs/storage footprint (WI-10.1)', () => {
  const scanned = () => {
    const actual = new Set()
    for (const file of productionSources()) for (const entry of scanFile(file)) actual.add(entry)
    return [...actual].sort()
  }

  it('matches the reviewed allowlist exactly — no new raw write, key or handle', () => {
    const actual = scanned()

    /* PER CAPABILITY, so a removed one is accounted for rather than skipped.
       Present: its entries must be exactly the reviewed set — the ratchet, and
       it still bites in the real tree where both capabilities are here.
       Absent: it must contribute nothing, which is what makes the removal
       complete rather than merely started. */
    /* A CAPABILITY MAY ONLY BE ABSENT IF THE MANIFEST SAYS SO.
     *
     * The absent branch below asserts that a removed capability contributes no
     * entries — and on its own that is a TAUTOLOGY: `productionSources()` walks
     * the directory, so a directory that is not there contributes nothing no
     * matter what the code in it used to do. Deleting `src/capabilities/sync`
     * while leaving it declared would therefore have turned the exact-footprint
     * gate into a check that passes by having nothing to check.
     *
     * The manifest is what makes the absence mean something: `capability:remove`
     * takes the entry out of `capabilities.manifest.json` in the same operation
     * that deletes the sources, so declared-but-missing is not a removal, it is
     * a broken tree. */
    const declared = new Set(
      JSON.parse(readFileSync(path.join(REPO_ROOT, 'capabilities.manifest.json'), 'utf8'))
        .capabilities.map((entry) => entry.ts ?? entry.id),
    )
    for (const id of REVIEWED_CAPABILITIES) {
      const mine = actual.filter((entry) => ownerOfEntry(entry) === id)
      const reviewed = REVIEWED_FOOTPRINT.filter((entry) => ownerOfEntry(entry) === id)
      if (present(id)) {
        expect(mine, `${id} is in the tree`).toEqual(reviewed)
        continue
      }
      expect(declared.has(id), `${id}'s sources are gone but the manifest still declares it`).toBe(
        false,
      )
      expect(mine, `${id} was removed — it must leave no footprint`).toEqual([])
    }

    /* And nothing from a capability the allowlist has never seen. A new
       capability that touches the filesystem is a review, not a silent pass. */
    const unreviewed = actual.filter((entry) => !REVIEWED_CAPABILITIES.includes(ownerOfEntry(entry)))
    expect(unreviewed, 'a capability outside the reviewed set touched fs or storage').toEqual([])
  })

  it('refuses a capability written in a form it cannot read', () => {
    /* THE GATE'S OWN BLIND SPOT, named and closed. Call detection is a regex
       over `receiver.method(`, so a write reached by bracket access or off a
       destructured binding is invisible — and invisible reads as "this
       capability touches nothing", which is the one direction a footprint
       scanner must never be wrong in. */
    for (const file of productionSources()) {
      /* THE RAW TEXT, NOT THE STRIPPED ONE. `stripComments` blanks the inside
         of every string — which is exactly where `fs['writeFile']` keeps its
         method name, so scanning the stripped text hid the form this guard
         exists to catch. A comment mentioning one is a false positive worth
         having: it costs a reworded comment, where the miss costs a silent
         hole in the footprint. */
      const text = readFileSync(file, 'utf8')
      for (const { what, pattern } of UNREADABLE) {
        const at = text.search(pattern)
        expect(
          at,
          `${path.relative(REPO_ROOT, file)} uses ${what}, which this scan cannot see`,
        ).toBe(-1)
      }
    }
  })

  it('does not let a quoted /* swallow the code after it', () => {
    /* The hole this stripper was rewritten for. Two regexes treated a slash-star
       inside a STRING as a comment opener, so everything up to the next
       close-comment ANYWHERE LATER IN THE FILE was deleted — taking any
       writeFile in that stretch out of the footprint without a word.
       (Written in words rather than in symbols: a literal close-comment in
       here ends this comment, which is how the first attempt broke.) */
    const source = [
      'const glob = "/*.epub"',
      'await fs.writeFile(SOMEWHERE, bytes)',
      'const done = true',
    ].join('\n')
    const stripped = stripComments(source)
    expect(stripped).toContain('fs.writeFile')
    expect(stripped).toContain('const done')
  })

  it('still strips a real comment, and keeps the line numbers true', () => {
    const source = ['const a = 1 // fs.writeFile(x)', '/* fs.rename(y) */', 'const b = 2'].join('\n')
    const stripped = stripComments(source)
    expect(stripped).not.toContain('writeFile')
    expect(stripped).not.toContain('rename')
    expect(stripped.split('\n')).toHaveLength(3)
  })

  it('every path constant the allowlist leans on resolves under sync/', () => {
    for (const [file, name, value] of SYNC_PATH_CONSTANTS) {
      const full = path.join(REPO_ROOT, file)
      if (!existsSync(full)) {
        /* Absence is ASSERTED, not skipped: the only thing that may take one of
           these files away is the removal of the capability that owns it. A
           kernel file owns no capability, so its disappearance fails here. */
        const owner = ownerOfFile(file)
        expect(owner, `${file} is gone and belongs to no capability`).not.toBeNull()
        expect(present(owner), `${file} is gone but ${owner} is still in the tree`).toBe(false)
        continue
      }
      const text = readFileSync(full, 'utf8')
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

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * THE RUST HALF OF THE OBLIGATION — the several hundred crates the desktop
 * binary statically links.
 *
 * `THIRD-PARTY-NOTICES.md` enumerated four typefaces, nine JavaScript packages
 * and two Tauri plugin crates, and said in its own words that "the wider Rust
 * dependency graph is not enumerated here". That sentence was a description of
 * the defect, printed inside the document the defect was in. Nearly six hundred
 * crates are linked into every shipped binary, overwhelmingly MIT and
 * Apache-2.0 — licences whose permission to redistribute is CONDITIONAL on the
 * notice and the copyright line travelling with the copy, in the same words the
 * OFL uses for the fonts. Naming two of them and not the rest is not a smaller
 * version of the right document; it is the same failure the fonts had, at
 * fifty times the scale.
 *
 * OVER-INCLUSION IS SAFE HERE AND OMISSION IS THE VIOLATION, which decides
 * every judgement call below:
 *
 *   - FOUR TARGETS, UNIONED. `--filter-platform` answers for one triple, and
 *     the crates differ sharply between them — 466 on aarch64-apple-darwin,
 *     506 on x86_64-unknown-linux-gnu, 456 on x86_64-pc-windows-msvc. A notice
 *     built on the host that made it describes the host's build. The union of
 *     the four shipped targets describes every copy, at the cost of naming a
 *     crate a given binary does not contain — which costs a reader a line and
 *     costs a redistributor nothing.
 *   - EVERY LICENCE FILE A CRATE SHIPS, not the one matching its SPDX id. A
 *     dual-licensed crate publishes both texts and offers the choice; printing
 *     one of them would be Paper deciding on the reader's behalf.
 *   - EVERY ID IN THE EXPRESSION for a crate that ships no text at all.
 *
 * NORMAL DEPENDENCIES ONLY (`dep_kinds` entry with `kind: null`). Build- and
 * dev-dependencies compile the build and the tests; neither is in the binary,
 * and a notice that named them would be claiming obligations Paper does not
 * have. Workspace-local crates are dropped too: `paper-data-root`,
 * `tauri-plugin-peer` and the rest are this repository's own, covered by its
 * own LICENSE.
 *
 * THE VENDORED SPDX TEXTS under `licenses/spdx/` are for the ~54 crates that
 * declare an identifier in `Cargo.toml` and publish no licence file — the
 * `objc2-*` family, most of `iroh`, the `unic-*` crates. Taken verbatim from
 * `github.com/spdx/license-list-data` (`text/<id>.txt`, fetched 2026-08-28),
 * because that is the one source whose copy of a licence is checkable against
 * a published list rather than against somebody's memory. They are the
 * unwrapped SPDX renderings, so they read as long lines; a licence text is the
 * one document where reflowing to taste is a defect, and the same rule that
 * keeps `copyrightFrom` verbatim keeps these unreflowed.
 *
 * The crate's declared `authors` stand in for the copyright holders those texts
 * leave as `<year> <copyright holders>`, which is the substitution
 * `cargo-about` makes for the same case. Twenty-seven of the fifty-four declare
 * no authors either, and the notice says so rather than inventing one.
 *
 * ⚠️ THIS MODULE NEVER RUNS CARGO. `scripts/refresh-rust-notices.mjs` does,
 * where a registry is certainly present, and commits the answer; everything
 * here reads what was committed. See `readCrates` in `notices.mjs` for the
 * incident that made that division non-negotiable.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * The targets Paper ships, and therefore the closures whose union is owed.
 *
 * Not "every target cargo knows": a triple nothing is built for would add
 * crates to the notice that no copy contains. These four are what
 * `.github/workflows/` and `tauri build` produce.
 */
export const SHIPPED_TARGETS = Object.freeze([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
])

/** The committed manifest, and the two directories of licence text. */
export const RUST_CRATES_PATH = path.join(HERE, 'rust-crates.json')
export const RUST_LICENSES_DIR = path.join(HERE, 'licenses', 'rust')
export const SPDX_DIR = path.join(HERE, 'licenses', 'spdx')

/**
 * What a crate's registry checkout ships that has to be reproduced.
 *
 * `LICENSE`, `LICENCE` and `COPYING`, with any suffix — `LICENSE-MIT`,
 * `LICENSE-APACHE.md`, `LICENSE.txt`, `license-mit`, `COPYING.LESSER`; thirty-
 * nine distinct filenames across the union, measured, which is why this is a
 * prefix rule and not a list.
 *
 * AND `NOTICE`, WHICH IS NOT A LICENCE AND IS STILL OWED. Apache-2.0 §4(d)
 * says that where the licensed work ships a NOTICE file, its attribution text
 * must be reproduced in every derivative distribution — an obligation separate
 * from reproducing the licence, and one that a rule matching only `LICENSE*`
 * misses in silence. Exactly one crate in the union has one (`moka`,
 * `(MIT OR Apache-2.0) AND Apache-2.0`), which is precisely the sort of single
 * instance a hand-kept list never acquires and a prefix rule catches for free.
 *
 * ⚠️ `LICENSE.spdx` IS EXCLUDED, and it is the one file here that would have
 * been silently wrong. It is SPDX metadata — a machine-readable declaration
 * ABOUT the terms — and reproducing it satisfies nothing. Eleven crates in the
 * union ship one (every `tauri-plugin-*`, `tao`, `wry`, `muda`, `tray-icon`,
 * `window-vibrancy`); all eleven ship real texts beside it, so excluding it
 * costs nothing and including it would have put a `SPDXVersion:` header into
 * the notice under the heading of a licence. `notices.mjs` records the same
 * trap hitting the JavaScript half.
 */
export const isLicenseFile = (name) => /^(licen[sc]e|copying|notice)/i.test(name) && !/\.spdx$/i.test(name)

/**
 * A licence text as it will be hashed and printed.
 *
 * CRLF to LF, trailing whitespace off each line, and the whole trimmed —
 * because the SAME licence arrives with different line endings and different
 * trailing spaces from different crates, and without this the file is stored
 * three times and printed three times. 946 files collapse to 317 texts; with
 * bytes compared raw they collapse to nowhere near that.
 *
 * Nothing else is touched. No reflowing, no case folding, no whitespace
 * collapsing inside a line: two texts that differ by a copyright line MUST
 * stay two texts, which is the property the whole document rests on.
 */
export function normaliseLicense(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()
}

/**
 * A text's identity: the first 12 hex digits of its SHA-256.
 *
 * Twelve, not sixty-four, because it is a filename a human reads in a diff.
 * At 317 texts the birthday odds of a collision in 48 bits are around one in
 * 10^10, and a collision would be caught by the check rather than shipped: two
 * different texts hashing alike makes the regenerated manifest disagree with
 * the committed one on the very next run.
 */
export function digestOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * A deterministic order for the manifest, and it is deliberately NOT
 * `localeCompare`.
 *
 * This array is committed and compared byte-for-byte by `--check`. ICU's
 * collation depends on the locale the process happens to be in, so a manifest
 * sorted with `localeCompare` on one machine can be "drifted" on another with
 * nothing having changed. Plain `<` compares UTF-16 code units and gives the
 * same answer everywhere.
 *
 * By name, then by version STRING — not by semver. `0.10.1` sorts before
 * `0.9.5` here, which is wrong as a version order and irrelevant as a document
 * order: what matters is that every machine produces the same one.
 */
export function byNameThenVersion(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.version === b.version) return 0
  return a.version < b.version ? -1 : 1
}

/**
 * The third-party crates a `cargo metadata` closure says the binary links.
 *
 * Walked from `resolve.root` over `resolve.nodes`, following only deps with a
 * `dep_kinds` entry whose `kind` is `null` — Cargo's spelling of "a normal
 * dependency". The alternative, taking `metadata.packages` whole, is what a
 * first attempt would do and it is wrong by about a hundred crates: that array
 * holds every package in the workspace's graph, build scripts and test
 * harnesses included.
 *
 * `source === null` is Cargo's marker for a path dependency, which here means
 * one of this repository's own crates.
 */
export function shippedCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const packages = new Map(metadata.packages.map((one) => [one.id, one]))
  const root = metadata.resolve.root
  /* A workspace with no root package resolves `root` to null, and a walk from
   * null visits nothing — an EMPTY notice, which looks exactly like a build
   * with no dependencies. Refused rather than rendered. */
  if (typeof root !== 'string') throw new Error('cargo metadata reported no root package — was it run against the workspace instead of src-tauri/Cargo.toml?')
  const seen = new Set([root])
  const queue = [root]
  for (let i = 0; i < queue.length; i++) {
    const node = nodes.get(queue[i])
    if (node === undefined) throw new Error(`cargo metadata has no resolve node for ${queue[i]} — the metadata is truncated`)
    for (const dep of node.deps) {
      /* NOT `dep.dep_kinds?.some(...)`. A cargo old enough to omit the field
       * would answer "no normal dependencies" for every edge and produce a
       * notice with nothing in it, green. */
      if (!Array.isArray(dep.dep_kinds)) throw new Error(`cargo metadata gave no dep_kinds for ${dep.pkg} — this needs cargo 1.41 or newer`)
      if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue
      if (seen.has(dep.pkg)) continue
      seen.add(dep.pkg)
      queue.push(dep.pkg)
    }
  }
  return [...seen].map((id) => {
    const found = packages.get(id)
    if (found === undefined) throw new Error(`cargo metadata resolved ${id} and does not describe it — the metadata is truncated`)
    return found
  }).filter((one) => one.source !== null)
}

/**
 * The identifiers in an SPDX expression, in the order stated.
 *
 * `MIT OR Apache-2.0`, `MIT/Apache-2.0` (Cargo's older spelling, still in the
 * `unic-*` crates), `Zlib OR Apache-2.0 OR MIT`, `(MIT OR Apache-2.0) AND
 * Unicode-3.0`. Every id in the expression, whatever the operator: for an `OR`
 * the crate offers the choice and a notice that printed one would be making it,
 * and for an `AND` both apply.
 *
 * `WITH` is deliberately NOT understood. `Apache-2.0 WITH LLVM-exception`
 * survives as one token, finds no vendored text and throws naming the crate —
 * which is right, because reproducing `Apache-2.0` for it would drop the
 * exception, and the exception is the part that differs.
 */
export function spdxIdsOf(expression) {
  return [
    ...new Set(
      expression
        .replace(/[()]/g, ' ')
        .split(/\s+(?:OR|AND)\s+|\s*\/\s*/)
        .map((one) => one.trim())
        .filter((one) => one !== ''),
    ),
  ]
}

/**
 * Every licence text one crate's registry checkout carries, by filename.
 *
 * Sorted by the default (UTF-16 code unit) comparator so the manifest's
 * `texts` array is stable across machines, for the reason in
 * `byNameThenVersion`.
 */
export function licenseFilesIn(dir, readdir = readdirSync, read = readFileSync) {
  let entries
  try {
    entries = readdir(dir, { withFileTypes: true })
  } catch (cause) {
    throw new Error(`no crate source at ${dir} — \`cargo metadata\` names it, so run a cargo command that unpacks it before regenerating`, { cause })
  }
  return entries
    .filter((entry) => entry.isFile() && isLicenseFile(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: read(path.join(dir, name), 'utf8') }))
}

/**
 * A vendored standard text, for a crate that declares terms and ships none.
 *
 * The id is VALIDATED before it reaches a path, because it comes out of a
 * crate's own `Cargo.toml` — third-party text, joined to a directory this
 * process can read. SPDX identifiers are letters, digits, dot, plus and dash;
 * anything else is refused rather than resolved.
 *
 * A missing text THROWS AND NAMES THE CRATE. The tempting alternative is to
 * skip the crate, and that produces a document that looks complete and is not,
 * which is the exact failure this whole file exists for.
 */
export function spdxText(id, crate, dir = SPDX_DIR) {
  if (!/^[A-Za-z0-9.+-]+$/.test(id)) throw new Error(`${crate}: ${JSON.stringify(id)} is not an SPDX identifier — the crate's license field cannot be resolved to a text`)
  const at = path.join(dir, `${id}.txt`)
  try {
    return readFileSync(at, 'utf8')
  } catch (cause) {
    throw new Error(`${crate}: no vendored text for SPDX id ${id} — add ${at} verbatim from https://spdx.org/licenses/${id}.html`, { cause })
  }
}

/**
 * The whole Rust half, from one `cargo metadata` output per shipped target.
 *
 * Returns the manifest rows and the distinct texts they reference. Both
 * injectables exist so the tests can drive this without a cargo registry;
 * neither has any other caller.
 */
export function collectRustNotices(metadatas, licensesIn = licenseFilesIn, standardText = spdxText) {
  /* Keyed on name AND version: nine crates in the union are linked at two
     versions at once (`objc2` 0.5.2 and 0.6.4, `windows-sys` at three), and
     they are different code under different copyright lines. */
  const union = new Map()
  for (const metadata of metadatas) {
    for (const one of shippedCrates(metadata)) union.set(`${one.name}@${one.version}`, one)
  }
  const texts = new Map()
  const crates = []
  for (const one of [...union.values()].sort(byNameThenVersion)) {
    const at = `${one.name} ${one.version}`
    const license = one.license
    if (typeof license !== 'string' || license === '') {
      throw new Error(`${at}: declares no licence at all — a crate whose terms are unknown cannot be shipped, let alone described`)
    }
    const entry = { name: one.name, version: one.version, license, texts: [] }
    const found = licensesIn(path.dirname(one.manifest_path))
    if (found.length === 0) {
      /* RECORDED, not inferred later. The standard MIT text and a crate's own
         LICENSE-MIT hash differently, but the standard Apache-2.0 text and a
         crate's LICENSE-APACHE are routinely byte-identical — so "did this
         crate ship its own text" cannot be recovered from the shas, and the
         reader is entitled to know which rows are reproduced and which are
         reconstructed. */
      entry.standard = true
      for (const id of spdxIdsOf(license)) entry.texts.push(remember(texts, normaliseLicense(standardText(id, at))))
      const authors = (one.authors ?? []).filter((author) => author !== '')
      if (authors.length > 0) entry.authors = authors
    } else {
      for (const file of found) entry.texts.push(remember(texts, normaliseLicense(file.text)))
    }
    /* An expression of nothing but punctuation parses to no ids and would
       leave a crate in the table with no terms under it. */
    if (entry.texts.length === 0) throw new Error(`${at}: ${JSON.stringify(license)} names no licence — the crate would appear in the notice with no terms`)
    /* A crate that ships the same text twice under two names (`LICENSE` and
       `LICENSE.md`, which several do) references it once. */
    entry.texts = [...new Set(entry.texts)]
    crates.push(entry)
  }
  return { crates, texts }
}

function remember(texts, text) {
  const sha = digestOf(text)
  texts.set(sha, text)
  return sha
}

/** The manifest, exactly as it is committed — two-space JSON, one newline. */
export function serialiseCrates(crates) {
  return `${JSON.stringify(crates, null, 2)}\n`
}

/** What is committed, or a failure that names the command that writes it. */
export function readRustCrates(at = RUST_CRATES_PATH) {
  let text
  try {
    text = readFileSync(at, 'utf8')
  } catch (cause) {
    throw new Error(`${at} is missing — run \`pnpm docs:rust-notices\` on a machine with a cargo registry`, { cause })
  }
  return JSON.parse(text)
}

/**
 * One committed licence text.
 *
 * The sha is validated for the same reason `spdxText` validates its id: it
 * arrives from a JSON file and is joined to a path. Twelve lowercase hex
 * digits, or nothing.
 */
export function rustLicenseText(sha, dir = RUST_LICENSES_DIR) {
  if (!/^[0-9a-f]{12}$/.test(sha)) throw new Error(`${JSON.stringify(sha)} is not a licence text id — rust-crates.json has been edited by hand`)
  const at = path.join(dir, `${sha}.txt`)
  try {
    return readFileSync(at, 'utf8')
  } catch (cause) {
    throw new Error(`no licence text at ${at} — run \`pnpm docs:rust-notices\``, { cause })
  }
}

/**
 * Every licence text committed under `dir`, by id, whether referenced or not.
 *
 * The CONTENTS come back, not just the names, so `driftBetween` can catch the
 * one tampering a name-only comparison is blind to: a licence text edited in
 * place still has its old filename, so the sha set matches perfectly while the
 * document reproduces something the crate never published. Re-reading is what
 * makes the filename a checksum rather than a label.
 *
 * Normalised on the way in, because that is the form the fresh side is in;
 * comparing a normalised text against a raw one would report every file as
 * edited on the first Windows checkout.
 */
export function committedTexts(dir = RUST_LICENSES_DIR, readdir = readdirSync, read = readFileSync) {
  const texts = new Map()
  let entries
  try {
    entries = readdir(dir)
  } catch {
    /* Not an error: the directory does not exist before the first run, and
       `driftBetween` then reports every text as missing, which is the true
       answer and a better one than a stack trace. */
    return texts
  }
  for (const name of entries) {
    if (!/^[0-9a-f]{12}\.txt$/.test(name)) continue
    texts.set(name.slice(0, 12), normaliseLicense(read(path.join(dir, name), 'utf8')))
  }
  return texts
}

/**
 * Crates the manifest names that the lockfile does not pin — the half of the
 * check that needs no cargo and no registry.
 *
 * `locked` is `lockedVersions`'s Map. This catches a manifest left behind by a
 * dependency bump, which is the ordinary way it rots; the opposite direction —
 * a crate that ships and is in no manifest — cannot be seen without cargo, and
 * is what `pnpm docs:rust-notices --check` is for.
 *
 * ⚠️ IT IS EXPECTED TO FIND THINGS AFTER A CAPABILITY REMOVAL, and that is why
 * it returns findings rather than throwing. `capability:remove` prunes
 * `Cargo.lock` with `cargo metadata --offline`, so cutting `peer` takes iroh
 * and its whole subtree out of the lockfile while `rust-crates.json` — which
 * only `pnpm docs:rust-notices` rewrites — still names them. The notice is then
 * over-inclusive, which is safe, and the caller decides what to do about it.
 */
export function absentFromLock(crates, locked) {
  const findings = []
  for (const one of crates) {
    const versions = locked.get(one.name)
    if (versions === undefined) findings.push(`${one.name}@${one.version} is in the manifest and in no [[package]] of Cargo.lock`)
    else if (!versions.includes(one.version)) findings.push(`${one.name}@${one.version} is in the manifest; Cargo.lock pins ${versions.join(', ')}`)
  }
  return findings
}

/**
 * Every way the committed manifest can disagree with the registry.
 *
 * Reported as a LIST, not as a boolean: a lockfile bump that adds four crates
 * and upgrades two should say which six, because the reader's next question is
 * always "what changed" and a bare "drifted" sends them to `git diff` on an
 * 800-row JSON file.
 *
 * Orphaned texts are a finding too. Without that arm the directory only ever
 * grows: a crate upgraded to a version with a reworded copyright line leaves
 * its old text behind, committed forever, describing nothing.
 */
export function driftBetween(fresh, committed) {
  const findings = []
  const key = (one) => `${one.name}@${one.version}`
  const freshBy = new Map(fresh.crates.map((one) => [key(one), one]))
  const heldBy = new Map(committed.crates.map((one) => [key(one), one]))
  for (const [id, one] of freshBy) {
    const held = heldBy.get(id)
    if (held === undefined) {
      findings.push(`${id} is linked into the binary and is not in the manifest (${one.license})`)
    } else if (serialiseCrates(held) !== serialiseCrates(one)) {
      findings.push(`${id} has changed: the manifest says ${serialiseCrates(held).trim()}, the registry says ${serialiseCrates(one).trim()}`)
    }
  }
  for (const id of heldBy.keys()) {
    if (!freshBy.has(id)) findings.push(`${id} is in the manifest and is no longer linked into the binary`)
  }
  for (const [sha, text] of fresh.texts) {
    const held = committed.texts.get(sha)
    if (held === undefined) findings.push(`licence text ${sha}.txt is referenced and is not committed`)
    else if (held !== text) findings.push(`licence text ${sha}.txt has been edited — its contents no longer hash to its name`)
  }
  for (const sha of committed.texts.keys()) {
    if (!fresh.texts.has(sha)) findings.push(`licence text ${sha}.txt is committed and is referenced by nothing`)
  }
  return findings
}

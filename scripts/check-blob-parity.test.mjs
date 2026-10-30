import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONTENT_EXTENSIONS } from '../src/kernel/core/bookVault.ts'
import { BLOB_FOLDER } from '../src/kernel/core/ports.ts'

/**
 * ONE BLOB POLICY, WRITTEN TWICE — so it is checked.
 *
 * The set of extensions a content blob may carry, and the shape of a book's
 * folder name, exist in TypeScript (`bookVault.ts`, `ports.ts`) and again in
 * Rust (`paths.rs`), because the transport resolves and writes those paths on
 * the native side while the kernel decides what may be asked for. Neither can
 * import the other.
 *
 * Nothing failed when they disagreed. A format added on one side only would
 * be accepted by the API and refused by the transport — a book that downloads
 * and then cannot be stored, reported as a generic error far from the cause —
 * or accepted by the transport and unreachable through the API, which is a
 * file on disk no service will admit exists.
 *
 * Parsed from the Rust source rather than duplicated here: a third copy of the
 * list would be the very drift this guards against.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATHS_RS = path.join(ROOT, 'src-tauri/crates/tauri-plugin-peer/src/paths.rs')

function rustList(name) {
  const source = readFileSync(PATHS_RS, 'utf8')
  const at = source.indexOf(`pub const ${name}:`)
  if (at === -1) throw new Error(`${name} is not declared in paths.rs — the parity check cannot run`)
  /* The VALUE's bracket, not the type's. `pub const NAME: &[&str] = &[...]`
   * has two: taking the first read `&str` out of the type annotation and
   * found no strings at all — which the emptiness assertion below caught
   * rather than letting an empty-equals-empty comparison pass as agreement. */
  const assign = source.indexOf('=', at)
  const open = source.indexOf('[', assign)
  const close = source.indexOf(']', open)
  if (assign === -1 || open === -1 || close === -1) {
    throw new Error(`${name} in paths.rs is not the array literal this reads`)
  }
  return [...source.slice(open + 1, close).matchAll(/"([^"]+)"/g)].map((one) => one[1])
}

describe('the blob policy is the same on both sides', () => {
  it('declares the same content extensions in TypeScript and Rust', () => {
    const rust = rustList('CONTENT_EXTENSIONS')
    /* Sorted, because the ORDER differs meaningfully — `contentBytes` picks by
     * it — but membership is what has to agree. */
    expect([...rust].sort()).toEqual([...CONTENT_EXTENSIONS].sort())
  })

  it('finds a non-empty list, so a parse failure cannot pass as agreement', () => {
    /* The check above would pass on two empty arrays. This is the assertion
     * that the extraction actually extracted something — the same reason the
     * icon build checks its own output rather than trusting exit 0. */
    expect(rustList('CONTENT_EXTENSIONS').length).toBeGreaterThan(4)
    expect(CONTENT_EXTENSIONS.length).toBeGreaterThan(4)
  })

  /**
   * BEHAVIOUR, NOT SOURCE TEXT.
   *
   * This compared `BLOB_FOLDER.source` against the substrings `A-Za-z0-9_` and
   * `80`, and the Rust file against `80`. Both halves are satisfied by things
   * that are not the rule: `/^[A-Za-z0-9_]{1,800}$/` contains both substrings,
   * and so does a pattern with an extra alternation bolted on the end. A check
   * that reads a regex as a STRING is checking spelling, not agreement.
   *
   * So the pattern is exercised on names, and the Rust bound is read out of
   * its own comparison rather than looked for anywhere in the file.
   */
  it('agrees on what a book folder may be called', () => {
    const rust = readFileSync(PATHS_RS, 'utf8')
    /* `folder.len() <= 80` — the bound as the Rust actually applies it. */
    const bound = rust.match(/folder\.len\(\)\s*<=\s*(\d+)/)
    expect(bound, 'paths.rs no longer bounds the folder length the way this reads it').not.toBeNull()
    const most = Number(bound[1])
    expect(most).toBeGreaterThan(0)

    /* The TypeScript pattern accepts exactly up to that many, and no more. */
    expect(BLOB_FOLDER.test('a'.repeat(most))).toBe(true)
    expect(BLOB_FOLDER.test('a'.repeat(most + 1))).toBe(false)
    expect(BLOB_FOLDER.test('')).toBe(false)

    /* And the same alphabet: Rust takes ASCII alphanumerics and `_`. */
    for (const good of ['a', 'Z', '0', '_', 'book_abc']) expect(BLOB_FOLDER.test(good), good).toBe(true)
    for (const bad of ['a-b', 'a.b', 'a/b', 'a b', 'né', 'a\u0000b']) expect(BLOB_FOLDER.test(bad), bad).toBe(false)
    expect(rust).toContain('is_ascii_alphanumeric')
    expect(rust).toContain("b'_'")
  })
})

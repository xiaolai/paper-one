/**
 * The passages plugin's wire: every command this capability may call, in one
 * file.
 *
 * ⚠️ **THE ONLY FILE IN THIS CAPABILITY THAT MAY NAME `@tauri-apps`**, which is
 * a boundary rule rather than a convention — `PLUGIN_WIRES` in
 * `.dependency-cruiser.cjs`, alongside `peer/lib/wire.ts`,
 * `webhost/lib/wire.ts` and `voices/lib/wire.ts`. One file per plugin, so the
 * set of command names a capability can reach is auditable by reading one
 * screen.
 *
 * Everything decidable is in `rows.ts`, and the port built on this is
 * `port.ts`. That split is what `pnpm browser:check` exists for: a pure value
 * sharing a module with a platform binding takes the whole subtree out of a
 * browser build, and that has happened four times in this tree.
 */

import { invoke } from '@tauri-apps/api/core'

/** A section handed over for indexing, as the plugin takes it. */
export interface SectionIn {
  readonly index: number
  readonly text: string
}

/** Every command, and nothing else. */
export interface PassagesWire {
  /** Answers `false` when the book was forgotten while it was being extracted. */
  put(book: string, generation: string, sections: readonly SectionIn[], at: number): Promise<boolean>
  note(book: string, why: string, at: number): Promise<void>
  flush(): Promise<void>
  forget(book: string, at: number): Promise<void>
  rekey(from: string, to: string): Promise<boolean>
  /** Which of these `[bookId, generation]` pairs are not current. */
  pending(books: readonly (readonly [string, string])[]): Promise<unknown>
  /** Every book id the index holds — the removal diff's question. */
  indexed(): Promise<unknown>
  rebuild(): Promise<void>
  /** Forget every note, so the next sweep tries those books again. */
  retry(): Promise<unknown>
  status(): Promise<unknown>
  search(query: string, limit: number | null): Promise<unknown>
}

/** The wire over the running plugin. */
export function passagesWire(): PassagesWire {
  return {
    put: (book, generation, sections, at) =>
      invoke<boolean>('plugin:passages|passages_put', { book, generation, sections, at }),
    note: (book, why, at) => invoke('plugin:passages|passages_note', { book, why, at }),
    flush: () => invoke('plugin:passages|passages_flush'),
    forget: (book, at) => invoke('plugin:passages|passages_forget', { book, at }),
    rekey: (from, to) => invoke<boolean>('plugin:passages|passages_rekey', { from, to }),
    pending: (books) => invoke<unknown>('plugin:passages|passages_pending', { books }),
    indexed: () => invoke<unknown>('plugin:passages|passages_indexed'),
    rebuild: () => invoke('plugin:passages|passages_rebuild'),
    retry: () => invoke<unknown>('plugin:passages|passages_retry'),
    status: () => invoke<unknown>('plugin:passages|passages_status'),
    search: (query, limit) => invoke<unknown>('plugin:passages|passages_search', { query, limit }),
  }
}

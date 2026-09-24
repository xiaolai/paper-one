import type { PassageHit, PassageIndexStatus, PassagesPort } from '../../../kernel'
import { hitsOf, pendingOf, statusOf } from './rows'
import { passagesWire, type PassagesWire, type SectionIn } from './wire'

/**
 * The passage index, over the plugin's wire.
 *
 * Pure but for the wire it is handed, which is what makes the whole of it
 * testable with no Tauri host — the shape `peer/lib/port.ts` and
 * `voices/lib/port.ts` both use, and the reason the peer port's
 * refusal-classifying defect could be measured at all.
 *
 * ⚠️ **TWO INTERFACES, AND THE NARROW ONE IS THE KERNEL'S.** `PassagesPort` is
 * what the kernel's slot takes: `search` and `status`, which is everything
 * `passage.search` needs. Building the index is this capability's own business
 * and is on {@link PassageIndex}, which extends it. Publishing the write half on
 * the kernel's slot would put a door to the index somewhere the service table
 * could reach, and there is no row in that table that writes to an index.
 */
export interface PassageIndex extends PassagesPort {
  /**
   * Index one book's sections, replacing whatever was there.
   *
   * Resolves `false` when the book was forgotten while it was being extracted —
   * the race WI-31.3 names, which a serial index writer does not close because
   * it does not serialise VAULT changes.
   */
  put(
    bookId: string,
    generation: string,
    sections: readonly SectionIn[],
    at: number,
  ): Promise<boolean>
  /** Record a book that yielded nothing, with the reason a reader can read. */
  note(bookId: string, why: string, at: number): Promise<void>
  /** Commit everything pending and write the checkpoint. */
  flush(): Promise<void>
  /**
   * Take a book out of the index and off the disk.
   *
   * `at` is WHEN, and it is not bookkeeping: the plugin refuses a later `put`
   * whose extraction began BEFORE this moment — the removal race — and accepts
   * one that began after it, which is a restore. A set of ids could not tell
   * those apart and left a restored book unsearchable for the life of the
   * process.
   */
  forget(bookId: string, at: number): Promise<void>
  /** Move a book's index to a new id, keeping the work. Resolves `false` when
   *  there was nothing to move. */
  rekey(from: string, to: string): Promise<boolean>
  /** Which of these books are not current at the generation given. */
  pending(books: readonly (readonly [string, string])[]): Promise<readonly string[]>
  /**
   * Every book id the index holds.
   *
   * ⚠️ **THIS IS WHAT MAKES AN EVICTION AND A REMOVAL REACH THE INDEX.** Neither
   * emits an event a capability could listen for — the library publishes one
   * undifferentiated *"the snapshot changed"* — so the driver compares this
   * against what the shelf wants and forgets the difference. Diffing rather than
   * listening also means a removal that happened while the app was CLOSED is
   * noticed on the next launch, which no listener could manage.
   */
  indexed(): Promise<readonly string[]>
  /** Build the postings again from the retained text. Reopens no book. */
  rebuild(): Promise<void>
  /**
   * Forget every note, so the next sweep extracts those books again. Answers
   * how many were cleared.
   *
   * ⚠️ **THE REMEDY FOR A BOOK RECORDED UNREADABLE IN ERROR.** A note is what
   * stops a book that yields nothing being re-parsed on every sweep for ever,
   * and it catches a transient failure — a disk that was momentarily busy —
   * just as well, which nothing can tell apart from a thrown value. Without
   * this there is no way back: `rebuild` deliberately keeps the notes, because
   * re-deriving postings says nothing about which books could not be EXTRACTED.
   */
  retry(): Promise<number>
}

/** The port over a wire. */
export function passageIndexOver(wire: PassagesWire = passagesWire()): PassageIndex {
  return {
    async search(query: string, limit?: number): Promise<readonly PassageHit[]> {
      /* ⚠️ **AN EMPTY QUERY IS ANSWERED HERE RATHER THAN SENT.** The plugin
       * refuses it by name — *"there is no word in that query to look for"* —
       * which is right for a caller that meant something and wrong for the
       * pane, which asks on every keystroke and is simply between questions.
       * Answering the empty list locally is the difference between a debounce
       * and a stream of refusals. */
      if (query.trim() === '') return []
      return hitsOf(await wire.search(query, limit ?? null))
    },

    async status(): Promise<PassageIndexStatus> {
      return statusOf(await wire.status())
    },

    async put(bookId, generation, sections, at): Promise<boolean> {
      return wire.put(bookId, generation, sections, at)
    },

    async note(bookId, why, at): Promise<void> {
      await wire.note(bookId, why, at)
    },

    async flush(): Promise<void> {
      await wire.flush()
    },

    async forget(bookId, at): Promise<void> {
      await wire.forget(bookId, at)
    },

    async rekey(from, to): Promise<boolean> {
      return wire.rekey(from, to)
    },

    async pending(books): Promise<readonly string[]> {
      /* NOTHING ASKED IS NOTHING PENDING, answered without a round trip. The
       * backfill asks this every time it wakes, and a shelf whose books are all
       * current asks it with an empty list for ever after. */
      if (books.length === 0) return []
      return pendingOf(await wire.pending(books))
    },

    async indexed(): Promise<readonly string[]> {
      return pendingOf(await wire.indexed())
    },

    async rebuild(): Promise<void> {
      await wire.rebuild()
    },

    async retry(): Promise<number> {
      const cleared = await wire.retry()
      /* A COUNT, CHECKED. The pane says how many books it will try again, and
       * `NaN books` is the shape this repository has shipped once already. */
      return Number.isInteger(cleared) && (cleared as number) >= 0 ? (cleared as number) : 0
    },
  }
}

import type { Capability, CapabilityContext, Command, Disposable } from '../../kernel'
import { createArchives, type Archives } from './lib/archiveActions'

/**
 * Archives: the reader's marks, cards and tags out to a file and back.
 *
 * ⚠️ **FOUR PALETTE ROWS AND NOTHING ELSE.** No shell control and no drag-drop
 * path reaches this, so `commands` and `services.files` are the whole of what it
 * needs. The stores it reads and writes are the kernel's and stay there, so a
 * reader without it loses the rows and nothing they made.
 *
 * ⚠️ **THE FILE FORMATS ARE A PROMISE TO FILES ALREADY ON READERS' DISKS.** The
 * fixtures in `tests/fixtures/archives/` were generated before these modules
 * moved, and `lib/archiveFixtures.test.ts` holds them to the byte.
 *
 * ROWS ONLY WHERE A DIALOG EXISTS. `services.files.available` is false in a plain
 * browser tab, and a row that opens a dialog which cannot exist is the app
 * describing a feature it does not have.
 */

let running: Archives | null = null

export const archives: Capability = {
  id: 'archives',
  requires: [],
  toggle: {
    title: 'Archives',
    summary:
      'Export your marks, cards and tags to a file, and bring them back from one. Off, those commands are gone, and everything you have made stays where it is.',
  },

  /* THE PALETTE'S IDS CHANGED AND ITS WORDS DID NOT. They were `marks:export` and
     so on, and the registry holds a contributed command to `<capability>:<name>`.
     Nothing stores a command id, so no reader's data names the old ones.

     No `combo`: these never had a key, and it is the rarest action in the app —
     done once, or after something went wrong — which is what the palette is for. */
  commands: (): Command[] => {
    const actions = running
    if (actions === null) return []
    return [
      {
        id: 'archives:export-marks',
        /* NAMES BOTH THINGS IT WRITES, because a reader looking for a way out
           does not know whether Paper calls a card marginalia. */
        label: 'Export your marks and cards…',
        group: 'Library',
        keywords: 'mark note card highlight annotation backup save export file json markdown archive',
        run: actions.exportMarks,
      },
      {
        id: 'archives:import-marks',
        /* "Merge" in the label, exactly as the tag import says it, and it is the
           reassurance rather than the description: an import never removes a
           mark, so restoring an old file cannot silently undo a month of
           reading. */
        label: 'Import marks from a file… (merge)',
        group: 'Library',
        keywords: 'mark note card highlight annotation restore load import merge file json archive backup',
        run: actions.importMarks,
      },
      {
        id: 'archives:export-tags',
        label: 'Export your tags…',
        group: 'Library',
        keywords: 'tag backup save export file json archive',
        run: actions.exportTags,
      },
      {
        id: 'archives:import-tags',
        /* "Merge" in the label, because that is what it does and the word is the
           reassurance: an import never removes a tag, so restoring an old file
           cannot silently undo a month of filing.

           ⚠️ THE LABEL NEVER CARRIED IT. This comment, the marks import's
           "exactly as the tag import says it" and a test titled "says merge in
           the import label" all promised the word from the day this row was
           written, and the test read the keywords. Added — and the test now reads
           the label — by the 2026-09-13 audit. */
        label: 'Import tags from a file… (merge)',
        group: 'Library',
        keywords: 'tag restore load import merge file json archive backup',
        run: actions.importTags,
      },
    ]
  },

  start(api: CapabilityContext): Disposable {
    running = api.services.files.available ? createArchives(api.services) : null
    return { dispose: () => void (running = null) }
  },
}

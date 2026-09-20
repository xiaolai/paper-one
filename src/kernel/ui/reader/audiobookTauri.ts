/**
 * The audiobook export's platform half — the part that can only exist inside
 * the app.
 *
 * SPLIT FROM `audiobook.ts` for the reason `vaultFsTauri.ts` was split from
 * `bookVault.ts`: that module holds the planning and the ordering, which the
 * browser client's own subtree imports through the reader, and one value import
 * of `@tauri-apps/plugin-fs` would drag the plugin in behind every one of them.
 * `check-browser-safe` refuses exactly that, four times over.
 *
 * ⚠️ **THE CHAPTER FILES LIVE UNDER `$APPDATA`, NOT BESIDE THE BOOK.** The app
 * is granted `fs:allow-write-file` and `fs:allow-remove` for `$APPDATA/**` and
 * nothing else, so scratch written next to a reader's chosen destination could
 * be created by Rust and never removed by the webview. Keeping it where the
 * grant already reaches means the tidy-up needs no new permission — and a
 * permission added for a tidy-up is a permission that outlives it.
 */

import { invoke } from '@tauri-apps/api/core'
import { appDataDir, join } from '@tauri-apps/api/path'
import { save } from '@tauri-apps/plugin-dialog'
import { BaseDirectory, mkdir, remove } from '@tauri-apps/plugin-fs'
import type { AudiobookPlatform } from './audiobook'

/** Under `$APPDATA`, so the fs grant already covers it. */
const SCRATCH_DIR = 'audiobook'

/**
 * Where the finished book should go, or null if the reader changed their mind.
 *
 * ⚠️ **THE DIALOG IS THE GRANT.** Rust writes the destination, and the reader
 * naming it in a save dialog is the whole of the authorisation for that write —
 * `narrate_package` takes a path from the webview and does not ask where it came
 * from. So this is the only place that path should ever be chosen, and a caller
 * that assembled one itself would be handing the backend an unasked-for write.
 */
export async function chooseAudiobookPath(bookTitle: string): Promise<string | null> {
  const suggested = `${safeFileName(bookTitle) || 'audiobook'}.m4b`
  const chosen = await save({
    title: 'Export as audiobook',
    defaultPath: suggested,
    filters: [{ name: 'Audiobook', extensions: ['m4b'] }],
  })
  return chosen ?? null
}

/**
 * A book's title, made into something a filesystem will take.
 *
 * The separators go because a title with one in it would name a directory that
 * does not exist; ordinary characters stay, because a reader's book is called
 * what it is called and a Chinese title is a perfectly good file name.
 *
 * ⚠️ **IT HANDLED POSIX ONLY, WHILE ITS COMMENT CLAIMED "ANY PLATFORM THIS SHIPS
 * TO".** Measured by running it: `CON`, `NUL`, `Why?`, `a*b`, `a|b`, `a"b` and
 * `a<b>` all came back unchanged, and every one of them is a name Windows
 * refuses. So did a trailing dot, which Windows silently strips — turning
 * `Vol. 2.` into a suggestion that is not what the reader was shown.
 *
 * ⚠️ **AND IT IS UNREACHABLE ON WINDOWS TODAY, WHICH IS WHY IT SURVIVED.** The
 * export is gated on macOS in `App.tsx`, so nothing here has ever run against a
 * Windows filesystem. A latent defect behind a platform gate is still a defect
 * the day the gate moves, and this function exists to be the thing that does
 * not need revisiting then.
 *
 * ⚠️ **THIS IS A SUGGESTION, NOT A SANITISER.** The value is the save dialog's
 * default, which the reader may edit and the system may reject; it is not a path
 * anything writes to unchecked. `chooseAudiobookPath` says where the authority
 * actually lives.
 */
export function safeFileName(title: string): string {
  const cleaned = title
    /* `< > : " / \ | ? *` is the set Windows forbids, and it CONTAINS the POSIX
       one — so a single rule serves both rather than two that can disagree. */
    .replace(/[<>:"/\\|?*]/gu, ' ')
    /* Control characters cannot appear in a name on any platform this ships to,
       and a leading dot would hide the file. Written as an explicit range rather
       than with a suppression comment: this repository runs no linter, so a
       disable line here would be a waiver for a rule nobody checks —
       `directives:check` refuses exactly that, and it is right to. */
    .replace(/[\u0000-\u001f]/gu, '')
    /* ⚠️ **LEADING WHITESPACE AND DOTS GO TOGETHER, AND THE DOTS USED TO GO
       FIRST.** `" .hidden"` had its dot stripped while the space still hid it, so
       the trim then exposed `.hidden` — a hidden file, which is exactly what the
       dot rule exists to prevent. One class, one pass, so neither can re-create
       what the other removed. */
    .replace(/^[\s.]+/u, '')
    .trimEnd()
  const budgeted = withinBytes(cleaned)
    /* TRAILING DOTS AND SPACES GO LAST, after the truncation: cutting a title can
       CREATE one, so a trim done earlier would not see it. Windows drops them
       silently, which makes the file's real name differ from the one the reader
       was shown in the dialog. */
    .replace(/[\s.]+$/u, '')
  return RESERVED_ON_WINDOWS.test(budgeted) ? `${budgeted} (book)` : budgeted
}

/**
 * What a filesystem will hold, derived from the limit rather than guessed at.
 *
 * A path COMPONENT is capped at 255 bytes on APFS, ext4 and NTFS alike, and this
 * value has to leave room for everything appended after it.
 */
const MAX_COMPONENT_BYTES = 255 - '.m4b'.length - ' (book)'.length

/**
 * `text`, cut to fit `MAX_COMPONENT_BYTES` without splitting a character.
 *
 * ⚠️ **`slice(0, 120)` WAS WRONG IN BOTH UNITS.** It counts UTF-16 code units, so
 * it can cut an emoji in half and leave an unpaired surrogate; and 120 is not the
 * filesystem's limit — 120 CJK characters are 360 UTF-8 bytes, well past what a
 * component may hold, which is most of the books this reader is for. A budget
 * measured in code units is neither the filesystem's unit nor the reader's.
 *
 * Cut by GRAPHEME rather than code point, so a flag, a family emoji or a
 * combining accent is not split either — `Intl.Segmenter` is the same tool the
 * reader's own sentence walk uses.
 */
function withinBytes(text: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= MAX_COMPONENT_BYTES) return text

  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)
  let out = ''
  let used = 0
  for (const { segment } of graphemes) {
    const size = encoder.encode(segment).length
    if (used + size > MAX_COMPONENT_BYTES) break
    out += segment
    used += size
  }
  return out
}

/**
 * The MS-DOS device names, which Windows still refuses at any extension.
 *
 * A book called `Con` or `Aux` is not far-fetched, and the failure is opaque:
 * the dialog rejects the name with nothing that explains why. Suffixed rather
 * than replaced, so the reader still sees their own title.
 */
const RESERVED_ON_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu

/** The engine, as `exportAudiobook` needs it. */
export async function tauriAudiobook(): Promise<AudiobookPlatform> {
  await mkdir(SCRATCH_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
  const root = await join(await appDataDir(), SCRATCH_DIR)

  return {
    render: (job) => invoke('narrate_render', { ...job }),
    package: (job) =>
      invoke<{ durationMs: number; chapters: number }>('narrate_package', { ...job }),
    scratchFor: (index) => `${root}/chapter-${index}.wav`,
    discard: async (path) => {
      /* REMOVED BY ITS NAME UNDER THE GRANTED ROOT, not by the absolute path the
       * engine was given: the fs plugin scopes by `$APPDATA`, and handing it an
       * absolute path from elsewhere is how a tidy-up starts needing a wider
       * permission than the work did. */
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (name === '') return
      await remove(`${SCRATCH_DIR}/${name}`, { baseDir: BaseDirectory.AppData })
    },
  }
}

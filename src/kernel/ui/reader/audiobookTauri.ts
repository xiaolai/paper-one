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
 * does not exist; everything else stays, because a reader's book is called what
 * it is called and a Chinese title is a perfectly good file name.
 */
export function safeFileName(title: string): string {
  return title
    .replace(/[/\\:]/gu, ' ')
    /* Control characters cannot appear in a name on any platform this ships to,
       and a leading dot would hide the file. Written as an explicit range rather
       than with a suppression comment: this repository runs no linter, so a
       disable line here would be a waiver for a rule nobody checks —
       `directives:check` refuses exactly that, and it is right to. */
    .replace(/[\u0000-\u001f]/gu, '')
    .replace(/^\.+/u, '')
    .trim()
    .slice(0, 120)
}

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

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
import { BaseDirectory, exists, mkdir, readDir, remove } from '@tauri-apps/plugin-fs'
import { basename } from '../../core/bookFiles'
import type { AudiobookPlatform } from './audiobook'
import { unqualify } from './engineVoice'
import type { SpeechRequest, SpokenClip, SpokenSkip, VoicePack } from '../../core/ports'

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
  const budgeted = withinBytes(cleaned)
    /* TRAILING DOTS AND SPACES GO LAST, after the truncation: cutting a title can
       CREATE one, so a trim done earlier would not see it. Windows drops them
       silently, which makes the file's real name differ from the one the reader
       was shown in the dialog.

       THE ONLY TRAILING TRIM. A `trimEnd()` before the truncation used to sit
       beside it, and `\s` is the same set of characters: whatever that removed,
       this removes after the cut, so the two could not be told apart. */
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
  /* EVERY TITLE WALKS THE GRAPHEMES, with no early return for one that fits.
     That return answered exactly what the walk answers — a title within the
     budget is kept whole by it — so it was a second route to one result, and a
     change to either could not be seen. Titles are short; the walk is cheap.

     `new Intl.Segmenter()` with no options, because `grapheme` IS the default
     granularity: spelled out, it was an option whose removal changed nothing. */
  const graphemes = new Intl.Segmenter().segment(text)
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

/**
 * How long an abandoned run directory is left alone before it is removed.
 *
 * Long enough that a run genuinely in flight on another window is never touched —
 * a ten-hour book at 22× real time is under half an hour — and short enough that
 * a crash does not leave gigabytes indefinitely.
 */
const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * Remove run directories no export can still own.
 *
 * ⚠️ **AGE IS THE ONLY OWNERSHIP SIGNAL AVAILABLE, SO IT IS USED CAREFULLY.**
 * Nothing records which window owns which run, and a second window may be
 * exporting right now — so a directory is removed only when its own id says it
 * was created longer ago than any export could plausibly still be running, and
 * never the one this call just made. Reading the id rather than the filesystem's
 * timestamps keeps it honest across a copied or restored profile.
 *
 * `fs:allow-read-dir` and `fs:allow-remove` are already granted for `$APPDATA`,
 * so this needs no new permission — which the note at the top of this file says
 * is the condition for a tidy-up existing at all.
 */
async function sweepAbandonedScratch(keep: string): Promise<void> {
  const now = Date.now()
  for (const entry of await readDir(SCRATCH_DIR, { baseDir: BaseDirectory.AppData })) {
    if (!entry.isDirectory || entry.name === keep) continue
    const match = /^run-([0-9a-z]+)-/u.exec(entry.name)
    if (match === null) continue
    /* THE GROUP IS ASSERTED, NOT CHECKED: the pattern requires it, so it is
       there whenever the match is. A check here was one no test could see —
       `parseInt(undefined, 36)` reads the WORD "undefined" as base-36 digits,
       a stamp in the year 4709, so a directory with no stamp came out young and
       was kept by the age test below regardless. */
    const made = Number.parseInt(match[1]!, 36)
    /* NO FINITENESS CHECK, because nothing here can use one. The stamp is
       base-36 digits, so `made` is a number or — for a name no clock could have
       made — +Infinity, and `now - Infinity` is below any age: such a run is
       left exactly as a young one is. An `isFinite` beside the age test only
       repeated the `stamp` check above, which is what turns a name with no stamp
       away, and neither could be told from the other. */
    if (now - made < ABANDONED_AFTER_MS) continue
    await remove(`${SCRATCH_DIR}/${entry.name}`, {
      baseDir: BaseDirectory.AppData,
      recursive: true,
    }).catch(() => {})
  }
}

/** The engine, as `exportAudiobook` needs it. */
export async function tauriAudiobook(
  /**
   * The installed packs, so an engine-qualified voice can be resolved to the
   * pack that holds it. A build with no voices capability passes an empty
   * list, where an export has no voice to render on at all and refuses.
   *
   * ⚠️ **THE STORED NAME CARRIES THE FAMILY, AND THE COMMAND WANTS THE PACK
   * ID.** They differ deliberately: a family outlives a re-cut pack, which is
   * why a reader's choice is written that way. The resolution has to happen
   * somewhere, and here is where both are in hand.
   *
   * ⚠️ **REQUIRED, AND IT USED TO DEFAULT TO `[]`.** A default no caller in
   * the app ever took is a value only a test can choose, and no test can tell
   * one empty list from another — so the default was an unkillable mutant
   * standing in front of a decision worth making at the call site.
   */
  packs: readonly VoicePack[],
  /**
   * Whether a section is already rendered, asked WITHOUT rendering it.
   *
   * ⚠️ **THIS IS THE WHOLE OF WI-34.4 — *exporting a book you have listened to
   * costs only the muxing*.** A hit is the reader's own audio, already on disk, at
   * the voice and speed they chose; the export names that file to the packer and
   * does not remove it afterwards.
   *
   * ⚠️ **REQUIRED, AND WITH NO DEFAULT.** A `?? (() => null)` would be a build
   * that silently re-rendered everything, which is the state this item exists to
   * leave — and no test could tell one absent function from another. A build with
   * no voices capability passes one that answers null, and says so at the call
   * site.
   */
  findClip: (request: SpeechRequest) => Promise<SpokenClip | null>,
  /**
   * Hold rendered sections open while the packer reads them, or let them go.
   *
   * REQUIRED, and with no default, for the reason `findClip` is: a build that
   * silently held nothing would lose a chapter under a running export only when
   * a reader happened to be listening at the same time, which is the hardest
   * kind of defect to find and the easiest kind to ship.
   */
  holdClips: (stems: readonly string[], hold: boolean) => Promise<number>,
): Promise<AudiobookPlatform> {
  /**
   * ⚠️ **ONE DIRECTORY PER EXPORT, AND IT USED TO BE ONE FOR ALL OF THEM.**
   * `chapter-<index>.wav` under a shared root meant two exports running together
   * wrote over each other's chapters, and each one's tidy-up deleted the other's
   * files — a rejected second export could discard a chapter the first had
   * already rendered. It also meant nothing OWNED a leftover, so a crash left
   * files behind for ever with no rule for removing them.
   *
   * The run id carries the clock so `sweepAbandonedScratch` can judge age, and
   * random suffix so two exports started in the same millisecond still differ.
   */
  const run = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dir = `${SCRATCH_DIR}/${run}`
  await mkdir(dir, { baseDir: BaseDirectory.AppData, recursive: true })
  const root = await join(await appDataDir(), dir)
  /**
   * Which clip NAME each cached path belongs to.
   *
   * The export speaks in paths, because that is what `narrate_package` takes; the
   * store speaks in names, because a name is its key and is what makes a hold
   * impossible to point at a file this app did not write. One map, at the one
   * place both are in hand.
   */
  const leases = new Map<string, string>()
  /* Abandoned runs go now rather than at boot: this is the only moment the app is
     certainly about to use this directory, and a sweep at launch would cost every
     reader who never exports anything. */
  await sweepAbandonedScratch(run).catch(() => {})

  return {
    /**
     * ⚠️ **ONLY A DOWNLOADED VOICE CAN RENDER A BOOK.** `narrate_render` over
     * AVSpeechSynthesizer was deleted in phase 30: every voice it reached on a
     * Mac is below the floor the reading refuses, so it could not produce a
     * file anybody would want. The voice's own shape is what says whether this
     * is one — the same string the reading stores, so one choice serves both.
     *
     * The file is the one WAV shape `narrate/wav.rs` accepts, and
     * `narrate_package` — the muxer, `afconvert`, the chapter track and both
     * readers' checks — reads it unchanged.
     */
    render: async (job) => {
      const named = unqualify(job.voice)
      if (!named) {
        /* ⚠️ THERE IS NO LONGER ANYWHERE ELSE TO SEND IT. `narrate_render`
         * over AVSpeechSynthesizer was deleted in phase 30: every voice it
         * could reach on a Mac is below the floor the reading refuses, so it
         * could not produce a file anybody would want. A job that arrives with
         * a platform identifier is a caller that has not asked the packs, and
         * it is refused by name rather than rendered in a voice the reading
         * would not use. */
        throw new Error(`${job.voice} is not a downloaded voice, and an audiobook is rendered on one`)
      }
      const pack = packs.find((one) => one.family === named.family)?.id ?? named.family
      /* ⚠️ **ASKED BEFORE RENDERING, WHICH IS WHAT MAKES THE EXPORT A CONSUMER.**
       * The key is exactly the reading's: same book, same section, same canonical
       * digest, same pack, same voice, same rate. Where any of those differs the
       * answer is a MISS and the chapter is rendered — never wrong audio, because
       * a clip found under a matching digest is a clip of the same words. */
      const already = await findClip({
        packId: pack,
        voiceId: named.voiceId,
        text: job.text,
        rate: job.rate,
        clip: { bookId: job.bookId, section: job.section, textDigest: job.textDigest },
      })
      /* ⚠️ **HELD BEFORE IT IS ANSWERED FOR, AND THE COUNT IS READ — FOUND BY AN
       * INDEPENDENT AUDIT, 2026-09-30.** The find and the hold are two commands,
       * so *Forget them* between them takes the clip and the export goes on to
       * name a path that holds nothing: the packer fails on a missing file,
       * which reads as a broken export rather than as the race it is.
       *
       * `voices_clip_hold` answers how many of the names it MOVED, and that
       * number is the whole point of it: 0 means the clip is no longer there, so
       * this is a MISS and the chapter falls through to the render below. The
       * earlier version discarded the count and could not tell the two apart.
       *
       * THE CLIP'S OWN NAME is what a hold takes and the PATH is what the packer
       * takes, so both travel, and `releaseClips` maps one to the other. */
      /* ⚠️ **AN ASSIGNMENT RATHER THAN `.catch(() => 0)` — FOUND BY THE MUTATION
         SWEEP.** An arrow returning a falsy constant has a falsy twin: `() => 0`
         mutated to `() => undefined` compares the same against 1. The success
         handler carries the answer instead, where emptying it loses the hit. */
      let held = false
      if (already) {
        await holdClips([already.stem], true)
          .then((moved) => {
            held = moved === 1
          })
          .catch(() => {})
      }
      if (already && held) {
        leases.set(already.path, already.stem)
        /* THE CLIP'S OWN SKIPS, which are the skips of the render that MADE it —
           the same passages the reader was told about when they heard it. */
        return { path: already.path, cached: true, skipped: already.skipped }
      }
      /* ⚠️ **TO SCRATCH AND NOT INTO THE STORE, DELIBERATELY.** A ten-hour book is
       * 6.2 GB against a 5 GB budget, so an export that filled the store would
       * evict its own earlier chapters before the muxer read them. The store holds
       * what a reader has HEARD. */
      const made = await invoke<{
        sampleRate: number
        skipped: readonly { text: string; why: string }[]
      }>('plugin:voices|voices_render_file', {
        pack,
        voice: named.voiceId,
        text: job.text,
        rate: job.rate,
        path: job.path,
      })
      /* ⚠️ **READ THROUGH `skippedOf`, NOT TAKEN AS GIVEN.** The command's reply
         crosses the IPC boundary as unknown JSON, and an export that trusted its
         shape would report `undefined.length` chapters late — the same reason
         every other reply on this road goes through a reader in `rows.ts`. */
      return { path: job.path, cached: false, skipped: skippedOf(made) }
    },
    package: (job) =>
      invoke<{ durationMs: number; chapters: number }>('narrate_package', { ...job }),
    scratchFor: (index) => `${root}/chapter-${index}.wav`,
    discard: async (path) => {
      /* REMOVED BY ITS NAME UNDER THE GRANTED ROOT, not by the absolute path the
       * engine was given: the fs plugin scopes by `$APPDATA`, and handing it an
       * absolute path from elsewhere is how a tidy-up starts needing a wider
       * permission than the work did. */
      /* ⚠️ **THE KERNEL'S OWN `basename`, NOT A SECOND ONE.** This was
         `path.slice(path.lastIndexOf('/') + 1)`, which knows only `/` — so on
         Windows a scratch path would come back whole, and `remove` would be
         handed something that is not a name under the granted root. The helper
         in `bookFiles.ts` takes the later of `/` and `\\`, and two basenames
         that disagree about a separator is exactly the drift one of them exists
         to prevent. */
      const name = basename(path)
      if (name === '') return
      await remove(`${dir}/${name}`, { baseDir: BaseDirectory.AppData })
    },
    discardScratch: async () => {
      await remove(dir, { baseDir: BaseDirectory.AppData, recursive: true })
    },
    /**
     * Whether there is already a book at the destination the reader chose.
     *
     * ⚠️ **AN ABSOLUTE PATH, ON THE SAVE DIALOG'S OWN GRANT — the same authority
     * `discardBook` below runs on.** `save()` calls `allow_file` for the path the
     * reader picked, which is what makes both this and the removal reachable
     * without widening the app's filesystem scope by a line.
     */
    exists: (path) => exists(path),
    /**
     * Let the cached chapters go.
     *
     * ⚠️ **ONE DIRECTION, AND IT USED TO BE TWO — `hold(paths, boolean)`.** That
     * spelling pretended taking a lease and giving one back were one operation
     * with a flag, and they are not: taking one must be ATOMIC WITH THE FIND,
     * which only this adapter can do, because only it has the stem; giving one
     * back must happen on every road out of the export, which only
     * `exportAudiobook` knows. Naming them as one hid the first requirement, and
     * the acquisition raced (audit, 2026-09-30).
     *
     * ⚠️ **BY NAME AND NOT BY PATH**, because the store's own key is the name:
     * `voices_clip_hold` looks a stem up in the checkpoint, which is what makes
     * it impossible to hold something this app did not write. The export speaks
     * in paths because that is what the packer takes, so the two are mapped here
     * — at the one place both are in hand.
     */
    releaseClips: async (paths) => {
      const stems = paths.map((path) => leases.get(path)).filter((stem): stem is string => !!stem)
      if (stems.length === 0) return
      await holdClips(stems, false)
      for (const path of paths) leases.delete(path)
    },
    /**
     * Remove the book at the destination the reader chose.
     *
     * ⚠️ **AN ABSOLUTE PATH, AND `discard` ABOVE DELIBERATELY REFUSES ONE.**
     * That one is scoped to `$APPDATA` because scratch is the app's own
     * directory; this one names a path OUTSIDE it, and the authority for that is
     * the save dialog itself.
     *
     * ⚠️ **AND THAT IS READ IN THE PLUGIN'S SOURCE RATHER THAN ASSUMED**, because
     * it decides whether this works at all: `tauri-plugin-dialog`'s `save`
     * command ends with `s.allow_file(&path)` on the window's fs scope, so the
     * file the reader named — and only that file — is granted to the fs plugin at
     * runtime. `fs:allow-remove` in `capabilities/default.json` stays at
     * `$APPDATA/**`, which is the point: the grant that reaches this book is one
     * the reader issued by naming it, and it does not outlive the export.
     *
     * A WIDER STATIC GRANT WAS THE OBVIOUS ALTERNATIVE AND IS REFUSED — this
     * file's own header says a permission added for a tidy-up is a permission
     * that outlives it.
     *
     * ⚠️ **AND IT IS ONLY EVER CALLED FOR A BOOK THIS EXPORT WROTE.**
     * `exportAudiobook` passes `request.path` and nothing else, which is the
     * path the dialog answered. A caller that assembled one itself would be
     * asking the app to delete a file nobody named.
     */
    discardBook: async (path) => {
      await remove(path)
    },
  }
}

/**
 * The skips out of `voices_render_file`'s reply, or none.
 *
 * ⚠️ **A REPLY THAT CROSSES THE IPC BOUNDARY IS UNKNOWN JSON.** An export that
 * took `made.skipped.length` on trust would throw on a plugin that did not send
 * the field — which is every build older than this one — and it would do it
 * after the chapter had been written, which is the most expensive moment there
 * is to fail. An ABSENT list is none; a list holding something that is not a
 * skip is refused rather than counted, on the rule this repository states for
 * every store: absent is empty, present-and-wrong is refused.
 */
export function skippedOf(reply: unknown): readonly SpokenSkip[] {
  const row = (typeof reply === 'object' && reply !== null ? reply : {}) as Record<string, unknown>
  if (row.skipped === undefined || row.skipped === null) return []
  if (!Array.isArray(row.skipped)) {
    throw new Error('the chapter was rendered with a skip list that is not one')
  }
  return row.skipped.map((one) => {
    const skip = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
    if (typeof skip.text !== 'string' || typeof skip.why !== 'string') {
      throw new Error('the chapter was rendered with a skip that names neither text nor reason')
    }
    return { text: skip.text, why: skip.why }
  })
}

/**
 * The audiobook export's platform half — the part that can only exist inside
 * the app, and the one file here that speaks to `tauri-plugin-narration`, so
 * every command it is sent can be read in one place (`PLUGIN_WIRES` in
 * `.dependency-cruiser.cjs`; the crate's `lists_agree` holds its own side).
 *
 * ⚠️ **THE WINDOW NAMES NO PATH THE PLUGIN OPENS AS GIVEN.** Scratch lives in a
 * run directory the plugin made (`narration_begin`), and a chapter is named to
 * the packer by its index; the destination is whatever the reader chose in the
 * plugin's own save dialog, held behind a token. Script in this window can
 * call every command granted to it with any arguments, so these are the only
 * shapes those commands take — see
 * `dev-docs/decisions/2026-11-09-narration-boundary.md`.
 *
 * ⚠️ **THE TIDY-UP NEEDS NO FILESYSTEM GRANT.** It used to remove scratch and
 * the destination through `@tauri-apps/plugin-fs`, on the `$APPDATA` grant and
 * the save dialog's runtime grant. Both removals are the plugin's now, and the
 * sweep of abandoned runs moved into `narration_begin` with them.
 */

import { invoke } from '@tauri-apps/api/core'
import { unqualify } from '../../../kernel'
import type { RenderedFile, SpeechFileRequest, SpeechRequest, SpokenClip, VoicePack } from '../../../kernel'
import type { AudiobookPlatform } from './audiobook'

/** Whether this window runs inside Tauri, and so has a plugin to ask. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Whether the plugin can package a book here.
 *
 * ⚠️ **THE PLUGIN SAYS**, rather than this file guessing from the platform: the
 * muxer is AVFoundation, so it is macOS today, and the answer moves with the
 * plugin. A reply that is not a boolean is a failure, not a no.
 *
 * OUTSIDE TAURI THERE IS NO PLUGIN TO ASK, and the answer is yes, as `peer`'s
 * `p2pAvailable` answers: the composition contract starts every capability a
 * platform lists, in node, and one left out there would hide a start bug.
 * Nothing is offered there anyway — the row needs the voices' engine, which
 * only Tauri has.
 */
export async function narrationSupported(): Promise<boolean> {
  if (!inTauri()) return true
  const reply: unknown = await invoke('plugin:narration|narration_supported')
  if (typeof reply !== 'boolean') {
    throw new Error('the narration plugin did not say whether it can package a book')
  }
  return reply
}

/**
 * What an export needs from the downloadable voices — the speech engine port,
 * narrowed to the four calls it makes.
 *
 * ⚠️ **`renderFile` IS REQUIRED HERE THOUGH THE PORT HAS IT OPTIONAL.** A port
 * without it cannot render a chapter, so there is no engine for an export at
 * all, and the host offers no row.
 */
export interface NarrationEngine {
  readonly catalogue: () => Promise<readonly VoicePack[]>
  readonly findClip: (request: SpeechRequest) => Promise<SpokenClip | null>
  readonly holdClips: (stems: readonly string[], hold: boolean) => Promise<number>
  readonly renderFile: (request: SpeechFileRequest) => Promise<RenderedFile>
}

/** What the reader picked in the save dialog: a token for it, and its file name. */
export interface Destination {
  readonly token: string
  readonly name: string
}

/**
 * Ask the reader where the finished book should go, or null if they changed
 * their mind.
 *
 * ⚠️ **THE DIALOG IS THE GRANT, AND IT IS THE PLUGIN'S.** The reader naming a
 * file in a save dialog the plugin opened is the whole of the authorisation for
 * writing there. The window is handed a token and the bare name, never the
 * path, so nothing it sends later can point the packer anywhere else.
 */
export async function pickDestination(bookTitle: string): Promise<Destination | null> {
  const reply: unknown = await invoke('plugin:narration|narration_pick', {
    name: `${safeFileName(bookTitle) || 'audiobook'}.m4b`,
  })
  if (reply === null) return null
  const row = recordOf(reply)
  if (typeof row.token !== 'string' || typeof row.name !== 'string') {
    throw new Error('the save dialog answered with something that is not a destination')
  }
  return { token: row.token, name: row.name }
}

/**
 * Let the plugin forget a destination. Called on every road out of an export,
 * since a token left behind holds one of the plugin's bounded places.
 */
export async function releaseDestination(token: string): Promise<void> {
  await invoke('plugin:narration|narration_release', { destination: token })
}

/** A reply as a record to read fields from; anything else reads as having none. */
function recordOf(reply: unknown): Record<string, unknown> {
  return (typeof reply === 'object' && reply !== null ? reply : {}) as Record<string, unknown>
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
 * plugin packages only on macOS and the capability's `available` says so, so
 * nothing here has ever run against a Windows filesystem. A latent defect behind a platform gate is still a defect
 * the day the gate moves, and this function exists to be the thing that does
 * not need revisiting then.
 *
 * ⚠️ **THIS IS A SUGGESTION, NOT A SANITISER.** The value is the save dialog's
 * default, which the reader may edit and the system may reject; it is not a path
 * anything writes to unchecked. `pickDestination` says where the authority
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

/** The engine, as `exportAudiobook` needs it: one run, begun now. */
export async function narrationPlatform(
  /**
   * The packs as the catalogue answered them, so an engine-qualified voice can
   * be resolved to the pack that holds it.
   *
   * ⚠️ **THE STORED NAME CARRIES THE FAMILY, AND THE ENGINE WANTS THE PACK
   * ID.** They differ deliberately: a family outlives a re-cut pack, which is
   * why a reader's choice is written that way. The resolution has to happen
   * somewhere, and here is where both are in hand.
   */
  packs: readonly VoicePack[],
  engine: NarrationEngine,
): Promise<AudiobookPlatform> {
  /* ⚠️ **ONE DIRECTORY PER EXPORT, MADE BY THE PLUGIN.** Two exports running
     together must not write over each other's chapters or remove each other's
     files, and a crash must not leave files nothing owns: the plugin makes a
     fresh run directory, sweeps runs abandoned long ago, and answers where this
     run's chapters go. */
  const begun = recordOf(await invoke('plugin:narration|narration_begin'))
  if (typeof begun.run !== 'string' || typeof begun.chapterPrefix !== 'string') {
    throw new Error('the export could not begin: the plugin answered with something that is not a run')
  }
  const run = begun.run
  const prefix = begun.chapterPrefix
  /**
   * Which clip NAME each cached path belongs to.
   *
   * The export speaks in paths, because that is what the packer is told for a
   * cached chapter; the store speaks in names, because a name is its key and is
   * what makes a hold impossible to point at a file this app did not write. One
   * map, at the one place both are in hand.
   */
  const leases = new Map<string, string>()

  return {
    /**
     * ⚠️ **ONLY A DOWNLOADED VOICE CAN RENDER A BOOK.** Every platform voice on
     * a Mac is below the floor the reading refuses, so it could not produce a
     * file anybody would want. The voice's own shape is what says whether this
     * is one — the same string the reading stores, so one choice serves both.
     */
    render: async (job) => {
      const named = unqualify(job.voice)
      if (!named) {
        /* A job that arrives with a platform identifier is a caller that has not
         * asked the packs, and it is refused by name rather than rendered in a
         * voice the reading would not use. */
        throw new Error(`${job.voice} is not a downloaded voice, and an audiobook is rendered on one`)
      }
      const pack = packs.find((one) => one.family === named.family)?.id ?? named.family
      /* ⚠️ **ASKED BEFORE RENDERING, WHICH IS WHAT MAKES THE EXPORT A CONSUMER.**
       * The key is exactly the reading's: same book, same section, same canonical
       * digest, same pack, same voice, same rate. Where any of those differs the
       * answer is a MISS and the chapter is rendered — never wrong audio, because
       * a clip found under a matching digest is a clip of the same words. */
      const already = await engine.findClip({
        packId: pack,
        voiceId: named.voiceId,
        text: job.text,
        rate: job.rate,
        clip: { bookId: job.bookId, section: job.section, textDigest: job.textDigest },
      })
      /* ⚠️ **HELD BEFORE IT IS ANSWERED FOR, AND THE COUNT IS READ — FOUND BY AN
       * INDEPENDENT AUDIT, 2026-09-30.** The find and the hold are two commands,
       * so *Forget them* between them takes the clip and the export goes on to
       * name a path that holds nothing. The hold answers how many names it
       * MOVED: 0 means the clip is no longer there, so this is a MISS and the
       * chapter falls through to the render below.
       *
       * ⚠️ **AN ASSIGNMENT RATHER THAN `.catch(() => 0)` — FOUND BY THE MUTATION
       * SWEEP.** An arrow returning a falsy constant has a falsy twin: `() => 0`
       * mutated to `() => undefined` compares the same against 1. The success
       * handler carries the answer instead, where emptying it loses the hit. */
      let held = false
      if (already) {
        await engine
          .holdClips([already.stem], true)
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
       * what a reader has HEARD. The port reads the reply's shape, skips
       * included, so nothing here takes it on trust. */
      const made = await engine.renderFile({
        packId: pack,
        voiceId: named.voiceId,
        text: job.text,
        rate: job.rate,
        path: job.path,
      })
      return { path: job.path, cached: false, skipped: made.skipped }
    },
    package: async (job) => {
      const reply = recordOf(
        await invoke('plugin:narration|narrate_package', {
          run,
          destination: job.destination,
          chapters: job.chapters,
          title: job.title,
          author: job.author,
        }),
      )
      if (
        typeof reply.name !== 'string' ||
        typeof reply.durationMs !== 'number' ||
        typeof reply.chapters !== 'number'
      ) {
        throw new Error('the book was packaged, but the plugin answered with something that is not a book')
      }
      return { name: reply.name, durationMs: reply.durationMs, chapters: reply.chapters }
    },
    /* The same file the plugin rebuilds from the index, so the voices plugin
       writes exactly where the packer will read. */
    scratchFor: (index) => `${prefix}${index}.wav`,
    discard: async (index) => {
      await invoke('plugin:narration|narration_discard_chapter', { run, index })
    },
    discardScratch: async () => {
      await invoke('plugin:narration|narration_discard', { run })
    },
    exists: async (destination) => {
      const there: unknown = await invoke('plugin:narration|narration_exists', { destination })
      if (typeof there !== 'boolean') {
        throw new Error('the plugin could not say whether the destination is there')
      }
      return there
    },
    /**
     * Let the cached chapters go.
     *
     * ⚠️ **ONE DIRECTION.** Taking a lease must be ATOMIC WITH THE FIND, which
     * only `render` above can do, because only it has the stem; giving one back
     * must happen on every road out of the export, which only `exportAudiobook`
     * knows.
     *
     * ⚠️ **BY NAME AND NOT BY PATH**, because the store's own key is the name,
     * which is what makes it impossible to hold something this app did not
     * write. The two are mapped here — at the one place both are in hand.
     */
    releaseClips: async (paths) => {
      const stems = paths.map((path) => leases.get(path)).filter((stem): stem is string => !!stem)
      if (stems.length === 0) return
      await engine.holdClips(stems, false)
      for (const path of paths) leases.delete(path)
    },
    /**
     * Remove the book at the destination the reader chose — only ever called
     * for a book this export wrote, and refused by the plugin for one that was
     * there before the export committed.
     */
    discardBook: async (destination) => {
      await invoke('plugin:narration|narration_discard_book', { destination })
    },
  }
}

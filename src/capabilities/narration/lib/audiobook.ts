/**
 * Turning an open book into an audiobook.
 *
 * THE ORCHESTRATION ONLY. Nothing here speaks, encodes or writes a container —
 * the engine is `tauri-plugin-narration`, reached through the platform this
 * module is handed. That split is what makes the part with the decisions
 * in it testable on a machine with no AVFoundation, which is every machine that
 * is not a Mac and every CI runner.
 *
 * ⚠️ **ONE CHAPTER PER SPINE SECTION, AND THAT IS A CHOICE WITH A COST.** A
 * table-of-contents entry can point into the MIDDLE of a section, and one entry
 * can cover several — so a book whose parts and chapters disagree with its spine
 * gets marks where its sections begin rather than where its chapters do. For an
 * ordinary EPUB the two coincide and this is exactly right; for an anthology in
 * one file it is one long chapter. Mapping a TOC onto section OFFSETS is the
 * fix, and it needs the renderer to answer where a `#fragment` lands; stated
 * here rather than discovered by somebody wondering why a book has one mark.
 *
 * ⚠️ **AND A SECTION WITH NO WORDS IS NOT A CHAPTER.** A cover, a plate, a
 * half-title: rendering one produces no audio, which `narrate_package` refuses
 * by name — correctly, since two chapters cannot share a start. They are dropped
 * here instead, where the reason can be said.
 */

import type { SectionText } from '../../../kernel'

/** A chapter to render: what to say, and what to call it. */
export interface ChapterPlan {
  readonly index: number
  readonly title: string
  readonly text: string
  /** As `SectionText.textDigest`. */
  readonly textDigest: string
}

/**
 * The chapters an export will produce, in order.
 *
 * TITLED FROM THE TABLE OF CONTENTS WHERE IT SAYS SO, and numbered where it does
 * not — `Chapter 3` counts the chapters this export actually contains, not the
 * spine position, because a reader who sees "Chapter 3" after two chapters and
 * then a gap has been told something false about the book.
 */
export function planChapters(sections: readonly SectionText[]): readonly ChapterPlan[] {
  const chapters: ChapterPlan[] = []
  for (const section of sections) {
    const text = section.text.trim()
    if (text === '') continue
    const title = section.title?.trim()
    chapters.push({
      index: section.index,
      textDigest: section.textDigest,
      /* `title &&` has already excluded the empty string, so `title !== ''` could
         never be false here — one condition, not two saying the same thing. */
      title: title ? title : `Chapter ${chapters.length + 1}`,
      text: section.text,
    })
  }
  return chapters
}

/** What an export needs from the platform, so the rest of this file needs none. */
export interface AudiobookPlatform {
  /**
   * Speak one chapter into a file, and answer WHERE it went and WHOSE it is.
   *
   * `path` is the scratch file `scratchFor` named for this chapter; a fresh
   * render writes there, and the packer is later told the chapter's INDEX, not
   * the path, so it rebuilds the path inside the run directory it made.
   *
   * ⚠️ **`cached` IS WHAT STOPS THE TIDY-UP DELETING A READER'S AUDIO.** Phase 34
   * keeps a rendered section on disk, and a chapter the reader has listened to is
   * already there — so the export names that file to the packer rather than
   * rendering it again, and must not then remove it. The path it answers is the
   * one to package; `cached` says whether the export owns it. A cached path is
   * sent to the packer as a clip, which it accepts only directly inside the
   * voices plugin's clip store.
   *
   * ⚠️ **AND A MISS IS STILL RENDERED TO SCRATCH, NOT INTO THE STORE.** A
   * ten-hour book is 6.2 GB of audio against a 5 GB budget, so an export that
   * filled the store would evict its own earlier chapters before the muxer read
   * them — a book missing its first half, or a packer failing on a file it was
   * told to expect. The store is for what a reader has HEARD; the export borrows
   * from it and does not fill it.
   */
  render: (job: {
    readonly text: string
    readonly voice: string
    readonly rate: number
    readonly path: string
    /** Which book and section this is, so the store can be asked. */
    readonly bookId: string
    readonly section: number
    readonly textDigest: string
  }) => Promise<{
    readonly path: string
    readonly cached: boolean
    /**
     * What the engine would not say in this chapter.
     *
     * ⚠️ **NEITHER ROAD CARRIED THIS AND THE EXPORT WAS SILENTLY INCOMPLETE —
     * FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `voices_render_file` answered
     * only a sample rate, and the cached road's `SpokenClip` had no field for it
     * — so a chapter the reading had told the reader was missing a sentence came
     * out of the export reported as whole. The reader is told now, with a count,
     * beside the file they got.
     */
    readonly skipped: readonly { readonly text: string; readonly why: string }[]
  }>
  /**
   * Stop letting go of the cached chapters this export is about to package, or
   * let them go again.
   *
   * ⚠️ **A CACHED CHAPTER IS THE READER'S OWN AUDIO AND SOMETHING ELSE MAY BE
   * REMOVING IT — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** The packer reads
   * these files for as long as the muxing takes; meanwhile a reading in the same
   * window can render a new section and evict one of them by budget, or the
   * reader can press *Forget them*. The export then fails on a file it was told
   * to expect — loud, and avoidable.
   *
   * ⚠️ **AND IT IS GIVEN BACK ON EVERY ROAD OUT, INCLUDING THE ONES NOBODY
   * PLANS FOR.** A lease released only on success is a clip pinned until the app
   * restarts, which is a slow leak of the reader's disk budget.
   */
  releaseClips: (paths: readonly string[]) => Promise<void>
  /**
   * Join the rendered chapters into one book, at the destination the reader
   * picked — named by its TOKEN, never by a path the window holds.
   */
  package: (job: {
    readonly chapters: readonly PackagedChapter[]
    readonly title: string
    readonly author: string
    readonly destination: string
  }) => Promise<{ readonly name: string; readonly durationMs: number; readonly chapters: number }>
  /** Where a chapter's audio is written on the way. */
  scratchFor: (index: number) => string
  /** Remove one of this export's own scratch chapters, by index, whatever happened. */
  discard: (index: number) => Promise<void>
  /**
   * Remove the book at the destination the reader chose.
   *
   * ⚠️ **A SEPARATE OPERATION, AND `discard` COULD NOT DO IT — FOUND BY AN
   * INDEPENDENT AUDIT, 2026-09-30.** The stop-during-packaging path once called
   * the scratch removal with the reader's chosen path, which asked it to delete
   * a file inside the run directory that had never existed. **So a reader who
   * pressed Stop while the chapters were being joined was left with a
   * half-joined `.m4b` at the name they chose** — and a part-written book is
   * indistinguishable from a whole one.
   *
   * The two are separate because the AUTHORITY is: scratch is the plugin's own
   * directory, and the destination is the one the reader named in the save
   * dialog, held by the plugin behind a token.
   *
   * ⚠️ **IT ANSWERS `'kept'` FOR A DESTINATION THAT EXISTED BEFORE THE EXPORT
   * WROTE IT, RATHER THAN REFUSING.** It refused, so a book kept over the
   * reader's own file was counted as a temporary file that would not go, and the
   * reader was told exactly that. The plugin checked at the moment it wrote the
   * file, which is later and truer than `exists` before the join, so its answer
   * wins where the two disagree.
   */
  discardBook: (destination: string) => Promise<'removed' | 'kept'>
  /**
   * Remove whatever is left of THIS export's scratch, once the chapters are gone.
   *
   * ⚠️ **PER-EXPORT, WHICH IS THE WHOLE POINT.** Scratch used to be
   * `chapter-<index>.wav` under one shared directory, so two exports running at
   * once wrote over each other's chapters and each tidy-up deleted the other's
   * files — and a crash left them there for ever, because nothing owned them.
   * Every export gets its own directory now, and this removes it.
   */
  discardScratch: () => Promise<void>
  /**
   * Whether there is already a file at the destination the reader chose.
   *
   * ⚠️ **ASKED BEFORE THE JOIN, AND A STOP DESTROYED BOTH BOOKS WITHOUT IT —
   * FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** The join cannot be interrupted:
   * a stop pressed during it lands after the packer has already written the
   * reader's chosen path. Where that path held an earlier audiobook, the old one
   * was gone by then — and removing the new one left the reader with NEITHER,
   * from a press that only meant *do not bother finishing*.
   *
   * So the destination is removed only where this export CREATED it. A file it
   * replaced is kept, and the reader is told that the stop came too late to undo
   * it — which is true, and is the only honest thing left to say once the bytes
   * are on top of each other.
   */
  exists: (destination: string) => Promise<boolean>
}

/**
 * One chapter as the packer is told it.
 *
 * ⚠️ **NEVER A SCRATCH PATH.** A chapter this export rendered is named by its
 * index, and the plugin rebuilds the file inside the run directory it made; a
 * cached chapter is a clip path the plugin accepts only inside the clip store.
 * A window that could name any path here could make the packer read any file.
 */
export interface PackagedChapter {
  readonly title: string
  readonly source:
    | { readonly kind: 'scratch'; readonly index: number }
    | { readonly kind: 'clip'; readonly path: string }
}

export interface AudiobookRequest {
  readonly chapters: readonly ChapterPlan[]
  readonly voice: string
  readonly rate: number
  readonly title: string
  readonly author: string
  /** Which book this is, so a chapter already rendered can be found. */
  readonly bookId: string
  /** Where the finished book goes: the token the save dialog's pick answered. */
  readonly destination: string
  readonly onProgress: (done: number, total: number, title: string) => void
  /** Asked between chapters; true stops the export. */
  readonly cancelled: () => boolean
}

export interface AudiobookResult {
  /** The file name the reader chose, for the notice — never the path. */
  readonly name: string
  readonly durationMs: number
  readonly chapters: number
  /**
   * How many scratch files could not be removed.
   *
   * ⚠️ **THEY USED TO BE SWALLOWED, AND THE HOOK THEN TOLD THE READER "NOTHING
   * WAS LEFT BEHIND".** `.catch(() => {})` is right about not letting a tidy-up
   * failure mask the export's own outcome, and wrong about saying nothing: a
   * chapter of a ten-hour book is tens of megabytes, so a run of failures is
   * real disk a reader cannot find. Counted here, reported by the caller, and
   * still never thrown.
   */
  readonly leftBehind: number
  /**
   * How many passages the engine would not say, across every chapter.
   *
   * ⚠️ **A COUNT AND NOT THE PASSAGES, DELIBERATELY.** A book can skip dozens,
   * and a notice that lists them is a notice nobody reads; what a reader needs
   * from the export is *this is not the whole book*, which a number says. The
   * reading names each one as it reaches it, which is where the text belongs.
   */
  readonly skipped: number
}

/** A stop the reader asked for — not a failure, and reported as neither. */
/**
 * What a stopped export left at the name the reader chose.
 *
 * - `gone`: nothing of this export is there — it never wrote the book, or it
 *   removed it.
 * - `replaced`: it wrote the book over a file the reader already had, and kept
 *   it, because removing it would leave them with neither.
 * - `stuck`: it wrote the book and the removal was refused, so the book is
 *   still there.
 *
 * ⚠️ **NOT A COUNT OF FILES.** A book that would not go was added to
 * `leftBehind`, and the reader was told one temporary audio file could not be
 * removed — about the audiobook at the name they had typed.
 */
export type StoppedBook = 'gone' | 'replaced' | 'stuck'

export class ExportCancelled extends Error {
  /**
   * @param leftBehind How many scratch files survived the tidy-up, for the same
   * reason `AudiobookResult` carries it: the notice for a stopped export
   * asserted that nothing was left behind, and nothing had checked.
   *
   * ⚠️ **A CONSTRUCTOR ARGUMENT, NOT A FIELD ASSIGNED LATER.** The count is only
   * known after the tidy-up, which runs after the stop was thrown, so it used to
   * be written onto the caught instance behind an `instanceof` — a mutation
   * whose guard nothing could observe, because an ordinary failure carrying a
   * stray count is not something any caller reads. `exportAudiobook` throws a
   * new one with the settled count instead, so every instance a caller catches
   * was built with the number it holds.
   */
  constructor(
    readonly leftBehind = 0,
    /**
     * What became of the book — see `StoppedBook`.
     *
     * ⚠️ **THE STOP CAN COME TOO LATE TO UNDO IT, AND SAYING SO IS THE ONLY
     * HONEST THING LEFT.** The join cannot be interrupted; once it has run over a
     * file the reader already had, removing the result would leave them with
     * neither. So it is kept, and this is what lets the caller say why.
     */
    readonly book: StoppedBook = 'gone',
  ) {
    super('the export was stopped')
    this.name = 'ExportCancelled'
  }
}

/**
 * Render every chapter, then package them.
 *
 * ⚠️ **THE SCRATCH FILES GO WHATEVER HAPPENS**, including when the reader stops
 * it. A chapter of a ten-hour book is tens of megabytes; an export abandoned
 * half way through must not leave half a book on the disk. They are removed in a
 * `finally`, which is the only construct that survives both a throw and a
 * cancellation.
 *
 * ⚠️ **CANCELLATION IS CHECKED BETWEEN CHAPTERS AND NOT INSIDE ONE.** A render
 * has no way in: it is one call into the engine, which owns the synthesiser
 * until it finishes. So the grain of "stop" is a chapter — a few seconds of
 * waiting at 22× real time, and a bounded promise rather than an unbounded one.
 */
export async function exportAudiobook(
  platform: AudiobookPlatform,
  request: AudiobookRequest,
): Promise<AudiobookResult> {
  if (request.chapters.length === 0) {
    throw new Error('this book has no readable text to export')
  }

  /**
   * TWO LISTS, BECAUSE THEY ANSWER TWO QUESTIONS.
   *
   * ⚠️ **ONE LIST SERVED BOTH AND COULD NOT.** `written` was pushed to AFTER the
   * render resolved — correctly, since packaging must never be handed a file a
   * failed render never finished — and the tidy-up then iterated the same list,
   * so a render that threw HAVING ALREADY WRITTEN BYTES left them behind with
   * nothing recorded. The two memberships are genuinely different: packaging
   * wants what succeeded, removal wants everything attempted.
   *
   * Nothing leaks from this today, because `apple.rs` writes beside and renames,
   * so a failed render leaves no file at that path at all. That is the BACKEND's
   * discipline and not this contract's, and the contract is the thing a second
   * backend would be written against — which is exactly when it would start
   * costing a reader a part-written chapter of a book.
   */
  const written: PackagedChapter[] = []
  const attempted: number[] = []
  /**
   * The cached chapters this export is holding open — see `AudiobookPlatform.hold`.
   *
   * SEPARATE FROM `written`, because they answer different questions: packaging
   * wants every chapter, and the lease is only over the ones this export does not
   * own and cannot replace.
   */
  const leased: string[] = []
  let leftBehind = 0
  /** Passages no chapter could say — see `AudiobookResult.skipped`. */
  let skipped = 0
  /**
   * Remove everything this export wrote on the way, counting what would not go.
   *
   * ⚠️ **CALLED ON BOTH ROADS OUT RATHER THAN FROM A `finally`, AND THAT IS NOT
   * A STYLE CHOICE.** The tidy-up WAS a `finally` and the count it produced was
   * always zero — because `return { …, leftBehind }` evaluates its object
   * BEFORE the `finally` runs, so the success path captured the value as it was
   * when nothing had been removed yet. A test asking for a failing `discard`
   * found it; reading the code did not. A `finally` cannot contribute to a value
   * the `return` beside it has already built.
   *
   * Calling it explicitly also puts the exception in the `catch`'s hand, which
   * is what lets a cancellation carry the count without a mutable flag the
   * compiler could not follow into a closure.
   */
  /**
   * Give every lease back.
   *
   * ⚠️ **CALLED FROM `tidy`, WHICH BOTH ROADS OUT ALREADY REACH.** A release that
   * hung off the success path alone would pin a clip until the app restarted
   * every time a reader stopped an export — a slow leak of their own disk budget,
   * invisible until the store stopped evicting.
   */
  const unlease = async (): Promise<void> => {
    if (leased.length === 0) return
    await platform.releaseClips(leased).catch(() => {
      /* Nothing to report: a lease that will not come back costs disk until the
         app restarts, and the holds live in memory precisely so that is bounded. */
    })
  }

  const tidy = async (): Promise<void> => {
    await unlease()
    /**
     * Files this export wrote that would not go one at a time.
     *
     * ⚠️ **HELD SEPARATELY, BECAUSE THE SWEEP BELOW USUALLY TAKES THEM ANYWAY —
     * FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** These were added straight to
     * `leftBehind`, and then `discardScratch` removed the whole directory
     * RECURSIVELY — so a reader whose per-file removal was refused for any
     * transient reason was told files had been left behind that no longer
     * existed. A count of what is on the disk has to be a count of what is on
     * the disk.
     */
    let refused = 0
    for (const index of attempted) {
      /* One failure to tidy up must not hide the export's own outcome, nor stop
       * the other scratch files being removed — so it is COUNTED rather than
       * thrown, and rather than swallowed. A chapter of a ten-hour book is tens
       * of megabytes; "nothing was left behind" was asserted upstream with
       * nothing checking it. */
      await platform.discard(index).catch(() => {
        refused += 1
      })
    }
    /* AFTER the files, and counted for the same reason: the directory is this
       export's own, so removing it cannot affect another one.
       ⚠️ **AND ITS SUCCESS CLEARS THE PER-FILE FAILURES**, because a recursive
       removal of the directory they were in is what makes them gone. */
    await platform.discardScratch().then(
      () => {
        refused = 0
      },
      () => {
        refused += 1
      },
    )
    leftBehind += refused
  }

  try {
    for (const [at, chapter] of request.chapters.entries()) {
      if (request.cancelled()) throw new ExportCancelled()
      request.onProgress(at, request.chapters.length, chapter.title)
      const scratch = platform.scratchFor(chapter.index)
      /* ⚠️ **RECORDED FOR REMOVAL BEFORE THE RENDER, AND ONLY A SCRATCH CHAPTER.**
       * The two lists answer two questions — packaging wants what succeeded,
       * removal wants everything attempted — and a render that threw HAVING
       * ALREADY WRITTEN BYTES must leave nothing behind. Recorded by INDEX,
       * because that is all the plugin takes to remove one. What is never recorded
       * here is a CACHED clip: it is the reader's audio, the store owns it, and
       * removing it would make listening to a chapter and then exporting it cost
       * the reader the chapter they had listened to. */
      attempted.push(chapter.index)
      const answered = await platform.render({
        text: chapter.text,
        voice: request.voice,
        rate: request.rate,
        path: scratch,
        bookId: request.bookId,
        section: chapter.index,
        textDigest: chapter.textDigest,
      })
      if (answered.cached) {
        /* Nothing was written at the scratch path, so there is nothing there to
           remove — and `discard` would be asked for a file that does not exist. */
        attempted.pop()
        /* ⚠️ **`cached` MEANS FOUND *AND* HELD, WHICH IS WHY THERE IS NO `hold`
           CALL HERE.** Taking the lease has to be atomic with the find — a clip
           can be forgotten between the two commands — so the platform does both
           or neither, and answers `cached: false` where it could not hold what
           it found. This list is what has to be GIVEN BACK, which is the half
           only this function knows the roads out of. */
        leased.push(answered.path)
      }
      /* PUSHED AFTER THE RENDER RESOLVES. Recorded before it, a render that
       * threw would leave a path in the list that holds nothing, and packaging
       * would fail on a file it was told to expect. */
      /* COUNTED FROM BOTH ROADS, because both can produce them: a fresh render
         refuses a passage as it goes, and a cached clip carries the refusals of
         the render that made it. */
      skipped += answered.skipped.length
      written.push({
        title: chapter.title,
        source: answered.cached
          ? { kind: 'clip', path: answered.path }
          : { kind: 'scratch', index: chapter.index },
      })
    }

    if (request.cancelled()) throw new ExportCancelled()
    /* ⚠️ **ASKED BEFORE THE JOIN, NOT AFTER**, which is the only moment the answer
       means anything: the packer writes the destination, so afterwards it exists
       whatever was there before. A refused question reads as *there was nothing*,
       which is the direction that removes rather than keeps — and a tidy-up that
       cannot tell should not be the thing that decides to keep a file the reader
       stopped asking for. */
    let replaced = false
    await platform
      .exists(request.destination)
      .then((there) => {
        replaced = there
      })
      /* ⚠️ **AN ASSIGNMENT RATHER THAN `.catch(() => false)` — FOUND BY THE
         MUTATION SWEEP.** An arrow returning a falsy constant has a falsy twin:
         `() => false` mutated to `() => undefined` behaves identically at the
         `if (replaced)` below, so the mutant could not be killed. Written this
         way the SUCCESS handler is what carries the answer — emptying it loses
         the replaced case, which a test reads — and the failure handler is an
         empty block, which Stryker makes no mutant of. */
      .catch(() => {})
    request.onProgress(request.chapters.length, request.chapters.length, 'joining the chapters')
    const packaged = await platform
      .package({
        chapters: written,
        title: request.title,
        author: request.author,
        destination: request.destination,
      })
      .catch((cause: unknown) => {
        /* ⚠️ **A STOP DURING THE JOIN GIVES THE DESTINATION BACK AT ONCE, AND
           THE PLUGIN THEN REFUSES TO WRITE IT** — see `useAudiobook`'s `letGo`.
           That refusal is the stop working, not a failure, and nothing reached
           the reader's name: only the commit writes there. */
        if (request.cancelled()) throw new ExportCancelled()
        throw cause
      })
    /**
     * ⚠️ **AND AGAIN AFTER THE JOIN, BECAUSE THE JOIN CANNOT BE INTERRUPTED AND
     * THE OLD CODE REPORTED SUCCESS FOR AN EXPORT THE READER HAD STOPPED.**
     * Cancellation was checked only on the way in, so a stop pressed while the
     * chapters were being joined and encoded — the longest single step there is,
     * and the one the transport says "Stopping…" over — was ignored, and the
     * reader was then told the book had been exported.
     *
     * The join itself still cannot be cut short: it is one call into the engine,
     * which owns the encoder until it finishes, exactly as a chapter render does.
     * What changes is that the OUTCOME is honest. The part-written book is
     * removed on the way out, because a file the reader stopped asking for must
     * not be left at the name they chose — a half-joined `.m4b` is
     * indistinguishable from a whole one, which is the trap `narrate` records for
     * a truncated render.
     */
    if (request.cancelled()) {
      /* ⚠️ **ONLY A FILE THIS EXPORT CREATED — see `exists`.** Removing one it
         REPLACED leaves the reader with neither book, because the join has
         already overwritten what was there. */
      if (replaced) {
        throw new ExportCancelled(leftBehind, 'replaced')
      }
      /* THE BOOK AT THE READER'S OWN NAME, through the operation that can reach
         it — see `discardBook`, which records what calling `discard` here cost.
         ⚠️ **ITS ANSWER WINS OVER `replaced`**: the plugin looked when it wrote
         the file. A refusal leaves the book where it is, which is `stuck`, and
         is not a temporary file. */
      let book: StoppedBook = 'stuck'
      await platform.discardBook(request.destination).then(
        (answer) => {
          book = answer === 'kept' ? 'replaced' : 'gone'
        },
        () => {},
      )
      throw new ExportCancelled(leftBehind, book)
    }
    await tidy()
    return {
      name: packaged.name,
      durationMs: packaged.durationMs,
      chapters: packaged.chapters,
      leftBehind,
      skipped,
    }
  } catch (cause) {
    await tidy()
    /* The count belongs to the reader's own stop, which is the notice that used
       to assert "nothing was left behind" with nothing checking it. A genuine
       failure carries the engine's sentence instead and says nothing about
       scratch — `narrate` names what it refused, and that is what to show. */
    throw cause instanceof ExportCancelled ? new ExportCancelled(leftBehind, cause.book) : cause
  }
}

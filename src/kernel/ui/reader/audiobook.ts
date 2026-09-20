/**
 * Turning an open book into an audiobook.
 *
 * THE ORCHESTRATION ONLY. Nothing here speaks, encodes or writes a container —
 * the engine is `src-tauri/src/narrate/`, reached through the two functions
 * this module is handed. That split is what makes the part with the decisions
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

/** One section's readable text, as `ReaderSession.sectionTexts` answers it. */
export interface SectionText {
  readonly index: number
  /** The table of contents' own label for this section, where it has one. */
  readonly title: string | null
  readonly text: string
}

/** A chapter to render: what to say, and what to call it. */
export interface ChapterPlan {
  readonly index: number
  readonly title: string
  readonly text: string
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
      title: title && title !== '' ? title : `Chapter ${chapters.length + 1}`,
      text: section.text,
    })
  }
  return chapters
}

/** What an export needs from the platform, so the rest of this file needs none. */
export interface AudiobookPlatform {
  /** Speak one chapter into a file, and answer where it went. */
  render: (job: {
    readonly text: string
    readonly voice: string
    readonly rate: number
    readonly path: string
  }) => Promise<unknown>
  /** Join the rendered chapters into one book. */
  package: (job: {
    readonly chapters: readonly { readonly title: string; readonly path: string }[]
    readonly title: string
    readonly author: string
    readonly path: string
  }) => Promise<{ readonly durationMs: number; readonly chapters: number }>
  /** Where a chapter's audio is written on the way. */
  scratchFor: (index: number) => string
  /** Remove one, whatever happened. */
  discard: (path: string) => Promise<void>
}

export interface AudiobookRequest {
  readonly chapters: readonly ChapterPlan[]
  readonly voice: string
  readonly rate: number
  readonly title: string
  readonly author: string
  /** Where the finished book goes. */
  readonly path: string
  readonly onProgress: (done: number, total: number, title: string) => void
  /** Asked between chapters; true stops the export. */
  readonly cancelled: () => boolean
}

export interface AudiobookResult {
  readonly path: string
  readonly durationMs: number
  readonly chapters: number
}

/** A stop the reader asked for — not a failure, and reported as neither. */
export class ExportCancelled extends Error {
  constructor() {
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
  const written: { title: string; path: string }[] = []
  const attempted: string[] = []
  try {
    for (const [at, chapter] of request.chapters.entries()) {
      if (request.cancelled()) throw new ExportCancelled()
      request.onProgress(at, request.chapters.length, chapter.title)
      const path = platform.scratchFor(chapter.index)
      attempted.push(path)
      await platform.render({
        text: chapter.text,
        voice: request.voice,
        rate: request.rate,
        path,
      })
      /* PUSHED AFTER THE RENDER RESOLVES. Recorded before it, a render that
       * threw would leave a path in the list that holds nothing, and packaging
       * would fail on a file it was told to expect. */
      written.push({ title: chapter.title, path })
    }

    if (request.cancelled()) throw new ExportCancelled()
    request.onProgress(request.chapters.length, request.chapters.length, 'joining the chapters')
    const packaged = await platform.package({
      chapters: written,
      title: request.title,
      author: request.author,
      path: request.path,
    })
    return {
      path: request.path,
      durationMs: packaged.durationMs,
      chapters: packaged.chapters,
    }
  } finally {
    for (const path of attempted) {
      /* One failure to tidy up must not hide the export's own outcome, nor stop
       * the other scratch files being removed. */
      await platform.discard(path).catch(() => {})
    }
  }
}

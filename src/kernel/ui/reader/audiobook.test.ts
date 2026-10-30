import { describe, expect, it, vi } from 'vitest'
import {
  ExportCancelled,
  exportAudiobook,
  planChapters,
  type AudiobookPlatform,
  type SectionText,
} from './audiobook'

const section = (index: number, text: string, title: string | null = null): SectionText => ({
  index,
  title,
  text,
  textDigest: `fnv1a64:${text.length}:${String(index).padStart(16, '0')}`,
})

describe('planChapters', () => {
  it('takes the table of contents label where there is one', () => {
    const plan = planChapters([section(0, 'one', 'Chapter One'), section(1, 'two', '第三章')])
    expect(plan.map((c) => c.title)).toEqual(['Chapter One', '第三章'])
  })

  it('numbers the chapters it produced, not the spine positions', () => {
    /* A cover and a plate sit between the chapters. Numbering by spine index
       would name the second chapter after the fourth section, which tells the
       reader something false about the book. */
    const plan = planChapters([
      section(0, '   '),
      section(1, 'real text'),
      section(2, ''),
      section(3, 'more text'),
    ])
    expect(plan.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2'])
    expect(plan.map((c) => c.index)).toEqual([1, 3])
  })

  it('drops a section with no words rather than making it a chapter', () => {
    /* A silent chapter shares the previous chapter's start, and two marks at one
       moment cannot both be reached — `narrate_package` refuses it by name. */
    expect(planChapters([section(0, ''), section(1, '\n\t  ')])).toEqual([])
  })

  it('keeps the untrimmed text, so the voice gets the book and not a trim', () => {
    const plan = planChapters([section(0, '  Hello world.  ')])
    expect(plan[0]?.text).toBe('  Hello world.  ')
  })

  it('falls back to a number for a blank label', () => {
    expect(planChapters([section(0, 'text', '   ')])[0]?.title).toBe('Chapter 1')
  })
})

/** A platform that records what it was asked and answers immediately. */
function fake(overrides: Partial<AudiobookPlatform> = {}) {
  const rendered: string[] = []
  const discarded: string[] = []
  const sweeps: string[] = []
  /** The book at the reader's chosen name, which `discard` cannot reach. */
  const books: string[] = []
  /** Every lease given back — see `AudiobookPlatform.releaseClips`. */
  const released: string[][] = []
  const platform: AudiobookPlatform = {
    render: vi.fn(async (job) => {
      rendered.push(job.path)
      return { path: job.path, cached: false, skipped: [] }
    }),
    package: vi.fn(async () => ({ durationMs: 1234, chapters: 2 })),
    scratchFor: (index) => `/tmp/ch-${index}.wav`,
    discard: vi.fn(async (path) => {
      discarded.push(path)
    }),
    discardScratch: vi.fn(async () => {
      sweeps.push('swept')
    }),
    discardBook: vi.fn(async (path: string) => {
      books.push(path)
    }),
    releaseClips: vi.fn(async (paths: readonly string[]) => {
      released.push([...paths])
    }),
    /* NOTHING AT THE DESTINATION, which is the ordinary export — a reader naming
       a file they already have is the case the two cases below are about. */
    exists: vi.fn(async () => false),
    ...overrides,
  }
  return { platform, rendered, discarded, sweeps, books, released }
}

const request = (over: Partial<Parameters<typeof exportAudiobook>[1]> = {}) => ({
  chapters: planChapters([section(0, 'one', 'One'), section(1, 'two', 'Two')]),
  voice: 'com.apple.voice.compact.en-US.Samantha',
  rate: 1,
  bookId: 'book:a',
  title: 'A Measured Book',
  author: 'Paper',
  path: '/tmp/book.m4b',
  onProgress: vi.fn(),
  cancelled: () => false,
  ...over,
})

describe('exportAudiobook', () => {
  it('renders every chapter and packages them in order', async () => {
    const { platform, rendered } = fake()
    const result = await exportAudiobook(platform, request())
    expect(rendered).toEqual(['/tmp/ch-0.wav', '/tmp/ch-1.wav'])
    expect(platform.package).toHaveBeenCalledWith({
      chapters: [
        { title: 'One', path: '/tmp/ch-0.wav' },
        { title: 'Two', path: '/tmp/ch-1.wav' },
      ],
      title: 'A Measured Book',
      author: 'Paper',
      path: '/tmp/book.m4b',
    })
    expect(result).toEqual({ path: '/tmp/book.m4b', durationMs: 1234, chapters: 2, leftBehind: 0, skipped: 0 })
  })

  /**
   * ⚠️ **A CACHED CHAPTER CAN BE EVICTED OUT FROM UNDER THE EXPORT THAT NAMED
   * IT** — found by an independent audit, 2026-09-30. `findClip` hands the packer
   * a PATH rather than bytes, and the packer reads that file for as long as the
   * muxing takes: a reading in the other window renders a section meanwhile, the
   * store evicts the least-recently-played clip to stay inside its budget, and
   * the join fails on a file it was told to expect — or worse, *Forget them*
   * deletes it and the book comes out a chapter short.
   *
   * The lease is the fix, and these two cases are the whole of its contract:
   * taken for what this export does not own, given back on every road out.
   */
  it('keeps a book it wrote over one the reader already had, rather than both going', async () => {
    /* ⚠️ **A STOP DURING THE JOIN DESTROYED BOTH BOOKS — FOUND BY AN INDEPENDENT
       AUDIT, 2026-09-30.** The join cannot be interrupted, so a stop pressed
       during it lands AFTER the packer has written the reader's chosen path. Where
       that path held an earlier audiobook, the old one was already gone — and
       removing the new one left the reader with NEITHER, from a press that only
       meant *do not bother finishing*.

       The destination is now removed only where this export CREATED it. */
    let joining = false
    const { platform, books, discarded } = fake({
      exists: vi.fn(async () => true),
      package: vi.fn(async () => {
        joining = true
        return { durationMs: 1234, chapters: 2 }
      }),
    })

    const stopped = await exportAudiobook(platform, request({ cancelled: () => joining })).then(
      () => null,
      (cause: unknown) => cause,
    )

    expect(stopped).toBeInstanceOf(ExportCancelled)
    expect((stopped as ExportCancelled).kept, 'the caller can say why').toBe(true)
    /* ⚠️ **AND THE DEFAULT IS `false`, WHICH ONLY AN ORDINARY STOP CAN SHOW —
       FOUND BY THE MUTATION SWEEP.** Every `new ExportCancelled()` in this file
       takes it, so a default of `true` would have every stopped export tell the
       reader their own file had been written over. The case below is the same
       export with nothing at the destination. */
    expect(books, 'the book the reader already had is not taken from them too').toEqual([])
    expect(discarded, 'the scratch still goes').not.toEqual([])
  })

  it('asks about the destination BEFORE the join, when the answer still means something', async () => {
    /* Afterwards the packer has written it, so it exists whatever was there —
       which would make the question answer `true` on every export and keep every
       stopped book at the reader's chosen name. */
    const { platform } = fake({ exists: vi.fn(async () => false) })
    await exportAudiobook(platform, request())
    const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder
    const [asked] = order(platform.exists)
    const [joined] = order(platform.package)
    expect(asked).toBeLessThan(Number(joined))
  })

  it('removes a destination it created, and a refused question reads as created', async () => {
    /* THE DIRECTION MATTERS: a question that cannot be answered must not be the
       thing that decides to KEEP a file the reader stopped asking for. */
    let joining = false
    const { platform, books } = fake({
      exists: vi.fn(async () => {
        throw new Error('the destination could not be read')
      }),
      package: vi.fn(async () => {
        joining = true
        return { durationMs: 1234, chapters: 2 }
      }),
    })

    await expect(
      exportAudiobook(platform, request({ cancelled: () => joining })),
    ).rejects.toBeInstanceOf(ExportCancelled)
    expect(books).toEqual(['/tmp/book.m4b'])
  })

  it('counts what no chapter could say, from both the cached road and the fresh one', async () => {
    /* ⚠️ **NEITHER ROAD CARRIED THESE AND THE EXPORT REPORTED A WHOLE BOOK —
     * FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `voices_render_file` answered
     * only a sample rate, and the clip the cached road reuses arrived without a
     * skip list at all. So a book missing a sentence came out reported as
     * finished, which is the complete-looking-and-wrong outcome `narrate` refuses
     * everywhere else it can.
     *
     * BOTH roads, in one case, because a real book mixes them — some chapters the
     * reader has heard and some they have not — and a count taken from only one
     * of them is a count that is right in the tests and wrong in the app. */
    const { platform } = fake({
      render: vi.fn(async (job) =>
        job.section === 0
          ? {
              path: '/data/audio/clips/book_a-0-abc.wav',
              cached: true,
              skipped: [{ text: 'Coenties', why: 'no pronunciation' }],
            }
          : {
              path: job.path,
              cached: false,
              skipped: [
                { text: 'Manhattoes', why: 'no pronunciation' },
                { text: '𓀀', why: 'no pronunciation' },
              ],
            },
      ),
    })

    const result = await exportAudiobook(platform, request())
    expect(result.skipped, 'one from the clip, two from the render').toBe(3)
  })

  it('counts none where every chapter was said whole', async () => {
    /* The common case, and it has to be ZERO rather than absent: the caller uses
       the number as the test for whether to say anything at all. */
    const { platform } = fake()
    expect((await exportAudiobook(platform, request())).skipped).toBe(0)
  })

  it('gives a cached chapter back only after the packer has read it', async () => {
    const { platform, released } = fake({
      render: vi.fn(async (job) => ({
        /* The first chapter is the reader's own audio, held in the store; the
           second is rendered fresh into this export's scratch. Only the first can
           be taken away by anything but this export, so only it is leased. */
        path: job.section === 0 ? '/data/audio/clips/book_a-0-abc.wav' : job.path,
        cached: job.section === 0,
        skipped: [],
      })),
    })

    await exportAudiobook(platform, request())

    expect(released, 'exactly what was cached, once').toEqual([
      ['/data/audio/clips/book_a-0-abc.wav'],
    ])
    /* THE ORDER IS THE WHOLE POINT: a release that landed before the packer read
       the file would leave exactly the window the lease exists to close. */
    const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder
    const [gaveBack] = order(platform.releaseClips)
    const [joined] = order(platform.package)
    expect(gaveBack, 'given back after the join').toBeGreaterThan(Number(joined))
  })

  it('gives a lease back when the export is stopped, not only when it finishes', async () => {
    /* A release that hung off the success path alone would pin a clip until the
       app restarted every time a reader stopped an export — a slow leak of their
       own disk budget, invisible until the store stopped evicting. */
    let rendered = 0
    const { platform, released } = fake({
      render: vi.fn(async () => {
        rendered += 1
        return { path: '/data/audio/clips/book_a-0-abc.wav', cached: true, skipped: [] }
      }),
    })

    await expect(
      exportAudiobook(platform, request({ cancelled: () => rendered > 0 })),
    ).rejects.toBeInstanceOf(ExportCancelled)

    expect(platform.package, 'it never got as far as joining').not.toHaveBeenCalled()
    expect(released).toEqual([['/data/audio/clips/book_a-0-abc.wav']])
  })

  it('gives nothing back where nothing was cached, rather than an empty call', async () => {
    /* A release for an empty list is a command round trip for a question with no
       subject, and it would make "a lease was taken" unobservable in every case
       above — the `leased.length === 0` guard is what keeps those honest. */
    const { platform, released } = fake()
    await exportAudiobook(platform, request())
    expect(released).toEqual([])
  })

  /**
   * ⚠️ **A STOP DURING THE JOIN WAS IGNORED, AND SUCCESS WAS REPORTED.**
   * Cancellation was checked only on the way INTO packaging, so a stop pressed
   * while the chapters were being joined and encoded — the longest single step
   * there is, and the one the transport shows "Stopping…" over — produced a
   * finished-looking `.m4b` and a notice saying the book had been exported.
   *
   * The join still cannot be cut short: it is one call into the engine, exactly
   * as a chapter render is. What must be true is that the OUTCOME is honest and
   * the file the reader stopped asking for is not left at the name they chose.
   */
  it('says nothing was kept where the destination was this export’s own', async () => {
    let joining = false
    const { platform } = fake({
      exists: vi.fn(async () => false),
      package: vi.fn(async () => {
        joining = true
        return { durationMs: 1234, chapters: 2 }
      }),
    })
    const stopped = await exportAudiobook(platform, request({ cancelled: () => joining })).then(
      () => null,
      (cause: unknown) => cause,
    )
    expect((stopped as ExportCancelled).kept, 'nothing of the reader’s was replaced').toBe(false)
  })

  it('reports a stop asked for while the chapters are being joined', async () => {
    let joining = false
    const { platform, discarded, books } = fake({
      package: vi.fn(async () => {
        joining = true
        return { durationMs: 1234, chapters: 2 }
      }),
    })

    const run = exportAudiobook(platform, request({ cancelled: () => joining }))

    await expect(run).rejects.toBeInstanceOf(ExportCancelled)
    expect(platform.package, 'the join itself is not interruptible, so it ran').toHaveBeenCalledTimes(1)
    /* ⚠️ **THROUGH `discardBook`, AND THIS CASE PASSED OVER THE DEFECT BECAUSE ITS
     * FAKE WAS MORE CAPABLE THAN THE REAL THING.** It asserted `discarded`, and
     * the fake's `discard` records any path it is handed — while the Tauri one
     * takes a BASENAME under the export's own scratch directory, so the reader's
     * chosen path asked it to remove `audiobook/run-…/Book.m4b`, which has never
     * existed. The book stayed at the name the reader chose, and this case was
     * green. Found by an independent audit, 2026-09-30.
     *
     * **A fake that can do something the implementation cannot is a test that
     * measures the fake** — the same lesson as `paper/share-notes/1` having no
     * client, and as `measuredIn` dropping `excluded`. The two operations are
     * separate now because their AUTHORITY is. */
    expect(books, 'the book went through the operation that can reach it').toContain('/tmp/book.m4b')
    expect(discarded, 'and not through the one scoped to scratch').not.toContain('/tmp/book.m4b')
  })

  /**
   * ⚠️ **EVERY TIDY-UP FAILURE WAS SWALLOWED WHILE THE CALLER SAID "NOTHING WAS
   * LEFT BEHIND".** `.catch(() => {})` is right that a failed removal must not
   * mask the export's own outcome, and wrong to say nothing at all: a chapter of
   * a ten-hour book is tens of megabytes, so a run of failures is real disk a
   * reader cannot find. Counted, never thrown.
   */
  it('counts the scratch it could not remove, rather than swallowing it', async () => {
    /* ⚠️ **AND THE SWEEP HAS TO FAIL TOO, OR THERE IS NOTHING LEFT TO COUNT —
     * FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `discardScratch` removes the
     * directory RECURSIVELY, so files a per-file removal was refused go with it.
     * This case failed only `discard` and asserted 2, which told the reader about
     * files that were no longer there. */
    const { platform } = fake({
      discard: vi.fn(async () => {
        throw new Error('the file is busy')
      }),
      discardScratch: vi.fn(async () => {
        throw new Error('the directory is busy')
      }),
    })
    const result = await exportAudiobook(platform, request())
    expect(result.chapters, 'the export still succeeded').toBe(2)
    expect(result.leftBehind, 'both chapter files, and the directory').toBe(3)
  })

  it('counts nothing where the sweep took what the files would not give up', async () => {
    /* The other half, and the defect itself: every per-file removal refused, and
       the recursive sweep then removed the directory they were in. Nothing is
       left behind, and the reader must not be told otherwise. */
    const { platform } = fake({
      discard: vi.fn(async () => {
        throw new Error('the file is busy')
      }),
    })
    const result = await exportAudiobook(platform, request())
    expect(result.leftBehind, 'the sweep took them').toBe(0)
  })

  it('carries the same count out on a cancellation', async () => {
    const { platform } = fake({
      discardScratch: vi.fn(async () => {
        throw new Error('the directory is busy')
      }),
    })
    const cause = await exportAudiobook(platform, request({ cancelled: () => true })).then(
      () => null,
      (e: unknown) => e,
    )
    expect(cause).toBeInstanceOf(ExportCancelled)
    expect((cause as ExportCancelled).leftBehind, 'the directory alone').toBe(1)
  })

  it('removes every scratch file it wrote', async () => {
    const { platform, discarded } = fake()
    await exportAudiobook(platform, request())
    expect(discarded).toEqual(['/tmp/ch-0.wav', '/tmp/ch-1.wav'])
  })

  it('removes them after a failure too', async () => {
    /* A chapter of a long book is tens of megabytes; an export that died half
       way must not leave half a book behind. */
    const { platform, discarded } = fake({
      package: vi.fn(async () => {
        throw new Error('afconvert refused the audio')
      }),
    })
    await expect(exportAudiobook(platform, request())).rejects.toThrow(/afconvert/u)
    expect(discarded).toEqual(['/tmp/ch-0.wav', '/tmp/ch-1.wav'])
  })

  it('tries to remove the chapter whose render failed, not only the ones that worked', async () => {
    /* ⚠️ **THIS ASSERTED THE OPPOSITE UNTIL A REFUTATION PASS RAN IT.** It read
       `['/tmp/ch-0.wav']` and was called "does not name a scratch file a failed
       render never wrote" — but a render that throws HAVING ALREADY WRITTEN
       BYTES is the ordinary failure, and nobody out here can tell that case
       from one that wrote nothing. Discarding a path that holds nothing costs a
       caught rejection; not discarding one that holds half a chapter costs the
       reader tens of megabytes they cannot find. */
    const { platform, discarded } = fake({
      render: vi.fn(async (job) => {
        if (job.path.endsWith('ch-1.wav')) throw new Error('the engine went quiet')
        return { path: job.path, cached: false, skipped: [] }
      }),
    })
    await expect(exportAudiobook(platform, request())).rejects.toThrow(/went quiet/u)
    expect(discarded).toEqual(['/tmp/ch-0.wav', '/tmp/ch-1.wav'])
  })

  it('removes the first chapter when it is the one that failed', async () => {
    /* The case that found this: with one list serving both packaging and the
       tidy-up, a book whose FIRST render died left its part-written file behind
       and the export reported nothing to remove at all. */
    const { platform, discarded } = fake({
      render: vi.fn(async (): Promise<never> => {
        throw new Error('the engine went quiet')
      }),
    })
    await expect(exportAudiobook(platform, request())).rejects.toThrow(/went quiet/u)
    expect(discarded).toEqual(['/tmp/ch-0.wav'])
  })

  it('still hands packaging only the chapters that finished', async () => {
    /* The other half, and the reason the two lists cannot be merged back: a
       file a failed render never completed must never reach `package`, which
       would fail on a file it was told to expect and blame the wrong step. */
    const { platform } = fake({
      render: vi.fn(async (job) => {
        if (job.path.endsWith('ch-1.wav')) throw new Error('the engine went quiet')
        return { path: job.path, cached: false, skipped: [] }
      }),
    })
    await expect(exportAudiobook(platform, request())).rejects.toThrow(/went quiet/u)
    expect(platform.package).not.toHaveBeenCalled()
  })

  it('stops between chapters when the reader asks', async () => {
    const { platform, rendered, discarded } = fake()
    let seen = 0
    await expect(
      exportAudiobook(
        platform,
        request({
          cancelled: () => {
            seen += 1
            return seen > 1
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ExportCancelled)
    /* One chapter got out before the stop was seen, and its file still goes. */
    expect(rendered).toEqual(['/tmp/ch-0.wav'])
    expect(discarded).toEqual(['/tmp/ch-0.wav'])
    expect(platform.package).not.toHaveBeenCalled()
  })

  it('checks once more before packaging, which is the long step', async () => {
    /* ⚠️ THIS CASE USED TO STOP AT THE FIRST CHAPTER. Its `cancelled` answered
       `platform.package !== undefined`, which is true from the start, so it
       never reached the check it is named for and nothing measured that check
       at all. The stop now lands while the LAST chapter renders — after every
       between-chapters check has passed, and before the join. */
    let stopped = false
    const { platform, rendered, discarded } = fake({
      render: vi.fn(async (job) => {
        rendered.push(job.path)
        if (job.path.endsWith('ch-1.wav')) stopped = true
        return { path: job.path, cached: false, skipped: [] }
      }),
    })
    await expect(exportAudiobook(platform, request({ cancelled: () => stopped }))).rejects.toBeInstanceOf(
      ExportCancelled,
    )
    expect(rendered, 'every chapter rendered before the stop was asked for').toEqual([
      '/tmp/ch-0.wav',
      '/tmp/ch-1.wav',
    ])
    expect(platform.package, 'the join began after the reader had stopped').not.toHaveBeenCalled()
    expect(discarded).toEqual(['/tmp/ch-0.wav', '/tmp/ch-1.wav'])
  })

  it('counts a part-joined book it could not remove after a stop during the join', async () => {
    /* The book at the reader's chosen name is removed on the way out of a stop
       during the join; when that removal fails, it is one more file left behind
       — and the reader is told, rather than told nothing was. */
    let joining = false
    const { platform } = fake({
      package: vi.fn(async () => {
        joining = true
        return { durationMs: 1234, chapters: 2 }
      }),
      /* THROUGH `discardBook`, which is the operation that can reach a path
         outside the export's own scratch — see the case above for what asserting
         it on `discard` hid. */
      discardBook: vi.fn(async () => {
        throw new Error('the book is open elsewhere')
      }),
    })
    const cause = await exportAudiobook(platform, request({ cancelled: () => joining })).then(
      () => null,
      (e: unknown) => e,
    )
    expect(cause).toBeInstanceOf(ExportCancelled)
    expect((cause as ExportCancelled).leftBehind, 'the part-joined book, and nothing else').toBe(1)
  })

  it('passes a genuine failure out as the engine’s own error, carrying no count', async () => {
    /* A failure is shown by its own sentence, and a stop by its count; turning
       one into the other would tell the reader the wrong thing either way. */
    const failure = new Error('afconvert refused the audio')
    const { platform } = fake({
      package: vi.fn(async () => {
        throw failure
      }),
    })
    const cause = await exportAudiobook(platform, request()).then(
      () => null,
      (e: unknown) => e,
    )
    expect(cause).toBe(failure)
  })

  it('names itself when a stop reaches a log', () => {
    const stop = new ExportCancelled(3)
    expect(stop).toBeInstanceOf(Error)
    expect(stop.name).toBe('ExportCancelled')
    expect(stop.message).toBe('the export was stopped')
    expect(stop.leftBehind).toBe(3)
    expect(new ExportCancelled().leftBehind, 'a stop with nothing counted left nothing').toBe(0)
  })

  it('reports progress per chapter and once for the join', async () => {
    const onProgress = vi.fn()
    const { platform } = fake()
    await exportAudiobook(platform, request({ onProgress }))
    expect(onProgress.mock.calls).toEqual([
      [0, 2, 'One'],
      [1, 2, 'Two'],
      [2, 2, 'joining the chapters'],
    ])
  })

  it('refuses a book with nothing to read rather than writing an empty one', async () => {
    const { platform } = fake()
    await expect(exportAudiobook(platform, request({ chapters: [] }))).rejects.toThrow(
      /no readable text/u,
    )
    expect(platform.package).not.toHaveBeenCalled()
  })

  it('removes its own scratch directory when it is done', async () => {
    /* ⚠️ **SCRATCH USED TO BE SHARED BY EVERY EXPORT.** `chapter-<index>.wav` under
       one directory meant two exports wrote over each other's chapters and each
       tidy-up deleted the other's files, and a crash left them owned by nobody.
       A directory per export is what makes both answerable. */
    const { platform, sweeps } = fake()
    await exportAudiobook(platform, request())
    expect(sweeps).toEqual(['swept'])
  })

  it('removes it after a failure too, and after the chapters', async () => {
    const { platform, discarded, sweeps } = fake({
      package: vi.fn(async () => {
        throw new Error('afconvert refused the audio')
      }),
    })
    await expect(exportAudiobook(platform, request())).rejects.toThrow(/afconvert/u)
    expect(discarded).toEqual(['/tmp/ch-0.wav', '/tmp/ch-1.wav'])
    expect(sweeps).toEqual(['swept'])
  })

  it('does not let a failed sweep hide the export either', async () => {
    const { platform } = fake({
      discardScratch: vi.fn(async () => {
        throw new Error('the disk is gone')
      }),
    })
    await expect(exportAudiobook(platform, request())).resolves.toMatchObject({ chapters: 2 })
  })

  it('does not let a failed tidy-up hide the export it belonged to', async () => {
    const { platform } = fake({
      discard: vi.fn(async () => {
        throw new Error('the disk is gone')
      }),
    })
    /* The result the caller gets is the EXPORT's, not the cleanup's. */
    await expect(exportAudiobook(platform, request())).resolves.toMatchObject({ chapters: 2 })
  })
})

describe('a chapter the reader has already listened to', () => {
  it('packages the clip the platform answered, not the scratch path', async () => {
    /* ⚠️ WI-34.4: *exporting a book you have listened to costs only the muxing*.
       The platform answers WHERE the audio is, and it is not always where the
       export asked for it to be put. */
    const { platform } = fake({
      render: vi.fn(async (job) => ({
        path: job.section === 0 ? '/data/audio/clips/heard-0.wav' : job.path,
        cached: job.section === 0,
        skipped: [],
      })),
    })
    await exportAudiobook(platform, request())
    expect(platform.package).toHaveBeenCalledWith(
      expect.objectContaining({
        chapters: [
          { title: 'One', path: '/data/audio/clips/heard-0.wav' },
          { title: 'Two', path: '/tmp/ch-1.wav' },
        ],
      }),
    )
  })

  it('does NOT remove it afterwards, which would cost the reader their audio', async () => {
    /* ⚠️ **THE DEFECT THIS EXISTS TO PREVENT.** The tidy-up removes everything the
       export attempted; a cached clip belongs to the store, and deleting it would
       mean listening to a chapter and then exporting it took the chapter away. */
    const { platform, discarded } = fake({
      render: vi.fn(async (job) => ({
        path: job.section === 0 ? '/data/audio/clips/heard-0.wav' : job.path,
        cached: job.section === 0,
        skipped: [],
      })),
    })
    await exportAudiobook(platform, request())
    expect(discarded, 'only the scratch this export wrote').toEqual(['/tmp/ch-1.wav'])
  })

  it('removes nothing at all when every chapter was already rendered', async () => {
    const { platform, discarded } = fake({
      render: vi.fn(async (job) => ({ path: `/data/audio/clips/heard-${job.section}.wav`, cached: true, skipped: [] })),
    })
    const result = await exportAudiobook(platform, request())
    expect(discarded).toEqual([])
    expect(result.leftBehind).toBe(0)
    /* The scratch DIRECTORY still goes: it was made on the way in whether or not
       anything landed in it. */
    expect(platform.discardScratch).toHaveBeenCalledTimes(1)
  })

  it('still removes the scratch of a chapter whose render threw after a cached one', async () => {
    const { platform, discarded } = fake({
      render: vi.fn(async (job) => {
        if (job.section === 0) return { path: '/data/audio/clips/heard-0.wav', cached: true, skipped: [] }
        throw new Error('the engine went quiet')
      }),
    })
    await expect(exportAudiobook(platform, request())).rejects.toThrow(/went quiet/u)
    expect(discarded, 'the cached clip is not among them').toEqual(['/tmp/ch-1.wav'])
  })
})

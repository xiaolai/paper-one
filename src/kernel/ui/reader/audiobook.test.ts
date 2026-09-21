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
  const platform: AudiobookPlatform = {
    render: vi.fn(async (job) => {
      rendered.push(job.path)
    }),
    package: vi.fn(async () => ({ durationMs: 1234, chapters: 2 })),
    scratchFor: (index) => `/tmp/ch-${index}.wav`,
    discard: vi.fn(async (path) => {
      discarded.push(path)
    }),
    discardScratch: vi.fn(async () => {
      sweeps.push('swept')
    }),
    ...overrides,
  }
  return { platform, rendered, discarded, sweeps }
}

const request = (over: Partial<Parameters<typeof exportAudiobook>[1]> = {}) => ({
  chapters: planChapters([section(0, 'one', 'One'), section(1, 'two', 'Two')]),
  voice: 'com.apple.voice.compact.en-US.Samantha',
  rate: 1,
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
    expect(result).toEqual({ path: '/tmp/book.m4b', durationMs: 1234, chapters: 2, leftBehind: 0 })
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
  it('reports a stop asked for while the chapters are being joined', async () => {
    let joining = false
    const { platform, discarded } = fake({
      package: vi.fn(async () => {
        joining = true
        return { durationMs: 1234, chapters: 2 }
      }),
    })

    const run = exportAudiobook(platform, request({ cancelled: () => joining }))

    await expect(run).rejects.toBeInstanceOf(ExportCancelled)
    expect(platform.package, 'the join itself is not interruptible, so it ran').toHaveBeenCalledTimes(1)
    expect(discarded, 'and the part-written book went with the scratch').toContain('/tmp/book.m4b')
  })

  /**
   * ⚠️ **EVERY TIDY-UP FAILURE WAS SWALLOWED WHILE THE CALLER SAID "NOTHING WAS
   * LEFT BEHIND".** `.catch(() => {})` is right that a failed removal must not
   * mask the export's own outcome, and wrong to say nothing at all: a chapter of
   * a ten-hour book is tens of megabytes, so a run of failures is real disk a
   * reader cannot find. Counted, never thrown.
   */
  it('counts the scratch it could not remove, rather than swallowing it', async () => {
    const { platform } = fake({
      discard: vi.fn(async () => {
        throw new Error('the file is busy')
      }),
    })
    const result = await exportAudiobook(platform, request())
    expect(result.chapters, 'the export still succeeded').toBe(2)
    expect(result.leftBehind, 'both chapter files; the directory itself still went').toBe(2)
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
      render: vi.fn(async () => {
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
      discard: vi.fn(async (path) => {
        if (path === '/tmp/book.m4b') throw new Error('the book is open elsewhere')
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

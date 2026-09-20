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
    expect(result).toEqual({ path: '/tmp/book.m4b', durationMs: 1234, chapters: 2 })
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
    const { platform } = fake()
    await expect(
      exportAudiobook(platform, request({ cancelled: () => platform.package !== undefined }))
    ).rejects.toBeInstanceOf(ExportCancelled)
    expect(platform.render).not.toHaveBeenCalled()
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

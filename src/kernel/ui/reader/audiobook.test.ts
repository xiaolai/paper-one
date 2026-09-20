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
  const platform: AudiobookPlatform = {
    render: vi.fn(async (job) => {
      rendered.push(job.path)
    }),
    package: vi.fn(async () => ({ durationMs: 1234, chapters: 2 })),
    scratchFor: (index) => `/tmp/ch-${index}.wav`,
    discard: vi.fn(async (path) => {
      discarded.push(path)
    }),
    ...overrides,
  }
  return { platform, rendered, discarded }
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

  it('does not name a scratch file a failed render never wrote', async () => {
    /* Recorded before the render resolved, a throw would leave a path in the
       list that holds nothing — and packaging would then fail on a file it was
       told to expect, blaming the wrong step. */
    const { platform, discarded } = fake({
      render: vi.fn(async (job) => {
        if (job.path.endsWith('ch-1.wav')) throw new Error('the engine went quiet')
      }),
    })
    await expect(exportAudiobook(platform, request())).rejects.toThrow(/went quiet/u)
    expect(discarded).toEqual(['/tmp/ch-0.wav'])
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

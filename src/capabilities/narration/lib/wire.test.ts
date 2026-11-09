import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refusalOf } from '../../../kernel/testkit'
import type { RenderedFile, SpeechFileRequest, SpeechRequest, SpokenClip, VoicePack } from '../../../kernel'
import {
  narrationPlatform,
  narrationSupported,
  pickDestination,
  releaseDestination,
  safeFileName,
  type NarrationEngine,
} from './wire'

/* THE COMMAND BRIDGE, and nothing else, is replaced. Every command this module
   sends is recorded with its arguments, because what it asks the plugin — which
   run, which token, which chapter — is the whole of what it does; and each
   command answers what the test says it does. */
const tauri = vi.hoisted(() => ({
  invoked: [] as [string, unknown][],
  answers: new Map<string, unknown>(),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: unknown) => {
    tauri.invoked.push([command, args])
    const answer = tauri.answers.get(command)
    if (answer instanceof Error) throw answer
    return answer
  },
}))

const BEGUN = { run: 'run-1', chapterPrefix: '/scratch/chapter-' }

beforeEach(() => {
  tauri.invoked = []
  tauri.answers = new Map<string, unknown>([['plugin:narration|narration_begin', BEGUN]])
  leases.length = 0
  holdAnswers = null
  rendered.length = 0
})

const PACK: VoicePack = {
  id: 'english-kokoro',
  name: 'English',
  summary: '',
  family: 'kokoro',
  languages: ['en'],
  bytes: 1,
  minimumMemoryGb: 4,
  voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
  installed: true,
}

const CLIP: SpokenClip = {
  stem: 'book_a-3-abc',
  path: '/data/audio/clips/book_a-3-abc.wav',
  bytes: 48_044,
  sampleRate: 24_000,
  durationMs: 1000,
  words: [],
  skipped: [],
}

const JOB = {
  text: 'Call me Ishmael.',
  voice: 'kokoro:af_heart',
  rate: 1.25,
  path: '/scratch/chapter-3.wav',
  bookId: 'book:a',
  section: 3,
  textDigest: 'fnv1a64:16:0000000000000001',
}

/** A store with nothing in it, which is what every case wants unless it is about the cache. */
const NO_CLIP = async () => null

/**
 * A recording lease. Every case takes it, so a case that never leases is
 * distinguishable from one that does — which is the whole of what the export's
 * lease is for.
 */
const leases: [readonly string[], boolean][] = []
/** How many names the next hold answers for — `null` means "all of them". */
let holdAnswers: number | null = null
const HOLD = async (stems: readonly string[], hold: boolean) => {
  leases.push([stems, hold])
  return holdAnswers ?? stems.length
}

/** Every chapter the engine was asked to render to a file. */
const rendered: SpeechFileRequest[] = []
let renderAnswer: RenderedFile = { sampleRate: 24_000, skipped: [] }

/** The voices' engine, with the store and the lease the case names. */
function voices(
  findClip: (request: SpeechRequest) => Promise<SpokenClip | null> = NO_CLIP,
  holdClips: (stems: readonly string[], hold: boolean) => Promise<number> = HOLD,
): NarrationEngine {
  return {
    catalogue: async () => [PACK],
    findClip,
    holdClips,
    renderFile: async (request) => {
      rendered.push(request)
      return renderAnswer
    },
  }
}

describe('whether the plugin can package here', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks the plugin inside Tauri, and believes only a boolean', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    tauri.answers.set('plugin:narration|narration_supported', true)
    await expect(narrationSupported()).resolves.toBe(true)
    tauri.answers.set('plugin:narration|narration_supported', false)
    await expect(narrationSupported()).resolves.toBe(false)
    expect(tauri.invoked).toEqual([
      ['plugin:narration|narration_supported', undefined],
      ['plugin:narration|narration_supported', undefined],
    ])

    tauri.answers.set('plugin:narration|narration_supported', 'yes')
    await expect(narrationSupported()).rejects.toThrow(/did not say whether it can package/u)
  })

  it('answers yes without asking where there is no window, or a window outside Tauri', async () => {
    expect(typeof window).toBe('undefined')
    await expect(narrationSupported()).resolves.toBe(true)
    vi.stubGlobal('window', {})
    await expect(narrationSupported()).resolves.toBe(true)
    expect(tauri.invoked).toEqual([])
  })
})

describe('choosing where the book goes', () => {
  it('asks the plugin’s dialog with the book’s own name, and answers the token and the name chosen', async () => {
    tauri.answers.set('plugin:narration|narration_pick', { token: 'destination:1', name: 'Dune Part Two.m4b' })
    await expect(pickDestination('Dune: Part Two')).resolves.toEqual({
      token: 'destination:1',
      name: 'Dune Part Two.m4b',
    })
    expect(tauri.invoked).toEqual([['plugin:narration|narration_pick', { name: 'Dune  Part Two.m4b' }]])
  })

  it('suggests a plain name for a title with nothing a filesystem will take', async () => {
    tauri.answers.set('plugin:narration|narration_pick', null)
    await pickDestination('///')
    expect(tauri.invoked).toEqual([['plugin:narration|narration_pick', { name: 'audiobook.m4b' }]])
  })

  it('answers null when the reader closes the dialog', async () => {
    tauri.answers.set('plugin:narration|narration_pick', null)
    await expect(pickDestination('Dune')).resolves.toBeNull()
  })

  it('refuses a reply that is not a destination, rather than exporting to it', async () => {
    /* The reply crosses the IPC boundary as unknown JSON: a token that is not a
       string would be sent back as one, and a missing name would be the notice. */
    const named = /not a destination/u
    for (const reply of [undefined, 'destination:1', { token: 'destination:1' }, { name: 'a.m4b' }, { token: 1, name: 'a.m4b' }, { token: 'destination:1', name: 2 }]) {
      tauri.answers.set('plugin:narration|narration_pick', reply)
      expect((await refusalOf(pickDestination('Dune'))).message).toMatch(named)
    }
  })

  it('gives a destination back by its token', async () => {
    await releaseDestination('destination:1')
    expect(tauri.invoked).toEqual([['plugin:narration|narration_release', { destination: 'destination:1' }]])
  })
})

describe('the run an export works in', () => {
  it('begins one of its own, and writes each chapter where the plugin said', async () => {
    /* ⚠️ ONE PER EXPORT, and THE PLUGIN MAKES IT: two exports in a shared
       directory wrote over each other's chapters, and a path the window built
       would be a path the plugin had to trust. */
    const platform = await narrationPlatform([PACK], voices())
    expect(tauri.invoked).toEqual([['plugin:narration|narration_begin', undefined]])
    expect(platform.scratchFor(3)).toBe('/scratch/chapter-3.wav')
  })

  it('refuses a reply that is not a run, rather than writing chapters nowhere', async () => {
    const named = /could not begin/u
    for (const reply of [undefined, 'run-1', { run: 'run-1' }, { chapterPrefix: '/scratch/chapter-' }, { run: 1, chapterPrefix: '/s/' }]) {
      tauri.answers.set('plugin:narration|narration_begin', reply)
      expect((await refusalOf(narrationPlatform([PACK], voices()))).message).toMatch(named)
    }
  })

  it('removes a chapter by its index in the run, and the run by its name', async () => {
    const platform = await narrationPlatform([], voices())
    tauri.invoked = []
    await platform.discard(4)
    await platform.discardScratch()
    expect(tauri.invoked).toEqual([
      ['plugin:narration|narration_discard_chapter', { run: 'run-1', index: 4 }],
      ['plugin:narration|narration_discard', { run: 'run-1' }],
    ])
  })
})

describe('packaging', () => {
  const job = {
    chapters: [
      { title: 'One', source: { kind: 'scratch', index: 0 } },
      { title: 'Two', source: { kind: 'clip', path: CLIP.path } },
    ] as const,
    title: 'Moby-Dick',
    author: 'Melville',
    destination: 'destination:1',
  }

  it('sends the run, the token and the chapters, and answers the book the plugin wrote', async () => {
    const platform = await narrationPlatform([PACK], voices())
    tauri.invoked = []
    tauri.answers.set('plugin:narration|narrate_package', { name: 'Moby-Dick.m4b', durationMs: 60_000, chapters: 2 })
    await expect(platform.package(job)).resolves.toEqual({ name: 'Moby-Dick.m4b', durationMs: 60_000, chapters: 2 })
    expect(tauri.invoked).toEqual([['plugin:narration|narrate_package', { run: 'run-1', ...job }]])
  })

  it('refuses a reply that is not a book, rather than reporting one', async () => {
    const platform = await narrationPlatform([PACK], voices())
    const named = /not a book/u
    for (const reply of [
      undefined,
      { durationMs: 1, chapters: 1 },
      { name: 'a.m4b', chapters: 1 },
      { name: 'a.m4b', durationMs: 1 },
      { name: 1, durationMs: 1, chapters: 1 },
      { name: 'a.m4b', durationMs: '1', chapters: 1 },
      { name: 'a.m4b', durationMs: 1, chapters: '1' },
    ]) {
      tauri.answers.set('plugin:narration|narrate_package', reply)
      expect((await refusalOf(platform.package(job))).message).toMatch(named)
    }
  })
})

describe('the lease, the destination, and the book', () => {
  /** An engine holding one cached chapter, with its lease already taken. */
  async function holding() {
    const platform = await narrationPlatform([PACK], voices(async () => CLIP))
    await platform.render(JOB)
    leases.length = 0
    return platform
  }

  it('gives a lease back by the clip’s NAME, for the path the packer was given', async () => {
    /* The export speaks in paths and the store's key is the name, so the mapping
       is the whole of what this does — and a release that sent the PATH would be
       refused by the store as a stem it never wrote. */
    const platform = await holding()
    await platform.releaseClips([CLIP.path])
    expect(leases).toEqual([[['book_a-3-abc'], false]])
  })

  it('asks for nothing where no path it is given holds a lease', async () => {
    /* A scratch chapter is this export's own file and was never leased, so a
       release naming one is a command round trip for a question with no subject —
       and the store would answer zero, which reads as a lease that had gone. */
    const platform = await holding()
    await platform.releaseClips(['/scratch/chapter-9.wav'])
    expect(leases, 'the store was not asked at all').toEqual([])
  })

  it('sends only the paths that hold one, where a list mixes them', async () => {
    const platform = await holding()
    await platform.releaseClips(['/scratch/chapter-9.wav', CLIP.path])
    expect(leases).toEqual([[['book_a-3-abc'], false]])
  })

  it('forgets a lease once it is given back, so a second release asks nothing', async () => {
    /* ⚠️ **THE MAP IS NOT CLEARED BY THE STORE.** An export that released and then
       failed would otherwise release the same name twice — harmless at the store,
       which is idempotent, and a lie in anything counting what this export holds. */
    const platform = await holding()
    await platform.releaseClips([CLIP.path])
    leases.length = 0
    await platform.releaseClips([CLIP.path])
    expect(leases).toEqual([])
  })

  it('takes the lease when it answers for a cached chapter, and not otherwise', async () => {
    const platform = await narrationPlatform([PACK], voices(async () => CLIP))
    await platform.render(JOB)
    expect(leases, 'held before it was answered for').toEqual([[['book_a-3-abc'], true]])
    /* AND THE MAP REMEMBERS IT, which is what makes the release above possible. */
    leases.length = 0
    await platform.releaseClips([CLIP.path])
    expect(leases).toEqual([[['book_a-3-abc'], false]])
  })

  it('removes the book by its token, through the plugin that holds the path', async () => {
    /* ⚠️ **NOT THROUGH `discard`, WHICH IS SCOPED TO THE RUN.** The authority for
       this one is the save dialog, which the plugin ran, so the window names the
       token and never the path. */
    const platform = await narrationPlatform([PACK], voices())
    tauri.invoked = []
    await platform.discardBook('destination:1')
    expect(tauri.invoked).toEqual([['plugin:narration|narration_discard_book', { destination: 'destination:1' }]])
  })

  it('asks the plugin whether the destination is already there', async () => {
    /* The answer decides whether a stop during the join removes the book or keeps
       it, so a question asked of nothing would silently take the removing side. */
    const platform = await narrationPlatform([PACK], voices())
    tauri.invoked = []
    tauri.answers.set('plugin:narration|narration_exists', true)
    await expect(platform.exists('destination:1')).resolves.toBe(true)
    tauri.answers.set('plugin:narration|narration_exists', false)
    await expect(platform.exists('destination:1')).resolves.toBe(false)
    expect(tauri.invoked).toEqual([
      ['plugin:narration|narration_exists', { destination: 'destination:1' }],
      ['plugin:narration|narration_exists', { destination: 'destination:1' }],
    ])
  })

  it('refuses an answer about the destination that is not a yes or a no', async () => {
    /* A missing answer read as "not there" would remove the book the reader
       already had, which is the side a doubt must never take. */
    const platform = await narrationPlatform([PACK], voices())
    tauri.answers.set('plugin:narration|narration_exists', undefined)
    expect((await refusalOf(platform.exists('destination:1'))).message).toMatch(/could not say/u)
  })
})

/**
 * ⚠️ **EVERY CASE HERE CAME BACK UNCHANGED BEFORE THE FIX, AND WINDOWS REFUSES
 * EVERY ONE OF THEM.** The function's own comment claimed "any platform this
 * ships to" while it handled POSIX only; the export being macOS-gated is why
 * nothing noticed. These are the seven names a refutation pass ran through it.
 */
describe('safeFileName', () => {
  it('replaces every character Windows forbids, not only the POSIX ones', () => {
    expect(safeFileName('Why?')).toBe('Why')
    expect(safeFileName('a*b')).toBe('a b')
    expect(safeFileName('a|b')).toBe('a b')
    expect(safeFileName('a"b')).toBe('a b')
    expect(safeFileName('a<b>')).toBe('a b')
  })

  it('still replaces the separators, which is what it was written for', () => {
    expect(safeFileName('Vol/2')).toBe('Vol 2')
    expect(safeFileName('Vol\\2')).toBe('Vol 2')
    expect(safeFileName('Dune: Part Two')).toBe('Dune  Part Two')
  })

  it('suffixes a reserved device name rather than replacing the title', () => {
    /* A book called `Con` is not far-fetched, and the dialog's refusal explains
       nothing. The reader should still recognise their own title in it. */
    expect(safeFileName('CON')).toBe('CON (book)')
    expect(safeFileName('nul')).toBe('nul (book)')
    expect(safeFileName('Com4')).toBe('Com4 (book)')
    expect(safeFileName('LPT9')).toBe('LPT9 (book)')
  })

  it('leaves a title that merely starts with a device name alone', () => {
    expect(safeFileName('Conrad')).toBe('Conrad')
    expect(safeFileName('Auxiliary Verbs')).toBe('Auxiliary Verbs')
  })

  it('drops a trailing dot, which Windows strips without saying so', () => {
    /* The file would then be named differently from the suggestion the reader
       accepted, which is the kind of difference nobody can diagnose. */
    expect(safeFileName('Vol. 2.')).toBe('Vol. 2')
    expect(safeFileName('Hmm...')).toBe('Hmm')
  })

  it('drops a trailing dot the truncation itself created', () => {
    /* ⚠️ **THE ORDER IS LOAD-BEARING.** Cutting to the byte budget can CREATE a
       trailing dot, so a trim done before it would not see one. */
    const budget = 255 - '.m4b'.length - ' (book)'.length
    const title = `${'a'.repeat(budget - 1)}.tail`
    expect(safeFileName(title)).toBe('a'.repeat(budget - 1))
  })

  it('strips a leading dot that leading whitespace was hiding', () => {
    /* ⚠️ **THE DOTS USED TO GO FIRST**, so the space hid them from the dot rule
       and the later trim exposed `.hidden` — a hidden file, which is the one thing
       that rule exists to prevent. */
    expect(safeFileName(' .hidden')).toBe('hidden')
    expect(safeFileName('\t\n ..Vol 2')).toBe('Vol 2')
  })

  it('budgets in BYTES, not UTF-16 code units', () => {
    /* ⚠️ **120 CJK CHARACTERS ARE 360 UTF-8 BYTES** — past what a path component
       may hold, and most of the books this reader is for. The old `slice(0, 120)`
       measured neither the filesystem's unit nor the reader's. */
    const budget = 255 - '.m4b'.length - ' (book)'.length
    const name = safeFileName('第'.repeat(200))
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(budget)
    expect(name.length).toBeGreaterThan(20)
  })

  it('never cuts a character in half', () => {
    /* A lone surrogate is an invalid name and an unreadable one. Cut by grapheme,
       so a family emoji and a combining accent survive whole too. */
    const name = safeFileName('👨\u200d👩\u200d👧\u200d👦'.repeat(60))
    expect(name).not.toMatch(/[\uD800-\uDFFF]/u)
    for (const ch of name) expect(ch.codePointAt(0)).toBeDefined()
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(244)
  })

  it('keeps a non-Latin title exactly as it is', () => {
    expect(safeFileName('第三章')).toBe('第三章')
  })

  it('strips control characters and a leading dot', () => {
    expect(safeFileName('a\u0007b')).toBe('ab')
    expect(safeFileName('...hidden')).toBe('hidden')
  })

  it('answers empty for a title made only of forbidden characters', () => {
    /* `pickDestination` falls back to `audiobook` on an empty answer, so
       this must be empty rather than a string of spaces. */
    expect(safeFileName('???')).toBe('')
    expect(safeFileName('   ')).toBe('')
  })
})

describe('safeFileName, at the edges of its rules', () => {
  it('leaves a title that merely ENDS with a device name alone', () => {
    /* Only the whole name is reserved: `Falcon` is not `con`. */
    expect(safeFileName('Falcon')).toBe('Falcon')
    expect(safeFileName('Reconquista')).toBe('Reconquista')
  })

  it('suffixes a device name at any extension, however long', () => {
    /* Windows refuses `nul.tar.gz` as it refuses `nul`. */
    expect(safeFileName('nul.tar.gz')).toBe('nul.tar.gz (book)')
  })

  it('fills the byte budget exactly, keeping a character that lands on its last byte', () => {
    /* 255 bytes for a component, less `.m4b` and ` (book)`: 244. A title one
       byte longer loses its last character, and only that. */
    const budget = 255 - '.m4b'.length - ' (book)'.length
    expect(safeFileName(`${'a'.repeat(budget)}b`)).toBe('a'.repeat(budget))
    expect(new TextEncoder().encode(safeFileName('a'.repeat(budget))).length).toBe(budget)
  })
})

describe('rendering a chapter', () => {
  it('renders through the pack that holds the voice, into the scratch it was given', async () => {
    /* ⚠️ **THE VOICE'S SHAPE IS THE ROUTING, AND THE FAMILY IS NOT THE PACK
     * ID.** A reader's choice is stored by FAMILY, because that outlives a
     * re-cut pack; the engine wants the id. Resolving the one to the other is
     * this function's job, and it is the only place both are in hand. */
    const platform = await narrationPlatform([PACK], voices())
    await expect(platform.render({ ...JOB, rate: 1 })).resolves.toEqual({
      path: '/scratch/chapter-3.wav',
      cached: false,
      skipped: [],
    })
    expect(rendered).toEqual([
      { packId: 'english-kokoro', voiceId: 'af_heart', text: 'Call me Ishmael.', rate: 1, path: '/scratch/chapter-3.wav' },
    ])
  })

  it('falls back to the family as the pack when no installed pack holds the voice', async () => {
    /* ⚠️ **THE `find` MUST BE THE ONE THAT DECIDES, AND IT MUST BE ALLOWED TO
     * FAIL.** A pack list that holds a DIFFERENT family is the case that
     * separates a real match from any match: matching anything would render
     * the Chinese voice through the English pack, and reading the `id` of a
     * match that is not there throws in the middle of an export. The family is
     * a usable pack id for a plugin that knows it, so it is the honest
     * fallback rather than a refusal. */
    const platform = await narrationPlatform([PACK], voices())
    await expect(
      platform.render({ text: '春天', voice: 'qwen:Vivian', rate: 1, path: '/x.wav', bookId: 'book:a', section: 0, textDigest: 'fnv1a64:1:0000000000000001' }),
    ).resolves.toEqual({ path: '/x.wav', cached: false, skipped: [] })
    expect(rendered).toEqual([{ packId: 'qwen', voiceId: 'Vivian', text: '春天', rate: 1, path: '/x.wav' }])
  })

  it('passes on what the engine could not say', async () => {
    /* The count the reader is told comes from here, so a render that dropped
       what the engine reported would claim the book was whole. */
    renderAnswer = { sampleRate: 24_000, skipped: [{ text: 'Coenties', why: 'no pronunciation' }] }
    const platform = await narrationPlatform([PACK], voices())
    await expect(platform.render(JOB)).resolves.toEqual({
      path: '/scratch/chapter-3.wav',
      cached: false,
      skipped: [{ text: 'Coenties', why: 'no pronunciation' }],
    })
    renderAnswer = { sampleRate: 24_000, skipped: [] }
  })

  it('refuses a platform voice rather than rendering in one', async () => {
    /* ⚠️ THERE IS NOWHERE TO SEND IT. `narrate_render` over AVSpeechSynthesizer
     * was deleted in phase 30 — every voice it reached on a Mac is below the
     * floor the reading refuses — so a job carrying a Web Speech identifier is
     * a caller that has not asked the packs. */
    const platform = await narrationPlatform([], voices())
    const job = { ...JOB, voice: 'com.apple.voice.enhanced.en-US.Zoe' }
    expect((await refusalOf(platform.render(job))).message).toMatch(/not a downloaded voice/u)
    expect(rendered).toEqual([])
  })
})

describe('asking the rendered reading before rendering again', () => {
  it('uses the clip and renders nothing where one is already there', async () => {
    /* ⚠️ WI-34.4, measured rather than asserted in a comment: a chapter the
       reader has listened to costs the export nothing but the muxing. */
    const asked: unknown[] = []
    const platform = await narrationPlatform(
      [PACK],
      voices(async (request) => {
        asked.push(request)
        return { ...CLIP, skipped: [{ text: 'Coenties', why: 'no pronunciation' }] }
      }),
    )
    await expect(platform.render(JOB)).resolves.toEqual({
      path: '/data/audio/clips/book_a-3-abc.wav',
      cached: true,
      skipped: [{ text: 'Coenties', why: 'no pronunciation' }],
    })
    expect(rendered, 'the engine is not asked at all').toEqual([])
    expect(leases, 'and the clip is held before it is answered for').toEqual([[['book_a-3-abc'], true]])
    expect(asked).toEqual([
      {
        packId: 'english-kokoro',
        voiceId: 'af_heart',
        text: 'Call me Ishmael.',
        rate: 1.25,
        clip: { bookId: 'book:a', section: 3, textDigest: 'fnv1a64:16:0000000000000001' },
      },
    ])
  })

  it('renders the chapter where the clip has gone between the find and the hold', async () => {
    /* ⚠️ **THE FIND AND THE HOLD ARE TWO COMMANDS, AND *FORGET THEM* FITS
       BETWEEN THEM — FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** The earlier
       version set the lease and answered `cached: true` without reading what the
       hold said, so the export named a path that held nothing and the packer
       failed on a missing file — which reads as a broken export rather than as
       the race it is.

       `voices_clip_hold` answers how many names it MOVED, so 0 is the store
       saying *that clip is not here any more*. This is the one case that proves
       the number is read at all. */
    holdAnswers = 0
    const platform = await narrationPlatform([PACK], voices(async () => CLIP))
    await expect(platform.render(JOB)).resolves.toEqual({
      path: '/scratch/chapter-3.wav',
      cached: false,
      skipped: [],
    })
    expect(leases, 'it did ask').toEqual([[['book_a-3-abc'], true]])
    expect(rendered.map((one) => one.path), 'and then rendered it').toEqual(['/scratch/chapter-3.wav'])
  })

  it('renders the chapter where the hold answers for more than the one clip', async () => {
    /* One name was asked about, so any answer but one is a store that is not
       answering this question — and a lease the export cannot account for. */
    holdAnswers = 2
    const platform = await narrationPlatform([PACK], voices(async () => CLIP))
    await expect(platform.render(JOB)).resolves.toEqual({
      path: '/scratch/chapter-3.wav',
      cached: false,
      skipped: [],
    })
  })

  it('renders the chapter where the hold itself refuses', async () => {
    /* A store that will not answer at all is the same outcome for the export as
       one that answers zero: the chapter cannot be relied on, so it is rendered.
       Separate from the case above because a REJECTION and a zero arrive by
       different roads, and only one of them was ever going to be handled. */
    const platform = await narrationPlatform(
      [PACK],
      voices(
        async () => CLIP,
        async () => {
          throw new Error('the store would not answer')
        },
      ),
    )
    await expect(platform.render(JOB)).resolves.toEqual({
      path: '/scratch/chapter-3.wav',
      cached: false,
      skipped: [],
    })
  })

  it('renders to its own scratch on a miss, and not into the store', async () => {
    /* ⚠️ **A TEN-HOUR BOOK IS 6.2 GB AGAINST A 5 GB BUDGET.** An export that
       filled the store would evict its own earlier chapters before the muxer read
       them — a book missing its first half, or a packer failing on a file it was
       told to expect. The store holds what a reader has HEARD. */
    const platform = await narrationPlatform([PACK], voices())
    await expect(platform.render(JOB)).resolves.toEqual({
      path: '/scratch/chapter-3.wav',
      cached: false,
      skipped: [],
    })
    expect(leases, 'nothing was held for a chapter that was not there').toEqual([])
    expect(rendered).toEqual([
      { packId: 'english-kokoro', voiceId: 'af_heart', text: 'Call me Ishmael.', rate: 1.25, path: '/scratch/chapter-3.wav' },
    ])
  })

  it('does not ask the store for a voice that is not a downloaded one', async () => {
    /* The refusal comes first: a platform identifier is a caller that has not
       asked the packs, and asking the store about it would be a round trip for a
       question that cannot have an answer. */
    const asked: unknown[] = []
    const platform = await narrationPlatform(
      [PACK],
      voices(async (request) => {
        asked.push(request)
        return null
      }),
    )
    expect((await refusalOf(platform.render({ ...JOB, voice: 'com.apple.voice.compact.en-US.Samantha' }))).message).toMatch(
      /is not a downloaded voice/u,
    )
    expect(asked).toEqual([])
    expect(rendered).toEqual([])
  })
})

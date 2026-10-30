import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseAudiobookPath, safeFileName, skippedOf, tauriAudiobook } from './audiobookTauri'

/* THE FOUR TAURI MODULES, and nothing else, are replaced: the dialog, the
   command bridge, the app-data path and the filesystem plugin. Each records what
   it was asked, because what this module asks them — which directory, under
   which base, with which options — is the whole of what it does. */
const tauri = vi.hoisted(() => ({
  APP_DATA: 'base:AppData',
  dialogAnswer: null as string | null,
  dialogs: [] as unknown[],
  invoked: [] as [string, unknown][],
  invokeAnswer: undefined as unknown,
  made: [] as [string, unknown][],
  removed: [] as [string, unknown][],
  listed: [] as [string, unknown][],
  listing: [] as { name: string; isDirectory: boolean }[] | Error,
  refuse: new Set<string>(),
  /** What the filesystem says about the reader's chosen destination. */
  exists: false,
  /** Every path `exists` was asked about. */
  asked: [] as string[],
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: async (options: unknown) => {
    tauri.dialogs.push(options)
    return tauri.dialogAnswer
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: unknown) => {
    tauri.invoked.push([command, args])
    return tauri.invokeAnswer
  },
}))
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/data/one.paper.reader',
  join: async (...parts: string[]) => parts.join('/'),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: tauri.APP_DATA },
  mkdir: async (path: string, options: unknown) => {
    tauri.made.push([path, options])
  },
  readDir: async (path: string, options: unknown) => {
    tauri.listed.push([path, options])
    if (tauri.listing instanceof Error) throw tauri.listing
    return tauri.listing
  },
  remove: async (path: string, options: unknown) => {
    tauri.removed.push([path, options])
    if (tauri.refuse.has(path)) throw new Error(`cannot remove ${path}`)
  },
  exists: async (path: string) => {
    tauri.asked.push(path)
    return tauri.exists
  },
}))

/**
 * ⚠️ **EVERY CASE HERE CAME BACK UNCHANGED BEFORE THE FIX, AND WINDOWS REFUSES
 * EVERY ONE OF THEM.** The function's own comment claimed "any platform this
 * ships to" while it handled POSIX only; the export being macOS-gated is why
 * nothing noticed. These are the seven names a refutation pass ran through it.
 */
/**
 * A store with nothing in it, which is what every case here wants unless it is
 * about the cache.
 *
 * ⚠️ **NOT A DEFAULT ON `tauriAudiobook` ITSELF.** A default no caller in the app
 * takes is a value only a test can choose, and no test can tell one function that
 * answers null from another — so it would be an unkillable mutant standing in
 * front of a decision worth making at the call site.
 */
const NO_CLIP = async () => null

/**
 * A recording lease. Every call site takes it, so a case that never leases is
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

describe('the lease, the destination, and the two path operations', () => {
  /* ⚠️ **`releaseClips`, `discardBook` AND `exists` HAD NO CASE AT ALL — FOUND BY
     THE MUTATION SWEEP, which reported sixteen added survivors across them.** Each
     is one line of mapping over an authority that differs from its neighbour's, and
     every defect in them type-checks: a lease given back for the wrong name, a
     destination removed through the scoped operation that cannot reach it, a
     question about the reader's own file asked of nothing at all. */
  const pack = {
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
  const clip = {
    stem: 'book_a-3-abc',
    path: '/data/audio/clips/book_a-3-abc.wav',
    bytes: 48_044,
    sampleRate: 24_000,
    durationMs: 1000,
    words: [],
    skipped: [],
  }
  const job = {
    text: 'Call me Ishmael.',
    voice: 'kokoro:af_heart',
    rate: 1.25,
    path: '/scratch/chapter-3.wav',
    bookId: 'book:a',
    section: 3,
    textDigest: 'fnv1a64:16:0000000000000001',
  }

  /** An engine holding one cached chapter, with its lease already taken. */
  async function holding() {
    const engine = await tauriAudiobook([pack], async () => clip, HOLD)
    await engine.render(job)
    leases.length = 0
    return engine
  }

  it('gives a lease back by the clip’s NAME, for the path the packer was given', async () => {
    /* The export speaks in paths and the store's key is the name, so the mapping
       is the whole of what this does — and a release that sent the PATH would be
       refused by the store as a stem it never wrote. */
    const engine = await holding()
    await engine.releaseClips([clip.path])
    expect(leases).toEqual([[['book_a-3-abc'], false]])
  })

  it('asks for nothing where no path it is given holds a lease', async () => {
    /* A scratch chapter is this export's own file and was never leased, so a
       release naming one is a command round trip for a question with no subject —
       and the store would answer zero, which reads as a lease that had gone. */
    const engine = await holding()
    await engine.releaseClips(['/scratch/chapter-9.wav'])
    expect(leases, 'the store was not asked at all').toEqual([])
  })

  it('sends only the paths that hold one, where a list mixes them', async () => {
    const engine = await holding()
    await engine.releaseClips(['/scratch/chapter-9.wav', clip.path])
    expect(leases).toEqual([[['book_a-3-abc'], false]])
  })

  it('forgets a lease once it is given back, so a second release asks nothing', async () => {
    /* ⚠️ **THE MAP IS NOT CLEARED BY THE STORE.** An export that released and then
       failed would otherwise release the same name twice — harmless at the store,
       which is idempotent, and a lie in anything counting what this export holds. */
    const engine = await holding()
    await engine.releaseClips([clip.path])
    leases.length = 0
    await engine.releaseClips([clip.path])
    expect(leases).toEqual([])
  })

  it('takes the lease when it answers for a cached chapter, and not otherwise', async () => {
    const engine = await tauriAudiobook([pack], async () => clip, HOLD)
    await engine.render(job)
    expect(leases, 'held before it was answered for').toEqual([[['book_a-3-abc'], true]])
    /* AND THE MAP REMEMBERS IT, which is what makes the release above possible. */
    leases.length = 0
    await engine.releaseClips([clip.path])
    expect(leases).toEqual([[['book_a-3-abc'], false]])
  })

  it('removes the book at the reader’s own path, whole and absolute', async () => {
    /* ⚠️ **NOT THROUGH `discard`, WHICH IS SCOPED TO `$APPDATA`.** The authority
       for this one is the save dialog, which granted exactly this path — so it is
       passed unchanged rather than reduced to a basename under the app's root. */
    /* A VOLUME RATHER THAN A HOME DIRECTORY, because the commit guard warns on an
       absolute `/Users/<name>/…` in added lines — rightly, since that is the shape
       a real path leaks in. What this case needs is only an absolute path OUTSIDE
       `$APPDATA`, and a volume is one. */
    const engine = await tauriAudiobook([pack], NO_CLIP, HOLD)
    await engine.discardBook('/Volumes/Archive/Moby-Dick.m4b')
    expect(tauri.removed).toEqual([['/Volumes/Archive/Moby-Dick.m4b', undefined]])
  })

  it('asks the filesystem whether the destination is already there', async () => {
    /* The answer decides whether a stop during the join removes the book or keeps
       it, so a question asked of nothing would silently take the removing side. */
    const engine = await tauriAudiobook([pack], NO_CLIP, HOLD)
    tauri.exists = true
    await expect(engine.exists('/Volumes/Archive/Moby-Dick.m4b')).resolves.toBe(true)
    tauri.exists = false
    await expect(engine.exists('/Volumes/Archive/Moby-Dick.m4b')).resolves.toBe(false)
    expect(tauri.asked).toEqual([
      '/Volumes/Archive/Moby-Dick.m4b',
      '/Volumes/Archive/Moby-Dick.m4b',
    ])
  })
})

describe('reading the skips out of a chapter render', () => {
  /* The reply crosses the IPC boundary as unknown JSON, and the export reads it
     AFTER the chapter has been written — the most expensive moment there is to
     throw on a shape. So: absent is none, present-and-wrong is refused by name.
     The same rule this repository states for every store it reads back. */
  it('takes an absent list as none, which is every older build', () => {
    expect(skippedOf({ sampleRate: 24_000 })).toEqual([])
    expect(skippedOf({ sampleRate: 24_000, skipped: null })).toEqual([])
    expect(skippedOf(undefined), 'and a reply that is no object at all').toEqual([])
    expect(skippedOf(42)).toEqual([])
  })

  it('reads what is there', () => {
    expect(
      skippedOf({ sampleRate: 24_000, skipped: [{ text: 'Coenties', why: 'no pronunciation' }] }),
    ).toEqual([{ text: 'Coenties', why: 'no pronunciation' }])
    expect(skippedOf({ skipped: [] })).toEqual([])
  })

  it('refuses a list that is not one, rather than counting it', () => {
    expect(() => skippedOf({ skipped: 'Coenties' })).toThrow(/skip list that is not one/u)
    expect(() => skippedOf({ skipped: { text: 'a', why: 'b' } })).toThrow(/skip list that is not one/u)
  })

  it('refuses a skip that names neither the text nor the reason', () => {
    const named = /names neither text nor reason/u
    expect(() => skippedOf({ skipped: [null] })).toThrow(named)
    expect(() => skippedOf({ skipped: ['Coenties'] })).toThrow(named)
    expect(() => skippedOf({ skipped: [{ text: 'Coenties' }] })).toThrow(named)
    expect(() => skippedOf({ skipped: [{ why: 'no pronunciation' }] })).toThrow(named)
    /* One good beside one bad refuses the chapter: a partial count is worse than
       a refusal, because it is a number the reader would believe. */
    expect(() => skippedOf({ skipped: [{ text: 'a', why: 'b' }, null] })).toThrow(named)
  })
})

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
    /* `chooseAudiobookPath` falls back to `audiobook` on an empty answer, so
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

const NOW = 1_789_992_000_000
const HOUR = 60 * 60 * 1000
/** What `tauriAudiobook` names its run, for `NOW` and a random draw of 0.123456789. */
const RUN = `run-${NOW.toString(36)}-4fzzzx`
const RUN_DIR = `audiobook/${RUN}`

/** A run directory made `ago` milliseconds before `NOW`. */
const runMade = (ago: number) => `run-${(NOW - ago).toString(36)}-abcdef`

beforeEach(() => {
  tauri.dialogAnswer = null
  tauri.dialogs = []
  tauri.invoked = []
  tauri.invokeAnswer = undefined
  tauri.made = []
  tauri.removed = []
  tauri.listed = []
  tauri.listing = []
  tauri.refuse = new Set()
  tauri.exists = false
  tauri.asked = []
  leases.length = 0
  holdAnswers = null
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('choosing where the book goes', () => {
  it('asks with the book’s own name, as an audiobook, and answers what the reader chose', async () => {
    tauri.dialogAnswer = '/books/Dune Part Two.m4b'
    await expect(chooseAudiobookPath('Dune: Part Two')).resolves.toBe('/books/Dune Part Two.m4b')
    expect(tauri.dialogs).toEqual([
      {
        title: 'Export as audiobook',
        defaultPath: 'Dune  Part Two.m4b',
        filters: [{ name: 'Audiobook', extensions: ['m4b'] }],
      },
    ])
  })

  it('suggests a plain name for a title with nothing a filesystem will take', async () => {
    await chooseAudiobookPath('///')
    expect(tauri.dialogs).toEqual([expect.objectContaining({ defaultPath: 'audiobook.m4b' })])
  })

  it('answers null when the reader closes the dialog', async () => {
    await expect(chooseAudiobookPath('Dune')).resolves.toBeNull()
  })
})

describe('the engine an export runs on', () => {
  it('makes a directory of its own for this export, under the app’s data', async () => {
    /* ⚠️ ONE PER EXPORT: under a shared directory two exports wrote over each
       other's chapters and deleted each other's files. The name carries the
       clock, for the sweep, and six random characters, for two exports in one
       millisecond. */
    await tauriAudiobook([], NO_CLIP, HOLD)
    expect(tauri.made).toEqual([[RUN_DIR, { baseDir: tauri.APP_DATA, recursive: true }]])
  })

  it('writes each chapter in that directory, by absolute path, for the engine', async () => {
    const engine = await tauriAudiobook([], NO_CLIP, HOLD)
    expect(engine.scratchFor(3)).toBe(`/data/one.paper.reader/${RUN_DIR}/chapter-3.wav`)
  })

  it('renders through the pack that holds the voice, and packages through narrate', async () => {
    /* ⚠️ **THE VOICE'S SHAPE IS THE ROUTING, AND THE FAMILY IS NOT THE PACK
     * ID.** A reader's choice is stored by FAMILY, because that outlives a
     * re-cut pack; the command wants the id. Resolving the one to the other is
     * this function's job, and it is the only place both are in hand. */
    const pack = {
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
    const engine = await tauriAudiobook([pack], NO_CLIP, HOLD)
    const job = { text: 'Call me Ishmael.', voice: 'kokoro:af_heart', rate: 1, path: '/x.wav', bookId: 'book:a', section: 0, textDigest: 'fnv1a64:1:0000000000000001' }
    await engine.render(job)
    tauri.invokeAnswer = { durationMs: 60_000, chapters: 1 }
    const packaged = { chapters: [{ title: 'One', path: '/x.wav' }], title: 'Moby-Dick', author: 'Melville', path: '/m.m4b' }
    await expect(engine.package(packaged)).resolves.toEqual({ durationMs: 60_000, chapters: 1 })
    expect(tauri.invoked).toEqual([
      [
        'plugin:voices|voices_render_file',
        { pack: 'english-kokoro', voice: 'af_heart', text: 'Call me Ishmael.', rate: 1, path: '/x.wav' },
      ],
      ['narrate_package', packaged],
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
    const pack = {
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
    const engine = await tauriAudiobook([pack], NO_CLIP, HOLD)
    await expect(
      engine.render({ text: '春天', voice: 'qwen:Vivian', rate: 1, path: '/x.wav', bookId: 'book:a', section: 0, textDigest: 'fnv1a64:1:0000000000000001' }),
    ).resolves.toEqual({ path: '/x.wav', cached: false, skipped: [] })
    expect(tauri.invoked).toEqual([
      ['plugin:voices|voices_render_file', { pack: 'qwen', voice: 'Vivian', text: '春天', rate: 1, path: '/x.wav' }],
    ])
  })

  it('refuses a platform voice rather than rendering in one', async () => {
    /* ⚠️ THERE IS NOWHERE TO SEND IT. `narrate_render` over AVSpeechSynthesizer
     * was deleted in phase 30 — every voice it reached on a Mac is below the
     * floor the reading refuses — so a job carrying a Web Speech identifier is
     * a caller that has not asked the packs. */
    const engine = await tauriAudiobook([], NO_CLIP, HOLD)
    const job = { text: 'Call me Ishmael.', voice: 'com.apple.voice.enhanced.en-US.Zoe', rate: 1, path: '/x.wav', bookId: 'book:a', section: 0, textDigest: 'fnv1a64:1:0000000000000001' }
    await expect(engine.render(job)).rejects.toThrow(/not a downloaded voice/)
    expect(tauri.invoked).toEqual([])
  })

  it('removes a chapter by its name under the granted root, whatever separator its path used', async () => {
    const engine = await tauriAudiobook([], NO_CLIP, HOLD)
    await engine.discard(`/data/one.paper.reader/${RUN_DIR}/chapter-3.wav`)
    await engine.discard('C:\\scratch\\chapter-4.wav')
    expect(tauri.removed).toEqual([
      [`${RUN_DIR}/chapter-3.wav`, { baseDir: tauri.APP_DATA }],
      [`${RUN_DIR}/chapter-4.wav`, { baseDir: tauri.APP_DATA }],
    ])
  })

  it('removes nothing for a path that names no file', async () => {
    /* A name of '' would be the run directory itself. */
    const engine = await tauriAudiobook([], NO_CLIP, HOLD)
    await engine.discard('/data/one.paper.reader/')
    expect(tauri.removed).toEqual([])
  })

  it('removes its own directory, and everything in it, when the export is done', async () => {
    const engine = await tauriAudiobook([], NO_CLIP, HOLD)
    await engine.discardScratch()
    expect(tauri.removed).toEqual([[RUN_DIR, { baseDir: tauri.APP_DATA, recursive: true }]])
  })
})

describe('the sweep of runs no export can still own', () => {
  it('removes a run older than any export could still be running, and only such runs', async () => {
    const stale = runMade(6 * HOUR)
    tauri.listing = [
      { name: RUN, isDirectory: true },
      { name: stale, isDirectory: true },
      { name: runMade(6 * HOUR - 1), isDirectory: true },
      { name: runMade(HOUR), isDirectory: true },
    ]
    await tauriAudiobook([], NO_CLIP, HOLD)
    expect(tauri.listed).toEqual([['audiobook', { baseDir: tauri.APP_DATA }]])
    /* SIX HOURS TO THE MILLISECOND, and a millisecond short of it is left: a
       ten-hour book at 22x is under half an hour, so anything younger may be a
       run another window has in flight. */
    expect(tauri.removed).toEqual([[`audiobook/${stale}`, { baseDir: tauri.APP_DATA, recursive: true }]])
  })

  it('never touches the run it has just made, even across a clock that jumped', async () => {
    /* Age alone keeps a run made a moment ago. It is kept BY NAME as well, which
       is what holds when the clock moves between making the run and sweeping —
       a machine that syncs its time, a reader who changes it. Here it jumps
       seven hours, so the run this call made reads as abandoned by its age. */
    vi.mocked(Date.now)
      .mockReturnValueOnce(NOW - 7 * HOUR)
      .mockReturnValue(NOW)
    const own = `run-${(NOW - 7 * HOUR).toString(36)}-4fzzzx`
    tauri.listing = [{ name: own, isDirectory: true }]
    await tauriAudiobook([], NO_CLIP, HOLD)
    expect(tauri.made).toEqual([[`audiobook/${own}`, { baseDir: tauri.APP_DATA, recursive: true }]])
    expect(tauri.removed).toEqual([])
  })

  it('leaves anything that is not a run, and goes on past it to the runs that are', async () => {
    /* A stranger in the directory must not end the sweep: the old run AFTER them
       all is still removed. */
    vi.mocked(Date.now).mockReturnValue(NOW + 7 * HOUR)
    const stale = runMade(0)
    tauri.listing = [
      { name: 'chapter-1.wav', isDirectory: false },
      { name: 'stray', isDirectory: true },
      { name: `run-${'z'.repeat(220)}-abcdef`, isDirectory: true },
      { name: `x-${stale}`, isDirectory: true },
      { name: stale, isDirectory: true },
    ]
    await tauriAudiobook([], NO_CLIP, HOLD)
    expect(tauri.removed, 'a file, a stranger and a run no clock could have made are all left').toEqual([
      [`audiobook/${stale}`, { baseDir: tauri.APP_DATA, recursive: true }],
    ])
  })

  it('leaves a file even when its name reads as an old run', async () => {
    tauri.listing = [{ name: runMade(9 * HOUR), isDirectory: false }]
    await tauriAudiobook([], NO_CLIP, HOLD)
    expect(tauri.removed).toEqual([])
  })

  it('goes on past a run it cannot remove, and past a listing it cannot read', async () => {
    const first = runMade(7 * HOUR)
    const second = runMade(8 * HOUR)
    tauri.listing = [
      { name: first, isDirectory: true },
      { name: second, isDirectory: true },
    ]
    tauri.refuse = new Set([`audiobook/${first}`])
    await tauriAudiobook([], NO_CLIP, HOLD)
    expect(tauri.removed.map(([path]) => path)).toEqual([`audiobook/${first}`, `audiobook/${second}`])

    tauri.listing = new Error('the directory is gone')
    await expect(tauriAudiobook([], NO_CLIP, HOLD), 'a sweep that fails must not stop the export').resolves.toBeDefined()
  })
})

describe('asking the rendered reading before rendering again', () => {
  const pack = {
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
  const job = {
    text: 'Call me Ishmael.',
    voice: 'kokoro:af_heart',
    rate: 1.25,
    path: '/scratch/chapter-3.wav',
    bookId: 'book:a',
    section: 3,
    textDigest: 'fnv1a64:16:0000000000000001',
  }

  it('uses the clip and renders nothing where one is already there', async () => {
    /* ⚠️ WI-34.4, measured rather than asserted in a comment: a chapter the
       reader has listened to costs the export nothing but the muxing. */
    const asked: unknown[] = []
    const engine = await tauriAudiobook([pack], async (request) => {
      asked.push(request)
      return {
        stem: 'book_a-3-abc',
        path: '/data/audio/clips/book_a-3-abc.wav',
        bytes: 48_044,
        sampleRate: 24_000,
        durationMs: 1000,
        words: [],
        skipped: [],
      }
    }, HOLD)
    await expect(engine.render(job)).resolves.toEqual({
      path: '/data/audio/clips/book_a-3-abc.wav',
      cached: true,
      skipped: [],
    })
    expect(tauri.invoked, 'the engine is not asked at all').toEqual([])
    expect(leases, 'and the clip is held before it is answered for').toEqual([
      [['book_a-3-abc'], true],
    ])
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
    const engine = await tauriAudiobook(
      [pack],
      async () => ({
        stem: 'book_a-3-abc',
        path: '/data/audio/clips/book_a-3-abc.wav',
        bytes: 48_044,
        sampleRate: 24_000,
        durationMs: 1000,
        words: [],
        skipped: [],
      }),
      HOLD,
    )

    await expect(engine.render(job)).resolves.toEqual({
      path: '/scratch/chapter-3.wav',
      cached: false,
      skipped: [],
    })
    expect(leases, 'it did ask').toEqual([[['book_a-3-abc'], true]])
    expect(tauri.invoked.map(([name]) => name), 'and then rendered it').toEqual([
      'plugin:voices|voices_render_file',
    ])
  })

  it('renders the chapter where the hold itself refuses', async () => {
    /* A store that will not answer at all is the same outcome for the export as
       one that answers zero: the chapter cannot be relied on, so it is rendered.
       Separate from the case above because a REJECTION and a zero arrive by
       different roads, and only one of them was ever going to be handled. */
    const engine = await tauriAudiobook(
      [pack],
      async () => ({
        stem: 'book_a-3-abc',
        path: '/data/audio/clips/book_a-3-abc.wav',
        bytes: 48_044,
        sampleRate: 24_000,
        durationMs: 1000,
        words: [],
        skipped: [],
      }),
      async () => {
        throw new Error('the store would not answer')
      },
    )

    await expect(engine.render(job)).resolves.toEqual({
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
    const engine = await tauriAudiobook([pack], NO_CLIP, HOLD)
    await expect(engine.render(job)).resolves.toEqual({
      path: '/scratch/chapter-3.wav',
      cached: false,
      skipped: [],
    })
    expect(tauri.invoked).toEqual([
      [
        'plugin:voices|voices_render_file',
        {
          pack: 'english-kokoro',
          voice: 'af_heart',
          text: 'Call me Ishmael.',
          rate: 1.25,
          path: '/scratch/chapter-3.wav',
        },
      ],
    ])
  })

  it('does not ask the store for a voice that is not a downloaded one', async () => {
    /* The refusal comes first: a platform identifier is a caller that has not
       asked the packs, and asking the store about it would be a round trip for a
       question that cannot have an answer. */
    const asked: unknown[] = []
    const engine = await tauriAudiobook([pack], async (request) => {
      asked.push(request)
      return null
    }, HOLD)
    await expect(
      engine.render({ ...job, voice: 'com.apple.voice.compact.en-US.Samantha' }),
    ).rejects.toThrow(/is not a downloaded voice/u)
    expect(asked).toEqual([])
    expect(tauri.invoked).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseAudiobookPath, safeFileName, tauriAudiobook } from './audiobookTauri'

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
}))

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
    await tauriAudiobook([])
    expect(tauri.made).toEqual([[RUN_DIR, { baseDir: tauri.APP_DATA, recursive: true }]])
  })

  it('writes each chapter in that directory, by absolute path, for the engine', async () => {
    const engine = await tauriAudiobook([])
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
    const engine = await tauriAudiobook([pack])
    const job = { text: 'Call me Ishmael.', voice: 'kokoro:af_heart', rate: 1, path: '/x.wav' }
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
    const engine = await tauriAudiobook([pack])
    await expect(
      engine.render({ text: '春天', voice: 'qwen:Vivian', rate: 1, path: '/x.wav' }),
    ).resolves.toBeUndefined()
    expect(tauri.invoked).toEqual([
      ['plugin:voices|voices_render_file', { pack: 'qwen', voice: 'Vivian', text: '春天', rate: 1, path: '/x.wav' }],
    ])
  })

  it('refuses a platform voice rather than rendering in one', async () => {
    /* ⚠️ THERE IS NOWHERE TO SEND IT. `narrate_render` over AVSpeechSynthesizer
     * was deleted in phase 30 — every voice it reached on a Mac is below the
     * floor the reading refuses — so a job carrying a Web Speech identifier is
     * a caller that has not asked the packs. */
    const engine = await tauriAudiobook([])
    const job = { text: 'Call me Ishmael.', voice: 'com.apple.voice.enhanced.en-US.Zoe', rate: 1, path: '/x.wav' }
    await expect(engine.render(job)).rejects.toThrow(/not a downloaded voice/)
    expect(tauri.invoked).toEqual([])
  })

  it('removes a chapter by its name under the granted root, whatever separator its path used', async () => {
    const engine = await tauriAudiobook([])
    await engine.discard(`/data/one.paper.reader/${RUN_DIR}/chapter-3.wav`)
    await engine.discard('C:\\scratch\\chapter-4.wav')
    expect(tauri.removed).toEqual([
      [`${RUN_DIR}/chapter-3.wav`, { baseDir: tauri.APP_DATA }],
      [`${RUN_DIR}/chapter-4.wav`, { baseDir: tauri.APP_DATA }],
    ])
  })

  it('removes nothing for a path that names no file', async () => {
    /* A name of '' would be the run directory itself. */
    const engine = await tauriAudiobook([])
    await engine.discard('/data/one.paper.reader/')
    expect(tauri.removed).toEqual([])
  })

  it('removes its own directory, and everything in it, when the export is done', async () => {
    const engine = await tauriAudiobook([])
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
    await tauriAudiobook([])
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
    await tauriAudiobook([])
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
    await tauriAudiobook([])
    expect(tauri.removed, 'a file, a stranger and a run no clock could have made are all left').toEqual([
      [`audiobook/${stale}`, { baseDir: tauri.APP_DATA, recursive: true }],
    ])
  })

  it('leaves a file even when its name reads as an old run', async () => {
    tauri.listing = [{ name: runMade(9 * HOUR), isDirectory: false }]
    await tauriAudiobook([])
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
    await tauriAudiobook([])
    expect(tauri.removed.map(([path]) => path)).toEqual([`audiobook/${first}`, `audiobook/${second}`])

    tauri.listing = new Error('the directory is gone')
    await expect(tauriAudiobook([]), 'a sweep that fails must not stop the export').resolves.toBeDefined()
  })
})

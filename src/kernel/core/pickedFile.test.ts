import { describe, expect, it, vi } from 'vitest'
import { createFilePicker, fileNameOf, NO_FILE_PICKER, type FilePicker, type FilePickerIo } from './pickedFile'

const SECRET_DIR = '/made/up/reader/private-folder'
const PICKED = `${SECRET_DIR}/notes.json`
const FILTERS = [{ name: 'Paper tags', extensions: ['json'] }]

function ioAnswering(answer: unknown) {
  return {
    showOpen: vi.fn(async () => answer),
    showSave: vi.fn(async () => answer),
    size: vi.fn(async () => 42),
    readText: vi.fn(async () => 'contents'),
    writeText: vi.fn(async () => {}),
  } satisfies FilePickerIo
}

describe('what a capability holds after a pick', () => {
  it('holds exactly four members, and none of them is the path', async () => {
    const file = await createFilePicker(ioAnswering(PICKED)).pickOpen(FILTERS)
    expect(Object.keys(file ?? {}).sort()).toEqual(['name', 'readText', 'size', 'writeText'])
    expect(JSON.stringify(file)).toBe('{"name":"notes.json"}')
    expect(file?.name).toBe('notes.json')
    /* Every way of asking an object what it knows, and the folder in none of them. */
    const said = [String(file), ...Object.getOwnPropertyNames(file), ...Object.values(file ?? {}).map(String)].join('\n')
    expect(said).not.toContain(SECRET_DIR)
  })

  it('cannot be given a path, or have one hung on it', async () => {
    const io = ioAnswering(PICKED)
    const file = await createFilePicker(io).pickOpen(FILTERS)
    expect(Object.isFrozen(file)).toBe(true)
    /* The methods take no path: a capability passing one reaches the picked file regardless. */
    await (file?.readText as unknown as (path: string) => Promise<string>)('/made/up/elsewhere/secret')
    expect(io.readText.mock.calls).toEqual([[PICKED]])
  })

  it.each([
    ['a POSIX path', '/made/up/a/b.md', 'b.md'],
    ['a Windows path', 'C:\\made\\up\\b.json', 'b.json'],
    ['a bare name', 'b.json', 'b.json'],
    ['a folder', '/made/up/dir/', ''],
  ])('names %s by its last part', (_shape, path, name) => {
    expect(fileNameOf(path)).toBe(name)
  })

  it('names a Windows pick without its folder', async () => {
    const file = await createFilePicker(ioAnswering('C:\\Users\\made-up\\b.json')).pickOpen(FILTERS)
    expect(file?.name).toBe('b.json')
  })
})

describe('the direction the reader agreed to', () => {
  it('reads and measures a file picked to open, on the picked path', async () => {
    const io = ioAnswering(PICKED)
    const file = await createFilePicker(io).pickOpen(FILTERS)
    await expect(file?.size()).resolves.toBe(42)
    await expect(file?.readText()).resolves.toBe('contents')
    expect(io.size).toHaveBeenCalledWith(PICKED)
    expect(io.readText).toHaveBeenCalledWith(PICKED)
  })

  it('refuses to write over a file the reader only agreed to open', async () => {
    const io = ioAnswering(PICKED)
    const file = await createFilePicker(io).pickOpen(FILTERS)
    await expect(file?.writeText('x')).rejects.toThrow('A file picked to read cannot be written: the reader was asked to open')
    expect(io.writeText).not.toHaveBeenCalled()
  })

  it('writes a file picked to save, on the picked path', async () => {
    const io = ioAnswering(PICKED)
    const file = await createFilePicker(io).pickSave('offered.json', FILTERS)
    await file?.writeText('body')
    expect(io.writeText.mock.calls).toEqual([[PICKED, 'body']])
  })

  it('refuses to read or measure what is already at the name the reader will overwrite', async () => {
    const io = ioAnswering(PICKED)
    const file = await createFilePicker(io).pickSave('offered.json', FILTERS)
    await expect(file?.readText()).rejects.toThrow('A file picked to write cannot be read: the reader was asked to save')
    await expect(file?.size()).rejects.toThrow('A file picked to write cannot be measured: the reader was asked to save')
    expect(io.readText).not.toHaveBeenCalled()
    expect(io.size).not.toHaveBeenCalled()
  })
})

/*
 * THE PLATFORM NAMES THE PATH WHEN IT FAILS. The real trigger needs no malice: a
 * file deleted between the pick and the read rejects with the whole path in the
 * sentence, and a capability's own catch is then holding what the closure kept.
 * Tauri's plugins reject with a bare string as often as an Error, so both shapes.
 */
describe('a platform failure, as a capability sees it', () => {
  const SENTENCE = `failed to read file as text at path: ${PICKED}`
  const everythingOn = (error: Error): string =>
    Object.getOwnPropertyNames(error)
      .map((key) => String((error as unknown as Record<string, unknown>)[key]))
      .join('\n')

  async function caught(act: () => Promise<unknown>): Promise<Error> {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await act()
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      /* The original is the kernel's to keep: logged once, whole, on this side of the line. */
      expect(logged).toHaveBeenCalledTimes(1)
      const [label, original] = logged.mock.calls[0] ?? []
      expect(label).toBe(`Paper: ${(error as Error).message}`)
      expect(String(original)).toContain(SECRET_DIR)
      return error as Error
    } finally {
      logged.mockRestore()
    }
    throw new Error('the platform failure was swallowed')
  }

  const REJECTIONS = [
    ['an Error', () => new Error(SENTENCE)],
    ['a bare string', () => SENTENCE],
  ] as const

  describe.each(REJECTIONS)('rejecting with %s', (_shape, rejection) => {
    it.each([
      ['size', 'open', 'The picked file could not be measured'],
      ['readText', 'open', 'The picked file could not be read'],
      ['writeText', 'save', 'The picked file could not be written'],
    ] as const)('%s says a fixed sentence and carries no path', async (method, dialog, sentence) => {
      const io = ioAnswering(PICKED)
      io[method].mockRejectedValue(rejection())
      const picker = createFilePicker(io)
      const file = dialog === 'open' ? await picker.pickOpen(FILTERS) : await picker.pickSave('offered.json', FILTERS)
      const error = await caught(() => (method === 'writeText' ? file!.writeText('x') : file![method]()))
      expect(error.message).toBe(sentence)
      expect(error.cause).toBeUndefined()
      expect(everythingOn(error)).not.toContain(SECRET_DIR)
      expect(everythingOn(error)).not.toContain('notes.json')
    })

    it.each([
      ['showOpen', (picker: FilePicker) => picker.pickOpen(FILTERS)],
      ['showSave', (picker: FilePicker) => picker.pickSave('offered.json', FILTERS)],
    ] as const)('%s says a fixed sentence and carries no path', async (method, pick) => {
      const io = ioAnswering(PICKED)
      io[method].mockRejectedValue(rejection())
      const error = await caught(() => pick(createFilePicker(io)))
      expect(error.message).toBe('The file dialog could not be shown')
      expect(error.cause).toBeUndefined()
      expect(everythingOn(error)).not.toContain(SECRET_DIR)
    })
  })

  it('catches a platform call that throws rather than rejects', async () => {
    const io = ioAnswering(PICKED)
    io.readText.mockImplementation(() => {
      throw new Error(SENTENCE)
    })
    const file = await createFilePicker(io).pickOpen(FILTERS)
    const error = await caught(() => file!.readText())
    expect(error.message).toBe('The picked file could not be read')
  })

  it('leaves the direction refusals saying what they said, and logs nothing for them', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const file = await createFilePicker(ioAnswering(PICKED)).pickOpen(FILTERS)
    await expect(file?.writeText('x')).rejects.toThrow('A file picked to read cannot be written')
    expect(logged).not.toHaveBeenCalled()
    logged.mockRestore()
  })
})

describe('the dialog', () => {
  it('is handed the filters, and the offered name', async () => {
    const io = ioAnswering(PICKED)
    const picker = createFilePicker(io)
    await picker.pickOpen(FILTERS)
    await picker.pickSave('offered.json', FILTERS)
    expect(io.showOpen).toHaveBeenCalledWith(FILTERS)
    expect(io.showSave).toHaveBeenCalledWith('offered.json', FILTERS)
  })

  /* A suggested name is where the dialog opens, so a path in it would let a capability
     aim the reader's Save at a place of its choosing, and a tired reader presses Return. */
  it.each([
    ['a POSIX path', '/made/up/.zshrc'],
    ['a relative POSIX folder', 'made-up/notes.json'],
    ['a Windows path', 'C:\\made\\up\\notes.json'],
    ['a Windows relative folder', 'made-up\\notes.json'],
    ['a POSIX climb', '../notes.json'],
    ['a Windows climb', '..\\notes.json'],
    ['two dots alone', '..'],
    ['two dots inside a name', 'notes..json'],
  ])('refuses a suggested name that is %s, before any dialog opens', async (_shape, name) => {
    const io = ioAnswering(PICKED)
    await expect(createFilePicker(io).pickSave(name, FILTERS)).rejects.toThrow(
      'A name offered to the save dialog must be a bare file name',
    )
    expect(io.showSave).not.toHaveBeenCalled()
  })

  it.each([
    ['a dated name', 'paper-tags-2026-01-02.json'],
    ['a name with a space and one dot', 'my notes.json'],
    ['a hidden name', '.notes'],
  ])('offers %s as it stands', async (_shape, name) => {
    const io = ioAnswering(PICKED)
    await createFilePicker(io).pickSave(name, FILTERS)
    expect(io.showSave.mock.calls).toEqual([[name, FILTERS]])
  })

  it.each([[null], [undefined], [''], [[PICKED]], [[PICKED, '/made/up/other']], [7]])(
    'treats an answer of %j as no pick, in both directions',
    async (answer) => {
      const picker = createFilePicker(ioAnswering(answer))
      await expect(picker.pickOpen(FILTERS)).resolves.toBeNull()
      await expect(picker.pickSave('x.json', FILTERS)).resolves.toBeNull()
    },
  )

  it('says it is there', () => {
    expect(createFilePicker(ioAnswering(null)).available).toBe(true)
  })
})

describe('a build with no dialog', () => {
  it('says so, and refuses rather than reading as a dismissed dialog', async () => {
    expect(NO_FILE_PICKER.available).toBe(false)
    await expect(NO_FILE_PICKER.pickOpen(FILTERS)).rejects.toThrow('This build has no file dialog')
    await expect(NO_FILE_PICKER.pickSave('x', FILTERS)).rejects.toThrow('This build has no file dialog')
  })
})

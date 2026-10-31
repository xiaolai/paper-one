import { describe, expect, it, vi } from 'vitest'
import { createFilePicker, fileNameOf, NO_FILE_PICKER, type FilePickerIo } from './pickedFile'

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

describe('the dialog', () => {
  it('is handed the filters, and the offered name', async () => {
    const io = ioAnswering(PICKED)
    const picker = createFilePicker(io)
    await picker.pickOpen(FILTERS)
    await picker.pickSave('offered.json', FILTERS)
    expect(io.showOpen).toHaveBeenCalledWith(FILTERS)
    expect(io.showSave).toHaveBeenCalledWith('offered.json', FILTERS)
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { open, save } from '@tauri-apps/plugin-dialog'
import { readTextFile, stat, writeTextFile } from '@tauri-apps/plugin-fs'
import { tauriFilePicker } from './pickedFilesTauri'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn(), stat: vi.fn(), writeTextFile: vi.fn() }))

const FILTERS = [{ name: 'Paper tags', extensions: ['json'] }]

describe('the dialogs and the file behind a pick', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks for one file and never a folder, so a pick is one thing the reader pointed at', async () => {
    vi.mocked(open).mockResolvedValue(null)
    await expect(tauriFilePicker().pickOpen(FILTERS)).resolves.toBeNull()
    expect(open).toHaveBeenCalledWith({ multiple: false, directory: false, filters: FILTERS })
  })

  it('offers the name it was given', async () => {
    vi.mocked(save).mockResolvedValue(null)
    await expect(tauriFilePicker().pickSave('tags.json', FILTERS)).resolves.toBeNull()
    expect(save).toHaveBeenCalledWith({ defaultPath: 'tags.json', filters: FILTERS })
  })

  it('reads and measures the path the dialog answered', async () => {
    vi.mocked(open).mockResolvedValue('/made/up/tags.json')
    vi.mocked(stat).mockResolvedValue({ size: 12 } as never)
    vi.mocked(readTextFile).mockResolvedValue('text')
    const file = await tauriFilePicker().pickOpen(FILTERS)
    expect(file?.name).toBe('tags.json')
    await expect(file?.size()).resolves.toBe(12)
    await expect(file?.readText()).resolves.toBe('text')
    expect(stat).toHaveBeenCalledWith('/made/up/tags.json')
    expect(readTextFile).toHaveBeenCalledWith('/made/up/tags.json')
  })

  it('writes the path the dialog answered', async () => {
    vi.mocked(save).mockResolvedValue('/made/up/out.json')
    const file = await tauriFilePicker().pickSave('tags.json', FILTERS)
    await file?.writeText('body')
    expect(writeTextFile).toHaveBeenCalledWith('/made/up/out.json', 'body')
  })
})

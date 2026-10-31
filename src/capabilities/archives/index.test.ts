import { describe, expect, it, vi } from 'vitest'
import {
  composeCapabilities,
  createCard,
  createKernelServices,
  kernelApi,
  recordPath,
  type CommandContext,
  type FilePicker,
  type KernelServices,
  type PickedFile,
} from '../../kernel'
import { fakeFs } from '../../kernel/testkit'
import { archives } from './index'

/**
 * The capability at its door: the four rows the palette had, where a dialog
 * exists, and a real round trip through the kernel's stores and picker — which is
 * the proof that it needs nothing the kernel does not hand it.
 */

const CTX: CommandContext = { screen: 'library', pane: null, hasBook: false, openPane: () => {} }

/** A dialog that answers with the path it is told to, and a disk of one file. */
function fileDesk(path: string) {
  const disk = new Map<string, string>()
  const file: PickedFile = {
    name: path,
    size: async () => (disk.get(path) ?? '').length,
    readText: async () => disk.get(path) ?? '',
    writeText: async (text) => void disk.set(path, text),
  }
  const files: FilePicker = { available: true, pickOpen: async () => file, pickSave: async () => file }
  return { disk, files }
}

const launch = (over: Partial<Parameters<typeof createKernelServices>[0]>, switchedOff = new Set<string>()) => {
  const services = createKernelServices({ fs: null, storage: null, ...over })
  return composeCapabilities([archives], kernelApi(services), new AbortController().signal, { switchedOff }).then(
    (composition) => ({ services, composition }),
  )
}

const noticeOf = (services: KernelServices) => {
  const said = vi.fn<(text: string) => void>()
  services.bindNotifier(said)
  return said
}

describe('the rows', () => {
  it('are the four the palette had, in its words and its group', async () => {
    const { composition } = await launch({ files: fileDesk('/x/a.json').files })
    expect(composition.commands(CTX).map(({ id, label, group, keywords }) => ({ id, label, group, keywords }))).toEqual([
      {
        id: 'archives:export-marks',
        label: 'Export your marks and cards…',
        group: 'Library',
        keywords: 'mark note card highlight annotation backup save export file json markdown archive',
      },
      {
        id: 'archives:import-marks',
        label: 'Import marks from a file… (merge)',
        group: 'Library',
        keywords: 'mark note card highlight annotation restore load import merge file json archive backup',
      },
      {
        id: 'archives:export-tags',
        label: 'Export your tags…',
        group: 'Library',
        keywords: 'tag backup save export file json archive',
      },
      {
        id: 'archives:import-tags',
        /* "Merge" in the LABEL, which is the reassurance: an import never removes
           a tag, so restoring an old file cannot silently undo a month of filing. */
        label: 'Import tags from a file… (merge)',
        group: 'Library',
        keywords: 'tag restore load import merge file json archive backup',
      },
    ])
  })

  /* A row that opens a dialog which cannot exist is the app describing a feature
     it does not have. */
  it('are absent where this build has no file dialog', async () => {
    const { composition } = await launch({})
    expect(composition.commands(CTX)).toEqual([])
  })

  it('are absent when the reader switched it off, and their cards and marks are untouched', async () => {
    const { composition, services } = await launch({ files: fileDesk('/x/a.json').files }, new Set(['archives']))
    expect(composition.commands(CTX)).toEqual([])
    expect(services.cards.getSnapshot().all).toEqual([])
  })

  it('words its switch without saying plugin or capability', () => {
    expect(archives.toggle?.title).toBe('Archives')
    expect(`${archives.toggle?.title} ${archives.toggle?.summary}`).not.toMatch(/plugin|capability/iu)
  })
})

describe('a round trip through the kernel it was given', () => {
  const BOOK = 'book:abc'
  const shelf = () =>
    fakeFs({ [recordPath(BOOK)]: JSON.stringify({ bookId: BOOK, title: 'Moby-Dick', author: 'Melville' }) })

  const row = (composition: Awaited<ReturnType<typeof launch>>['composition'], id: string) => {
    const found = composition.commands(CTX).find((command) => command.id === id)
    if (!found) throw new Error(`no row ${id}`)
    return found
  }

  it('says there is nothing to export over an empty shelf, having read it first', async () => {
    const { disk, files } = fileDesk('/x/a.json')
    const { composition, services } = await launch({ fs: shelf(), files })
    const said = noticeOf(services)

    row(composition, 'archives:export-marks').run()
    await vi.waitFor(() => expect(said).toHaveBeenCalled())

    expect(said).toHaveBeenCalledWith('Nothing to export yet — no marks and no cards.')
    expect(JSON.parse(disk.get('/x/a.json') ?? '')).toMatchObject({ version: 1, books: [] })
  })

  it('takes a card out to the file and back onto a store that lost it', async () => {
    const { disk, files } = fileDesk('/x/a.json')
    const first = await launch({ fs: shelf(), files })
    const said = noticeOf(first.services)
    await first.services.cards.add(
      createCard({ bookId: BOOK, kind: 'Idea', body: 'Still worth keeping', answer: '', source: 'Loomings', cfi: null }),
    )

    row(first.composition, 'archives:export-marks').run()
    await vi.waitFor(() => expect(said).toHaveBeenCalled())
    expect(said.mock.calls[0]?.[0]).toMatch(/^Exported 0 marks and 1 card from /u)
    expect(disk.get('/x/a.json')).toContain('Still worth keeping')

    const second = await launch({ fs: shelf(), files })
    const heard = noticeOf(second.services)
    row(second.composition, 'archives:import-marks').run()
    await vi.waitFor(() => expect(heard).toHaveBeenCalled())
    expect(second.services.cards.getSnapshot().all.map((card) => card.body)).toEqual(['Still worth keeping'])
  })
})

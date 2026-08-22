// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StoragePane, formatBytes } from './StoragePane'
import { COVER_CAP_MAX_MB, COVER_CAP_MIN_MB, type StorageModel, type StorageSnapshot } from './storageModel'

/**
 * The Storage section, mounted.
 *
 * Nothing here had ever been executed by a test — the pane's comment said the
 * decisions live in the model, and several of them do not: which line the
 * status row shows, when a typed cap is COMMITTED, what the Evict button is
 * called, and whether a failure is announced. Every one of those is a decision
 * this file makes, and the last two are about a destructive action.
 */

const EMPTY: StorageSnapshot = {
  downloads: [],
  downloadCount: 0,
  coverBytes: 0,
  coverCapMB: 200,
  status: { state: 'idle', detail: null, lastSyncAt: null, lastSummary: null },
  busy: null,
  failure: null,
}

/** A model whose snapshot the test sets, recording what the pane asked for. */
function fakeModel(over: Partial<StorageSnapshot> = {}) {
  let snapshot: StorageSnapshot = {
    ...EMPTY,
    ...over,
    /* The count follows the rows unless a test names it — a fixture whose
     * count disagreed with its list by accident would be testing the "there
     * are more" line by mistake. */
    downloadCount: over.downloadCount ?? over.downloads?.length ?? 0,
  }
  const listeners = new Set<() => void>()
  const removed: string[] = []
  const caps: number[] = []
  let refreshes = 0
  const model: StorageModel & { removed: string[]; caps: number[]; refreshes: () => number; set: (next: Partial<StorageSnapshot>) => void } = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh: async () => void (refreshes += 1),
    removeDownload: async (book: string) => void removed.push(book),
    setCoverCapMB: async (mb: number) => void caps.push(mb),
    dispose: () => void listeners.clear(),
    removed,
    caps,
    refreshes: () => refreshes,
    set: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
  return model
}

afterEach(cleanup)

describe('formatBytes', () => {
  it('scales to the unit a reader can hold in their head', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(5 * 1024 * 1024 + 512 * 1024)).toBe('5.5 MB')
  })

  /* NULL IS "NOBODY CAN SAY", and it is reachable: `SizePort` answers null for
   * a directory it could not walk, and this formatter is exported for any
   * caller carrying such a number. An em dash rather than "0 B", which would
   * be a measurement nobody made. */
  it('says nothing rather than zero for an unmeasurable size', () => {
    expect(formatBytes(null)).toBe('—')
  })
})

describe('the status line', () => {
  it('shows a degraded detail over everything else', () => {
    render(<StoragePane model={fakeModel({ status: { state: 'degraded', detail: 'Paper on your Mac is unreachable', lastSyncAt: 1, lastSummary: null } })} />)
    expect(screen.getByRole('status').textContent).toBe('Paper on your Mac is unreachable')
  })

  it('falls back to a standard sentence when degraded with no detail', () => {
    render(<StoragePane model={fakeModel({ status: { state: 'degraded', detail: null, lastSyncAt: null, lastSummary: null } })} />)
    expect(screen.getByRole('status').textContent).not.toBe('')
    expect(screen.getByRole('status').textContent).not.toBe('Not synced yet')
  })

  it('says it is syncing while it is', () => {
    render(<StoragePane model={fakeModel({ status: { state: 'syncing', detail: null, lastSyncAt: null, lastSummary: null } })} />)
    expect(screen.getByRole('status').textContent).toBe('Syncing…')
  })

  /**
   * A DETAIL IS SHOWN WHATEVER THE STATE.
   *
   * `detail` used to be read only when degraded, and production supplies one
   * while idle too — "Peer plugin unavailable" is the reason there will never
   * BE a sync, and it was dropped in favour of "Not synced yet", which reads
   * as "not yet" rather than "not ever".
   */
  it('prefers an idle detail to the never-synced sentence', () => {
    render(<StoragePane model={fakeModel({ status: { state: 'idle', detail: 'Peer plugin unavailable', lastSyncAt: null, lastSummary: null } })} />)
    expect(screen.getByRole('status').textContent).toBe('Peer plugin unavailable')
  })

  it('reports the last sync time when there is one and nothing to explain', () => {
    render(<StoragePane model={fakeModel({ status: { state: 'idle', detail: null, lastSyncAt: 1_700_000_000_000, lastSummary: null } })} />)
    expect(screen.getByRole('status').textContent).toMatch(/^Last synced /)
  })

  it('says so plainly when nothing has synced yet', () => {
    render(<StoragePane model={fakeModel()} />)
    expect(screen.getByRole('status').textContent).toBe('Not synced yet')
  })

  /* IT IS A LIVE REGION. The line changes without the reader doing anything,
   * so a screen reader has to be told — politely, so it waits for a pause. */
  it('announces itself politely', () => {
    render(<StoragePane model={fakeModel()} />)
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite')
  })
})

describe('the downloads list', () => {
  const downloads = [
    { book: 'book:a', title: 'Moby-Dick', size: 1024 * 1024 },
    { book: 'book:b', title: 'Walden', size: 2048 },
  ]

  it('counts and lists what the model published', () => {
    render(<StoragePane model={fakeModel({ downloads })} />)
    expect(screen.getByText('Moby-Dick')).toBeTruthy()
    expect(screen.getByText('1.0 MB')).toBeTruthy()
    expect(screen.getByText('2.0 KB')).toBeTruthy()
  })

  /**
   * EVERY EVICT BUTTON IS NAMED FOR ITS BOOK.
   *
   * They were all called "Evict", so a screen reader moving through a shelf of
   * downloads heard the same word repeatedly with no way to tell which book it
   * would free — on an action that deletes bytes.
   */
  it('names each destructive button for the book it frees', () => {
    render(<StoragePane model={fakeModel({ downloads })} />)
    expect(screen.getByLabelText('Evict Moby-Dick')).toBeTruthy()
    expect(screen.getByLabelText('Evict Walden')).toBeTruthy()
  })

  it('asks the model to remove the book that was clicked', () => {
    const model = fakeModel({ downloads })
    render(<StoragePane model={model} />)
    fireEvent.click(screen.getByLabelText('Evict Walden'))
    expect(model.removed).toEqual(['book:b'])
  })

  /* THE BUSY ROW IS THE ONLY ONE DISABLED. Disabling the lot would stop a
   * reader queuing a second eviction; disabling none would let them fire the
   * same one twice. */
  it('disables only the row being removed', () => {
    render(<StoragePane model={fakeModel({ downloads, busy: 'book:a' })} />)
    expect((screen.getByLabelText('Evict Moby-Dick') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Evict Walden') as HTMLButtonElement).disabled).toBe(false)
  })

  /* A FAILURE IS ANNOUNCED, not swallowed. Every action here used to discard
   * its rejection, so a failed eviction left the pane unchanged and the reader
   * with no way to tell a refusal from a no-op. */
  it('shows a failure as an alert', () => {
    const model = fakeModel({ downloads })
    render(<StoragePane model={model} />)
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => model.set({ failure: 'the file is locked' }))
    expect(screen.getByRole('alert').textContent).toBe('the file is locked')
  })

  /* THE COUNT IS THE TOTAL, and the rows are the biggest few — so the pane
   * must not report the number it happens to be rendering. */
  it('reports the total, not the number of rows it drew', () => {
    render(<StoragePane model={fakeModel({ downloads, downloadCount: 412 })} />)
    expect(screen.getByText('412')).toBeTruthy()
    expect(screen.getByText('Showing the 2 largest of 412.')).toBeTruthy()
  })

  it('says nothing about a remainder when there is none', () => {
    render(<StoragePane model={fakeModel({ downloads })} />)
    expect(screen.queryByText(/Showing the/)).toBeNull()
  })

  it('refreshes once on mount, so an open pane is current', () => {
    const model = fakeModel()
    render(<StoragePane model={model} />)
    expect(model.refreshes()).toBe(1)
  })
})

describe('the cover cap field', () => {
  /**
   * COMMITTED WHEN THE EDIT IS FINISHED, NOT PER KEYSTROKE.
   *
   * `onChange` fires on every character and each one wrote the setting and ran
   * an eviction — so replacing `200` with `250` committed `2` first, and a
   * one-megabyte cap evicted almost every cover before the second digit
   * arrived. Covers do not come back; they are re-fetched from a peer, or not
   * at all.
   */
  it('writes nothing while the reader is still typing', () => {
    const model = fakeModel()
    render(<StoragePane model={model} />)
    const field = screen.getByLabelText('Cover cache cap, megabytes')
    fireEvent.change(field, { target: { value: '2' } })
    fireEvent.change(field, { target: { value: '25' } })
    fireEvent.change(field, { target: { value: '250' } })
    expect(model.caps).toEqual([])
    /* And the field shows what is being typed, not the committed value. */
    expect((field as HTMLInputElement).value).toBe('250')
  })

  it('commits on blur, and on Enter', () => {
    const model = fakeModel()
    render(<StoragePane model={model} />)
    const field = screen.getByLabelText('Cover cache cap, megabytes')
    fireEvent.change(field, { target: { value: '250' } })
    fireEvent.blur(field)
    expect(model.caps).toEqual([250])

    fireEvent.change(field, { target: { value: '300' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(model.caps).toEqual([250, 300])
  })

  /* ESCAPE ABANDONS THE EDIT. The field goes back to the committed value and
   * nothing is written. */
  it('abandons the edit on Escape', () => {
    const model = fakeModel()
    render(<StoragePane model={model} />)
    const field = screen.getByLabelText('Cover cache cap, megabytes')
    fireEvent.change(field, { target: { value: '1' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(model.caps).toEqual([])
    expect((field as HTMLInputElement).value).toBe('200')
  })

  /* AN EMPTY FIELD IS NOT ZERO. Clearing it and tabbing away must not commit a
   * cap of nothing, which would evict every cover on the device. */
  it('commits nothing for an empty field', () => {
    const model = fakeModel()
    render(<StoragePane model={model} />)
    const field = screen.getByLabelText('Cover cache cap, megabytes')
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.blur(field)
    expect(model.caps).toEqual([])
  })

  /**
   * NONSENSE NEVER REACHES THE MODEL, because the field is a NUMBER input:
   * the browser refuses to hold `abc` and hands back an empty value, which
   * this pane treats as "no edit" rather than as zero.
   *
   * The range itself is still the MODEL's to enforce — one place decides it —
   * and the test below shows a value the field will hold but the model
   * refuses passing straight through.
   */
  it('never commits text a number field cannot hold', () => {
    const model = fakeModel()
    render(<StoragePane model={model} />)
    const field = screen.getByLabelText('Cover cache cap, megabytes')
    fireEvent.change(field, { target: { value: 'abc' } })
    fireEvent.blur(field)
    expect(model.caps).toEqual([])
  })

  it('passes an out-of-range number to the model rather than deciding itself', () => {
    const model = fakeModel()
    render(<StoragePane model={model} />)
    const field = screen.getByLabelText('Cover cache cap, megabytes')
    fireEvent.change(field, { target: { value: '0' } })
    fireEvent.blur(field)
    /* The model refuses it; the pane's job is only to stop guessing. */
    expect(model.caps).toEqual([0])
  })

  it('declares the model’s own bounds to the browser', () => {
    render(<StoragePane model={fakeModel()} />)
    const field = screen.getByLabelText('Cover cache cap, megabytes') as HTMLInputElement
    expect(field.min).toBe(String(COVER_CAP_MIN_MB))
    expect(field.max).toBe(String(COVER_CAP_MAX_MB))
  })

  it('shows the committed cap once the edit is over', () => {
    const model = fakeModel({ coverCapMB: 500, coverBytes: 3 * 1024 * 1024 })
    render(<StoragePane model={model} />)
    expect((screen.getByLabelText('Cover cache cap, megabytes') as HTMLInputElement).value).toBe('500')
    expect(screen.getByText('3.0 MB of')).toBeTruthy()
  })
})

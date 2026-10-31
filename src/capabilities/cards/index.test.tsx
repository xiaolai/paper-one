// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeCapabilities, createKernelServices, kernelApi, type Highlight } from '../../kernel'
import { cards } from './index'

/**
 * The capability at its door: what it contributes, what a reader who switched
 * it off keeps, and #128 — a card made a moment after typing has the note as
 * written, not as the row last heard it.
 */

afterEach(cleanup)

const launch = (switchedOff: ReadonlySet<string>, services = createKernelServices({ fs: null, storage: null })) =>
  composeCapabilities([cards], kernelApi(services), new AbortController().signal, { switchedOff }).then((composition) => ({
    services,
    composition,
  }))

const MARK = {
  id: 'm1',
  bookId: 'b1',
  text: 'Call me Ishmael.',
  note: 'as the row heard it',
  chapter: 'Loomings',
  cfi: 'epubcfi(/6/4!/4/2)',
} as Highlight

describe('the cards, switched on', () => {
  it('contributes one unfinished panel and one control among the actions', async () => {
    const { composition } = await launch(new Set())
    expect(composition.panes.map((one) => [one.id, one.label, one.icon, one.unfinished, one.screens])).toEqual([
      ['cards:deck', 'Cards', 'layers', true, ['reader', 'library']],
    ])
    expect(composition.markControls.map((one) => [one.id, one.place])).toEqual([['cards:make', 'actions']])
    expect(composition.standing).toEqual([expect.objectContaining({ id: 'cards', state: 'on' })])
    composition.dispose()
  })

  it('makes a card from the note as written, not the note the row holds (#128)', async () => {
    const { composition, services } = await launch(new Set())
    const control = composition.markControls[0]
    const noteAsWritten = vi.fn((mark: Highlight) => ({ ...mark, note: 'as the reader wrote it' }))
    render(control?.render(MARK, { noteAsWritten }) as ReactElement)
    fireEvent.click(screen.getByRole('button', { name: 'Make a card' }))
    await waitFor(() => expect(services.cards.getSnapshot().all).toHaveLength(1))
    expect(services.cards.getSnapshot().all[0]).toEqual(
      expect.objectContaining({ bookId: 'b1', kind: 'Idea', body: 'as the reader wrote it', source: 'Loomings', cfi: MARK.cfi }),
    )
    composition.dispose()
  })

  it('draws the panel over the store, and hands on the jump the host gave it', async () => {
    const { composition, services } = await launch(new Set())
    render(composition.panes[0]?.render({ bookId: 'b1', goTo: vi.fn() }) as ReactElement)
    expect(screen.getByText('No cards yet')).toBeTruthy()
    expect(services.cards.getSnapshot().all).toEqual([])
    composition.dispose()
  })

  it('says nothing over the rows while the store is writing, and says so when it is not', async () => {
    const { composition, services } = await launch(new Set())
    const notice = composition.markControls[0]?.notice
    const reading = vi.spyOn(services.cards, 'getSnapshot')
    reading.mockReturnValue({ all: [], persistent: true })
    const first = render(notice?.() as ReactElement)
    expect(first.container.textContent).toBe('')
    first.unmount()
    reading.mockReturnValue({ all: [], persistent: false })
    render(notice?.() as ReactElement)
    expect(screen.getByText("Cards you make are not being saved — this device's storage is unavailable.")).toBeTruthy()
    reading.mockRestore()
    composition.dispose()
  })

  it('draws nothing once it has stopped, rather than writing to a store it let go of', async () => {
    const { composition } = await launch(new Set())
    const [pane] = composition.panes
    const [control] = composition.markControls
    composition.dispose()
    expect(pane?.render({ bookId: null })).toBeNull()
    expect(control?.render(MARK, { noteAsWritten: (mark) => mark })).toBeNull()
    expect(control?.notice?.()).toBeNull()
  })
})

describe('the cards, switched off', () => {
  it('offers a switch in words a reader knows', () => {
    expect(cards.toggle?.title).toBe('Cards')
    expect(`${cards.toggle?.title} ${cards.toggle?.summary}`).not.toMatch(/plugin|capability/i)
  })

  it('leaves no panel and no control, and is not a failure', async () => {
    const { composition } = await launch(new Set(['cards']))
    expect(composition.panes).toEqual([])
    expect(composition.markControls).toEqual([])
    expect(composition.failures).toEqual([])
    expect(composition.standing).toEqual([expect.objectContaining({ id: 'cards', state: 'off' })])
    composition.dispose()
  })

  /* D5: "their data stays". The store is the kernel's and stands either way. */
  it('keeps the cards a reader made', async () => {
    const services = createKernelServices({ fs: null, storage: null })
    await services.cards.add({
      id: 'c1',
      bookId: 'b1',
      kind: 'Idea',
      body: 'kept',
      answer: '',
      source: '',
      cfi: null,
      createdAt: 1,
    } as never)
    const { composition } = await launch(new Set(['cards']), services)
    expect(services.cards.getSnapshot().all.map((one) => one.body)).toEqual(['kept'])
    composition.dispose()
  })
})

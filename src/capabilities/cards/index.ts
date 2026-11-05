import { createElement } from 'react'
import type { Capability, CapabilityContext, Disposable, KernelServices } from '../../kernel'
import { DeckPane } from './ui/Deck'
import { MakeCard, NotSavingCards } from './ui/MakeCard'

/**
 * Cards: the panel and the control that makes one, and nothing underneath them.
 *
 * ⚠️ **THE STORE IS THE KERNEL'S AND STAYS THE KERNEL'S** (D2). `services.cards`,
 * the `card.*` services and their `card:*` grants, the journal's `cards` kind and
 * `books[].cards` all stand with this switched off or cut out, so another
 * device's cards still arrive, sync still carries them and an archive still
 * reads them. What leaves with this is the way to look at them and to make one.
 *
 * ⚠️ **THE PANEL IS UNFINISHED AND THE CONTROL IS NOT.** That is where the two
 * stood in the kernel: the panel has a study surface with no scheduler under it
 * and shows only under developer options, and "Make a card" sat on every mark
 * for every reader. Moving them changes neither.
 *
 * THE PANEL HAS NO DIGIT. ⌘4 was the kernel's, and the seam offers a capability
 * no accelerator: a palette row's `combo` is only printed. The palette row and
 * the rail reach it.
 */

let running: Pick<KernelServices, 'cards' | 'library'> | null = null

export const cards: Capability = {
  id: 'cards',
  requires: [],
  toggle: {
    title: 'Cards',
    summary:
      'Make a card from a mark, to keep and come back to. Off, the control is gone, and the cards you made stay on this device for when you turn it on again.',
  },

  panes: [
    {
      id: 'cards:deck',
      label: 'Cards',
      icon: 'layers',
      screens: ['reader', 'library'],
      unfinished: true,
      render: ({ bookId, goTo }) =>
        running && createElement(DeckPane, { services: running, bookId, ...(goTo ? { goTo } : {}) }),
    },
  ],

  markControls: [
    {
      id: 'cards:make',
      place: 'actions',
      render: (mark, tools) => running && createElement(MakeCard, { mark, tools, cards: running.cards }),
      notice: () => running && createElement(NotSavingCards, { cards: running.cards }),
    },
  ],

  start(api: CapabilityContext): Disposable {
    running = { cards: api.services.cards, library: api.services.library }
    return { dispose: () => void (running = null) }
  },
}

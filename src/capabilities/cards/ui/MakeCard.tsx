import { useSyncExternalStore } from 'react'
import { Layers } from 'lucide-react'
import { CAPABILITY_UI as ui, createCard, ICON, type Highlight, type KernelServices, type MarkControlTools } from '../../../kernel'
import { cardFromMark } from '../lib/cardFromMark'

/**
 * Notes stay raw; cards are made. This is the only place the one becomes the
 * other, which is what keeps the distinction §15 draws visible rather than
 * nominal.
 */
export function MakeCard({
  mark,
  tools,
  cards,
}: {
  mark: Highlight
  tools: MarkControlTools
  cards: KernelServices['cards']
}) {
  return (
    <button
      type="button"
      className={ui.iconButton}
      aria-label="Make a card"
      title="Make a card"
      /* THE NOTE AS WRITTEN HERE, not as the row last heard it (#128). A pointer
         going down on this button blurs the editor, which saves, but the row's
         `mark` is the render before that save reached the store. */
      onClick={() => {
        /* A rejection is a store that could not take the write, and
           `NotSavingCards` is what says so. */
        void cards.add(createCard(cardFromMark(tools.noteAsWritten(mark)))).catch(() => {})
      }}
    >
      <Layers size={ICON.inline} strokeWidth={ICON.stroke} />
    </button>
  )
}

/**
 * Above the rows that make cards: a card store that cannot write looks exactly
 * like one that can until the next launch (#122, #132). Its own store and its
 * own flag, so a mark being written cannot clear it.
 */
export function NotSavingCards({ cards }: { cards: KernelServices['cards'] }) {
  const { persistent } = useSyncExternalStore(cards.subscribe, cards.getSnapshot, cards.getSnapshot)
  return persistent ? null : <span>Cards you make are not being saved — this device&apos;s storage is unavailable.</span>
}

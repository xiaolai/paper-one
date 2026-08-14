/**
 * Prototype fixtures.
 *
 * The design handoff is explicit that this data is illustration, not
 * architecture: "their hardcoded data (2,418 titles, the Moby-Dick text, the
 * notes) ... are illustrations". It stands in until the library index and the
 * annotation store exist, and every screen that reads from here should be able
 * to swap the source without changing its markup.
 */

export type BookFormat = 'epub' | 'pdf'

export interface Book {
  readonly title: string
  readonly author: string
  /** Reading progress, 0–100. 0 means never opened. */
  readonly pct: number
  readonly format: BookFormat
  readonly openedAt: string
  readonly locationLabel: string
}

export const BOOKS: readonly Book[] = [
  { title: 'Moby-Dick', author: 'Herman Melville', pct: 37, format: 'epub', openedAt: '2m ago', locationLabel: 'Ch. 1 · Loomings' },
  { title: 'The Wealth of Nations', author: 'Adam Smith', pct: 12, format: 'epub', openedAt: 'yesterday', locationLabel: 'Bk. I · Ch. 3' },
  { title: 'Meditations', author: 'Marcus Aurelius', pct: 88, format: 'epub', openedAt: '3 days ago', locationLabel: 'Book XI' },
  { title: 'Attention Is All You Need', author: 'Vaswani et al.', pct: 64, format: 'pdf', openedAt: '4 days ago', locationLabel: 'p. 6' },
  { title: 'Frankenstein', author: 'Mary Shelley', pct: 0, format: 'epub', openedAt: '—', locationLabel: '' },
  { title: 'On the Origin of Species', author: 'Charles Darwin', pct: 22, format: 'epub', openedAt: '1 week ago', locationLabel: '' },
  { title: 'The Interpretation of Dreams', author: 'Sigmund Freud', pct: 5, format: 'epub', openedAt: '1 week ago', locationLabel: '' },
  { title: 'Walden', author: 'Henry D. Thoreau', pct: 100, format: 'epub', openedAt: '2 weeks ago', locationLabel: '' },
  { title: 'A Room of One’s Own', author: 'Virginia Woolf', pct: 46, format: 'epub', openedAt: '2 weeks ago', locationLabel: '' },
  { title: 'The Republic', author: 'Plato', pct: 8, format: 'epub', openedAt: '3 weeks ago', locationLabel: '' },
  { title: 'Leaves of Grass', author: 'Walt Whitman', pct: 0, format: 'epub', openedAt: '—', locationLabel: '' },
  { title: 'Great Expectations', author: 'Charles Dickens', pct: 71, format: 'epub', openedAt: '3 weeks ago', locationLabel: '' },
  { title: 'The Art of War', author: 'Sun Tzu', pct: 100, format: 'epub', openedAt: '1 month ago', locationLabel: '' },
  { title: 'Ulysses', author: 'James Joyce', pct: 3, format: 'epub', openedAt: '1 month ago', locationLabel: '' },
  { title: 'Pride and Prejudice', author: 'Jane Austen', pct: 100, format: 'epub', openedAt: '1 month ago', locationLabel: '' },
  { title: 'Silent Spring — field notes', author: 'Archive scan', pct: 18, format: 'pdf', openedAt: '1 month ago', locationLabel: '' },
  { title: 'The Odyssey', author: 'Homer', pct: 33, format: 'epub', openedAt: '2 months ago', locationLabel: '' },
  { title: 'Essays', author: 'Michel de Montaigne', pct: 27, format: 'epub', openedAt: '2 months ago', locationLabel: '' },
  { title: 'The Trial', author: 'Franz Kafka', pct: 0, format: 'epub', openedAt: '—', locationLabel: '' },
  { title: 'Elements', author: 'Euclid', pct: 6, format: 'pdf', openedAt: '2 months ago', locationLabel: '' },
  { title: 'The Federalist Papers', author: 'Hamilton, Madison, Jay', pct: 14, format: 'epub', openedAt: '3 months ago', locationLabel: '' },
  { title: 'Middlemarch', author: 'George Eliot', pct: 52, format: 'epub', openedAt: '3 months ago', locationLabel: '' },
  { title: 'Tao Te Ching', author: 'Laozi', pct: 100, format: 'epub', openedAt: '3 months ago', locationLabel: '' },
  { title: 'The Double Helix', author: 'Lab reprint', pct: 41, format: 'pdf', openedAt: '4 months ago', locationLabel: '' },
]

/**
 * §01 Covers: five tints stand in for missing artwork, cycled by index. The
 * prototype cycles a six-long sequence over the five tokens, which is why a
 * repeats — keep the sequence rather than the token list.
 */
export const COVER_TINTS: readonly string[] = [
  'var(--tint-a)',
  'var(--tint-d)',
  'var(--tint-c)',
  'var(--tint-a)',
  'var(--tint-b)',
  'var(--tint-c)',
]

export function coverTint(index: number): string {
  return COVER_TINTS[index % COVER_TINTS.length] ?? 'var(--tint-a)'
}

/** Library filter chips, with their counts. */
export const LIBRARY_CHIPS: readonly (readonly [string, string])[] = [
  ['All', '2,418'],
  ['Reading', '7'],
  ['Unread', '41'],
  ['Finished', '312'],
  ['Documents', '486'],
  ['Tags', '24'],
]

/** Fallback contents, used before a real book is open. */
export interface TocEntry {
  readonly label: string
  readonly current: boolean
  /** Number of marks in the chapter; drives the margin dot. */
  readonly marks: number
}

export const FALLBACK_TOC: readonly TocEntry[] = [
  { label: 'Etymology', current: false, marks: 0 },
  { label: 'Extracts', current: false, marks: 0 },
  { label: '1 · Loomings', current: true, marks: 2 },
  { label: '2 · The Carpet-Bag', current: false, marks: 0 },
  { label: '3 · The Spouter-Inn', current: false, marks: 1 },
  { label: '4 · The Counterpane', current: false, marks: 0 },
  { label: '5 · Breakfast', current: false, marks: 0 },
  { label: '6 · The Street', current: false, marks: 0 },
  { label: '7 · The Chapel', current: false, marks: 1 },
  { label: '8 · The Pulpit', current: false, marks: 0 },
  { label: '9 · The Sermon', current: false, marks: 0 },
  { label: '10 · A Bosom Friend', current: false, marks: 0 },
  { label: '11 · Nightgown', current: false, marks: 0 },
  { label: '12 · Biographical', current: false, marks: 0 },
  { label: '13 · Wheelbarrow', current: false, marks: 0 },
  { label: '14 · Nantucket', current: false, marks: 0 },
  { label: '15 · Chowder', current: false, marks: 0 },
]

export type NoteKind = 'Highlight' | 'AI'

export interface Note {
  readonly body: string
  readonly book: string
  readonly at: string
  readonly kind: NoteKind
  readonly comment: string
}

export const NOTES: readonly Note[] = [
  {
    body: 'Whenever I find myself growing grim about the mouth; whenever it is a damp, drizzly November in my soul…',
    book: 'Moby-Dick', at: 'Ch. 1 · ¶2', kind: 'Highlight',
    comment: 'The melancholy is seasonal weather, not illness — worth tracking how often Melville returns to this.',
  },
  {
    body: '“Call me Ishmael” leaves the name provisional — the narrator offers a handle, not an identity.',
    book: 'Moby-Dick', at: 'Ch. 1 · ¶1', kind: 'AI',
    comment: 'Generated while reading. Cites 3 passages in Chapter 1.',
  },
  {
    body: 'It is not from the benevolence of the butcher, the brewer, or the baker that we expect our dinner…',
    book: 'The Wealth of Nations', at: 'Bk. I · Ch. 2', kind: 'Highlight',
    comment: 'The self-interest argument in its original, narrower form.',
  },
  {
    body: 'Attention weights are computed as a scaled dot product, then normalised across the sequence.',
    book: 'Attention Is All You Need', at: 'p. 4 · §3.2', kind: 'AI',
    comment: 'Simplified restatement of the scaled dot-product section.',
  },
  {
    body: 'Confine yourself to the present.',
    book: 'Meditations', at: 'Book VII', kind: 'Highlight', comment: '',
  },
  {
    body: 'The tone shifts sharply after the sermon — from documentary to prophetic.',
    book: 'Moby-Dick', at: 'Ch. 9', kind: 'AI',
    comment: 'Pattern noticed across chapters 7–9.',
  },
]

export interface SearchResult {
  readonly book: string
  readonly at: string
  readonly before: string
  readonly hit: string
  readonly after: string
}

export const SEARCH_RESULTS: readonly SearchResult[] = [
  { book: 'Moby-Dick', at: 'Ch. 1 · Loomings', before: 'and nothing particular to interest me on shore, I thought I would sail about a little and see the ', hit: 'watery', after: ' part of the world.' },
  { book: 'Moby-Dick', at: 'Ch. 35 · The Mast-Head', before: 'lulled into such an opium-like listlessness of vacant, unconscious reverie by the blending cadence of ', hit: 'waves', after: ' with thoughts.' },
  { book: 'The Odyssey', at: 'Book V', before: 'he was sitting on the shore, and his eyes were ever filled with tears as he looked out over the barren ', hit: 'water', after: '.' },
  { book: 'Silent Spring — field notes', at: 'p. 12', before: 'the chemical had already entered the ground', hit: 'water', after: ' by the second season of application.' },
  { book: 'Walden', at: 'The Ponds', before: 'A lake is the landscape’s most beautiful and expressive feature. It is earth’s eye; looking into which the beholder measures the depth of his own nature.', hit: '', after: '' },
]

export type CardKind = 'Idea' | 'Claim' | 'Recall' | 'Synthesis' | 'Excerpt'

export interface Card {
  readonly kind: CardKind
  readonly body: string
  readonly source: string
  /** A count for most kinds; a due-date phrase for Recall. */
  readonly passages: number | string
  readonly answer: string
  /** 0 = none, 1 unsure, 2 likely, 3 certain. */
  readonly confidence: 0 | 1 | 2 | 3
}

export const CARDS: readonly Card[] = [
  { kind: 'Idea', body: 'Going to sea is framed as an ordinary remedy for despair, not an adventure — the voyage stands in for suicide.', source: 'Moby-Dick · Ch. 1', passages: 3, answer: '', confidence: 0 },
  { kind: 'Claim', body: 'In 1851 “hypos” meant low spirits, not imagined illness.', source: 'Moby-Dick · Ch. 1 · OED', passages: 1, answer: '', confidence: 3 },
  { kind: 'Recall', body: 'What does Ishmael say he does whenever it is “a damp, drizzly November” in his soul?', source: 'Moby-Dick · Ch. 1', passages: 'due today', answer: 'He goes to sea — deliberately, as a substitute for pistol and ball.', confidence: 0 },
  { kind: 'Synthesis', body: 'Across the first four chapters, water is always approached as a cure: the crowds at the Battery, the chapel, the inn. Melville sets the sea against the land as remedy against disease.', source: 'Moby-Dick · Ch. 1–4 · from 7 highlights', passages: 7, answer: '', confidence: 0 },
  { kind: 'Excerpt', body: '“Whenever I find myself growing grim about the mouth; whenever it is a damp, drizzly November in my soul…”', source: 'Moby-Dick · Ch. 1 · ¶2', passages: 1, answer: '', confidence: 0 },
  { kind: 'Claim', body: 'Attention weights are computed as scaled dot products, divided by √d to keep gradients stable.', source: 'Attention Is All You Need · §3.2', passages: 2, answer: '', confidence: 3 },
  { kind: 'Idea', body: 'Transformers replace recurrence with position — order becomes data rather than sequence.', source: 'Attention Is All You Need · §3.5', passages: 4, answer: '', confidence: 0 },
  { kind: 'Recall', body: 'Why divide the dot products by √d?', source: 'Attention Is All You Need · §3.2', passages: 'due in 3 days', answer: 'Large dot products push softmax into regions with vanishing gradients.', confidence: 0 },
  { kind: 'Synthesis', body: 'Both Melville and Meadows describe systems that resist their own correction — the whale hunt and the reinforcing loop share a shape.', source: 'Whales & the sea · from 3 books', passages: 9, answer: '', confidence: 0 },
]

/** §01: each card kind carries a colour, so provenance is readable at a glance. */
export const CARD_TINT: Record<CardKind, string> = {
  Idea: 'var(--accent)',
  Claim: 'var(--ok)',
  Recall: 'var(--mark-rule)',
  Synthesis: 'var(--amber)',
  Excerpt: 'var(--line-3)',
}

export const PALETTE_ACTIONS: readonly (readonly [string, string, string])[] = [
  ['Summarise chapter to here', 'sparkles', '↵'],
  ['Simplify reading level', 'sparkles', ''],
  ['Summarise the whole book', 'sparkles', ''],
  ['Jump to chapter…', 'corner-down-right', ''],
  ['Search inside Moby-Dick', 'search', ''],
]

/** §11 keyboard map, shown in Settings → Shortcuts and the palette footer. */
export const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['⌘K', 'Search or ask'],
  ['Space / ↓', 'Advance one line, ruler pinned'],
  ['← →', 'Previous and next page'],
  ['⌘\\', 'Open or close the side pane'],
  ['⌘1…5', 'Contents, notes, search, cards, stats'],
  ['⌘D', 'Highlight the selection'],
  ['⌘⇧A', 'Ask the companion about the selection'],
  ['Esc', 'Dismiss the topmost layer only'],
]

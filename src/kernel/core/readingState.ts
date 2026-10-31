/** Where a reader is with a book — Douban's 想读 / 在读 / 读过. */
export type ReadingState = 'want' | 'reading' | 'finished'
export const READING_STATES: readonly ReadingState[] = ['want', 'reading', 'finished']

/** One to five, and nothing else. A `4.2` is what Douban says. */
export type Stars = 1 | 2 | 3 | 4 | 5
export const STARS: readonly Stars[] = [1, 2, 3, 4, 5]

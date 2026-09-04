import {
  claimFor,
  FIRST_EPOCH, drawsEntry,
  drawsOverlays,
  indexKeys,
  matchWork,
  READING_STATES,
  type Hlc,
  type ReadingState,
  type Relationship,
  type ShelvedWork,
  type Stars,
  type WorkClaim,
} from '../../../kernel'
import { bookVia, claimOf, indexOf, workDigest, type BookLike } from './exchange'
import type { ForeignFile } from './store'

/**
 * The circle's view of a book the reader has — WI-23.D1, D2, D3. Computed
 * from what the recipient already holds; no new protocol.
 *
 * PURE: every input is handed in, so the falsifiers are plain assertions —
 * no decimal anywhere in the sentences (D1), one friend means one name and
 * no ranking (D2), and a review from an older relationship epoch is not
 * drawn (D3).
 *
 * ## Never a mean
 *
 * ⚠️ **A COUNT OVER NAMED PEOPLE, NEVER A NUMBER THAT COULD BE MISTAKEN FOR
 * DOUBAN'S.** *"2 of 3 gave it four stars or more"* is what Paper says. A
 * `4.2` is what a site with a million readers says, and a reader will read
 * it as that site's — three friends are not a sample, they are three
 * friends. Every number rendered here is an integer count of people or an
 * integer star count, and `sentencesOf` is tested to contain no decimal.
 *
 * ## Which people, and which of their words
 *
 * Only a person whose relationship draws — `drawsOverlays`, so a muted,
 * blocked or exited person says nothing here. A REVIEW is drawn only if its
 * relationship epoch is the current one — `drawsEntry`, WI-23.D3, the first
 * consumer of that rule outside passages: a review received before a block
 * is not drawn after a re-admission. The status and rating registers carry
 * no epoch — a person's next word overwrites them, and a block that purges
 * (`defaultRetain`) clears them — so they follow the relationship's state
 * alone. `heldOf` is read for a book the reader HAS, which is where a
 * per-book file can be.
 *
 * ## The displayed name
 *
 * The roster's signed `displayName`, which `surfaces.md` §"The displayed name
 * must be bound" says is the person's own signed claim and not a name Paper
 * has checked. No alias store exists yet; when one does, it goes over the
 * name here and nowhere else.
 */

/** One person's word on the book. */
export interface CircleOpinion {
  readonly person: string
  readonly name: string
  /** Whether the book is on the shelf they show this reader. */
  readonly has: boolean
  readonly status: ReadingState | null
  readonly stars: Stars | null
  /** Newest first. Only the ones the relationship draws. */
  readonly reviews: readonly { readonly text: string; readonly at: Hlc }[]
}

/** A work that sits on friends' shelves beside this book — WI-23.D2. */
export interface AlsoRead {
  /** One row's worth of identity — the group's first member — so two groups that share a title and an author are still two rows. */
  readonly key: string
  readonly title: string
  readonly author: string
  /** Who has it, in the order the people were given. */
  readonly names: readonly string[]
  /** The reader's own copy, by id, or null. */
  readonly own: string | null
}

export interface CircleView {
  /** People with something to say: on their shelf, a status, a rating or a review. */
  readonly people: readonly CircleOpinion[]
  /**
   * Ranked by how many friends, then by title.
   *
   * ⚠️ **THE ORDER IS THE WHOLE RANKING, and the surface never shows a count.**
   * With one friend every entry has one name, so the order is by title and
   * there is nothing to rank — a ranking over one person is a recommendation
   * engine pretending.
   */
  readonly alsoRead: readonly AlsoRead[]
}

/** What the view is computed from, for one person. */
export interface PersonHeld {
  readonly person: string
  readonly name: string
  readonly relationship: Relationship
  readonly shelf: ForeignFile
  /** The per-book file for the book in question. */
  readonly held: ForeignFile
}

export const EMPTY_VIEW: CircleView = { people: [], alsoRead: [] }

/** The claim a shelf row names — the same inputs `claimFor` reads from a book. */
export function claimOfShelved(work: ShelvedWork): WorkClaim {
  return claimFor(
    {
      title: work.title,
      author: work.author,
      /* Stryker disable next-line all: `claimFor` reads an explicit `undefined` as absence; the spread keeps the type honest, not the answer. */
      ...(work.identifier === undefined ? {} : { identifier: work.identifier }),
      languages: [work.language],
    },
    workDigest,
  )
}

export function viewOf(
  book: BookLike,
  books: readonly BookLike[],
  people: readonly PersonHeld[],
  /** How two claims are compared — `matchWork`. A PARAMETER so a test can count the comparisons the grouping makes; the default is the policy. */
  match: (a: WorkClaim, b: WorkClaim) => ReturnType<typeof matchWork> = matchWork,
): CircleView {
  const claim = claimOf(book)
  const index = indexOf(books)
  const opinions: CircleOpinion[] = []
  /* Every other book on the shelf of somebody who has THIS one, collected
     first and grouped after — see `groupsOf`. */
  const others: Candidate[] = []

  for (const one of people) {
    // Stryker disable next-line ConditionalExpression: `drawsEntry` refuses each row again under the same rule; this spares the walk.
    if (!drawsOverlays(one.relationship.state)) continue
    /* Under the relationship: a row or a register retained from an earlier
       admission belongs to a relationship that ended. A row kept before
       epochs were stamped belongs to the FIRST epoch, not
       the current one: under a re-admission it stays hidden until the next
       round keeps it again, stamped — the answer that is safe to be wrong about. */
    const admits = (epoch: number | undefined): boolean => drawsEntry(one.relationship, epoch ?? FIRST_EPOCH)
    const shelf = one.shelf.works.filter((row) => admits(row.epoch)).map((row) => ({ row, claim: claimOfShelved(row.work) }))
    const has = shelf.some((row) => matchWork(claim, row.claim) !== 'none')
    const status = one.held.opinion.status !== undefined && admits(one.held.opinion.status.epoch) ? one.held.opinion.status.value : null
    const stars = one.held.opinion.stars !== undefined && admits(one.held.opinion.stars.epoch) ? one.held.opinion.stars.value : null
    const reviews = one.held.reviews
      .filter((review) => drawsEntry(one.relationship, review.epoch))
      .map((review) => ({ text: review.text, at: review.at }))
      .sort((a, b) => b.at.localeCompare(a.at))
    if (has || status !== null || stars !== null || reviews.length > 0) {
      opinions.push({ person: one.person, name: one.name, has, status, stars, reviews })
    }
    if (!has) continue
    /* EVERY row goes into the closure, the ones that meet the book included:
       a row that meets the book only through one of those has to be able to
       find it there, or it is listed as "also read" beside the book it is. */
    for (const other of shelf) {
      others.push({ person: one.person, name: one.name, pub: other.row.pub, title: other.row.work.title, author: other.row.work.author, claim: other.claim })
    }
  }

  /* The book itself rides along as a candidate nobody named, so a row that
     meets it only through another row — transitively — falls into its
     component and out of "also read", instead of being listed as a book the
     reader is looking at. */
  // Stryker disable next-line StringLiteral,LogicalOperator: the self row is dropped with its whole component; only its claim is ever read.
  const self: Candidate = { person: '', name: '', pub: '', title: book.title ?? '', author: book.author ?? '', claim }
  const alsoRead = groupsOf([self, ...others], index, match)
    .filter((group) => !group.persons.has(''))
    .map(({ key, title, author, names, own }) => ({ key, title, author, names, own }))
    .sort((a, b) => b.names.length - a.names.length || a.title.localeCompare(b.title))
  return { people: opinions, alsoRead }
}

interface Candidate {
  readonly person: string
  readonly name: string
  readonly pub: string
  readonly title: string
  readonly author: string
  readonly claim: WorkClaim
}

/**
 * The also-read groups: every pair of candidates that `matchWork` joins is in
 * one group, transitively.
 *
 * ⚠️ **NOT "the first group whose representative matches".** `matchWork` is
 * not transitive — a claim with an identifier matches one that shares it and
 * one that shares its title, and those two may not match each other — so
 * grouping against a representative made the groups, and their counts,
 * depend on the order people and shelves were read in. A closure over every
 * pair, walked in one fixed order, answers the same whatever the order.
 *
 * Membership is by PERSON; the names are what is shown. Two people who share
 * a display name are two people, and both count.
 *
 * ⚠️ **BUCKETED BY INDEX KEY, NOT EVERY PAIR.** Two claims `matchWork` joins
 * share an identifier or a title-author-language — which is exactly what
 * `indexKeys` mints — so only candidates in one bucket can meet, and only
 * those pairs are judged. Every pair over every friend's whole shelf was
 * quadratic in the circle's books, and blocked the pane for tens of millions
 * of comparisons on ordinary shelves. `matchWork` still decides each pair:
 * a shared key is a candidate, not an answer.
 */
function groupsOf(
  candidates: readonly Candidate[],
  index: ReturnType<typeof indexOf>,
  match: (a: WorkClaim, b: WorkClaim) => ReturnType<typeof matchWork>,
): readonly { key: string; title: string; author: string; persons: Set<string>; names: string[]; own: string | null }[] {
  const sorted = [...candidates].sort((a, b) => a.person.localeCompare(b.person) || a.pub.localeCompare(b.pub))
  const parent = sorted.map((_, i) => i)
  const rootOf = (i: number): number => {
    while (parent[i] !== i) i = parent[i]!
    return i
  }
  const buckets = new Map<string, number[]>()
  sorted.forEach((one, i) => {
    for (const key of indexKeys(one.claim)) {
      const bucket = buckets.get(key)
      if (bucket) bucket.push(i)
      else buckets.set(key, [i])
    }
  })
  for (const bucket of buckets.values()) {
    // Stryker disable next-line EqualityOperator: one index past the end has nothing after it to compare with, so the inner loop never runs there.
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const [i, j] = [bucket[x]!, bucket[y]!]
        if (match(sorted[i]!.claim, sorted[j]!.claim) === 'none') continue
        const [a, b] = [rootOf(i), rootOf(j)]
        // Stryker disable next-line ConditionalExpression: joining a root to itself writes what is already there.
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
      }
    }
  }
  const groups = new Map<number, { key: string; title: string; author: string; persons: Set<string>; names: string[]; own: string | null }>()
  sorted.forEach((one, i) => {
    const root = rootOf(i)
    const group = groups.get(root)
    if (group) {
      if (!group.persons.has(one.person)) {
        group.persons.add(one.person)
        group.names.push(one.name)
      }
      if (group.own === null) group.own = bookVia(index, one.claim)?.id ?? null
      return
    }
    /* The key is the first member's, in the fixed order — one row draws one group, whatever its title shares with another. */
    groups.set(root, { key: `${one.person}:${one.pub}`, title: one.title, author: one.author, persons: new Set([one.person]), names: [one.name], own: bookVia(index, one.claim)?.id ?? null })
  })
  return [...groups.values()]
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol". */
export function namesOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const STATUS_SENTENCE: Readonly<Record<ReadingState, (names: readonly string[]) => string>> = {
  finished: (names) => `${namesOf(names)} finished it.`,
  reading: (names) => `${namesOf(names)} ${names.length === 1 ? 'is' : 'are'} reading it.`,
  want: (names) => `${namesOf(names)} ${names.length === 1 ? 'wants' : 'want'} to read it.`,
}

/** The stars a rating is "four or more" at. */
export const FOUR_STARS = 4

/**
 * What the book's surface says about the circle, one sentence each: who has
 * it, who is where in it, and how many of those who rated it gave it four
 * stars or more. No sentence for a group nobody is in.
 */
export function sentencesOf(view: CircleView): readonly string[] {
  const out: string[] = []
  const having = view.people.filter((one) => one.has).map((one) => one.name)
  if (having.length > 0) out.push(`${namesOf(having)} ${having.length === 1 ? 'has' : 'have'} this.`)
  for (const state of READING_STATES) {
    const names = view.people.filter((one) => one.status === state).map((one) => one.name)
    if (names.length > 0) out.push(STATUS_SENTENCE[state](names))
  }
  const rated = view.people.filter((one) => one.stars !== null)
  if (rated.length > 0) {
    /* Stryker disable next-line ConditionalExpression: `rated` holds no null, and null would compare false anyway. */
    const liked = rated.filter((one) => one.stars !== null && one.stars >= FOUR_STARS).length
    out.push(`${namesOf(rated.map((one) => one.name))} rated it: ${liked} of ${rated.length} gave it four stars or more.`)
  }
  return out
}

/** "4 of 5 stars" — an integer, never a mean. */
export function starsText(stars: Stars): string {
  return `${stars} of 5 stars`
}

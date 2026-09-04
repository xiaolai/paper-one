import {
  DEFAULT_BUDGET,
  SHELF_WORK,
  acceptsTransport,
  chainHash,
  charge,
  listIdOf,
  listWork,
  type Budget,
  type PageCrypto,
  type Relationship,
  type Spend,
  compareHlc,
} from '../../../kernel'
import { claimOf, type BookLike } from './exchange'
import {
  CIRCLE_PROTO,
  CIRCLE_SERVICES,
  CIRCLE_VERSION,
  parseCircleWelcome,
  parsePagesAnswer,
  type PagesAnswer,
} from './protocol'
import { takePages } from './receive'
import { NOTHING_SHARED, type ForeignFile } from './store'

/**
 * The fetch driver — WI-23.A2. The half of the transport that ASKS.
 *
 * 0.1.3 shipped the serving half complete and registered, and nothing asked
 * it anything: a passage shared on one machine reached the other only if
 * somebody copied a file. This is the round that asks — on a cadence
 * (`cadence.ts`), for every person whose relationship accepts transport, for
 * every book on the shelf, from the cursor that person's file persists.
 *
 * PURE over its ports. Every socket, file, clock and key is a parameter, so a
 * whole round — dial, hello, pages, take, keep — runs in a test against an
 * in-process publisher with real signatures and no wire.
 *
 * ## Bounded, three ways
 *
 * - **One person at a time, one book at a time within a person.** A round is a
 *   loop, not a fan-out; the cadence never overlaps two.
 * - **The per-peer budget `bound.ts` defines, charged per answer.** Before a
 *   page is parsed, the answer's bytes are charged against the person's spend;
 *   a refusal ends that person's round. The ledger is the caller's to persist
 *   (`FetchPorts.spend` / `spent`).
 * - **A bounded number of answers per log per round.** `more` is followed, but
 *   not for ever: a publisher answering `more: true` indefinitely costs this
 *   side `MAX_ANSWERS_PER_LOG` calls and then the next round.
 *
 * ## A device that is asleep is skipped, not failed
 *
 * `keeper.rs`'s rule for introductions, applied here: a dial that does not
 * answer moves to the person's next device, and a person with no device awake
 * is reported and left for the next round. One friend's laptop being shut
 * must not cost the round every other friend.
 *
 * ## Which relationship a person has
 *
 * ⚠️ **ASKED THROUGH A PORT, AND THE PORT IS THE RELATIONSHIP STORE.** WI-22.E1
 * left the record decided and its store unbuilt, and until WI-23.C2 built it
 * everyone `circlePeople` named was `admitted` in epoch 1. Now the record
 * decides both: `acceptsTransport` on its state says whether to dial at all,
 * and its EPOCH is what every entry taken is recorded under — which is what
 * `drawsEntry` reads later, so a review received before a block is not drawn
 * after a re-admission (WI-23.D3). A record read from nothing is a new
 * admission, which is the same answer the interim gave.
 */

/** A person as the fetch needs them — `KnownPerson`, narrowed. */
export interface PersonToFetch {
  readonly person: string
  /** The devices the root-signed roster vouches for; endpoint ids. */
  readonly devices: readonly string[]
  readonly revoked: readonly string[]
  /** The roster epoch this side holds. */
  readonly roster: { readonly epoch: number }
}

/** An open session to one device — `Channel`, narrowed to what a round uses. */
export interface Dialled {
  call(service: string, body: unknown): Promise<unknown>
  close(): Promise<void>
}

export interface FetchPorts {
  /** Who this device speaks for. `null` is a reader with no identity: nothing to ask as. */
  readonly mine: () => Promise<{ readonly person: string } | null>
  readonly people: () => Promise<readonly PersonToFetch[]>
  /** The relationship record's state and epoch — `readRelationship`. */
  readonly relationship: (person: string) => Promise<Pick<Relationship, 'state' | 'epoch' | 'changedAt'>>
  /** Endpoint ids this device may dial — the peers it holds records for. */
  readonly dialable: () => Promise<ReadonlySet<string>>
  /** Dial one device. Rejects when it does not answer — which is skipped, not failed. */
  readonly dial: (device: string) => Promise<Dialled>
  readonly books: () => readonly BookLike[]
  readonly held: (bookId: string, person: string) => Promise<ForeignFile>
  readonly keep: (bookId: string, person: string, held: ForeignFile) => Promise<void>
  /** The person's SHELF as this device holds it, and where to put it — WI-23.C3. */
  readonly heldShelf: (person: string) => Promise<ForeignFile>
  readonly keepShelf: (person: string, held: ForeignFile) => Promise<void>
  /** The person's LISTS as this device holds them, by id, and where to put one — WI-23.E1. */
  readonly heldLists: (person: string) => Promise<ReadonlyMap<string, ForeignFile>>
  readonly keepList: (person: string, listId: string, held: ForeignFile) => Promise<void>
  /** The person's spend so far, and where to put it after charging. */
  readonly spend: (person: string) => Spend
  readonly spent: (person: string, spend: Spend) => void
  readonly now: () => number
  readonly crypto: PageCrypto
  readonly budget?: Budget
}

/** The most answers one log is asked for in one round. */
export const MAX_ANSWERS_PER_LOG = 8

/** What an answer's pages weigh on the wire — bytes, not UTF-16 code units. */
function bytesOf(pages: readonly string[]): number {
  const encoder = new TextEncoder()
  return pages.reduce((sum, page) => sum + encoder.encode(page).length, 0)
}

/** One log's answer from the peer, parsed — or `null` for one this build cannot read. */
async function askLog(session: Dialled, service: string, body: unknown): Promise<PagesAnswer | null> {
  return parsePagesAnswer(await session.call(service, body))
}

export type Skip =
  | 'not-admitted'
  | 'no-device'
  | 'asleep'
  | 'refused-hello'
  | 'over-budget'
  | 'failed'

export interface Skipped {
  readonly person: string
  readonly why: Skip
  readonly detail?: string
}

/** What one round did, for the diagnostics line that says so. */
export interface RoundReport {
  /** People asked, at least the hello. */
  readonly asked: number
  /** Log calls made — pages, shelf and lists alike, their probes included. */
  readonly calls: number
  /** Pages taken and kept. */
  readonly accepted: number
  readonly refusals: number
  readonly skipped: readonly Skipped[]
}

/** One round: every admitted person, every book. */
export async function fetchRound(ports: FetchPorts): Promise<RoundReport> {
  const empty: RoundReport = { asked: 0, calls: 0, accepted: 0, refusals: 0, skipped: [] }
  const mine = await ports.mine()
  /* No identity is the ordinary state of a reader who never shared, and it is
     not a failure — there is simply nobody to ask AS. */
  if (mine === null) return empty

  const dialable = await ports.dialable()
  let asked = 0
  let calls = 0
  let accepted = 0
  let refusals = 0
  const skipped: Skipped[] = []

  for (const person of await ports.people()) {
    /* EVERYTHING ABOUT ONE PERSON IS INSIDE THE ONE BOUNDARY — the record
       read and the dial included. A relationship file that would not read
       used to throw from outside the `try` and end the round for every
       person after them. */
    let session: Dialled | null = null
    try {
      const relationship = await ports.relationship(person.person)
      if (!acceptsTransport(relationship.state)) {
        skipped.push({ person: person.person, why: 'not-admitted' })
        continue
      }
      const candidates = person.devices.filter((device) => dialable.has(device) && !person.revoked.includes(device))
      if (candidates.length === 0) {
        skipped.push({ person: person.person, why: 'no-device' })
        continue
      }
      const dialled = await dialOneOf(ports, candidates)
      if ('failed' in dialled) {
        skipped.push({ person: person.person, why: 'asleep', detail: dialled.failed })
        continue
      }
      session = dialled
      asked += 1
      const welcome = parseCircleWelcome(
        await session.call(CIRCLE_SERVICES.hello.name, {
          proto: CIRCLE_PROTO,
          pages: CIRCLE_VERSION,
          person: mine.person,
        }),
      )
      /* ⚠️ **THE ANSWERING DEVICE MUST SPEAK FOR THE PERSON DIALLED.** A
       * welcome naming somebody else is a device on the wrong roster — every
       * page it served would be refused `wrong-person` anyway, but paying for
       * the pages to learn that is paying twice. */
      if (welcome === null || welcome.person !== person.person) {
        skipped.push({ person: person.person, why: 'refused-hello' })
        continue
      }
      /* ⚠️ **RE-READ BEFORE EVERY WRITE.** A block landed while this round
       * was out is a purge racing these writes; a keep after it would bring
       * the person's file back from the dead. Each keep asks the record
       * again, and a record that no longer admits them ends the person's
       * round with nothing written. */
      /* AND NOT ONLY THE STATE: a record that no longer exists reads as the
         undecided default — admitted, first epoch, stamped at the beginning
         of time — which is what a purge under way looks like from here. A
         record that has gone BACKWARDS from the one this round started with,
         or moved to another epoch, ends the person's round the same way. */
      const admitted = async (): Promise<number | null> => {
        const now = await ports.relationship(person.person)
        if (!acceptsTransport(now.state) || now.epoch !== relationship.epoch) return null
        if (compareHlc(now.changedAt, relationship.changedAt) < 0) return null
        /* AND THE ROSTER AS IT STANDS: a device revoked while this round was
           out must not have its pages taken against the roster the round
           started with. A person gone from the roster, or one whose devices,
           revocations or roster epoch moved, ends the round here. */
        const listed = (await ports.people()).find((one) => one.person === person.person)
        if (listed === undefined || !sameRoster(listed, person)) return null
        return now.epoch
      }
      const outcome = await fetchBooks(ports, session, person, welcome.agreed, admitted)
      calls += outcome.calls
      accepted += outcome.accepted
      refusals += outcome.refusals
      if (outcome.overBudget) {
        skipped.push({ person: person.person, why: 'over-budget' })
        continue
      }
      /* The shelf, after the books — one more log, the person's own, and
         only from a peer that publishes one: v1 has no shelf. */
      if (welcome.agreed >= 2) {
        const shelf = await fetchShelf(ports, session, person, welcome.agreed, admitted)
        calls += shelf.calls
        accepted += shelf.accepted
        refusals += shelf.refusals
        if (shelf.overBudget) {
          skipped.push({ person: person.person, why: 'over-budget' })
          continue
        }
      }
      /* The lists, last — a v3 log, and the least used. */
      if (welcome.agreed >= 3) {
        const lists = await fetchLists(ports, session, person, welcome.agreed, admitted)
        calls += lists.calls
        accepted += lists.accepted
        refusals += lists.refusals
        if (lists.overBudget) skipped.push({ person: person.person, why: 'over-budget' })
      }
    } catch (cause) {
      /* One person failing must not cost the round the people after them. */
      skipped.push({ person: person.person, why: 'failed', detail: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      /* Said, not swallowed: a session that would not close is a transport
         problem the round can go on past, and the only evidence of it. */
      await session?.close().catch((cause: unknown) => {
        console.warn(`Paper: could not close the session with ${person.person}`, cause)
      })
    }
  }
  return { asked, calls, accepted, refusals, skipped }
}

/** Whether a person's roster is the one a round started with — devices, revocations and epoch alike. */
function sameRoster(now: PersonToFetch, before: PersonToFetch): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((one, i) => one === b[i])
  return now.roster.epoch === before.roster.epoch && same(now.devices, before.devices) && same(now.revoked, before.revoked)
}

/** The first of a person's devices that answers, or null when none does. */
async function dialOneOf(ports: FetchPorts, devices: readonly string[]): Promise<Dialled | { readonly failed: string }> {
  // Stryker disable next-line StringLiteral: never read — a person with no device to dial is skipped before this is asked.
  let last = 'no device to dial'
  for (const device of devices) {
    try {
      return await ports.dial(device)
    } catch (cause) {
      /* Asleep, or unreachable from here. The next device, then the next
         round — `keeper.rs`'s rule for an introduction that does not answer.
         The reason is kept, so a failure that is not sleep — a bad grant, a
         misconfiguration — reads as what it is in the round's report. */
      last = cause instanceof Error ? cause.message : String(cause)
    }
  }
  return { failed: last }
}

interface BooksOutcome {
  readonly calls: number
  readonly accepted: number
  readonly refusals: number
  readonly overBudget: boolean
}

/** Every book on the shelf, from this person, from the cursor each file holds. */
async function fetchBooks(
  ports: FetchPorts,
  session: Dialled,
  person: PersonToFetch,
  /** The page version the hello agreed on — which chain to ask for and take. */
  agreed: number,
  /** The relationship's current epoch when it still admits them, else null — asked before every take. */
  admitted: () => Promise<number | null>,
): Promise<BooksOutcome> {
  const budget = ports.budget ?? DEFAULT_BUDGET
  let spend = ports.spend(person.person)
  let calls = 0
  let accepted = 0
  let refusals = 0

  for (const book of ports.books()) {
    const work = claimOf(book)
    let held = await ports.held(book.id, person.person)
    for (let answers = 0; answers < MAX_ANSWERS_PER_LOG; answers++) {
      calls += 1
      /* ⚠️ **`since` IS ONLY MEANINGFUL ON THE CHAIN IT WAS TAKEN FROM.** A
       * cursor held for another version is a position on another chain, and
       * asking from it would skip the new chain's opening pages for ever. A
       * v1 peer's strict parser refuses a member it does not know, so `v` is
       * named only when the agreed version is one that knows it. */
      const since = held.v === agreed ? held.cursor : {}
      const answer = parsePagesAnswer(
        await session.call(CIRCLE_SERVICES.pages.name, { work, since, ...(agreed > 1 ? { v: agreed } : {}) }),
      )
      if (answer === null) {
        /* An answer this build cannot read is one refusal for the log, and no
           further question to a peer that answers in a shape we do not. */
        refusals += 1
        break
      }
      if (answer.pages.length === 0) break

      /* ⚠️ **CHARGED BEFORE A PAGE IS PARSED.** `importLimits.ts`: a bound
       * that runs after the read has not bounded anything. The bytes are
       * known from the strings' lengths; nothing inside them has been looked
       * at yet. Keyed per book, because this side names the work by its own
       * book and the peer's claim is what it is answering about. */
      const bytes = bytesOf(answer.pages)
      const charged = charge(spend, book.id, bytes, ports.now(), budget)
      if (!charged.allowed) {
        return { calls, accepted, refusals, overBudget: true }
      }
      spend = charged.spend
      ports.spent(person.person, spend)

      /* The record, read again: a block since the round began ends this
         person's round here, and a re-admission since records what follows
         under the new epoch. */
      const epoch = await admitted()
      // Stryker disable next-line ConditionalExpression: the keep's own check, below, refuses the same way; this one spares the taking.
      if (epoch === null) return { calls, accepted, refusals, overBudget: false }
      const taken = takePages(
        answer.pages,
        work,
        person.person,
        {
          held,
          devices: person.devices,
          revoked: person.revoked,
          epoch: person.roster.epoch,
          relationshipEpoch: epoch,
          admitted: true,
        },
        ports.crypto,
        ports.now(),
        agreed,
      )
      refusals += taken.refusals.length
      if (taken.accepted === 0) break
      held = taken.held
      /* Kept per answer, not per book: a round interrupted after the third
         answer has the first three on disk, cursor and all. COUNTED once
         kept: a page taken and not written is not a page the report may
         call accepted. */
      if (!(await admitted())) return { calls, accepted, refusals, overBudget: false }
      await ports.keep(book.id, person.person, held)
      accepted += taken.accepted
      if (!answer.more) break
    }
  }
  return { calls, accepted, refusals, overBudget: false }
}


/**
 * The person's shelf — WI-23.C1's log, asked for whole under `SHELF_WORK`.
 *
 * A person the switch is off for answers exactly as a reader who owns nothing
 * does, so this side cannot tell the two apart and does not try: an empty
 * answer is an empty shelf, and nothing is written for it.
 */
async function fetchShelf(
  ports: FetchPorts,
  session: Dialled,
  person: PersonToFetch,
  agreed: number,
  admitted: () => Promise<number | null>,
): Promise<BooksOutcome> {
  const budget = ports.budget ?? DEFAULT_BUDGET
  let spend = ports.spend(person.person)
  let calls = 0
  let accepted = 0
  let refusals = 0
  let held = await ports.heldShelf(person.person)
  for (let answers = 0; answers < MAX_ANSWERS_PER_LOG; answers++) {
    calls += 1
    const since = held.v === agreed ? held.cursor : {}
    const answer = await askLog(session, CIRCLE_SERVICES.shelf.name, { since, v: agreed })
    if (answer === null) {
      refusals += 1
      break
    }
    if (answer.pages.length === 0) {
      /* Nothing new — or nothing served any more. The probe tells them apart. */
      if (answers === 0 && held.works.length > 0) {
        calls += 1
        const pay = (bytes: number): boolean => {
          // Stryker disable next-line StringLiteral: the key names the log in the ledger, and the shelf, its probe and the lists share one on purpose — any one name they all carry behaves the same.
          const charged = charge(spend, 'shelf', bytes, ports.now(), budget)
          if (!charged.allowed) return false
          spend = charged.spend
          ports.spent(person.person, spend)
          return true
        }
        const probed = await stillServed(session, CIRCLE_SERVICES.shelf.name, held, agreed, ports.crypto, pay)
        if (probed === 'over-budget') return { calls, accepted, refusals, overBudget: true }
        if (probed === 'gone') {
          held = NOTHING_SHARED
          if (await admitted()) await ports.keepShelf(person.person, held)
        }
      }
      break
    }
    const bytes = bytesOf(answer.pages)
    /* Stryker disable next-line StringLiteral: the key names the log in the ledger, and the shelf and the lists share one on purpose — any one name they both carry behaves the same. */
    const charged = charge(spend, 'shelf', bytes, ports.now(), budget)
    if (!charged.allowed) return { calls, accepted, refusals, overBudget: true }
    spend = charged.spend
    ports.spent(person.person, spend)

    const epoch = await admitted()
    // Stryker disable next-line ConditionalExpression: the keep's own check, below, refuses the same way; this one spares the taking.
    if (epoch === null) return { calls, accepted, refusals, overBudget: false }
    const taken = takePages(
      answer.pages,
      SHELF_WORK,
      person.person,
      {
        held,
        devices: person.devices,
        revoked: person.revoked,
        epoch: person.roster.epoch,
        relationshipEpoch: epoch,
        admitted: true,
      },
      ports.crypto,
      ports.now(),
      agreed,
    )
    refusals += taken.refusals.length
    if (taken.accepted === 0) break
    held = taken.held
    if (!(await admitted())) return { calls, accepted, refusals, overBudget: false }
    await ports.keepShelf(person.person, held)
    accepted += taken.accepted
    if (!answer.more) break
  }
  return { calls, accepted, refusals, overBudget: false }
}

/**
 * The list a page is for, read from its claim before anything is verified —
 * the same early look `judge` takes at `person` and `work`, and for the same
 * reason: a page has to be filed under its list to be judged against that
 * list's chain. `null` for bytes that are not a list's page; `takePages`
 * never sees those and they count as refused.
 */
function listIdOfRaw(raw: string): string | null {
  let parsed: unknown
  /* Stryker disable BlockStatement: with the block emptied, `parsed` stays undefined and the check below answers null for it too. */
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  // Stryker restore BlockStatement
  /* Stryker disable next-line ConditionalExpression: a primitive has no `work` member, so the check below refuses it anyway. */
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const work = (parsed as Record<string, unknown>)['work']
  if (typeof work !== 'object' || work === null || Array.isArray(work)) return null
  const ids = (work as Record<string, unknown>)['ids']
  /* Stryker disable next-line MethodExpression: `listIdOf` takes one id only, so a mixed list of two is refused either way. */
  if (!Array.isArray(ids) || !ids.every((one) => typeof one === 'string')) return null
  /* Stryker disable next-line all: `listIdOf` reads the ids and nothing else. */
  return listIdOf({ ids: ids as string[], titles: [], author: '', language: '' })
}

/**
 * Ask one person for their lists — WI-23.E1. One request names a cursor per
 * list held; the answer's pages name their lists, which is how a new one is
 * discovered, and each list's pages are taken against that list's own chain.
 * A person the switch is off for answers as a reader with no lists does.
 */
async function fetchLists(
  ports: FetchPorts,
  session: Dialled,
  person: PersonToFetch,
  agreed: number,
  admitted: () => Promise<number | null>,
): Promise<BooksOutcome> {
  const budget = ports.budget ?? DEFAULT_BUDGET
  let spend = ports.spend(person.person)
  let calls = 0
  let accepted = 0
  let refusals = 0
  const held = new Map(await ports.heldLists(person.person))
  for (let answers = 0; answers < MAX_ANSWERS_PER_LOG; answers++) {
    calls += 1
    const since: Record<string, Readonly<Record<string, number>>> = {}
    for (const [id, file] of held) since[id] = file.v === agreed ? file.cursor : {}
    const answer = await askLog(session, CIRCLE_SERVICES.lists.name, { since, v: agreed })
    if (answer === null) {
      refusals += 1
      break
    }
    if (answer.pages.length === 0) {
      /* Nothing new, or nothing served any more: probe each list held, as
         the shelf is probed. A list never fetched has no page to ask for
         again; one held on another chain is asked from its start above, and
         an empty answer to THAT means it is not served, whichever chain. */
      // Stryker disable next-line ConditionalExpression: an empty answer after a full one follows a list just fetched, so a probe then finds it served.
      if (answers === 0) {
        for (const [id, file] of held) {
          if (Object.keys(file.cursor).length === 0) continue
          calls += 1
          const pay = (bytes: number): boolean => {
            // Stryker disable next-line StringLiteral: the key names the log in the ledger, and the shelf, its probe and the lists share one on purpose — any one name they all carry behaves the same.
          const charged = charge(spend, 'shelf', bytes, ports.now(), budget)
            if (!charged.allowed) return false
            spend = charged.spend
            ports.spent(person.person, spend)
            return true
          }
          const probed = await stillServedList(session, id, file, agreed, ports.crypto, pay)
          if (probed === 'over-budget') return { calls, accepted, refusals, overBudget: true }
          if (probed === 'served') continue
          if (await admitted()) await ports.keepList(person.person, id, NOTHING_SHARED)
        }
      }
      break
    }
    const bytes = bytesOf(answer.pages)
    /* Stryker disable next-line StringLiteral: the key names the log in the ledger, and the shelf and the lists share one on purpose — any one name they both carry behaves the same. */
    const charged = charge(spend, 'shelf', bytes, ports.now(), budget)
    if (!charged.allowed) return { calls, accepted, refusals, overBudget: true }
    spend = charged.spend
    ports.spent(person.person, spend)

    const byList = new Map<string, string[]>()
    for (const raw of answer.pages) {
      const id = listIdOfRaw(raw)
      /* Counted here rather than handed to `takePages`, which would refuse
         each under a claim that is not a list's — the same count, later. */
      // Stryker disable next-line all: as the note says — the count is the same by the other route.
      if (id === null) {
        refusals += 1
        continue
      }
      const group = byList.get(id)
      if (group) group.push(raw)
      else byList.set(id, [raw])
    }
    const epoch = await admitted()
    // Stryker disable next-line ConditionalExpression: the keep's own check, below, refuses the same way; this one spares the taking.
    if (epoch === null) return { calls, accepted, refusals, overBudget: false }
    let taken = 0
    for (const [id, raws] of byList) {
      const file = held.get(id) ?? NOTHING_SHARED
      const outcome = takePages(
        raws,
        listWork(id),
        person.person,
        {
          held: file,
          devices: person.devices,
          revoked: person.revoked,
          epoch: person.roster.epoch,
          relationshipEpoch: epoch,
          admitted: true,
        },
        ports.crypto,
        ports.now(),
        agreed,
      )
      refusals += outcome.refusals.length
      if (outcome.accepted === 0) continue
      // Stryker disable next-line AssignmentOperator: read only against zero below, and a count of taken pages is never zero once one was.
      taken += outcome.accepted
      held.set(id, outcome.held)
      if (!(await admitted())) return { calls, accepted, refusals, overBudget: false }
      await ports.keepList(person.person, id, outcome.held)
      /* Counted per list, once kept — a later list's refusal must not uncount an earlier one's pages already on disk. */
      accepted += outcome.accepted
    }
    if (taken === 0) break
    if (!answer.more) break
  }
  return { calls, accepted, refusals, overBudget: false }
}

/**
 * Whether a log this side holds is still served to it — the Stage C exit.
 *
 * ⚠️ **AN EMPTY ANSWER FROM A CURSOR CANNOT SAY WHICH OF TWO THINGS IT IS.**
 * "Nothing new" and "nothing served to you any more" are the same bytes, by
 * WI-23.C2's own falsifier — a person the switch was turned off for must be
 * answered exactly as a reader who owns nothing is. So this side asks for the
 * LAST page it holds again, from one sequence before its cursor: a publisher
 * still serving it re-sends that page, byte for byte, and its hash is the
 * chain head already held; a publisher that has stopped answers nothing. The
 * page is not taken — it is held already — only compared. Costs one call and
 * one page per round that found nothing new, and only for a log this side
 * holds something of; the answer is what lets a shelf, or a list, disappear
 * from this side within one cadence of the switch going off.
 */
/**
 * What a probe found: the log still served, gone, or the answer unpaid for.
 *
 * THREE ANSWERS, NOT TWO. An unpaid probe used to read as "still served",
 * which kept what was held — right — and said nothing about the budget —
 * wrong: the next probe, and the next log, went on downloading over it.
 */
type Probed = 'served' | 'gone' | 'over-budget'

async function stillServed(
  session: Dialled,
  service: string,
  held: ForeignFile,
  agreed: number,
  crypto: PageCrypto,
  pay: (bytes: number) => boolean,
): Promise<Probed> {
  return stillServedAt(session, service, held, {}, agreed, crypto, pay)
}

async function stillServedList(
  session: Dialled,
  id: string,
  held: ForeignFile,
  agreed: number,
  crypto: PageCrypto,
  pay: (bytes: number) => boolean,
): Promise<Probed> {
  return stillServedAt(session, CIRCLE_SERVICES.lists.name, held, { list: id }, agreed, crypto, pay)
}

async function stillServedAt(
  session: Dialled,
  service: string,
  held: ForeignFile,
  name: { readonly list?: string },
  agreed: number,
  crypto: PageCrypto,
  /** Charge the probe's answer; false is a budget spent, and a probe unpaid for keeps what is held. */
  pay: (bytes: number) => boolean,
): Promise<Probed> {
  /* The device whose last page is asked for again: the one furthest along,
     and at a tie the first held. */
  const furthest = Object.entries(held.cursor).sort((a, b) => b[1] - a[1])[0]
  // Stryker disable next-line StringLiteral: any word but 'gone' and 'over-budget' keeps what is held.
  if (furthest === undefined) return 'served'
  const [device, seq] = furthest
  const before = { ...held.cursor, [device]: Math.max(0, seq - 1) }
  const since = name.list === undefined ? before : { [name.list]: before }
  const answer = await askLog(session, service, { since, v: agreed })
  // Stryker disable next-line StringLiteral: as above.
  if (answer === null) return 'served'
  /* ⚠️ **A PROBE IS AN ANSWER, AND ANSWERS ARE PAID FOR.** The page it
     carries is the same size as any other; unbudgeted, a held shelf per
     friend per round was free bandwidth nobody was counting. */
  if (!pay(bytesOf(answer.pages))) return 'over-budget'
  const head = held.heads[device]
  return answer.pages.some((raw) => chainHash(crypto, raw) === head) ? 'served' : 'gone'
}

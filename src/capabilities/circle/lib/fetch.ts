import {
  DEFAULT_BUDGET,
  SHELF_WORK,
  acceptsTransport,
  chainHash,
  listIdOf,
  listWork,
  type Budget,
  type PageCrypto,
  type Relationship,
  compareHlc,
} from '../../../kernel'
import { claimOf, type BookLike } from './exchange'
import {
  CIRCLE_PROTO,
  CIRCLE_SERVICES,
  CIRCLE_VERSION,
  MAX_LISTS_PER_REQUEST,
  parseCircleWelcome,
  parsePagesAnswer,
  type PagesAnswer,
} from './protocol'
import { takePages, type Ledger } from './receive'
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
 *   a refusal ends that person's round. The ledger is the caller's to keep
 *   (`FetchPorts.charge`).
 * - **A bounded number of answers per log per round.** `more` is followed, but
 *   not for ever: a publisher answering `more: true` indefinitely costs this
 *   side `MAX_ANSWERS_PER_LOG` calls and then the next round.
 *
 * ## Every device is asked; one that is asleep is skipped, not failed
 *
 * A device serves only its own stream (`pagesOver`), so the person's devices
 * are each dialled in turn. `keeper.rs`'s rule for introductions, applied
 * here: a dial that does not answer moves to the person's next device, and a
 * person with no device awake is reported and left for the next round. One
 * friend's laptop being shut must not cost the round every other friend.
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
  /**
   * Write what was taken. `epoch` is the relationship epoch the pages were
   * recorded under: a keep is refused, inside the file's own lane, for a
   * person no longer admitted in that epoch — the round's own re-check runs
   * before the lane is taken, and a purge can take it in between.
   */
  readonly keep: (bookId: string, person: string, held: ForeignFile, epoch: number) => Promise<void>
  /** The person's SHELF as this device holds it, and where to put it — WI-23.C3. */
  readonly heldShelf: (person: string) => Promise<ForeignFile>
  readonly keepShelf: (person: string, held: ForeignFile, epoch: number) => Promise<void>
  /** The person's LISTS as this device holds them, by id, and where to put one — WI-23.E1. */
  readonly heldLists: (person: string) => Promise<ReadonlyMap<string, ForeignFile>>
  readonly keepList: (person: string, listId: string, held: ForeignFile, epoch: number) => Promise<void>
  /**
   * Charge one answer to the person's budget — read, decided and committed
   * in ONE step by the ledger, so a jacket charged between two of a round's
   * awaits is not written over. `false` is a budget spent.
   */
  readonly charge: (person: string, key: string, bytes: number, now: number, budget?: Budget) => boolean
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

/** What one log's fetch did — and the two ways a person's round ends short. */
interface LogOutcome {
  readonly calls: number
  readonly accepted: number
  readonly refusals: number
  /** The person's budget ran out: their round ends here. */
  readonly overBudget: boolean
  /**
   * The person is no longer admitted as they were when the round began — a
   * block landed, or the roster moved — so their round ends here and nothing
   * more is written.
   *
   * ⚠️ **AN OUTCOME OF ITS OWN, AND IT USED TO BE THE ORDINARY ONE.** A helper
   * that found the record gone answered as though it had simply finished, so
   * the round went on to the shelf and the lists of a person it had just
   * been told not to read — and reported no reason.
   */
  readonly stopped: boolean
}

const NOTHING_DONE: LogOutcome = { calls: 0, accepted: 0, refusals: 0, overBudget: false, stopped: false }

const sum = (a: LogOutcome, b: LogOutcome): LogOutcome => ({
  calls: a.calls + b.calls,
  accepted: a.accepted + b.accepted,
  refusals: a.refusals + b.refusals,
  overBudget: a.overBudget || b.overBudget,
  stopped: a.stopped || b.stopped,
})

/**
 * One round: every admitted person, every device of theirs that answers,
 * every log.
 *
 * ⚠️ **EVERY DEVICE THAT ANSWERS, NOT THE FIRST.** A person's devices are
 * separate streams, and a device serves only its own (`pagesOver`): the
 * laptop cannot serve what the phone published, however their stores have
 * met. Dialling the first device that answered meant an always-on laptop
 * kept the phone's passages from ever arriving. Each device is dialled in
 * turn; one asleep is skipped for the next, and only a person with NO device
 * awake is reported asleep.
 */
export async function fetchRound(ports: FetchPorts): Promise<RoundReport> {
  const empty: RoundReport = { asked: 0, calls: 0, accepted: 0, refusals: 0, skipped: [] }
  const mine = await ports.mine()
  /* No identity is the ordinary state of a reader who never shared, and it is
     not a failure — there is simply nobody to ask AS. */
  if (mine === null) return empty

  const dialable = await ports.dialable()
  let asked = 0
  let done = NOTHING_DONE
  const skipped: Skipped[] = []

  for (const person of await ports.people()) {
    /* EVERYTHING ABOUT ONE PERSON IS INSIDE THE ONE BOUNDARY — the record
       read and the dials included. A relationship file that would not read
       used to throw from outside the `try` and end the round for every
       person after them. */
    try {
      const outcome = await fetchPerson(ports, person, dialable, mine.person)
      done = sum(done, outcome.done)
      if (outcome.asked) asked += 1
      if (outcome.skipped !== null) skipped.push(outcome.skipped)
    } catch (cause) {
      /* One person failing must not cost the round the people after them. */
      skipped.push({ person: person.person, why: 'failed', detail: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return { asked, calls: done.calls, accepted: done.accepted, refusals: done.refusals, skipped }
}

/**
 * One person's round: the relationship's say, the candidate devices, and a
 * dial to each in turn — the per-person policy, apart from the loop over
 * people and the report.
 */
async function fetchPerson(
  ports: FetchPorts,
  person: PersonToFetch,
  dialable: ReadonlySet<string>,
  me: string,
): Promise<{ readonly done: LogOutcome; readonly asked: boolean; readonly skipped: Skipped | null }> {
  const relationship = await ports.relationship(person.person)
  if (!acceptsTransport(relationship.state)) return { done: NOTHING_DONE, asked: false, skipped: { person: person.person, why: 'not-admitted' } }
  const candidates = person.devices.filter((device) => dialable.has(device) && !person.revoked.includes(device))
  if (candidates.length === 0) return { done: NOTHING_DONE, asked: false, skipped: { person: person.person, why: 'no-device' } }
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
  let done = NOTHING_DONE
  let answered = 0
  let welcomed = 0
  // Stryker disable next-line StringLiteral: never read — a device that would not answer overwrites it before it is reported.
  let asleep = 'no device to dial'
  let ended: Skip | null = null
  for (const device of candidates) {
    let session: Dialled
    try {
      session = await ports.dial(device)
    } catch (cause) {
      /* Asleep, or unreachable from here. The next device, then the next
         round — `keeper.rs`'s rule for an introduction that does not
         answer. The reason is kept, so a failure that is not sleep — a
         bad grant, a misconfiguration — reads as what it is. */
      asleep = cause instanceof Error ? cause.message : String(cause)
      continue
    }
    answered += 1
    try {
      const outcome = await fetchFromDevice(ports, session, device, person, me, admitted)
      done = sum(done, outcome.done)
      if (outcome.welcomed) welcomed += 1
      ended = outcome.ended
    } catch (cause) {
      /* A failure past the dial is the person's, and they were ASKED: the
         hello went out. Reported as failed, and their round ends here. */
      return { done, asked: true, skipped: { person: person.person, why: 'failed', detail: cause instanceof Error ? cause.message : String(cause) } }
    } finally {
      /* Said, not swallowed: a session that would not close is a
         transport problem the round can go on past, and the only
         evidence of it. */
      await session.close().catch((cause: unknown) => {
        console.warn(`Paper: could not close the session with ${person.person}`, cause)
      })
    }
    /* A budget spent, or a person no longer admitted, ends the person —
       every device of theirs — here. */
    if (ended !== null) break
  }
  /* Asked, from the first device that answered — whatever the rest of the
     person's round did, the hello went out. */
  if (answered === 0) return { done, asked: false, skipped: { person: person.person, why: 'asleep', detail: asleep } }
  if (ended !== null) return { done, asked: true, skipped: { person: person.person, why: ended } }
  if (welcomed === 0) return { done, asked: true, skipped: { person: person.person, why: 'refused-hello' } }
  return { done, asked: true, skipped: null }
}

/** Whether a person's roster is the one a round started with — devices, revocations and epoch alike. */
function sameRoster(now: PersonToFetch, before: PersonToFetch): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((one, i) => one === b[i])
  return now.roster.epoch === before.roster.epoch && same(now.devices, before.devices) && same(now.revoked, before.revoked)
}

/**
 * One device's share of a person's round: the hello, then every log it
 * serves — the books, then the shelf, then the lists.
 *
 * ⚠️ **THE ANSWERING DEVICE MUST SPEAK FOR THE PERSON DIALLED.** A welcome
 * naming somebody else is a device on the wrong roster — every page it served
 * would be refused `wrong-person` anyway, but paying for the pages to learn
 * that is paying twice. Not welcomed, nothing more is asked of it.
 */
async function fetchFromDevice(
  ports: FetchPorts,
  session: Dialled,
  device: string,
  person: PersonToFetch,
  me: string,
  admitted: () => Promise<number | null>,
): Promise<{ readonly done: LogOutcome; readonly welcomed: boolean; readonly ended: 'over-budget' | 'not-admitted' | null }> {
  const welcome = parseCircleWelcome(
    await session.call(CIRCLE_SERVICES.hello.name, {
      proto: CIRCLE_PROTO,
      pages: CIRCLE_VERSION,
      person: me,
    }),
  )
  if (welcome === null || welcome.person !== person.person) return { done: NOTHING_DONE, welcomed: false, ended: null }
  const agreed = welcome.agreed
  /* The books; the shelf, from a peer that publishes one — v1 has no shelf;
     the lists, last — a v3 log, and the least used. */
  const phases: (() => Promise<LogOutcome>)[] = [
    () => fetchBooks(ports, session, person, agreed, admitted),
    ...(agreed >= 2 ? [() => fetchShelf(ports, session, device, person, agreed, admitted)] : []),
    ...(agreed >= 3 ? [() => fetchLists(ports, session, device, person, agreed, admitted)] : []),
  ]
  let done = NOTHING_DONE
  for (const phase of phases) {
    const outcome = await phase()
    done = sum(done, outcome)
    if (outcome.overBudget) return { done, welcomed: true, ended: 'over-budget' }
    if (outcome.stopped) return { done, welcomed: true, ended: 'not-admitted' }
  }
  return { done, welcomed: true, ended: null }
}

/**
 * What a probe found: the log still served, the answer unpaid for, or the
 * person no longer admitted. `gone` is the probe's own business — it clears
 * what it holds before answering `served`.
 */
type Probed = 'served' | 'over-budget' | 'stopped'

/** One log to fetch — what the three logs each supply to `fetchLog`. */
interface LogFetch {
  /** The ledger key the answers are charged under. */
  readonly key: string
  /** Ask once, from the cursor as it stands. */
  readonly ask: () => Promise<PagesAnswer | null>
  /**
   * Take the pages and keep what was taken, under the epoch the record
   * answered before the take — or `null` when the record no longer admits
   * the person by the time the keep would land.
   */
  readonly take: (pages: readonly string[], epoch: number) => Promise<{ readonly accepted: number; readonly refusals: number } | null>
  /**
   * When the FIRST answer is empty: whether the log is still served —
   * probing what is held, paying for the probe, and clearing what is no
   * longer served. Absent for a log with nothing to probe.
   */
  readonly probe?: (pay: (bytes: number) => boolean) => Promise<{ readonly verdict: Probed; readonly calls: number }>
}

/**
 * One log, asked for from its cursor until it is caught up — the primitive
 * the three logs share, so a bound, a charge or a re-check fixed here is
 * fixed for the books, the shelf and the lists alike. They had each carried
 * their own copy, and the copies had drifted.
 *
 * Bounded three ways, as the module header says: at most
 * `MAX_ANSWERS_PER_LOG` answers; each answer charged BEFORE a page is parsed
 * — `importLimits.ts`: a bound that runs after the read has not bounded
 * anything — and the record asked again before every take and every keep.
 */
async function fetchLog(ports: FetchPorts, person: PersonToFetch, admitted: () => Promise<number | null>, log: LogFetch): Promise<LogOutcome> {
  const budget = ports.budget ?? DEFAULT_BUDGET
  /* ⚠️ **ONE CHARGE, NOT A READ AND A WRITE.** The ledger reads, decides and
     commits in a single step; a snapshot held here across the awaits was
     written back over the jackets' charges. */
  const pay = (bytes: number): boolean => ports.charge(person.person, log.key, bytes, ports.now(), budget)
  let calls = 0
  let accepted = 0
  let refusals = 0
  const outcome = (over: Partial<LogOutcome> = {}): LogOutcome => ({ calls, accepted, refusals, overBudget: false, stopped: false, ...over })
  for (let answers = 0; answers < MAX_ANSWERS_PER_LOG; answers++) {
    calls += 1
    const answer = await log.ask()
    if (answer === null) {
      /* An answer this build cannot read is one refusal for the log, and no
         further question to a peer that answers in a shape we do not. */
      refusals += 1
      break
    }
    if (answer.pages.length === 0) {
      /* Nothing new — or nothing served any more. The probe tells them
         apart, and only on the first answer: an empty answer after a full
         one follows a log just fetched. */
      if (answers === 0 && log.probe !== undefined) {
        const probed = await log.probe(pay)
        calls += probed.calls
        if (probed.verdict === 'over-budget') return outcome({ overBudget: true })
        if (probed.verdict === 'stopped') return outcome({ stopped: true })
      }
      break
    }
    if (!pay(bytesOf(answer.pages))) return outcome({ overBudget: true })
    /* The record, read again: a block since the round began ends this
       person's round here, and a re-admission since records what follows
       under the new epoch. */
    const epoch = await admitted()
    if (epoch === null) return outcome({ stopped: true })
    const taken = await log.take(answer.pages, epoch)
    if (taken === null) return outcome({ stopped: true })
    refusals += taken.refusals
    if (taken.accepted === 0) break
    accepted += taken.accepted
    if (!answer.more) break
  }
  return outcome()
}

/** The ledger a page is judged against: what is held, and the roster as this side holds it. */
function ledgerFor(held: ForeignFile, person: PersonToFetch, epoch: number): Ledger {
  return { held, devices: person.devices, revoked: person.revoked, epoch: person.roster.epoch, relationshipEpoch: epoch, admitted: true }
}

/**
 * ⚠️ **`since` IS ONLY MEANINGFUL ON THE CHAIN IT WAS TAKEN FROM.** A cursor
 * held for another version is a position on another chain, and asking from
 * it would skip the new chain's opening pages for ever.
 */
const sinceOf = (held: ForeignFile, agreed: number): Readonly<Record<string, number>> => (held.v === agreed ? held.cursor : {})

/** Every book on the shelf, from this person, from the cursor each file holds. */
async function fetchBooks(
  ports: FetchPorts,
  session: Dialled,
  person: PersonToFetch,
  /** The page version the hello agreed on — which chain to ask for and take. */
  agreed: number,
  /** The relationship's current epoch when it still admits them, else null — asked before every take. */
  admitted: () => Promise<number | null>,
): Promise<LogOutcome> {
  let done = NOTHING_DONE
  for (const book of ports.books()) {
    const work = claimOf(book)
    let held = await ports.held(book.id, person.person)
    const outcome = await fetchLog(ports, person, admitted, {
      /* Keyed per book, because this side names the work by its own book and
         the peer's claim is what it is answering about. */
      key: book.id,
      /* A v1 peer's strict parser refuses a member it does not know, so `v`
         is named only when the agreed version is one that knows it. */
      ask: () => askLog(session, CIRCLE_SERVICES.pages.name, { work, since: sinceOf(held, agreed), ...(agreed > 1 ? { v: agreed } : {}) }),
      take: async (pages, epoch) => {
        const taken = takePages(pages, work, person.person, ledgerFor(held, person, epoch), ports.crypto, ports.now(), agreed)
        if (taken.accepted === 0) return { accepted: 0, refusals: taken.refusals.length }
        held = taken.held
        /* Kept per answer, not per book: a round interrupted after the third
           answer has the first three on disk, cursor and all. COUNTED once
           kept: a page taken and not written is not a page the report may
           call accepted. */
        if ((await admitted()) === null) return null
        await ports.keep(book.id, person.person, held, epoch)
        return { accepted: taken.accepted, refusals: taken.refusals.length }
      },
    })
    done = sum(done, outcome)
    if (outcome.overBudget || outcome.stopped) return done
  }
  return done
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
  device: string,
  person: PersonToFetch,
  agreed: number,
  admitted: () => Promise<number | null>,
): Promise<LogOutcome> {
  let held = await ports.heldShelf(person.person)
  return fetchLog(ports, person, admitted, {
    // Stryker disable next-line StringLiteral: the key names the log in the ledger, and the shelf, its probe and the lists share one on purpose — any one name they all carry behaves the same.
    key: 'shelf',
    ask: () => askLog(session, CIRCLE_SERVICES.shelf.name, { since: sinceOf(held, agreed), v: agreed }),
    take: async (pages, epoch) => {
      const taken = takePages(pages, SHELF_WORK, person.person, ledgerFor(held, person, epoch), ports.crypto, ports.now(), agreed)
      if (taken.accepted === 0) return { accepted: 0, refusals: taken.refusals.length }
      held = taken.held
      if ((await admitted()) === null) return null
      await ports.keepShelf(person.person, held, epoch)
      return { accepted: taken.accepted, refusals: taken.refusals.length }
    },
    probe: async (pay) => {
      /* Nothing held, or nothing held FROM THIS DEVICE: nothing to ask for again. */
      if (held.works.length === 0 || held.cursor[device] === undefined) return { verdict: 'served', calls: 0 }
      const probed = await stillServedAt(session, CIRCLE_SERVICES.shelf.name, held, {}, device, agreed, ports.crypto, pay)
      if (probed === 'over-budget') return { verdict: 'over-budget', calls: 1 }
      if (probed === 'gone') {
        held = withoutStream(held, device)
        const still = await admitted()
        if (still === null) return { verdict: 'stopped', calls: 1 }
        await ports.keepShelf(person.person, held, still)
      }
      return { verdict: 'served', calls: 1 }
    },
  })
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
 * The lists a request names a cursor for — a WINDOW over what is held,
 * within what a request may carry, that moves with the clock.
 *
 * ⚠️ **BOUNDED, BECAUSE THE PEER'S PARSER IS.** A request naming every held
 * list was refused whole once sixty-five were held, and list synchronisation
 * stopped for good. The publisher holds its own lists to the same bound
 * (`listsPort`), so an honest peer never reaches it; past it, the window is
 * rotated by the clock so every list is named within a few rounds, and a
 * held list OUTSIDE the window is not taken from — the peer serves it from
 * its start, and pages from the start of a chain this side already holds
 * would only fail that chain. A list not held at all is always taken: there
 * is nothing to name and nothing to fail.
 */
export function listWindowOf(ids: readonly string[], now: number): readonly string[] {
  const sorted = [...ids].sort()
  if (sorted.length <= MAX_LISTS_PER_REQUEST) return sorted
  /* A whole window on per cadence, not one list: every list is named within
     as many rounds as there are windows over them. */
  const start = ((Math.floor(now / LIST_WINDOW_ROTATES_MS) % sorted.length) * MAX_LISTS_PER_REQUEST) % sorted.length
  return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, MAX_LISTS_PER_REQUEST)
}

/** How often the window over a person's lists moves on — one cadence. */
export const LIST_WINDOW_ROTATES_MS = 5 * 60_000

function cursorsOf(held: ReadonlyMap<string, ForeignFile>, window: readonly string[], agreed: number): Readonly<Record<string, Readonly<Record<string, number>>>> {
  const since: Record<string, Readonly<Record<string, number>>> = {}
  for (const id of window) since[id] = sinceOf(held.get(id)!, agreed)
  return since
}

/**
 * What is held with one device's stream dropped — its cursor, its head and
 * the rows it published — and NOTHING once no stream is left.
 *
 * ⚠️ **A DEVICE THAT NO LONGER SERVES ITS PAGE SAYS SO FOR ITSELF.** A
 * device answers a probe only about its own stream, so its silence is about
 * that stream: dropped whole for it, the shelf lost what the person's other
 * devices published, on one device's word. Each device that answers gone in
 * turn takes its own stream with it — and with the switch off every device
 * does, which is the person-wide confirmation that empties the file within
 * one round. A row kept before devices were stamped can be nobody's but the
 * device that served it, and goes with the first stream that goes.
 */
function withoutStream(held: ForeignFile, device: string): ForeignFile {
  const { [device]: _cursor, ...cursor } = held.cursor
  const { [device]: _head, ...heads } = held.heads
  if (Object.keys(cursor).length === 0) return NOTHING_SHARED
  const theirs = (row: { readonly device?: string }): boolean => row.device === undefined || row.device === device
  return {
    ...held,
    cursor,
    heads,
    works: held.works.filter((row) => !theirs(row)),
    list: { ...held.list, items: held.list.items.filter((item) => !theirs(item)) },
  }
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
  device: string,
  person: PersonToFetch,
  agreed: number,
  admitted: () => Promise<number | null>,
): Promise<LogOutcome> {
  const held = new Map(await ports.heldLists(person.person))
  /* The window over what is held, taken afresh before each ask: a list
     discovered by one answer is held by the next, and must be named. */
  let window = new Set<string>()
  return fetchLog(ports, person, admitted, {
    // Stryker disable next-line StringLiteral: as the shelf's — one key on purpose.
    key: 'shelf',
    ask: () => {
      window = new Set(listWindowOf([...held.keys()], ports.now()))
      return askLog(session, CIRCLE_SERVICES.lists.name, { since: cursorsOf(held, [...window], agreed), v: agreed })
    },
    take: async (pages, epoch) => {
      const byList = new Map<string, string[]>()
      let refusals = 0
      for (const raw of pages) {
        const id = listIdOfRaw(raw)
        /* Counted here rather than handed to `takePages`, which would refuse
           each under a claim that is not a list's — the same count, later. */
        // Stryker disable next-line all: as the note says — the count is the same by the other route.
        if (id === null) {
          refusals += 1
          continue
        }
        /* A held list the window left out: served from its start, and the
           start of a chain this side holds the head of would only be refused
           as a gap. Its turn comes with the window; see `listWindowOf`. */
        if (held.has(id) && !window.has(id)) continue
        const group = byList.get(id)
        if (group) group.push(raw)
        else byList.set(id, [raw])
      }
      let accepted = 0
      for (const [id, raws] of byList) {
        const file = held.get(id) ?? NOTHING_SHARED
        const outcome = takePages(raws, listWork(id), person.person, ledgerFor(file, person, epoch), ports.crypto, ports.now(), agreed)
        refusals += outcome.refusals.length
        if (outcome.accepted === 0) continue
        held.set(id, outcome.held)
        if ((await admitted()) === null) return null
        await ports.keepList(person.person, id, outcome.held, epoch)
        /* Counted per list, once kept — a later list's refusal must not uncount an earlier one's pages already on disk. */
        accepted += outcome.accepted
      }
      return { accepted, refusals }
    },
    probe: async (pay) => {
      /* Each list held, as the shelf is probed. A list this device never
         served us has nothing to ask for again; one held on another chain is
         asked from its start above, and an empty answer to THAT means it is
         not served, whichever chain. */
      let calls = 0
      for (const [id, file] of held) {
        if (file.cursor[device] === undefined) continue
        calls += 1
        if (!window.has(id)) continue
        const probed = await stillServedAt(session, CIRCLE_SERVICES.lists.name, file, { list: id }, device, agreed, ports.crypto, pay)
        if (probed === 'over-budget') return { verdict: 'over-budget', calls }
        if (probed === 'served') continue
        const still = await admitted()
        if (still === null) return { verdict: 'stopped', calls }
        await ports.keepList(person.person, id, withoutStream(file, device), still)
      }
      return { verdict: 'served', calls }
    },
  })
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
 *
 * ⚠️ **THE DIALLED DEVICE'S OWN CURSOR, NOT THE FURTHEST.** A device serves
 * only its own stream, so asked for another device's last page it answers
 * nothing — and the probe read that as the whole log gone, and cleared what
 * was held. A device this side holds no page from is not probed: it has
 * nothing to re-send, and its silence says nothing.
 */
type ProbeAnswer = 'served' | 'gone' | 'over-budget'

async function stillServedAt(
  session: Dialled,
  service: string,
  held: ForeignFile,
  name: { readonly list?: string },
  device: string,
  agreed: number,
  crypto: PageCrypto,
  /** Charge the probe's answer; false is a budget spent, and a probe unpaid for keeps what is held. */
  pay: (bytes: number) => boolean,
): Promise<ProbeAnswer> {
  const seq = held.cursor[device]
  // Stryker disable next-line StringLiteral: any word but 'gone' and 'over-budget' keeps what is held.
  if (seq === undefined) return 'served'
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

import {
  WIRE_VERSION,
  chainHash,
  checkPage,
  compareEntries,
  compareItems,
  isCanonical,
  isPageShape,
  type Entry,
  type ListItem,
  type Hlc,
  type Page,
  type PageCrypto,
  type PageRefusal,
  type WorkClaim,
} from '../../../kernel'
import { matchWork } from '../../../kernel'
import type { ForeignFile, HeldList, HeldOpinion } from './store'

/**
 * Taking a page from somebody, and deciding whether to believe it — WI-22.C4.
 *
 * PURE. Everything that touches a disk, a clock or a key is a parameter, so
 * every refusal below is reachable from a test rather than from a live peer.
 *
 * ## Why the page's own roster is not trusted
 *
 * ⚠️ **`Page.roster` IS COVERED BY THE PAGE'S SIGNATURE, WHICH IS THE DEVICE'S
 * — NOT THE PERSON'S.** So a device can put itself on a roster it is not on,
 * sign that, and present it as evidence that it may speak. The field cannot
 * establish what it looks like it establishes, and a receiver that used it
 * would be asking the suspect for its own alibi.
 *
 * The roster this side checks against is the one it HOLDS, which arrived
 * root-signed over the introduction ALPN (`circle.rs`) and was verified there.
 * That is what makes revocation work at all: the person says who their devices
 * are, and no device gets a vote.
 *
 * `wire.md` says a page carries the roster because it is *"needed to check
 * it"*. It is needed to check the page against a roster the receiver already
 * trusts — not to supply one.
 */

/** Why a page was not taken. `PageRefusal` plus what happens before it. */
export type Refusal =
  | PageRefusal
  | 'unparseable'
  | 'wrong-person'
  | 'wrong-work'
  | 'bad-delegation'
  | 'not-admitted'

/** A delegation as `person.rs` mints and signs it. */
export interface SignedDelegation {
  readonly person: string
  readonly device: string
  readonly notBefore: number
  readonly notAfter: number
  /** The roster EPOCH it was minted under — `Version.epoch`. */
  readonly roster: number
  readonly sig: string
}

/**
 * The exact bytes a delegation's signature covers.
 *
 * ⚠️ **THIS REPRODUCES `Delegation::signed_bytes` IN `person.rs`, BYTE FOR
 * BYTE, AND THE TWO MUST NEVER DRIFT.** A fixed field order written by hand on
 * both sides rather than a canonical JSON on both sides — deliberately.
 * `wire.md` names two canonicalisers disagreeing about key order as *"a
 * signature that verifies on one machine and fails on another"*, and the
 * cheapest way not to have that problem is not to have two canonicalisers: six
 * fields joined by newlines is a format neither side can implement two ways.
 *
 * `crypto.test.ts` and `person.rs` pin the same golden vector for it.
 */
export function delegationBytes(delegation: SignedDelegation): string {
  return [
    'paper/circle/delegation/1',
    delegation.person,
    delegation.device,
    String(delegation.notBefore),
    String(delegation.notAfter),
    String(delegation.roster),
  ].join('\n')
}

/**
 * Whether a value is a delegation of the shape `person.rs` emits.
 *
 * ⚠️ **THE THREE `typeof` CHECKS BELOW DECIDE NOTHING AND ARE STILL RIGHT TO
 * KEEP.** Mutation testing showed each one unobservable through this module's
 * only caller, and the reason is worth writing down rather than deleting the
 * checks over: `readDelegation` compares `person` against the id it was asked
 * about, and verifies `sig` — so a delegation with a numeric `person` or `sig`
 * is refused a few lines later whatever this predicate says, and `device` is
 * compared against the page's in `canSpeak`.
 *
 * What they buy is that the TYPE GUARD is true. Without them this claims
 * `value is SignedDelegation` about a value whose `person` is a number, and
 * every reader downstream is entitled to believe it. A guard that lies is
 * worse than a redundant check, so the checks stay and the mutants are named
 * for what they are.
 */
function isDelegation(value: unknown): value is SignedDelegation {
  /* Stryker disable next-line ConditionalExpression: a non-object has none of
     the six members, so the key-set check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const held = value as Record<string, unknown>
  /* ⚠️ **A COUNT, BECAUSE EVERY NAME IS CHECKED BELOW.** `person`, `device`,
   * `notBefore`, `notAfter`, `roster` and `sig` each get their own line, and a
   * missing one reads as `undefined` and fails there — so the only thing left
   * to establish is that there is nothing ELSE. An unknown member is a field
   * the signer can use to mean something the verifier never saw (`wire.md`,
   * and the whole reason this parser is strict where the rest of the codebase
   * is tolerant), so "nothing else" is the load-bearing half.
   *
   * A `keys.every(hasOwn)` over a list of the six names stood here and was
   * entirely redundant; worse, once it went the list remained and still looked
   * like it validated names, while only its length was ever read. */
  const MEMBERS = 6
  if (Object.keys(held).length !== MEMBERS) return false
  // Stryker disable next-line all: see the note above — the caller's own
  // comparison refuses a non-string `person`, and `canSpeak` refuses a
  // non-string `device`. This keeps the type guard honest.
  if (typeof held['person'] !== 'string' || typeof held['device'] !== 'string') return false
  // Stryker disable next-line all: the signature check refuses a non-string
  // `sig` on the next line but one. Same reason as above.
  if (typeof held['sig'] !== 'string') return false
  return ['notBefore', 'notAfter', 'roster'].every((key) => Number.isSafeInteger(held[key]))
}

/**
 * The delegation a page carries, if the PERSON really signed it.
 *
 * ⚠️ **VERIFIED AGAINST THE PERSON KEY, WHICH IS THE PERSON ID.** A person id
 * IS their root public key — that is the whole reason `admit` can work from a
 * name alone — so there is no key to look up and no way to be handed the wrong
 * one.
 */
export function readDelegation(
  raw: string,
  person: string,
  crypto: PageCrypto,
): SignedDelegation | null {
  let parsed: unknown
  /* Stryker disable BlockStatement: with either block emptied, `parsed` stays
     `undefined` and the canonicality check below refuses it. Same answer, one
     step later, with nothing naming the cause. */
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  // Stryker restore BlockStatement
  /* Canonical, for the reason a page must be: the bytes signed are the bytes
     that arrived, and anything else is a second spelling of one statement. */
  if (!isCanonical(raw, parsed)) return null
  if (!isDelegation(parsed)) return null
  if (parsed.person !== person) return null
  if (!crypto.verify(person, delegationBytes(parsed), parsed.sig)) return null
  return parsed
}

/** What this side already knows about the person whose pages these are. */
export interface Ledger {
  /** What is held for this `(book, person)`. */
  readonly held: ForeignFile
  /**
   * The devices this person's ROOT-SIGNED roster vouches for.
   *
   * From `KnownPerson.devices`, which the introduction ALPN fills in after
   * verifying the person's signature over it. See the module header for why
   * the page's own copy is not used.
   */
  readonly devices: readonly string[]
  /** Devices this person has revoked, as this side holds them. */
  readonly revoked: readonly string[]
  /** The roster epoch this side considers current. */
  readonly epoch: number
  /** The relationship epoch entries are recorded under. */
  readonly relationshipEpoch: number
  /** Whether this person's pages are read at all — `acceptsTransport`. */
  readonly admitted: boolean
}

/** What taking a batch of pages did. */
export interface Taken {
  readonly held: ForeignFile
  readonly accepted: number
  /** One per page refused, in the order they arrived. */
  readonly refusals: readonly Refusal[]
  /**
   * The highest `seq` now held per device — the next request's cursor.
   *
   * The store's own `held.cursor`, repeated here so a caller with the answer
   * in hand does not reach into the file for it. ONE value, not two derived
   * separately: it is written into `held` and read back out.
   */
  readonly cursor: Readonly<Record<string, number>>
}

/**
 * Whether the device that signed this page may speak for its person, now.
 *
 * Runs BEFORE the signature check — see `checkPage`, which takes this as a
 * required argument so the expensive step stays last.
 */
function canSpeak(page: Page, ledger: Ledger, now: number, crypto: PageCrypto): boolean {
  const delegation = readDelegation(page.delegation, page.person, crypto)
  if (!delegation) return false
  /* The delegation must name the device that signed the page. Without this a
     device could present somebody else's valid delegation and sign with its
     own key. */
  if (delegation.device !== page.device) return false
  /* ⚠️ **NO TOLERANCE ON EXPIRY, AND FIVE MINUTES ON `notBefore`** —
     `identity.md` is explicit that the asymmetry is the point: a tolerance on
     expiry is an extension granted to exactly the device you are stopping. */
  if (now + SKEW_MS < delegation.notBefore) return false
  if (now >= delegation.notAfter) return false
  /* A delegation minted under an older roster generation is stale: a
     succession is how a person disowns everything issued before it. */
  if (delegation.roster < ledger.epoch) return false
  /* The roster this side HOLDS, not the one the page carries. */
  if (!ledger.devices.includes(page.device)) return false
  if (ledger.revoked.includes(page.device)) return false
  return true
}

/** ±5 minutes on `notBefore`, and none on `notAfter`. Mirrors `identity.ts`. */
const SKEW_MS = 5 * 60 * 1000

/**
 * Take what can be taken from a batch of pages.
 *
 * ⚠️ **ONE BAD PAGE DOES NOT DISCARD THE GOOD ONES BEFORE IT.** Pages are an
 * append-only log and each verifies alone; stopping at the first refusal would
 * make a single corrupt or hostile page cost a friend their whole history.
 * Each is judged, the refusals are reported, and what passed is kept.
 *
 * ⚠️ **BUT A REFUSED PAGE STOPS ITS OWN DEVICE'S CHAIN.** The pages after it
 * from that device would fail `chain` anyway — `prevPageHash` no longer
 * matches — and letting them through would be accepting a log with a hole in
 * it. So the chain simply does not advance, and the next fetch asks again from
 * the last good page.
 */
export function takePages(
  raws: readonly string[],
  work: WorkClaim,
  person: string,
  ledger: Ledger,
  crypto: PageCrypto,
  now: number,
  /**
   * The page version the hello agreed on — which CHAIN these pages are from.
   *
   * ⚠️ **A DIFFERENT VERSION FROM THE FILE'S IS A DIFFERENT CHAIN**, and the
   * heads and cursor held for the old one say nothing about the new. They are
   * started from nothing; what is held — the folded entries, the withdrawals
   * — stays. See `ForeignFile.v`.
   */
  version: number = WIRE_VERSION,
): Taken {
  /* ⚠️ **A BLOCKED OR EXITED PERSON'S PAGES ARE NOT PARSED**, not merely not
   * drawn. `relationships.md` makes the transport the boundary, and a parse is
   * work a blocked peer must not be able to ask for. */
  if (!ledger.admitted) {
    return {
      held: ledger.held,
      accepted: 0,
      refusals: raws.map(() => 'not-admitted' as const),
      cursor: ledger.held.cursor,
    }
  }

  const sameChain = ledger.held.v === version
  const refusals: Refusal[] = []
  let heads: Record<string, string> = sameChain ? { ...ledger.held.heads } : {}
  /* ⚠️ **ADVANCED FROM WHAT WAS ACCEPTED, NEVER FROM WHAT ARRIVED.** A cursor
   * moved past a refused page is a page never fetched again, and the gap is
   * permanent and silent. `page.to` rather than the entries' own `seq`: a
   * boundary names the range the publisher SEALED, and `pagesFor` answers from
   * `since` by comparing boundaries — so the cursor has to be spoken in the
   * same units. */
  let cursor: Record<string, number> = sameChain ? { ...ledger.held.cursor } : {}
  /* Stryker disable next-line ArrayDeclaration: only a verified page's entries
     are pushed here, and a seeded string is not an entry the fold would take. */
  const taken: Entry[] = []
  /* A device whose chain has broken in this batch takes no further pages. */
  const broken = new Set<string>()
  let accepted = 0

  for (const raw of raws) {
    const refusal = judge(raw, work, person, ledger, heads, broken, crypto, now, version)
    if (typeof refusal === 'string') {
      refusals.push(refusal)
      continue
    }
    const { page } = refusal
    heads = { ...heads, [page.device]: chainHash(crypto, raw) }
    cursor = { ...cursor, [page.device]: Math.max(cursor[page.device] ?? 0, page.to) }
    taken.push(...page.entries)
    accepted += 1
  }

  const held = applyEntries({ ...ledger.held, heads, cursor, v: version }, taken, person, ledger.relationshipEpoch, now)
  return { held, accepted, refusals, cursor: held.cursor }
}

/** One page: the refusal, or the page itself. */
function judge(
  raw: string,
  work: WorkClaim,
  person: string,
  ledger: Ledger,
  heads: Readonly<Record<string, string>>,
  broken: Set<string>,
  crypto: PageCrypto,
  now: number,
  version: number,
): Refusal | { readonly page: Page } {
  let parsed: unknown
  /* Stryker disable BlockStatement: with either block emptied, the object
     check below answers `unparseable` for `undefined` too. */
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'unparseable'
  }
  // Stryker restore BlockStatement
  /* ⚠️ **THE SHAPE IS CHECKED BEFORE ANYTHING IS READ FROM IT.** A signed
   * page is still bytes a peer chose; a claim that is not a claim would throw
   * inside `matchWork`, and an entry with the wrong fields would fold to
   * something no honest log could hold — after a signature check that said it
   * was fine. `isPageShape` refuses both before either is reached. */
  if (!isPageShape(parsed)) return 'unparseable'
  const page: Page = parsed
  /* ⚠️ **THE PERSON AND THE WORK ARE CHECKED BEFORE ANYTHING EXPENSIVE.** A
   * page for somebody else's log, or another book, is a page this call has no
   * business writing anywhere — and finding that out after a signature check is
   * paying for the answer twice. */
  if (page.person !== person) return 'wrong-person'
  if (broken.has(page.device)) return 'chain'
  if (matchWork(page.work, work) === 'none') return 'wrong-work'

  const refusal = checkPage(
    page,
    raw,
    crypto,
    /* The signing key IS the device id: an endpoint id is an Ed25519 public
       key, which is why a peer never has to be told which key to check. */
    page.device,
    heads[page.device] ?? '',
    (one) => canSpeak(one, ledger, now, crypto),
    version,
  )
  if (refusal) {
    /* `may-not-speak` is reported as its own cause; everything else that
       breaks a chain stops this device for the rest of the batch. */
    if (refusal === 'chain' || refusal === 'bad-signature') broken.add(page.device)
    return refusal === 'may-not-speak' ? 'bad-delegation' : refusal
  }
  return { page }
}


/**
 * Whether an incoming entry takes a held row's place: nothing held, or a
 * held row whose stamp the entry PRECEDES. A held row with no stamp — written
 * before stamps were kept — cannot be compared and stands.
 */
function precedes(entry: Entry, held: { readonly at?: Hlc; readonly device?: string; readonly seq?: number } | undefined): boolean {
  if (held === undefined) return true
  if (held.at === undefined || held.device === undefined || held.seq === undefined) return false
  return compareEntries(entry, { at: held.at, device: held.device, seq: held.seq }) < 0
}

/**
 * Apply a log's entries to what is held — `fold`, done incrementally.
 *
 * ⚠️ **EQUIVALENT TO FOLDING THE WHOLE LOG, IN ANY ORDER, AND
 * `receive.test.ts` HOLDS THAT AS A PROPERTY.** A store keeps the FOLDED
 * result, not the log, so this has to agree with `fold` on every ordering — and
 * "agrees on the cases I thought of" is not the same claim.
 *
 * ⚠️ **A DUPLICATE `pub` KEEPS THE ENTRY ALREADY HELD.** `fold` keeps the
 * earlier stamp so *"a redelivery cannot quietly move a passage up the reader's
 * list"*; the stored entry has no `at`, so `receivedAt` is the ordering key and
 * not overwriting it is the same guarantee by the same reasoning.
 */
export function applyEntries(
  held: ForeignFile,
  incoming: readonly Entry[],
  person: string,
  epoch: number,
  receivedAt: number,
): ForeignFile {
  /* Five families, each folded by its own reducer over the same pages — so
     a kind added to one cannot reach into another's state, and each rule can
     be read on its own. The chain state — heads, cursor, version — is the
     caller's, and passes through untouched. */
  return {
    heads: held.heads,
    cursor: held.cursor,
    v: held.v,
    ...foldPassages(held, incoming, person, epoch, receivedAt),
    ...foldReviews(held, incoming, epoch),
    ...foldShelf(held, incoming, epoch),
    opinion: foldRegisters(held.opinion, incoming, epoch),
    list: foldListState(held.list, incoming, epoch),
  }
}

/**
 * A tombstoned publication kind — passages, reviews, shelf rows — folded
 * one rule: a withdrawal is remembered even for a `pub` not yet seen, and a
 * duplicate `pub` keeps the earlier entry BY STAMP.
 *
 * ⚠️ **REMEMBERED EVEN FOR A `pub` NOT YET SEEN.** Pages from two of a
 * person's devices travel independently, so a withdrawal can land before the
 * share it withdraws — and a withdrawal that is dropped comes straight back
 * when that share arrives.
 *
 * ⚠️ **A DUPLICATE `pub` KEEPS THE EARLIER ENTRY, BY STAMP — `fold`'s rule,
 * not first-arrival.** Two of a person's devices can publish one pub, and
 * their pages travel independently; a recipient that kept whichever page it
 * opened first held a different passage from a recipient that opened the
 * other, for ever. The stored row keeps its stamp so the comparison is the
 * same one `fold` makes over the whole log; a row written before stamps were
 * kept stands.
 */
function foldPublications<T extends { readonly pub: string; readonly at?: Hlc; readonly device?: string; readonly seq?: number }>(
  heldRows: readonly T[],
  heldGone: readonly string[],
  incoming: readonly Entry[],
  kinds: { readonly publish: Entry['op']; readonly withdraw: Entry['op'] },
  rowOf: (entry: Entry & { readonly pub: string }) => T,
): { readonly rows: readonly T[]; readonly gone: readonly string[] } {
  const gone = new Set(heldGone)
  const byPub = new Map(heldRows.map((one) => [one.pub, one]))
  for (const entry of incoming) {
    if (!('pub' in entry)) continue
    if (entry.op === kinds.withdraw) {
      gone.add(entry.pub)
      byPub.delete(entry.pub)
    } else if (entry.op === kinds.publish) {
      if (gone.has(entry.pub) || !precedes(entry, byPub.get(entry.pub))) continue
      byPub.set(entry.pub, rowOf(entry))
    }
  }
  return { rows: [...byPub.values()], gone: [...gone] }
}

function foldPassages(held: ForeignFile, incoming: readonly Entry[], person: string, epoch: number, receivedAt: number): Pick<ForeignFile, 'entries' | 'withdrawn'> {
  const { rows, gone } = foldPublications(held.entries, held.withdrawn, incoming, { publish: 'share', withdraw: 'unshare' }, (entry) =>
    entry.op === 'share'
      ? { pub: entry.pub, person, passage: entry.passage, epoch, receivedAt, at: entry.at, device: entry.device, seq: entry.seq }
      : unreachable(entry),
  )
  return { entries: rows, withdrawn: gone }
}

/** Its own withdrawal list, for `ForeignFile.unreviewed`'s reason: a tombstone withdraws only the kind it names. */
function foldReviews(held: ForeignFile, incoming: readonly Entry[], epoch: number): Pick<ForeignFile, 'reviews' | 'unreviewed'> {
  const { rows, gone } = foldPublications(held.reviews, held.unreviewed, incoming, { publish: 'review', withdraw: 'unreview' }, (entry) =>
    entry.op === 'review' ? { pub: entry.pub, text: entry.text, at: entry.at, epoch, device: entry.device, seq: entry.seq } : unreachable(entry),
  )
  return { reviews: rows, unreviewed: gone }
}

function foldShelf(held: ForeignFile, incoming: readonly Entry[], epoch: number): Pick<ForeignFile, 'works' | 'unshelved'> {
  const { rows, gone } = foldPublications(held.works, held.unshelved, incoming, { publish: 'shelf', withdraw: 'unshelf' }, (entry) =>
    entry.op === 'shelf' ? { pub: entry.pub, work: entry.work, at: entry.at, device: entry.device, seq: entry.seq, epoch } : unreachable(entry),
  )
  return { works: rows, unshelved: gone }
}

/**
 * ⚠️ **THE REGISTERS FOLD BY STAMP, NOT BY ARRIVAL** — WI-23.B5. The file
 * keeps the winning entry's stamp and `(device, seq)`, so the comparison here
 * is `fold`'s own, ties included, and applying pages one at a time answers
 * what folding the whole log would.
 */
function foldRegisters(held: HeldOpinion, incoming: readonly Entry[], epoch: number): HeldOpinion {
  let { status, stars, tags } = held
  for (const entry of incoming) {
    if (entry.op === 'status' && newer(entry, status)) status = { value: entry.state, at: entry.at, device: entry.device, seq: entry.seq, epoch }
    else if (entry.op === 'rate' && newer(entry, stars)) stars = { value: entry.stars, at: entry.at, device: entry.device, seq: entry.seq, epoch }
    else if (entry.op === 'tag' && newer(entry, tags)) tags = { value: entry.tags, at: entry.at, device: entry.device, seq: entry.seq, epoch }
  }
  return {
    ...(status === undefined ? {} : { status }),
    ...(stars === undefined ? {} : { stars }),
    ...(tags === undefined ? {} : { tags }),
  }
}

/**
 * The list — WI-23.E1 — folded by `foldList`'s rules, one entry at a time.
 * Stamped with the epoch as the shelf and the registers are, PART BY PART:
 * the creation with the epoch its `create` arrived under, the title with
 * its winning entry's, every item with its own — so a list retained across
 * a block is not drawn on re-admission, and nothing of it is drawn under a
 * page that arrived later under a new relationship. ⚠️ One epoch on the
 * list, moved by its newest page, let a `place` under the new relationship
 * re-expose a title and a creation that arrived under the old one. The
 * withdrawals — `delete`, `remove` — carry none; see `HeldList`.
 */
function foldListState(held: HeldList, incoming: readonly Entry[], epoch: number): HeldList {
  let { created, createdEpoch, deleted, title } = held
  const items = new Map(held.items.map((one) => [one.pub, one]))
  const removed = new Set(held.removed)
  for (const entry of incoming) {
    switch (entry.op) {
      case 'create':
        created = true
        createdEpoch = epoch
        if (newer(entry, title)) title = { value: entry.title, at: entry.at, device: entry.device, seq: entry.seq, epoch }
        break
      case 'retitle':
        if (newer(entry, title)) title = { value: entry.title, at: entry.at, device: entry.device, seq: entry.seq, epoch }
        break
      case 'delete':
        deleted = true
        break
      case 'remove':
        removed.add(entry.pub)
        items.delete(entry.pub)
        break
      case 'place': {
        if (removed.has(entry.pub) || !newer(entry, items.get(entry.pub))) break
        const item: ListItem = {
          pub: entry.pub,
          work: entry.work,
          position: entry.position,
          note: entry.note,
          at: entry.at,
          device: entry.device,
          seq: entry.seq,
          epoch,
        }
        items.set(entry.pub, item)
        break
      }
      /* Every other kind belongs to another family's reducer. */
      default:
        break
    }
  }
  return {
    created,
    ...(createdEpoch === undefined ? {} : { createdEpoch }),
    ...(title === undefined ? {} : { title }),
    deleted,
    items: [...items.values()].sort(compareItems),
    removed: [...removed],
  }
}

/** The arm `foldPublications` never reaches: it hands a reducer only the kind it named. */
// Stryker disable next-line all: unreachable by construction — the reducer is called with the kind it asked for.
function unreachable(entry: Entry): never {
  throw new Error(`receive: a ${entry.op} handed to the wrong reducer`)
}

/** Whether an entry is a later word than the register held — `fold`'s rule. */
function newer(entry: Entry, held: { readonly at: Hlc; readonly device: string; readonly seq: number } | undefined): boolean {
  return held === undefined || compareEntries(entry, held) > 0
}

import { connectToShelf, type SocketLike } from '../kernel'
import { nodeSocketOpener } from './nodeSocket'
import { remoteCaller } from './remote'
import { shelfAddress, type ShelfAddress } from './shelfAddress'
import type { ServiceCaller } from './caller'

/**
 * How `paper --shelf` reaches a shelf's web surface (WI-11.7).
 *
 * ## The credential comes from the ENVIRONMENT, and only from there
 *
 * Not from a flag, and not from a file.
 *
 * Not a flag because `scripts/shot-client.mjs` already made and reversed that
 * mistake: `--cookie` and `--code` put a credential into the shell's history
 * file and into `ps` output for every process running as this user, and that
 * script now REFUSES both flags rather than deprecating them, because "a
 * warning does not unset the exposure". A second tool re-introducing the same
 * flag would re-introduce the same leak.
 *
 * Not a file because the repository has already written down what a durable
 * credential store costs: `tauri-plugin-inference` says plainly that "the only
 * honest durable store for a credential is the OS keychain — not a file in the
 * data root, which syncs, backs up and reads as plaintext to anything with the
 * reader's disk". `peer/` is the apparent counter-example and is not one: it
 * holds a key and is explicitly EXCLUDED from backups by `identity.rs`, an
 * exclusion a new sibling directory would not inherit.
 *
 * So the same two variables `shot-client.mjs` uses, for the same surface:
 * `PAPER_CLIENT_COOKIE` and `PAPER_CLIENT_CODE`. One spelling, one story.
 *
 * ## What this cannot do
 *
 * The shelf grants a web session READS, plus `book.position` and nothing else
 * — `webhost/lib/pump.ts` sets `hasGrant` to exactly that, after an earlier
 * version granted everything and a phone that signed in once could empty the
 * library. So a write over `--shelf` is refused BY THE SHELF, with the
 * envelope's own `forbidden`, and that refusal is correct rather than a gap
 * here. A writing remote CLI needs a credential class the server does not have
 * yet; it does not need a different transport.
 */

/** The two variables, named once. Shared with `scripts/shot-client.mjs`. */
export const COOKIE_VAR = 'PAPER_CLIENT_COOKIE'
export const CODE_VAR = 'PAPER_CLIENT_CODE'
export const ORIGIN_VAR = 'PAPER_CLIENT_ORIGIN'

/** How long the two auth requests get. The socket has its own deadline. */
const HTTP_TIMEOUT_MS = 10_000

export interface ShelfLinkOptions {
  /** Whatever followed `--shelf`. */
  readonly key: string
  /** The environment, injected so a test does not mutate `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Injected for tests. Defaults to the global. */
  readonly fetch?: typeof globalThis.fetch
  /** Injected for tests. Defaults to a real Node socket carrying the cookie. */
  readonly open?: (cookie: string) => (url: string) => SocketLike
  /** Where a newly minted credential is reported. stderr, never stdout. */
  readonly note?: (line: string) => void
  readonly timeoutMs?: number
}

/**
 * The `Cookie` header value from a pairing response's `Set-Cookie`.
 *
 * Keeps the `name=value` pair and drops the attributes, which belong to a
 * browser's cookie jar and mean nothing on the way back out. The CLI therefore
 * never spells the cookie's name, and a rename on the server cannot silently
 * strand it.
 *
 * `getSetCookie()` rather than `get()` because a response may carry several
 * and `get()` folds them into one comma-joined string that cannot be split
 * again safely — an `Expires` attribute contains a comma of its own.
 */
export function cookieFrom(headers: Headers): string | null {
  const pairs = headers
    .getSetCookie()
    .map((raw) => raw.split(';', 1)[0]?.trim() ?? '')
    .filter((pair) => pair.length > 0 && pair.includes('='))
  return pairs.length === 0 ? null : pairs.join('; ')
}

/** A refusal the CLI prints as one line and exits on. */
function refuse(message: string): never {
  throw new Error(message)
}

/**
 * Spend the six digits and come back with a credential.
 *
 * `redirect: 'manual'` IS LOAD-BEARING, and it is what `shot-client.mjs`
 * already does. Node's fetch follows redirects by default, so a shelf — or
 * something answering for one — could reply 307 and have the six digits
 * re-posted, body and all, to an origin the reader never named. A redirect
 * here is not a route to follow; it is a shelf that is not where it said.
 */
async function pair(
  address: ShelfAddress,
  code: string,
  call: typeof globalThis.fetch,
): Promise<string> {
  let response: Response
  try {
    response = await call(address.submit, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (error) {
    refuse(`could not reach ${address.origin} to pair: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status >= 300 && response.status < 400) {
    refuse(`${address.origin} redirected the pairing request; that is not the shelf you named`)
  }
  /* THE SHELF'S OWN VOCABULARY, kept rather than flattened. Each of these is a
   * different thing for the reader to do, and "pairing failed" is none of
   * them. */
  if (response.status === 409) refuse(`${address.origin} is not showing a code — open Paper and ask it to pair`)
  if (response.status === 410) refuse('that code has expired — the shelf shows a new one every ninety seconds')
  if (response.status === 429) refuse('too many attempts on that code — ask the shelf for a new one')
  if (response.status === 401) refuse('that code was not right')
  if (!response.ok) refuse(`${address.origin} refused the pairing request: HTTP ${response.status}`)

  const cookie = cookieFrom(response.headers)
  /* A 204 THAT ISSUED NOTHING IS NOT A PAIRING. Reading it as one produces a
   * client that believes it is signed in and fails on every later call. */
  if (cookie === null) refuse(`${address.origin} accepted the code but issued no credential`)
  return cookie
}

/**
 * Ask the shelf whether this credential is live, BEFORE opening a socket.
 *
 * The channel cannot tell these apart: a 401 on the upgrade, a closed port and
 * a wrong host all arrive as `refused`, deliberately — a browser hides the
 * reason. So a reader whose ninety days ran out is told the shelf is
 * unreachable, and goes looking at the network.
 *
 * This is the authoritative answer, and it costs one request.
 */
async function check(
  address: ShelfAddress,
  cookie: string,
  call: typeof globalThis.fetch,
  justPaired: boolean,
): Promise<void> {
  let response: Response
  try {
    response = await call(address.session, {
      headers: { Cookie: cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (error) {
    /* AN OUTAGE IS NOT A REVOCATION. Said plainly, because the two repairs are
     * opposite: wait, versus pair again. */
    refuse(`could not reach ${address.origin}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status === 401) {
    /* THE SAME 401 MEANS TWO DIFFERENT THINGS, and only the caller knows
     * which. On a credential that arrived from the environment it is an
     * expiry or a revocation, and pairing again is the repair. One request
     * after a successful pairing it cannot be either — it means what came back
     * from `/api/auth/submit` was not a session cookie at all, which is what a
     * proxy or a captive portal answering 204 with a cookie of its own looks
     * like. Telling a reader to pair again would loop them forever. */
    refuse(
      justPaired
        ? `${address.origin} issued a credential it then would not accept — that is not the shelf answering`
        : `${address.origin} does not accept this credential — it may have been revoked or expired. ` +
            `Set ${CODE_VAR} to the six digits the shelf is showing to get a new one.`,
    )
  }
  if (!response.ok) refuse(`${address.origin} answered HTTP ${response.status} for the session check`)
}

/**
 * Build the caller for `paper --shelf <key>`.
 *
 * Throws with a one-line message for anything that stops it; `paper.ts` turns
 * that into `paper: <message>` and an exit code.
 */
export async function openShelf(options: ShelfLinkOptions): Promise<ServiceCaller> {
  const resolved = shelfAddress(options.key)
  if (!resolved.ok) refuse(resolved.message)
  const address = resolved.address
  const call = options.fetch ?? globalThis.fetch
  const opener = options.open ?? nodeSocketOpener
  const note = options.note ?? (() => {})

  /* A CREDENTIAL MINTED FOR ONE SHELF MUST NOT BE SENT TO ANOTHER.
   *
   * These variables are shared with `shot-client.mjs`, which points at a local
   * shelf by default — so a reader with one exported for local work would
   * otherwise hand it to whatever `--shelf` names next, over the network. When
   * the origin is declared, it has to agree. */
  const declared = options.env[ORIGIN_VAR]
  if (declared !== undefined && declared !== '') {
    const declaredOrigin = shelfAddress(declared)
    if (!declaredOrigin.ok || declaredOrigin.address.origin !== address.origin) {
      refuse(
        `${ORIGIN_VAR} names a different shelf than --shelf does; unset it, or point both at ${address.origin}`,
      )
    }
  }

  const existing = options.env[COOKIE_VAR]
  const code = options.env[CODE_VAR]
  let cookie: string
  let justPaired = false
  if (existing !== undefined && existing !== '') {
    cookie = existing
  } else if (code !== undefined && code !== '') {
    cookie = await pair(address, code, call)
    justPaired = true
    /* REPORTED, NEVER STORED — and to stderr, so `paper book list --json |
     * jq` is unaffected. Keeping it is the reader's decision to make with
     * whatever they already trust with credentials. */
    note(`paper: paired with ${address.origin}. To reuse this session:`)
    note(`  export ${COOKIE_VAR}='${cookie}'`)
  } else {
    refuse(
      `no credential for ${address.origin}. Set ${COOKIE_VAR} to a session you already have, ` +
        `or ${CODE_VAR} to the six digits the shelf is showing.`,
    )
  }

  await check(address, cookie, call, justPaired)

  const channel = await connectToShelf({
    url: address.socket,
    open: opener(cookie),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return remoteCaller({ channel })
}

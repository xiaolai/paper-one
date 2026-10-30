import { connectToShelf, messageOf, type SocketLike } from '../kernel'
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

/** RFC 6265 `cookie-name`: an RFC 7230 token. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/**
 * RFC 6265 `cookie-octet`: `%x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E` —
 * printable ASCII less space, `"`, `,`, `;` and backslash.
 *
 * In ESCAPES, spelled as the RFC spells them. Written as literal ranges this
 * is a line nobody can check against the specification, and the two control
 * characters already caught in this branch both entered exactly that way.
 */
const COOKIE_VALUE = /^[\u0021\u0023-\u002b\u002d-\u003a\u003c-\u005b\u005d-\u007e]*$/

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
 *
 * ## EXACTLY ONE, and it has to be well formed
 *
 * This used to join every cookie it found. Being name-agnostic is right; being
 * COUNT-agnostic is not. The shelf issues one, so anything else on that
 * response is somebody else's — a proxy's, a portal's — and joining them
 * forwarded all of it to `/api/auth/session`, to the socket handshake, and
 * onto the reader's terminal as a credential to keep.
 *
 * Refusing more than one keeps the name unspelled and still takes only what
 * the shelf issued.
 *
 * The shape is checked too, because this value becomes a `Cookie` REQUEST
 * HEADER: a control character in it is header injection, and neither the
 * check nor the refusal can be written against a name we deliberately do not
 * know.
 */

export function cookieFrom(headers: Headers): string | null {
  const pairs = headers
    .getSetCookie()
    .map((raw) => raw.split(';', 1)[0]?.trim() ?? '')
    .filter((pair) => pair.length > 0)
  if (pairs.length !== 1) return null
  return wellFormedCookie(pairs[0] as string) ? (pairs[0] as string) : null
}

/** Whether `pair` is one `name=value` this is willing to put in a header. */
export function wellFormedCookie(pair: string): boolean {
  const at = pair.indexOf('=')
  if (at <= 0) return false
  const value = pair.slice(at + 1)
  return COOKIE_NAME.test(pair.slice(0, at)) && COOKIE_VALUE.test(unquoted(value))
}

/** A cookie value may be wrapped in double quotes; the quotes are not the value. */
function unquoted(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
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
    refuse(`could not reach ${address.origin} to pair: ${messageOf(error)}`)
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
/** What the shelf says about a credential. An OUTAGE still throws. */
type SessionState = 'live' | 'refused'

async function sessionState(
  address: ShelfAddress,
  cookie: string,
  call: typeof globalThis.fetch,
): Promise<SessionState> {
  let response: Response
  try {
    response = await call(address.session, {
      headers: { Cookie: cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (error) {
    /* AN OUTAGE IS NOT A REVOCATION. Raised rather than returned, because the
     * two repairs are opposite — wait, versus pair again — and a caller that
     * had to tell them apart from a return value would get it wrong once. */
    refuse(`could not reach ${address.origin}: ${messageOf(error)}`)
  }
  /* A 401 IS RETURNED, NOT RAISED. It means two different things depending on
   * where the credential came from, and this function does not know: from the
   * environment it is an expiry the caller may be able to repair with a code;
   * one request after pairing it means what `/api/auth/submit` returned was
   * never a session at all. The caller has that context; this does not. */
  if (response.status === 401) return 'refused'
  if (!response.ok) refuse(`${address.origin} answered HTTP ${response.status} for the session check`)
  return 'live'
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
  let cookie: string | null = null
  let justPaired = false

  if (existing !== undefined && existing !== '') {
    /* A CREDENTIAL WITH NO STATED AUDIENCE IS THE FOOTGUN. `PAPER_CLIENT_*` is
     * shared with `shot-client.mjs`, which points at a local shelf by default,
     * so an exported cookie would otherwise be handed to whatever `--shelf`
     * names next — over the network, to a host with no business seeing it.
     * Optional binding does not close that: the reader who needed it most is
     * the one who never set it. Pairing is exempt because `--shelf` named the
     * shelf explicitly in the same command, and the code is single-use. */
    if (declared === undefined || declared === '') {
      refuse(
        `${COOKIE_VAR} is set but ${ORIGIN_VAR} is not, so there is nothing saying which shelf that ` +
          `credential belongs to. Set ${ORIGIN_VAR}=${address.origin} to send it here.`,
      )
    }
    if (!wellFormedCookie(existing)) {
      refuse(`${COOKIE_VAR} is not a well-formed cookie; it cannot be sent as a header`)
    }
    if ((await sessionState(address, existing, call)) === 'live') {
      cookie = existing
    } else if (code !== undefined && code !== '') {
      /* THE ADVICE HAS TO BE FOLLOWABLE. The refusal below tells a reader to
       * set the code — and the cookie used to take precedence unconditionally,
       * so doing exactly that changed nothing and produced the same 401. When
       * both are present and the cookie is dead, the code is what they meant. */
      note(`paper: ${COOKIE_VAR} was refused by ${address.origin}; pairing with ${CODE_VAR} instead`)
    } else {
      refuse(
        `${address.origin} does not accept ${COOKIE_VAR} — it may have been revoked or expired. ` +
          `Set ${CODE_VAR} to the six digits the shelf is showing and run this again.`,
      )
    }
  }

  if (cookie === null) {
    if (code === undefined || code === '') {
      refuse(
        `no credential for ${address.origin}. Set ${COOKIE_VAR} (with ${ORIGIN_VAR}) to a session you ` +
          `already have, or ${CODE_VAR} to the six digits the shelf is showing.`,
      )
    }
    const minted = await pair(address, code, call)
    /* VERIFIED BEFORE IT IS ANNOUNCED. This used to print the credential the
     * moment `/api/auth/submit` answered, so a cookie the shelf then refused
     * had already been offered to the reader as one to keep and re-export. */
    if ((await sessionState(address, minted, call)) === 'refused') {
      refuse(`${address.origin} issued a credential it then would not accept — that is not the shelf answering`)
    }
    cookie = minted
    justPaired = true
  }

  if (justPaired) {
    /* PRINTED AS VALUES, NOT AS A COMMAND TO PASTE.
     *
     * This emitted `export ${COOKIE_VAR}='<cookie>'`. An apostrophe is a legal
     * `cookie-octet`, so a value containing one closes the quote and the rest
     * of the line is whatever the shell makes of it — the same defect that put
     * an environment dump in a commit message on a public repo. Naming the
     * variables and their values leaves the reader to set them, which is the
     * one form that cannot be executed by accident.
     *
     * stderr, so `paper book list --json | jq` is unaffected. Both variables,
     * because a cookie without its origin is refused above. */
    note(`paper: paired with ${address.origin}. This credential is not stored — to reuse it, set:`)
    note(`paper:   ${ORIGIN_VAR} = ${address.origin}`)
    note(`paper:   ${COOKIE_VAR} = ${cookie}`)
  }

  const channel = await connectToShelf({
    url: address.socket,
    open: opener(cookie),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return remoteCaller({ channel })
}

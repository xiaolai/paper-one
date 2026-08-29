import { socketUrl } from '../kernel'

/**
 * What `--shelf <key>` names, and what it refuses to guess (WI-11.7).
 *
 * ## An EXACT origin, never a bare hostname
 *
 * It is tempting to accept `--shelf studio` and prepend `https://`. Do not.
 * The shelf's own address discovery deliberately reports Tailscale's full
 * `Self.DNSName` — `studio.tail1234.ts.net` — rather than the short
 * `HostName`, because the short form is what MagicDNS resolves and the long
 * form is what the certificate is issued for. A guessed `https://studio`
 * therefore resolves, connects, and fails hostname validation; or worse,
 * succeeds against something else answering to the name.
 *
 * Guessing a TLS identity is not a convenience. So the scheme is required and
 * the host is taken exactly as written.
 *
 * ## `http:` is loopback-only
 *
 * The server binds plain HTTP on purpose and expects TLS in front of it
 * (`tailscale serve`, or any proxy). Its whole auth design rests on that: six
 * digits is enough only because an attacker can neither read the code in
 * flight nor impersonate the shelf, and the cookie's `Secure` attribute is the
 * backstop that makes a missing proxy visible to a browser. A CLI setting its
 * own `Cookie` header has no such backstop — nothing would stop it posting a
 * credential in the clear — so the refusal here IS the backstop.
 *
 * Loopback is exempt because there is no network to intercept, and because it
 * is the address `PAPER_CLIENT_ORIGIN` already defaults to.
 */

/** Where the shelf's plugin binds. `tauri-plugin-webhost::WEBHOST_PORT`. */
export const WEBHOST_PORT = 27182

export interface ShelfAddress {
  /** Canonical `scheme://host[:port]`, default ports dropped, host lower-cased. */
  readonly origin: string
  /** `ws(s)://host[:port]/ws` — the kernel's own derivation, not a second one. */
  readonly socket: string
  readonly submit: string
  readonly session: string
}

export type Resolved =
  | { readonly ok: true; readonly address: ShelfAddress }
  | { readonly ok: false; readonly message: string }

const fail = (message: string): Resolved => ({ ok: false, message })

/**
 * Anything a URL has no business containing, the space included.
 *
 * ESCAPES, NOT LITERALS. This range was first written as the raw bytes it
 * matches, which renders as an empty-looking character class in every diff,
 * review and terminal that will ever show it. A guard against control
 * characters written in control characters cannot be read, and an unreadable
 * guard is one nobody can check.
 */
const CONTROL = /[\u0000-\u0020\u007f]/

/** `127.0.0.0/8`, and the name that resolves into it. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * Turn `--shelf <key>` into the URLs the remote caller needs, or say why not.
 *
 * A REFUSAL NEVER ECHOES THE INPUT when the input may carry a secret. A key
 * written `https://user:hunter2@shelf` would otherwise put the password into
 * stderr, into the terminal's scrollback, and into whatever collects it — and
 * the channel interpolates its url into every connection error too, so an
 * accepted one would leak again on each failure for the life of the session.
 */
export function shelfAddress(key: string): Resolved {
  const raw = key.trim()
  if (raw === '') return fail('--shelf needs a shelf address')
  if (CONTROL.test(raw)) return fail('--shelf address contains a space or a control character')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    /* NOT "invalid URL". The overwhelmingly likely mistake is a bare hostname,
     * and saying so is the difference between fixing it in one go and guessing
     * at a spelling. */
    return fail(`--shelf needs a full address with a scheme, like https://shelf.example — not ${JSON.stringify(raw)}`)
  }

  /* USERINFO IS REFUSED BEFORE ANYTHING IS REPORTED, and the message names no
   * part of the input. */
  if (url.username !== '' || url.password !== '') {
    return fail('--shelf address must not carry a username or password; pair with the code instead')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return fail(`--shelf address must be https or http, not ${url.protocol.replace(':', '')}`)
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    /* The shelf serves its routes at the ORIGIN ROOT — `/ws`, `/api/auth/*`.
     * Its own Tailscale discovery refuses a proxy mounted on a subpath for the
     * same reason, so accepting one here would promise what nothing delivers. */
    return fail('--shelf address must be an origin with no path; the shelf serves its routes at the root')
  }
  if (url.search !== '' || url.hash !== '') {
    return fail('--shelf address must not carry a query or a fragment')
  }
  if (url.hostname === '') return fail('--shelf address has no host')

  /* IPv6 LOOPBACK REACHES NOTHING, and it is diagnosed BEFORE the scheme.
   *
   * The plugin binds `Ipv4Addr::LOCALHOST` alone, so `[::1]` connects to
   * nothing and the failure would otherwise arrive as a refused socket with no
   * hint at all. Order matters: `[::1]` is not loopback by the IPv4 test below
   * it, so with these two the other way round `http://[::1]` was refused for
   * travelling in the clear — true of nothing, since it never leaves the
   * machine, and it sends the reader to find a certificate they do not need.
   * The specific diagnosis goes first. */
  if (url.hostname === '[::1]') {
    return fail('--shelf: the shelf binds IPv4 loopback only — use http://127.0.0.1 rather than [::1]')
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return fail(
      `--shelf refuses plain http to ${url.host}: the code and the credential would travel in the clear. ` +
        'Put TLS in front of the shelf — `tailscale serve` does it — and use https.',
    )
  }

  /* `URL.origin` is the canonical form: scheme and host lower-cased, a default
   * port dropped. So `HTTPS://Shelf.Example:443` and `https://shelf.example`
   * are one address rather than two. */
  const origin = url.origin
  return {
    ok: true,
    address: {
      origin,
      /* ONE derivation of the socket scheme — the kernel's, shared with the
       * browser client — not a second `https ? wss : ws` written out here. */
      socket: socketUrl({ protocol: url.protocol, host: url.host }),
      submit: `${origin}/api/auth/submit`,
      session: `${origin}/api/auth/session`,
    },
  }
}

import { messageOf } from '../../kernel'
/**
 * The browser client's half of the six-digit exchange.
 *
 * Four fetches and no state. Everything that decides anything is on the shelf;
 * this turns its answers into something a screen can say.
 *
 * ## The credential is never here
 *
 * There is no token in this module, and there must never be one. The shelf sets
 * an `HttpOnly` cookie, so page script cannot read it — which is the whole
 * defence against a hostile EPUB, since foliate renders a book's HTML in an
 * iframe sharing this origin. `credentials: 'same-origin'` is what makes the
 * browser attach it; nothing here ever sees the value.
 *
 * ## Why the statuses are distinguished
 *
 * The shelf deliberately answers `401` for both a wrong code and a stale one,
 * so a guess cannot learn whether it was close. But it separates the cases
 * where the FIX is different, and those are worth telling a human apart:
 *
 *   - `409` — nobody has pressed the button on the shelf. Nothing to type yet.
 *   - `410` — the code aged out. Ask for another.
 *   - `429` — the attempts are spent. Ask for another.
 *   - `401` — that was not the code.
 *
 * A single "could not sign in" would send someone hunting for a typo when the
 * real problem is that no code is on screen.
 */

/** Where the browser stands with its shelf. */
export type SessionState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'needs-code' }
  /** The shelf could not be reached at all — asleep, or the tunnel is down. */
  | { readonly kind: 'unreachable' }

/** Why a submitted code was refused, in the shape a screen can render. */
export type SubmitOutcome =
  | { readonly kind: 'connected' }
  | { readonly kind: 'wrong' }
  | { readonly kind: 'no-code-showing' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'no-attempts-left' }
  | { readonly kind: 'unreachable' }

const SAME_ORIGIN: RequestInit = { credentials: 'same-origin' }

/**
 * Does this browser already hold a live credential?
 *
 * A network failure is `unreachable` and NOT `needs-code`: showing the code
 * entry to someone whose shelf is merely asleep would have them hunting for a
 * screen that is not on, and typing digits that could never be checked.
 */
export async function checkSession(fetcher: typeof fetch = fetch): Promise<SessionState> {
  let response: Response
  try {
    response = await fetcher('/api/auth/session', SAME_ORIGIN)
  } catch {
    return { kind: 'unreachable' }
  }
  if (response.status === 204) return { kind: 'connected' }
  if (response.status === 401) return { kind: 'needs-code' }
  /* Anything else is the shelf answering something this build does not
   * understand — a proxy error page, a version skew. Treated as unreachable
   * rather than as a missing credential, because asking for a code would not
   * fix it. */
  return { kind: 'unreachable' }
}

export async function submitCode(code: string, fetcher: typeof fetch = fetch): Promise<SubmitOutcome> {
  let response: Response
  try {
    response = await fetcher('/api/auth/submit', {
      ...SAME_ORIGIN,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  } catch {
    return { kind: 'unreachable' }
  }
  switch (response.status) {
    case 204:
      return { kind: 'connected' }
    case 401:
      return { kind: 'wrong' }
    case 409:
      return { kind: 'no-code-showing' }
    case 410:
      return { kind: 'expired' }
    case 429:
      return { kind: 'no-attempts-left' }
    default:
      return { kind: 'unreachable' }
  }
}

/**
 * Whether the shelf actually forgot this browser.
 *
 * ⚠️ **`signOut` RETURNED `void` AND SWALLOWED EVERYTHING**, including a
 * non-204 answer. The credential lives in an `HttpOnly` cookie, so JavaScript
 * cannot clear it: if the POST does not reach the shelf, or the shelf refuses
 * it, the credential stays good for its full ninety days — while the screen
 * returns to the gate and every appearance is of having signed out. A reader
 * who signs out on a borrowed laptop has been told something untrue about
 * where their library is.
 *
 * The screen still clears either way: the shelf is the authority and this
 * browser has nothing left to show. What changes is that the caller can SAY
 * so, and point at the one place that can finish the job — the Browsers pane
 * on the shelf, which revokes by durable id whether or not the browser is
 * connected.
 */
export type SignOutResult = { readonly kind: 'signed-out' } | { readonly kind: 'still-paired'; readonly why: string }

export async function signOut(fetcher: typeof fetch = fetch): Promise<SignOutResult> {
  let response: Response
  try {
    response = await fetcher('/api/auth/signout', { ...SAME_ORIGIN, method: 'POST' })
  } catch (cause) {
    return { kind: 'still-paired', why: messageOf(cause) }
  }
  /* 204 IS THE ONLY YES. The endpoint is idempotent and answers 204 whether or
     not anything was revoked, so any other status is the shelf declining — a
     403 from the same-origin check, say — and not a sign-out. */
  if (response.status !== 204) {
    return { kind: 'still-paired', why: `the shelf answered ${response.status}` }
  }
  return { kind: 'signed-out' }
}

/** Only the six digits, and never more than six. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6)
}

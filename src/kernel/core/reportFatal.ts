/**
 * Last-resort error surface.
 *
 * A packaged desktop app has no console anyone will look at, and a webview
 * that throws during startup renders a blank window that is indistinguishable
 * from a slow one. Anything that reaches here is painted into the DOM instead,
 * so a failure states itself rather than looking like an empty page.
 */

const HOST_ID = 'paper-fatal'

function host(): HTMLElement {
  const existing = document.getElementById(HOST_ID)
  if (existing) return existing

  const el = document.createElement('div')
  el.id = HOST_ID
  el.setAttribute('role', 'alert')
  el.style.cssText = [
    'position:fixed',
    'left:12px',
    'right:12px',
    'bottom:12px',
    'z-index:2147483647',
    'max-height:40vh',
    'overflow:auto',
    'padding:14px 16px',
    'border-radius:14px',
    'background:var(--amber-bg,#FBF6EE)',
    'border:1px solid var(--amber-line,#E7D6BE)',
    'color:var(--amber,#9E5A16)',
    'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
    'white-space:pre-wrap',
  ].join(';')
  document.body.append(el)
  return el
}

/**
 * An error, its stack, and EVERYTHING UNDERNEATH IT.
 *
 * `cause` is where the diagnosis lives and it was being thrown away. A
 * `CapabilityError` says "capability X failed to start; nothing stays
 * registered" — which names the victim, not the problem — and attaches what
 * actually went wrong as its cause. Twice now that surface has been the only
 * thing on screen while the sentence that identified the fault sat one link
 * below it, unprinted: the first time it cost a debugging session, the second
 * time it was reported as a bug with nothing in it to act on.
 *
 * `AggregateError` is spelled out too, because the registry wraps a rollback's
 * teardown failures in one and the interesting error can be any of them.
 * Depth-capped and cycle-guarded: this runs on the path where things are
 * already going wrong, and a reporter that hangs or recurses is worse than a
 * terse one.
 */
export function explainFatal(detail: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (depth > 6 || seen.has(detail)) return '…'
  seen.add(detail)
  if (!(detail instanceof Error)) return String(detail)
  const head = `${detail.name}: ${detail.message}\n${detail.stack ?? ''}`
  const inner: string[] = []
  if (detail instanceof AggregateError && Array.isArray(detail.errors)) {
    detail.errors.forEach((one, i) => inner.push(`  [${i}] ${explainFatal(one, depth + 1, seen)}`))
  }
  if (detail.cause !== undefined) inner.push(`caused by: ${explainFatal(detail.cause, depth + 1, seen)}`)
  return inner.length === 0 ? head : `${head}\n${inner.join('\n')}`
}

export function reportFatal(label: string, detail: unknown): void {
  const text = explainFatal(detail)
  // eslint-disable-next-line no-console -- the console is still the better
  // channel when devtools happen to be open; the DOM surface is the fallback.
  console.error(label, detail)
  const line = document.createElement('div')
  line.textContent = `${label} — ${text}`
  host().append(line)
}

export function installFatalHandlers(): void {
  // Clear anything left from a previous load. The banner is append-only during
  // a session on purpose, but surviving a reload would make a fixed error look
  // permanent and mask whatever is behind it.
  document.getElementById(HOST_ID)?.remove()

  window.addEventListener('error', (event) => {
    reportFatal('Uncaught error', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportFatal('Unhandled rejection', event.reason)
  })
}

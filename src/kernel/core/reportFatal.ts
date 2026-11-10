import { createDiagnostics } from './diagnostics'
import { RADIUS } from './metrics'
import type { Diagnostics } from './ports'
import { NOOP_DIAGNOSTICS } from './ports'
/**
 * Last-resort error surface.
 *
 * A packaged desktop app has no console anyone will look at, and a webview
 * that throws during startup renders a blank window that is indistinguishable
 * from a slow one. Anything that reaches here is painted into the DOM instead,
 * so a failure states itself rather than looking like an empty page.
 *
 * ⚠️ **THE ONE SURFACE IN THE APP THAT WRITES `var(--x, #hex)` ON PURPOSE.**
 * Everywhere else a fallback inside a `var()` is a defect — the token does all
 * the work, so the fallback is a second colour nobody re-values with the theme,
 * and `tokens.test.ts` is built around finding them. Here the stylesheet is one
 * of the things that may have failed: a banner styled only through custom
 * properties would paint as unstyled black-on-transparent text at the exact
 * moment it is the only thing on screen. The fallbacks are the amber palette's
 * light values, and they are what this reads as when nothing else loaded.
 *
 * ⚠️ **AND FOR THE SAME REASON THE GEOMETRY IS TYPESCRIPT, NOT CSS.** `RADIUS`
 * is imported rather than `var(--radius-card)`-ed: a constant interpolated here
 * is in the string whether or not `applyMetrics` ever ran, which is the whole
 * point of this file. The paddings and the offsets below are the SPACE SCALE's
 * 12, 14 and 16 — and that scale exists only in `tokens.css`, with no mirror in
 * `metrics.ts` and nothing published through `applyMetrics`, so there is no name
 * in TypeScript to reach for. They stay written out, and this says why.
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
    /* THE CARD RADIUS, which is what this is: a floating surface over the app,
       drawn like the palette and the popovers. It was a 14 written out beside
       `RADIUS.card`'s 14 — agreeing today, and the one thing in the app that
       would not follow the shape scale if it moved. */
    `border-radius:${RADIUS.card}px`,
    'background:var(--amber-bg,#FBF6EE)',
    'border:1px solid var(--amber-line,#E7D6BE)',
    'color:var(--amber,#9E5A16)',
    'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
    'white-space:pre-wrap',
  ].join(';')
  el.append(dismissButton(el))
  document.body.append(el)
  return el
}

/**
 * THE BANNER CAN BE PUT AWAY. It was append-only with no way to close it, and
 * it is fixed over the page at up to 40vh: one error after a book was open —
 * not a blank window at all — left the bottom of every page covered for the
 * rest of the session. Dismissing removes the whole surface; the next error
 * builds it again, so a new fault is never hidden by an old dismissal.
 */
function dismissButton(banner: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Dismiss'
  button.setAttribute('aria-label', 'Dismiss the error report')
  button.style.cssText = [
    /* Sticky so it stays reachable while the report scrolls inside its cap. */
    'position:sticky',
    'top:0',
    'float:right',
    'margin-left:12px',
    `border-radius:${RADIUS.chip}px`,
    'border:1px solid var(--amber-line,#E7D6BE)',
    'background:var(--amber-bg,#FBF6EE)',
    'color:inherit',
    'font:inherit',
    'cursor:pointer',
  ].join(';')
  button.addEventListener('click', () => banner.remove())
  return button
}

/** Each line's report and how many times it has arrived. */
const reported = new WeakMap<Element, { readonly text: string; count: number }>()

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

/**
 * A REPEAT IS COUNTED, NOT APPENDED. An error raised from a callback — a
 * ResizeObserver, an animation frame — arrives once per frame, and every
 * arrival was a new line until the banner filled its 40vh with copies of one
 * report. Any line already showing the same text takes a count instead
 * (`×N`), so a flood reads as one fault and distinct faults stay visible.
 */
export function reportFatal(label: string, detail: unknown): void {
  const text = `${label} — ${explainFatal(detail)}`
  // The console is still the better channel when devtools happen to be open;
  // the DOM surface below is the fallback for when they are not.
  console.error(label, detail)
  const banner = host()
  for (const line of Array.from(banner.children)) {
    const seen = reported.get(line)
    if (seen?.text !== text) continue
    // Mutated in place: the count belongs to the line it labels.
    seen.count += 1
    line.textContent = `${text} (×${seen.count})`
    return
  }
  const line = document.createElement('div')
  line.textContent = text
  reported.set(line, { text, count: 1 })
  banner.append(line)
}

/**
 * Where the ResizeObserver notices below go. The fatal handlers are installed
 * before boot has built the app's own `Diagnostics`, so installing them starts
 * these on one of the same kind, always on, writing to the console, until boot
 * hands over its own. Nothing reaches this before the handlers are installed.
 *
 * ⚠️ **HANDED OVER ONLY WHEN THE APP'S DIAGNOSTICS ARE ON.** Off, those are the
 * no-op, and taking them would make the notice vanish from the console it
 * reached before boot.
 */
let notices: Diagnostics = NOOP_DIAGNOSTICS

export function reportNoticesTo(diagnostics: Diagnostics): void {
  notices = diagnostics
}

/** One ResizeObserver notice, as a warning — see `isResizeObserverLoop`. */
export function noteResizeObserverLoop(message: string): void {
  notices.warn('resize-observer-loop', { message })
}

export function installFatalHandlers(): void {
  // Clear anything left from a previous load. The banner is append-only during
  // a session on purpose, but surviving a reload would make a fixed error look
  // permanent and mask whatever is behind it.
  document.getElementById(HOST_ID)?.remove()
  notices = createDiagnostics({ scope: 'window' })

  window.addEventListener('error', (event) => {
    if (isResizeObserverLoop(event)) {
      noteResizeObserverLoop(event.message)
      return
    }
    reportFatal('Uncaught error', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportFatal('Unhandled rejection', event.reason)
  })
}

/**
 * The browser's notice that a ResizeObserver callback resized something, so
 * the notifications that change caused are delivered next frame.
 *
 * ⚠️ **A NOTICE, NOT A FAULT, SO NOT THE FATAL BANNER.** The ResizeObserver
 * specification reports it as an `error` event when a frame ends with
 * observations still pending. Nothing threw and nothing is lost: the
 * observers run again on the next frame. It had been putting an alert over
 * the page during every reading run.
 *
 * ⚠️ **NOT SWALLOWED EITHER: A FLOOD OF THEM IS A REAL LOOP.** The flood on
 * Gutenberg Chinese books was one: a figure cap of `95vh` inside a scrolled
 * section grew the section, which grew the cap. c2880568 removed that cause
 * by capping figures in pixels measured off the stage (`bookCss.ts`,
 * `BookCssOptions.pageHeight`), and `FoliateView.session.test.tsx` ("hands
 * the measured page height to every document the session writes to") pins
 * the cap in pixels. So every notice is still a warning through the app's
 * logger — the console, and the diagnostics window once boot has one — and
 * the reading run's hooks still record each as `page.error`. A loop that
 * comes back is visible; it is just not called a crash.
 *
 * ⚠️ **MATCHED EXACTLY, ONE TEXT.** The event carries no error object, which
 * is how the browser sends the notice, and the message is exactly the text
 * WebKit and Chromium use, full stop included. Anything else — an `Error`
 * thrown with the same words, a message that only begins like it, the older
 * "loop limit exceeded" text no supported engine sends — is still reported.
 */
export const RESIZE_OBSERVER_LOOP = 'ResizeObserver loop completed with undelivered notifications.'

export function isResizeObserverLoop(event: ErrorEvent): boolean {
  return event.error == null && event.message === RESIZE_OBSERVER_LOOP
}

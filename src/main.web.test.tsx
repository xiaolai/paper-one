// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor, cleanup } from '@testing-library/react'

/**
 * The browser client's ENTRY, mounted.
 *
 * ⚠️ **WHY THIS FILE DID NOT EXIST, AND WHAT THAT COST.** `main.web.tsx` is 700
 * lines with no exports and a `createRoot` at module scope, so nothing could
 * import it — and the mutation gate therefore reported it as *"no covering test
 * was found for 1 file(s) that Stryker makes mutants in — a discovery or
 * testability failure, not a mutation result, and not a pass"*, over **317
 * mutants**. A file nothing can import is a file nothing can check, and this is
 * the one every browser reader actually runs.
 *
 * ⚠️ **THE MOUNT IS THE IMPORT, WHICH IS WHY EVERY CASE HERE RESETS MODULES.**
 * The module renders as a side effect of being loaded, so it can only be driven
 * once per module registry: `vi.resetModules()` between cases, a fresh `#root`
 * each time, and the network stubbed BEFORE the import rather than after.
 */

/* ⚠️ **THE VIRTUAL COMPOSITION RESOLVES TO THE DESKTOP'S ONE UNDER VITEST.**
 * `main.web.tsx` imports `virtual:paper-composition`, which a Vite plugin
 * resolves per platform — to the empty `composition.web.ts` for a web build,
 * and to the desktop's seven capabilities here. The entry's own guard then
 * throws *"composition.web.ts names 7 capability/capabilities and this entry
 * does not compose any"*, which is the guard working: it exists so the day a
 * capability is added to the WEB composition, this throws instead of silently
 * ignoring it.
 *
 * So the web composition is supplied explicitly. That is what the client is
 * built with — not a convenience, and not a way round the guard. `AGENTS.md`
 * records the same specifier defeating the mutation gate's base discovery, for
 * the same reason: it names no installed package, so nothing can follow it. */
vi.mock('virtual:paper-composition', () => ({ capabilities: [] }))

/** What the client asks for before it draws anything. */
function stubNetwork(session: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/auth/session')) {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
  /* A socket that connects and says nothing. The shelf screens read the LINK's
     state, not the socket's traffic, so a quiet one is enough to reach them. */
  vi.stubGlobal(
    'WebSocket',
    class {
      static readonly OPEN = 1
      readyState = 1
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((event: unknown) => void) | null = null
      close(): void {}
      send(): void {}
    },
  )
}

beforeEach(() => {
  vi.resetModules()
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the browser client, from its own entry', () => {
  it('draws the gate when the shelf has never seen this browser', async () => {
    /* ⚠️ **THE CLIENT IS NOT A STATIC PAGE** — it asks `/api/auth/session`
     * before it draws anything, and what it draws depends on the answer.
     * `shot-client.mjs` records the same thing for the same reason. */
    stubNetwork({ kind: 'unpaired' })
    await import('./main.web')
    /* The gate itself, by the words on it — `childElementCount` alone would be
     * satisfied by any render at all, including the one that says nothing. */
    await waitFor(() => expect(document.querySelector('#root')?.childElementCount).toBeGreaterThan(0))
    /* WHAT IT DREW, not merely that it drew. The gate is the one screen a
     * reader who has never paired this browser ever sees, and `checkSession`'s
     * answer is what chooses it. */
    expect(String(document.body.textContent), `drew: ${String(document.body.textContent).slice(0, 200)}`)
      .toMatch(/librar|connect|code|digits/iu)
  })

  it('installs the platform metrics on the document, before the mount', async () => {
    /* ⚠️ **EVERY SURFACE READS THESE AS CUSTOM PROPERTIES**, and a browser tab
     * has no titlebar and no window controls — the table says so with zeros.
     * Nothing else writes them, so their absence is silent: the layout is
     * merely wrong. */
    stubNetwork({ kind: 'unpaired' })
    await import('./main.web')
    const root = document.documentElement
    const inspect = root.getAttribute('style') ?? ''
    expect(inspect, 'no custom property reached the document').toMatch(/--/u)
  })

  it('reports a shelf it cannot reach rather than a blank page', async () => {
    /* A failed session check is the one state a reader meets before anything
     * works, and the client has no devtools to open and no log to read. */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('the shelf is not there')
      }),
    )
    await import('./main.web')
    await waitFor(() => expect(document.querySelector('#root')?.childElementCount).toBeGreaterThan(0))
    expect(String(document.body.textContent)).toMatch(/\S/u)
  })

  it('refuses to mount with nowhere to mount into, rather than drawing nothing', async () => {
    /* ⚠️ **A BLANK PAGE WITH NOTHING SAID IS THE ONE FAILURE THIS CLIENT MUST
     * NOT HAVE**, so a missing `#root` is loud. */
    stubNetwork({ kind: 'unpaired' })
    document.body.innerHTML = ''
    await expect(import('./main.web')).rejects.toThrow(/no #root/u)
  })
})

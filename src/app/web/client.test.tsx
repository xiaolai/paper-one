// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor, cleanup } from '@testing-library/react'
import type { Root } from 'react-dom/client'
import { mountWebClient } from './client'

/**
 * The browser client, mounted, over its real modules and a stubbed network.
 * `client.wiring.test.tsx` is the same client over stand-ins, for what it hands
 * each of them.
 *
 * ⚠️ **WHY THIS FILE DID NOT EXIST, AND WHAT THAT COST.** The client was 700 lines
 * with no exports and a `createRoot` at module scope in `main.web.tsx`, so nothing
 * could import it — and the mutation gate therefore reported it as *"no covering
 * test was found for 1 file(s) that Stryker makes mutants in — a discovery or
 * testability failure, not a mutation result, and not a pass"*, over **317
 * mutants**. A file nothing can import is a file nothing can check, and this is
 * the one every browser reader actually runs.
 *
 * ⚠️ **THE MOUNT WAS THE IMPORT, AND THEN THE COMPOSITION WAS THE PROBLEM.** Those
 * tests loaded the entry, and the entry imported `virtual:paper-composition`, which
 * no import graph can follow. So they sat on a route the gate records as unseen
 * (`unseenAtBase`), and any change to the entry left nothing in a sweep authorised:
 * `dev-docs/decisions/2026-11-02-composition-route.md`. The composition is an
 * argument now, and what it is here is what the client is built with — the empty
 * list `composition.web.ts` exports — rather than a mock of a module this file
 * has no need to name.
 */

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

const mounted: Root[] = []

function mount(): void {
  mounted.push(mountWebClient([]))
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  for (const root of mounted.splice(0)) root.unmount()
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the browser client, mounted', () => {
  it('draws the gate when the shelf has never seen this browser', async () => {
    /* ⚠️ **THE CLIENT IS NOT A STATIC PAGE** — it asks `/api/auth/session`
     * before it draws anything, and what it draws depends on the answer.
     * `shot-client.mjs` records the same thing for the same reason. */
    stubNetwork({ kind: 'unpaired' })
    mount()
    /* The gate itself, by the words on it — `childElementCount` alone would be
     * satisfied by any render at all, including the one that says nothing. */
    await waitFor(() => expect(document.querySelector('#root')?.childElementCount).toBeGreaterThan(0))
    /* WHAT IT DREW, not merely that it drew. The gate is the one screen a
     * reader who has never paired this browser ever sees, and `checkSession`'s
     * answer is what chooses it. */
    expect(String(document.body.textContent), `drew: ${String(document.body.textContent).slice(0, 200)}`)
      .toMatch(/librar|connect|code|digits/iu)
  })

  it('installs the platform metrics on the document', async () => {
    /* ⚠️ **EVERY SURFACE READS THESE AS CUSTOM PROPERTIES**, and a browser tab
     * has no titlebar and no window controls — the table says so with zeros.
     * Nothing else writes them, so their absence is silent: the layout is
     * merely wrong. */
    stubNetwork({ kind: 'unpaired' })
    mount()
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
    mount()
    await waitFor(() => expect(document.querySelector('#root')?.childElementCount).toBeGreaterThan(0))
    expect(String(document.body.textContent)).toMatch(/\S/u)
  })

  it('refuses to mount with nowhere to mount into, rather than drawing nothing', async () => {
    /* ⚠️ **A BLANK PAGE WITH NOTHING SAID IS THE ONE FAILURE THIS CLIENT MUST
     * NOT HAVE**, so a missing `#root` is loud. */
    stubNetwork({ kind: 'unpaired' })
    document.body.innerHTML = ''
    expect(mount).toThrow(/no #root/u)
  })
})

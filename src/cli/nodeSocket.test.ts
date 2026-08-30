import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { connectToShelf } from '../kernel'
import { nodeSocketOpener } from './nodeSocket'

/**
 * THE CAST IN `nodeSocket.ts`, SETTLED BY THE RUNTIME (WI-11.7).
 *
 * `lib.dom` says a WebSocket constructor takes `(url, protocols?)`, and this
 * CLI passes `{ headers }` instead. That is a claim about Node's
 * implementation, and no amount of typechecking can confirm or refute it — a
 * cast typechecks precisely because it stops the compiler asking.
 *
 * So this drives a real `node:http` server through a real upgrade and reads
 * the header off the wire. If Node ever stops honouring it, the credential
 * silently stops being sent and every remote command starts answering 401 for
 * a reason that looks nothing like the cause. This test is what turns that
 * into a failure.
 */

let server: Server | null = null
afterEach(async () => {
  const open = server
  server = null
  if (open) await new Promise<void>((resolve) => open.close(() => resolve()))
})

/** A server that records the upgrade request and then refuses it. */
async function recordingServer(): Promise<{ url: string; seen: Promise<IncomingMessage> }> {
  const made = createServer()
  server = made
  const seen = new Promise<IncomingMessage>((resolve) => {
    made.on('upgrade', (request, socket) => {
      resolve(request)
      /* Refused deliberately: this test is about the REQUEST. Completing the
         handshake would need an accept-key implementation that proves nothing
         extra here — the frame path is covered by shelfChannel's own suite. */
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    })
  })
  await new Promise<void>((resolve) => made.listen(0, '127.0.0.1', resolve))
  const { port } = made.address() as AddressInfo
  return { url: `ws://127.0.0.1:${port}/ws`, seen }
}

describe('the Node socket opener', () => {
  it('puts the credential on the handshake, where the browser would have put it itself', async () => {
    const { url, seen } = await recordingServer()
    nodeSocketOpener('paper_session=abc123')(url)
    const request = await seen
    expect(request.headers.cookie).toBe('paper_session=abc123')
  })

  it('sends the pair verbatim, whatever the cookie is called', async () => {
    const { url, seen } = await recordingServer()
    nodeSocketOpener('renamed=xyz')(url)
    expect((await seen).headers.cookie).toBe('renamed=xyz')
  })

  it('requests the path it was given, and adds no query or fragment', async () => {
    const { url, seen } = await recordingServer()
    nodeSocketOpener('paper_session=abc')(url)
    const request = await seen
    expect(request.url).toBe('/ws')
  })

  /**
   * THE SHAPE THE CHANNEL ACTUALLY USES.
   *
   * `connect()` sets `binaryType`, assigns four handlers and calls `send`. The
   * cast claims the returned object has all of them; a `SocketLike` that were
   * missing one would fail here rather than at the first frame of a real
   * session.
   */
  it('returns an object the channel can drive', async () => {
    const { url } = await recordingServer()
    const socket = nodeSocketOpener('paper_session=abc')(url)
    expect(typeof socket.send).toBe('function')
    expect(typeof socket.close).toBe('function')
    socket.binaryType = 'arraybuffer'
    expect(socket.binaryType).toBe('arraybuffer')
    socket.close()
  })

  /* A REFUSED UPGRADE MUST REJECT, not hang. The shelf answers 401 to a
     credential it does not accept, and a caller that waited for a socket that
     is never coming would look exactly like a slow shelf. */
  it('rejects when the shelf refuses the upgrade', async () => {
    const { url } = await recordingServer()
    await expect(connectToShelf({ url, open: nodeSocketOpener('paper_session=wrong'), timeoutMs: 5_000 })).rejects.toThrow()
  })
})

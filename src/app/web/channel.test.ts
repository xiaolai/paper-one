import { describe, expect, it, vi } from 'vitest'
import { connect, socketUrl, type SocketLike } from './channel'
import { ENVELOPE_VERSION, decodeFrame, encodeFrame } from '../../kernel/core/envelope'

/** A socket a test drives by hand. */
class FakeSocket implements SocketLike {
  binaryType = ''
  sent: Uint8Array[] = []
  closedByUs = false
  onopen: ((this: unknown, ev: unknown) => unknown) | null = null
  onclose: ((this: unknown, ev: unknown) => unknown) | null = null
  onerror: ((this: unknown, ev: unknown) => unknown) | null = null
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null = null

  send(data: ArrayBufferView | ArrayBuffer) {
    this.sent.push(new Uint8Array(data as ArrayBufferView['buffer']))
  }
  close() {
    this.closedByUs = true
  }
  /** Everything the shelf would do, from the test's side. */
  open() {
    this.onopen?.call(null, {})
  }
  deliver(bytes: Uint8Array) {
    this.onmessage?.call(null, { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }
  drop() {
    this.onclose?.call(null, {})
  }
  fail() {
    this.onerror?.call(null, {})
  }
}

/** Connect against a socket the test opens on the next tick. */
async function connected() {
  const socket = new FakeSocket()
  const channel = connect({ url: 'ws://shelf/ws', open: () => socket })
  await Promise.resolve()
  socket.open()
  return { socket, channel: await channel }
}

/** The frame the shelf would send in answer to whatever was asked. */
function answer(socket: FakeSocket, body: unknown) {
  const request = decodeFrame(socket.sent[socket.sent.length - 1]!)
  socket.deliver(
    encodeFrame({ v: ENVELOPE_VERSION, id: request.id, service: request.service, kind: 'res', body }),
  )
}

describe('socketUrl', () => {
  it('follows the page: wss from https, ws from http', () => {
    /* Derived, never written down. A hardcoded scheme is how a client asks for
     * an insecure socket from a secure page, which browsers refuse as mixed
     * content — and the error names the socket, not the hardcoding. */
    expect(socketUrl({ protocol: 'https:', host: 'studio.ts.net' })).toBe('wss://studio.ts.net/ws')
    expect(socketUrl({ protocol: 'http:', host: 'localhost:27182' })).toBe('ws://localhost:27182/ws')
  })

  it('keeps the port, because the shelf is rarely on 443', () => {
    expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:27182' })).toBe('ws://127.0.0.1:27182/ws')
  })
})

describe('connect', () => {
  it('does not resolve until the socket is actually open', async () => {
    /* A channel handed back early accepts calls that queue invisibly and fail
       later as timeouts — which is what makes a refused upgrade look like a
       slow shelf rather than a credential problem. */
    const socket = new FakeSocket()
    let settled = false
    const pending = connect({ url: 'ws://shelf/ws', open: () => socket }).then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    socket.open()
    await pending
    expect(settled).toBe(true)
  })

  it('asks for bytes rather than blobs', async () => {
    /* Blobs are async to read, so frame ORDER would depend on how fast each
       one resolved — and order is the envelope's ground. */
    const { socket } = await connected()
    expect(socket.binaryType).toBe('arraybuffer')
  })

  it('rejects when the socket errors before opening', async () => {
    const socket = new FakeSocket()
    const pending = connect({ url: 'ws://shelf/ws', open: () => socket })
    await Promise.resolve()
    socket.fail()
    await expect(pending).rejects.toThrow(/could not open a channel/)
  })

  it('gives up rather than hanging when the shelf never answers', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const pending = connect({ url: 'ws://shelf/ws', open: () => socket, timeoutMs: 500 })
    const settled = pending.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(600)
    expect((await settled) as Error).toBeInstanceOf(Error)
    expect(socket.closedByUs).toBe(true)
    vi.useRealTimers()
  })

  it('carries a call to the shelf and its answer back', async () => {
    const { socket, channel } = await connected()
    const pending = channel.call('book.list', { limit: 2 })

    const request = decodeFrame(socket.sent[0]!)
    expect(request.service).toBe('book.list')
    expect(request.kind).toBe('req')

    answer(socket, [{ id: 'a' }])
    expect(await pending).toEqual([{ id: 'a' }])
  })

  it('rejects everything in flight when the socket drops', async () => {
    /* The reader is mid-page and the shelf went away. A pending call that never
       settles is a spinner with no end; `disconnected` is something the UI can
       say out loud. */
    const { socket, channel } = await connected()
    const pending = channel.call('book.list', {}).catch((e: unknown) => e)
    socket.drop()
    expect(String(await pending)).toMatch(/disconnect/i)
  })

  it('refuses a call made after the channel closed, without waiting for a timeout', async () => {
    const { channel } = await connected()
    channel.close()
    const failure = await channel.call('book.list', {}).catch((e: unknown) => e)
    expect(String(failure)).toMatch(/closed/)
  })

  it('tells a listener added after the close about it anyway', async () => {
    /* A caller that awaits `connect` and subscribes on the next tick would
       otherwise miss a socket that died in between, and wait forever for an
       event that has already happened. */
    const { socket, channel } = await connected()
    socket.drop()
    const heard: string[] = []
    channel.onClosed((reason) => heard.push(reason))
    expect(heard).toEqual(['lost'])
  })

  it('reports a close once, however many times the socket says so', async () => {
    const { socket, channel } = await connected()
    const heard: string[] = []
    channel.onClosed((reason) => heard.push(reason))
    socket.drop()
    socket.drop()
    socket.fail()
    expect(heard).toEqual(['lost'])
  })

  it('distinguishes a channel we closed from one that was lost', async () => {
    /* A caller deciding whether to reconnect needs these apart: one is the
       reader leaving, the other is the shelf going away. */
    const first = await connected()
    const heardClosed: string[] = []
    first.channel.onClosed((r) => heardClosed.push(r))
    first.channel.close()

    const second = await connected()
    const heardLost: string[] = []
    second.channel.onClosed((r) => heardLost.push(r))
    second.socket.drop()

    expect(heardClosed).toEqual(['closed'])
    expect(heardLost).toEqual(['lost'])
  })

  it('stops listening to a peer that has stopped speaking the protocol', async () => {
    /* Bytes that are not a frame. The envelope's own note says a router sending
       garbage is the transport's problem to raise, and the only honest thing a
       transport can do is stop. */
    const { socket, channel } = await connected()
    const heard: string[] = []
    channel.onClosed((r) => heard.push(r))
    socket.deliver(new Uint8Array([1, 2, 3, 4, 5]))
    expect(heard).toEqual(['lost'])
    expect(socket.closedByUs).toBe(true)
  })

  it('ignores a text frame rather than throwing inside a socket callback', async () => {
    /* The shelf closes a socket that sends text, so this connection is already
       over. An exception here would have nowhere to go. */
    const { socket, channel } = await connected()
    const heard: string[] = []
    channel.onClosed((r) => heard.push(r))
    expect(() => socket.onmessage?.call(null, { data: 'hello' })).not.toThrow()
    expect(heard).toEqual([])
  })

  it('sends nothing after the channel is closed', async () => {
    const { socket, channel } = await connected()
    const before = socket.sent.length
    channel.close()
    void channel.call('book.list', {}).catch(() => {})
    expect(socket.sent.length).toBe(before)
  })
})

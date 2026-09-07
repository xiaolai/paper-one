import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECT_TIMEOUT_MS, EXECUTE_TIMEOUT_MS, connect, evaluate, execute } from './bridge.mjs'

/**
 * The bridge client, against a fake socket.
 *
 * ⚠️ **THE ID MATCHING IS THE WHOLE REASON THIS FILE EXISTS.** The bridge
 * broadcasts IPC events down the same socket a call is waiting on, so a client
 * that resolved on the next message to arrive would read an unrelated event as
 * its own answer — and only under load, which is the worst way to find out.
 * That branch cannot be reached by running the real thing against a quiet app;
 * it needs a socket that can be made to speak out of turn, which is this.
 *
 * The rest of the surface is refusals, and refusals are what a harness client
 * is FOR: `circle-scenario.sh` reports "the bridge did not answer" as a named
 * step, and a refusal nobody has executed is one nobody has checked names
 * anything useful.
 */

/** A socket that records what was sent and can be made to say anything back. */
function fakeSocket() {
  const listeners = new Map()
  return {
    sent: [],
    closed: false,
    /* `WebSocket.OPEN`. Present so the guard in `execute` passes; the two
       tests that need another state override it. */
    readyState: 1,
    addEventListener(type, fn) {
      const held = listeners.get(type) ?? new Set()
      held.add(fn)
      listeners.set(type, held)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    send(text) {
      this.sent.push(JSON.parse(text))
    },
    close() {
      this.closed = true
    },
    /** How many listeners are still attached — the leak check. */
    count(type) {
      return listeners.get(type)?.size ?? 0
    },
    emit(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
    },
    reply(body) {
      this.emit('message', { data: JSON.stringify(body) })
    },
  }
}

const lastId = (socket) => socket.sent.at(-1).id

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('execute — one round trip, matched by id', () => {
  it('resolves with the data of the answer carrying its own id', async () => {
    const socket = fakeSocket()
    const call = execute(socket, 'script', 'label')
    socket.reply({ id: lastId(socket), success: true, data: '{"a":1}' })
    await expect(call).resolves.toBe('{"a":1}')
  })

  it('sends the script under the execute_js command', async () => {
    const socket = fakeSocket()
    const call = execute(socket, 'the script', 'label')
    expect(socket.sent.at(-1)).toMatchObject({ command: 'execute_js', args: { script: 'the script' } })
    socket.reply({ id: lastId(socket), success: true, data: 'ok' })
    await call
  })

  it('IGNORES a message carrying another id, which is what stops an event being read as an answer', async () => {
    const socket = fakeSocket()
    const call = execute(socket, 'script', 'label')
    socket.reply({ id: 'somebody-else', success: true, data: 'the wrong answer' })
    socket.reply({ id: lastId(socket), success: true, data: 'the right one' })
    await expect(call).resolves.toBe('the right one')
  })

  it('ignores a frame that is not JSON at all, rather than dying on it', async () => {
    const socket = fakeSocket()
    const call = execute(socket, 'script', 'label')
    socket.emit('message', { data: 'not json' })
    socket.reply({ id: lastId(socket), success: true, data: 'fine' })
    await expect(call).resolves.toBe('fine')
  })

  it.each([
    ['null', null],
    ['a bare string', 'hello'],
  ])('ignores %s, which has no id to match', async (_what, body) => {
    const socket = fakeSocket()
    const call = execute(socket, 'script', 'label')
    socket.emit('message', { data: JSON.stringify(body) })
    socket.reply({ id: lastId(socket), success: true, data: 'fine' })
    await expect(call).resolves.toBe('fine')
  })

  it('rejects with the bridge’s own reason when it reports failure', async () => {
    const socket = fakeSocket()
    const call = execute(socket, 'script', 'the label')
    socket.reply({ id: lastId(socket), success: false, error: 'Script execution timeout' })
    await expect(call).rejects.toThrow(/the label: Script execution timeout/u)
  })

  it('rejects namefully when the bridge fails with no reason at all', async () => {
    const socket = fakeSocket()
    const call = execute(socket, 'script', 'the label')
    socket.reply({ id: lastId(socket), success: false })
    await expect(call).rejects.toThrow(/reported failure with no reason/u)
  })

  it('rejects when the socket closes mid-call', async () => {
    const socket = fakeSocket()
    const call = execute(socket, 'script', 'the label')
    socket.emit('close', {})
    await expect(call).rejects.toThrow(/the label: the bridge closed the connection mid-run/u)
  })

  it('rejects by name when the webview never answers', async () => {
    vi.useFakeTimers()
    const socket = fakeSocket()
    const call = execute(socket, 'script', 'the label')
    vi.advanceTimersByTime(EXECUTE_TIMEOUT_MS)
    await expect(call).rejects.toThrow(new RegExp(`the label: the webview did not answer within ${EXECUTE_TIMEOUT_MS} ms`, 'u'))
  })

  it('refuses at once on a socket that is already closed, instead of blaming the webview', async () => {
    /* ⚠️ **THIS COST 30 s AND POINTED AT THE WRONG THING.** Sending on a closed
       socket does nothing and no `close` event is coming — it already fired —
       so the call waited out the whole timeout and reported that the app did
       not answer. */
    const socket = { ...fakeSocket(), readyState: 3 }
    await expect(execute(socket, 'script', 'the label')).rejects.toThrow(/the bridge connection is not open \(readyState 3\)/u)
    expect(socket.sent).toHaveLength(0)
  })

  it('cleans up when send THROWS, rather than leaking both listeners and the timer', async () => {
    /* The fake's `send` always succeeded, so this path had never run: an
       exception rejected through the executor, which skips `cleanup()`. */
    const socket = fakeSocket()
    socket.send = () => {
      throw new Error('socket is gone')
    }
    await expect(execute(socket, 'script', 'the label')).rejects.toThrow(/the label: could not send the script: socket is gone/u)
    expect(socket.count('message')).toBe(0)
    expect(socket.count('close')).toBe(0)
  })

  it('leaves no listener behind on either exit, so a later frame cannot resolve a settled call', async () => {
    const socket = fakeSocket()
    const done = execute(socket, 'script', 'label')
    socket.reply({ id: lastId(socket), success: true, data: 'ok' })
    await done
    expect(socket.count('message')).toBe(0)
    expect(socket.count('close')).toBe(0)
  })
})

describe('evaluate — the answer, parsed', () => {
  it('parses a JSON answer', async () => {
    const socket = fakeSocket()
    const call = evaluate(socket, 'script', 'label')
    socket.reply({ id: lastId(socket), success: true, data: '{"ok":true,"n":2}' })
    await expect(call).resolves.toEqual({ ok: true, n: 2 })
  })

  it('re-encodes an answer the bridge already parsed', async () => {
    const socket = fakeSocket()
    const call = evaluate(socket, 'script', 'label')
    socket.reply({ id: lastId(socket), success: true, data: { ok: true } })
    await expect(call).resolves.toEqual({ ok: true })
  })

  it('KEEPS THE RAW TEXT when the answer is not JSON, because that text is the complaint', async () => {
    /* A caller that blindly parsed would report a SyntaxError and throw away
       the webview's actual message — which is the only thing that makes such a
       run diagnosable. */
    const socket = fakeSocket()
    const call = evaluate(socket, 'script', 'label')
    socket.reply({ id: lastId(socket), success: true, data: 'ReferenceError: x is not defined' })
    await expect(call).rejects.toThrow(/answered something that is not JSON: ReferenceError: x is not defined/u)
  })
})

describe('connect — and the two ways it does not', () => {
  const stubSocket = (behaviour) => {
    const made = []
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url) {
          this.url = url
          made.push(this)
          behaviour?.(this)
        }
        addEventListener(type, fn) {
          this[type] = fn
        }
        close() {
          this.closed = true
        }
      },
    )
    return made
  }

  it('resolves with the socket once it opens, on the port it was given', async () => {
    const made = stubSocket()
    const call = connect(4242)
    made[0].open()
    await expect(call).resolves.toBe(made[0])
    expect(made[0].url).toBe('ws://127.0.0.1:4242')
  })

  it('defaults to the pinned port when given none', async () => {
    const made = stubSocket()
    const call = connect()
    made[0].open()
    await call
    expect(made[0].url).toBe('ws://127.0.0.1:31415')
  })

  it('rejects namefully when the connection is refused', async () => {
    const made = stubSocket()
    const call = connect(4242)
    made[0].error()
    await expect(call).rejects.toThrow(/the bridge on port 4242 refused or dropped the connection/u)
  })

  it('rejects and closes the socket when nothing answers in time', async () => {
    vi.useFakeTimers()
    const made = stubSocket()
    const call = connect(4242)
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS)
    await expect(call).rejects.toThrow(new RegExp(`no answer from the bridge on port 4242 within ${CONNECT_TIMEOUT_MS} ms`, 'u'))
    expect(made[0].closed).toBe(true)
  })

  it('rejects with the cause when the constructor itself throws', async () => {
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new Error('bad url')
        }
      },
    )
    await expect(connect(4242)).rejects.toThrow(/bad url/u)
  })
})

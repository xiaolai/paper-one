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
    /* ⚠️ **`{ once: true }` IS HONOURED HERE, OR ASSERTING IT MEANS NOTHING.**
       The fake used to ignore the option, so a listener registered once and a
       listener registered for ever were the same thing to every count below. */
    addEventListener(type, fn, options) {
      const held = listeners.get(type) ?? new Set()
      const wrapped = options && options.once ? (event) => {
        held.delete(wrapped)
        fn(event)
      } : fn
      held.add(wrapped)
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

  it('gives two calls on one socket two ids, and answers each with its own', async () => {
    /* ⚠️ **ONE PENDING CALL AT A TIME IS NOT WHAT THE IDS ARE FOR.** Every
       test here started a call, answered it, and moved on — so a client that
       used one constant id would have passed all of them and misrouted every
       concurrent pair in the field, which is exactly the load-dependent
       failure the id matching exists to prevent. Two in flight, answered in
       REVERSE, each getting its own result. */
    const socket = fakeSocket()
    const first = execute(socket, 'one', 'a step')
    const second = execute(socket, 'two', 'another step')
    const [a, b] = socket.sent.map((one) => one.id)
    expect(a).not.toBe(b)

    socket.reply({ id: b, success: true, data: 'second' })
    socket.reply({ id: a, success: true, data: 'first' })
    expect(await first).toBe('first')
    expect(await second).toBe('second')
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

describe('the label a failure is quoted under', () => {
  it('falls back to the command\u2019s own name when the caller gives none', async () => {
    /* ⚠️ **NO TEST HAD EVER OMITTED THE LABEL.** Both defaults were uncovered
       outright, so `execute_js` could have been the empty string and a harness
       failure would read `: the bridge closed the connection mid-run` with
       nothing saying which call it was. */
    const socket = fakeSocket()
    const call = execute(socket, 'x')
    socket.reply({ id: lastId(socket), success: false, error: 'no' })
    await expect(call).rejects.toThrow(/^execute_js: no$/u)

    const parsing = evaluate(socket, 'x')
    socket.reply({ id: lastId(socket), success: true, data: 'not json' })
    await expect(parsing).rejects.toThrow(/^execute_js: the webview answered something that is not JSON/u)
  })

  it('names the SEND failure by what actually went wrong, thrown object or not', async () => {
    /* ⚠️ `cause && cause.message ? cause.message : cause` — a `send` that
       throws a bare string has no `message`, and reading one off it would put
       `undefined` in the error where the complaint should be. Every fixture
       threw an `Error`. */
    const socket = fakeSocket()
    socket.send = () => {
      throw 'the socket is in a bad state'
    }
    await expect(execute(socket, 'x', 'a step')).rejects.toThrow(/a step: could not send the script: the socket is in a bad state/u)
  })

  it('sends on a socket that does not report a readyState at all', async () => {
    /* ⚠️ **THE GUARD IS `!== undefined &&`, AND EVERY FAKE HAD ONE.** A
       transport that does not expose `readyState` is not a closed transport,
       and refusing it would have made the client unusable against one. */
    const socket = fakeSocket()
    delete socket.readyState
    const call = execute(socket, 'x', 'a step')
    expect(socket.sent).toHaveLength(1)
    socket.reply({ id: lastId(socket), success: true, data: '1' })
    await expect(call).resolves.toBe('1')
  })
})

describe('what every exit leaves behind', () => {
  /* ⚠️ **A LEAKED TIMER IS A HARNESS THAT DOES NOT EXIT.** Every path through
     `execute` clears its 30-second timer through `cleanup`, and nothing counted
     them: each `clearTimeout` could be deleted and the suite stayed green while
     a scenario script hung half a minute past its last call, on every call. */
  const settled = async (drive) => {
    vi.useFakeTimers()
    const socket = fakeSocket()
    const call = execute(socket, 'x', 'a step')
    await Promise.resolve()
    await drive(socket, call)
    expect(vi.getTimerCount(), 'timers left running').toBe(0)
    expect(socket.count('message'), 'message listeners left attached').toBe(0)
    expect(socket.count('close'), 'close listeners left attached').toBe(0)
  }

  it('clears the timer and both listeners when the answer arrives', async () => {
    await settled(async (socket, call) => {
      socket.reply({ id: lastId(socket), success: true, data: '1' })
      await call
    })
  })

  it('clears them when the bridge reports failure', async () => {
    await settled(async (socket, call) => {
      socket.reply({ id: lastId(socket), success: false, error: 'no' })
      await expect(call).rejects.toThrow(/a step: no/u)
    })
  })

  it('clears them when the socket closes mid-call', async () => {
    await settled(async (socket, call) => {
      socket.emit('close', {})
      await expect(call).rejects.toThrow(/closed the connection mid-run/u)
    })
  })

  it('clears them when the call TIMES OUT — the path that installs them longest', async () => {
    await settled(async (_socket, call) => {
      const waiting = expect(call).rejects.toThrow(/did not answer within/u)
      await vi.advanceTimersByTimeAsync(EXECUTE_TIMEOUT_MS + 1)
      await waiting
    })
  })

  it('clears them when the socket is already closed', async () => {
    vi.useFakeTimers()
    const socket = { ...fakeSocket(), readyState: 3 }
    await expect(execute(socket, 'x', 'a step')).rejects.toThrow(/is not open \(readyState 3\)/u)
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.count('message')).toBe(0)
  })

  it('leaves nothing running once connect has opened, or been refused', async () => {
    /* The connect timer is a 15-second one, and its two listeners are `once`.
       Left attached, a scenario that opens a socket per step accumulates both. */
    for (const event of ['open', 'error']) {
      vi.useFakeTimers()
      const socket = fakeSocket()
      vi.stubGlobal('WebSocket', function () {
        return socket
      })
      const opening = connect(31415)
      await Promise.resolve()
      socket.emit(event, {})
      await opening.catch(() => {})
      /* The timer is gone, so nothing fires half a minute later. */
      expect(vi.getTimerCount(), event).toBe(0)
      /* And the listener that FIRED took itself off — the other never fired,
         and a settled promise ignores it if it ever does. */
      expect(socket.count(event), event).toBe(0)
      /* The socket is NOT closed by a timeout that no longer applies: without
         the `clearTimeout` the connection would be dropped under a run that
         had already opened it. */
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1)
      expect(socket.closed, event).toBe(false)
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
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

  it('TRUNCATES a very long non-JSON answer, so one bad frame is not the whole log', async () => {
    /* ⚠️ **THE SLICE HAD NO TEST.** A webview that answers with a whole page of
       HTML puts every character of it into an error a scenario script prints —
       and every fixture here was a few characters long, so the bound could be
       deleted with nothing noticing. */
    const socket = fakeSocket()
    const call = evaluate(socket, 'x', 'a step')
    socket.reply({ id: lastId(socket), success: true, data: 'z'.repeat(2000) })
    const cause = await call.then(() => null, (one) => one)
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toContain('z'.repeat(400))
    expect(cause.message).not.toContain('z'.repeat(401))
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
  /**
   * ⚠️ **ONE FAKE, THE SAME ONE THE CALLS USE.** This was a second socket
   * double with different manners: it OVERWROTE a listener rather than adding
   * one, ignored `{ once: true }`, and had no `removeEventListener` at all —
   * so the connection tests could not have noticed a change to how `connect`
   * registers or removes them, and a legitimate change to that could fail
   * against the substitute rather than against the code. It also took a
   * `behaviour` callback nothing ever passed; the constructor-failure test
   * builds its own class instead, which is what that parameter was for.
   */
  const stubSocket = () => {
    const made = []
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url) {
          const socket = fakeSocket()
          Object.assign(this, socket)
          /* Bound, because `fakeSocket`'s methods close over its own maps. */
          for (const name of ['addEventListener', 'removeEventListener', 'emit', 'count', 'close', 'send', 'reply']) {
            this[name] = socket[name].bind(socket)
          }
          this.url = url
          Object.defineProperty(this, 'closed', {
            configurable: true,
            get: () => socket.closed,
          })
          made.push(this)
        }
      },
    )
    return made
  }

  it('resolves with the socket once it opens, on the port it was given', async () => {
    const made = stubSocket()
    const call = connect(4242)
    made[0].emit('open', {})
    await expect(call).resolves.toBe(made[0])
    expect(made[0].url).toBe('ws://127.0.0.1:4242')
  })

  it('defaults to the pinned port when given none', async () => {
    const made = stubSocket()
    const call = connect()
    made[0].emit('open', {})
    await call
    expect(made[0].url).toBe('ws://127.0.0.1:31415')
  })

  it('rejects namefully when the connection is refused', async () => {
    const made = stubSocket()
    const call = connect(4242)
    made[0].emit('error', {})
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

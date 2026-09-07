/**
 * A client for the Tauri MCP bridge, shared by every script that drives the
 * running app.
 *
 * The bridge speaks plain JSON over a WebSocket
 * (`tauri-plugin-mcp-bridge/src/websocket.rs`), so this needs no MCP client and
 * no npm dependency — Node has had a global `WebSocket` since v22.
 *
 * ⚠️ **EXTRACTED FROM `word-snap-live.mjs` RATHER THAN COPIED.** That file held
 * the only implementation, and `circle-scenario.sh` needed the same round trip.
 * Two copies of a protocol client is how one of them quietly stops matching the
 * plugin — and the id-matching below is the part a second copy would most
 * likely get wrong, because a client that ignores it works perfectly until the
 * app happens to emit an IPC event mid-call.
 *
 * ⚠️ **DEBUG BUILDS ONLY.** The plugin is compiled under a debug cfg, so a
 * release build answers nothing on this port. `connect` rejects by name rather
 * than hanging, because "the app is a release build" and "the app is not
 * running" look identical from here and both need saying out loud.
 */

import { randomUUID } from 'node:crypto'

/** `WebSocket.OPEN`, named so a fake socket in a test need not carry the constant. */
const OPEN = 1

/**
 * The bridge port, pinned.
 *
 * The plugin defaults to `0.0.0.0:9223` and scans the next 100 ports if that is
 * taken, so two Tauri projects on the default stack next to each other and the
 * host attaches to whichever won the bind. 9223 is the default and 9323 belongs
 * to vmark; 31415 clears both by far more than the scan window. See `AGENTS.md`.
 */
export const DEFAULT_PORT = 31415

export const CONNECT_TIMEOUT_MS = 8000
export const EXECUTE_TIMEOUT_MS = 30000

/** A WebSocket to the plugin's bridge, or a rejection naming the port. */
export function connect(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = new WebSocket('ws://127.0.0.1:' + port)
    } catch (cause) {
      reject(cause)
      return
    }
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('no answer from the bridge on port ' + port + ' within ' + CONNECT_TIMEOUT_MS + ' ms'))
    }, CONNECT_TIMEOUT_MS)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve(socket)
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('the bridge on port ' + port + ' refused or dropped the connection'))
      },
      { once: true },
    )
  })
}

/**
 * One `execute_js` round trip.
 *
 * ⚠️ **RESPONSES ARE MATCHED BY ID BECAUSE THE BRIDGE ALSO BROADCASTS EVENTS
 * DOWN THE SAME SOCKET.** A client that took the next message to arrive would
 * read an IPC event as its own answer — and would do it only under load, which
 * is the worst way to find out. Every exit clears the listeners, so a later
 * message cannot resolve a settled call.
 */
export function execute(socket, script, label = 'execute_js') {
  return new Promise((resolve, reject) => {
    const id = randomUUID()

    function cleanup() {
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(label + ': the webview did not answer within ' + EXECUTE_TIMEOUT_MS + ' ms'))
    }, EXECUTE_TIMEOUT_MS)

    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message === null || typeof message !== 'object' || message.id !== id) return
      cleanup()
      if (message.success !== true) {
        reject(new Error(label + ': ' + String(message.error ?? 'the bridge reported failure with no reason')))
        return
      }
      resolve(message.data)
    }

    const onClose = () => {
      cleanup()
      reject(new Error(label + ': the bridge closed the connection mid-run'))
    }

    /* ⚠️ **A CLOSED SOCKET SWALLOWS THE SEND AND BLAMES THE WEBVIEW.** Sending
       on a socket that has already closed does nothing, no `close` event is
       coming (it already fired), and the call sat out the full 30 s before
       reporting that the app did not answer — which sent an investigation to
       the app rather than to the connection. Refused at once, by name. */
    if (socket.readyState !== undefined && socket.readyState !== OPEN) {
      cleanup()
      reject(new Error(label + ': the bridge connection is not open (readyState ' + socket.readyState + ')'))
      return
    }

    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    /* ⚠️ **AND A THROWING `send` MUST NOT LEAK THE LISTENERS AND THE TIMER.**
       An exception here rejected the promise through the executor, which skips
       `cleanup()` entirely: both listeners and the 30 s timer stayed attached
       to a socket nobody was waiting on any more, and the original error lost
       its label. */
    try {
      socket.send(JSON.stringify({ id, command: 'execute_js', args: { script } }))
    } catch (cause) {
      cleanup()
      reject(new Error(label + ': could not send the script: ' + String(cause && cause.message ? cause.message : cause)))
    }
  })
}

/**
 * `execute`, with the result parsed as JSON.
 *
 * ⚠️ **THE BRIDGE ANSWERS WITH A STRING, AND IT IS NOT ALWAYS JSON.** A script
 * that throws comes back as a message rather than as a rejection in some
 * plugin versions, so a caller that blindly `JSON.parse`d would report a
 * SyntaxError and lose the actual complaint. This keeps the raw text in the
 * error, which is the only thing that makes such a run diagnosable.
 */
export async function evaluate(socket, script, label = 'execute_js') {
  const raw = await execute(socket, script, label)
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(label + ': the webview answered something that is not JSON: ' + String(text).slice(0, 400))
  }
}

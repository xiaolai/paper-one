#!/usr/bin/env node
/**
 * A throwaway TLS front for the shelf, so the browser client can be looked at.
 *
 * `node scripts/dev-tls.mjs [--port 27183] [--target 27182]`
 *
 * ## Why this exists
 *
 * Measured 2026-08-25: WebKit stores the `Secure` session cookie from
 * `http://127.0.0.1` and then refuses to SEND it. So **every screen behind the
 * six digits is unreachable over plain HTTP** — the shelf, the reader, the
 * connection states, all of it. Development was stuck at the gate screen.
 *
 * Paper does not ship TLS and will not: the shelf listens on loopback and the
 * reader puts something in front of it that terminates TLS on a name their
 * browser trusts. That is the right division — it is one Caddy line for anyone
 * who has a certificate, and it keeps Paper out of the business of operating
 * one.
 *
 * But a DEVELOPER still has to see the thing. This is the smallest possible
 * stand-in: a self-signed certificate generated on the spot and thrown away,
 * proxying to the shelf.
 *
 * ## What it is NOT
 *
 * Not a deployment, and it must never become one. The certificate is
 * self-signed, generated fresh on every run and written to a temporary
 * directory — no browser will trust it and no phone should be asked to. It
 * exists so `shot-client.mjs` (which can ignore certificate errors) and a
 * desktop browser with a click-through can reach the connected states.
 *
 * A real phone still needs the reader's own TLS. That is the point, not a gap.
 */

import { createServer } from 'node:https'
import { request } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const valueOf = (flag, fallback) => {
  const at = args.indexOf(flag)
  return at === -1 ? fallback : Number(args[at + 1])
}
const PORT = valueOf('--port', 27183)
const TARGET = valueOf('--target', 27182)

/* Generated fresh, into a temporary directory, every run. A key that persists
 * is a key somebody eventually trusts. */
const dir = mkdtempSync(join(tmpdir(), 'paper-dev-tls-'))
const keyPath = join(dir, 'key.pem')
const certPath = join(dir, 'cert.pem')

try {
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1',
      '-subj', '/CN=localhost',
      /* `localhost` AND `127.0.0.1`, because a browser matches the name it was
       * given and the two are not interchangeable to it. */
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
} catch (error) {
  console.error(`dev-tls: could not generate a certificate with openssl: ${String(error)}`)
  process.exit(2)
}

const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (from, to) => {
    /* A plain pipe. Headers pass through untouched — including `Cookie` and
     * `Set-Cookie`, which is the entire reason this exists. */
    const upstream = request(
      { host: '127.0.0.1', port: TARGET, method: from.method, path: from.url, headers: from.headers },
      (answer) => {
        to.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(to)
      },
    )
    upstream.on('error', (error) => {
      to.writeHead(502, { 'content-type': 'text/plain' })
      to.end(`dev-tls: the shelf is not answering on ${TARGET}: ${error.message}\n`)
    })
    from.pipe(upstream)
  },
)

/* WEBSOCKETS TOO, or the channel cannot open and only the gate is reachable —
 * which would leave this script solving half the problem it exists for. */
server.on('upgrade', (from, socket, head) => {
  const upstream = request({
    host: '127.0.0.1',
    port: TARGET,
    method: from.method,
    path: from.url,
    headers: from.headers,
  })
  upstream.end()
  upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
    const lines = Object.entries(answer.headers).map(([k, v]) => `${k}: ${String(v)}`)
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) socket.unshift(upstreamHead)
    if (head.length > 0) upstreamSocket.unshift(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })
  /* AN UPGRADE THAT IS REFUSED IS STILL AN ANSWER. The shelf replies 401 to a
   * socket with no credential, which is not an `upgrade` event — so with only
   * the handler above, the browser sat in CONNECTING for ever: no open, no
   * error, no close. That looks exactly like a hung shelf and is not one.
   *
   * Relay whatever came back and let the browser see it. */
  upstream.on('response', (answer) => {
    const lines = Object.entries(answer.headers).map(([k, v]) => `${k}: ${String(v)}`)
    socket.write(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage ?? ''}\r\n${lines.join('\r\n')}\r\n\r\n`)
    answer.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev-tls: https://localhost:${PORT} → http://127.0.0.1:${TARGET}`)
  console.log('  Self-signed and thrown away on exit. A browser will warn; a phone should not be asked.')
})

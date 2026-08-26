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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const valueOf = (flag, fallback) => {
  const at = args.indexOf(flag)
  return at === -1 ? fallback : Number(args[at + 1])
}
const textOf = (flag) => {
  const at = args.indexOf(flag)
  return at === -1 ? null : args[at + 1]
}
const PORT = valueOf('--port', 27183)
const TARGET = valueOf('--target', 27182)

/**
 * What this front listens on. LOOPBACK BY DEFAULT, and widening it is a choice
 * the caller makes out loud.
 *
 * A phone cannot reach `127.0.0.1`, so serving one means binding somewhere it
 * can — a tailnet address, usually. That is a real exposure decision and it is
 * not the default: the difference between "my shelf is on my tailnet" and "my
 * shelf is on the café wifi" is which address goes here, and a default of
 * `0.0.0.0` would make that choice silently.
 *
 *   --host 100.x.y.z     the tailnet only
 *   --host 0.0.0.0       every interface, including the LAN
 */
const HOST = textOf('--host') ?? '127.0.0.1'

/**
 * A CERTIFICATE THE CALLER SUPPLIED, or a throwaway one.
 *
 * `--cert` and `--key` exist for the case the throwaway cannot serve: **a
 * phone.** A self-signed certificate is refused by iOS, and the right answer is
 * not to teach somebody to click past that — clicking past the warning is
 * clicking past the only thing authenticating the shelf. The right answer is a
 * certificate the device genuinely trusts, which for a private tailnet means a
 * CA of your own:
 *
 *   brew install mkcert && mkcert -install
 *   mkcert <your machine's MagicDNS name>
 *   node scripts/dev-tls.mjs --cert ./<name>.pem --key ./<name>-key.pem
 *
 * then install `$(mkcert -CAROOT)/rootCA.pem` on the phone and turn on full
 * trust for it. That is the opposite of ignoring a warning: a wrong certificate
 * still fails.
 *
 * ⚠️ `tailscale serve` IS NOT AN OPTION ON EVERY TAILNET, whatever the Browsers
 * pane suggests. It needs Tailscale-operated certificate issuance for a
 * `.ts.net` name; on a self-hosted Headscale control server `tailscale cert`
 * answers "your Tailscale account does not support getting TLS certs", and
 * HTTPS support for `serve` is an open feature request against Headscale.
 */
const suppliedCert = textOf('--cert')
const suppliedKey = textOf('--key')
if ((suppliedCert === null) !== (suppliedKey === null)) {
  console.error('dev-tls: --cert and --key go together; supply both or neither')
  process.exit(2)
}

let keyPath = suppliedKey
let certPath = suppliedCert

if (certPath === null) {
  /* Generated fresh, into a temporary directory, every run. A key that persists
   * is a key somebody eventually trusts. */
  const dir = mkdtempSync(join(tmpdir(), 'paper-dev-tls-'))
  keyPath = join(dir, 'key.pem')
  certPath = join(dir, 'cert.pem')

  /* AND THROWN AWAY AT THE END, which "generated fresh every run" did not
     previously include. The directory outlived the process, so every run left a
     private key on disk in `$TMPDIR` — readable, valid for a day, and
     accumulating one per run. A throwaway key nobody throws away is just a key
     with a short expiry, and the argument above for generating it fresh is
     precisely the argument for removing it.

     On the ordinary exit and on the signals a terminal actually sends. `SIGKILL`
     and a crash still leak, which is what `$TMPDIR` cleanup is for; these cover
     everything a reader does on purpose. */
  const sweep = () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Best effort at teardown — a failure here must not mask the exit. */
    }
  }
  process.on('exit', sweep)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      sweep()
      process.exit(130)
    })
  }

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
} else {
  /* READ BOTH BEFORE BINDING, so a wrong path is a message and not a server
   * that accepts a connection and then cannot complete a handshake. */
  for (const [flag, path] of [['--cert', certPath], ['--key', keyPath]]) {
    try {
      readFileSync(path)
    } catch {
      console.error(`dev-tls: cannot read ${flag} ${path}`)
      process.exit(2)
    }
  }
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
    /* EACH HEAD GOES THE WAY IT WAS ALREADY TRAVELLING, and this was backwards.
     *
     * `head` is what the CLIENT sent after its upgrade request; `upstreamHead`
     * is what the SHELF sent after its 101. Both are bytes already in flight
     * toward the other side. The code `unshift`ed them, which pushes data back
     * onto a stream's READABLE side — so `socket.unshift(upstreamHead)` made
     * the client's socket read the shelf's bytes as though the client had sent
     * them, and `socket.pipe(upstreamSocket)` then forwarded them straight back
     * to the shelf. Each head travelled to the end it came from.
     *
     * It is invisible almost always: both heads are usually empty, because a
     * browser waits for the 101 before sending a frame. It bites exactly when a
     * client is quick enough to send its first frame with the handshake — and
     * then the channel's first message is lost and mirrored, which reads as the
     * shelf being broken.
     *
     * Written BEFORE the pipes, so the bytes keep their place in the stream. */
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
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

server.listen(PORT, HOST, () => {
  /* THE BANNER SAYS WHAT IS ACTUALLY RUNNING. It said "https://localhost" and
   * "self-signed, a browser will warn" unconditionally — both false the moment
   * a certificate and a host were supplied, which is exactly the run where
   * somebody is reading it carefully because a phone is involved. A startup
   * line that describes a different configuration is worse than none. */
  const shown = HOST === '127.0.0.1' ? 'localhost' : HOST
  console.log(`dev-tls: https://${shown}:${PORT} → http://127.0.0.1:${TARGET}`)
  if (suppliedCert === null) {
    console.log('  Self-signed and thrown away on exit. A browser will warn; a phone should not be asked.')
  } else {
    console.log(`  Serving ${suppliedCert}. A device that trusts its issuer will not warn.`)
  }
  if (HOST !== '127.0.0.1') {
    console.log(`  ⚠️  Reachable from ${HOST === '0.0.0.0' ? 'every interface, including the local network' : 'that address'} — not just this machine.`)
  }
})

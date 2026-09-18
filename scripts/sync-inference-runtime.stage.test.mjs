import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { LLAMACPP_TAG, MANIFEST_FILE, VENDOR, main, sha256, stage, stampFor } from './sync-inference-runtime.mjs'

/**
 * THE STAGING ITSELF — one archive in, one verified tree out.
 *
 * The pure pieces (`buildManifest`, `promote`, the stamp) are pinned in
 * `sync-inference-runtime.pin.test.mjs`. What nothing tested until 2026-09-18
 * was the run that strings them together, because it fetches from GitHub.
 * That run is also what changed most when `lemond` left: it stages ONE archive
 * now, writes a version-2 manifest, and has to replace a Lemonade-era tree
 * whole rather than keep it. So `fetch` is stubbed with an archive built here,
 * under a pin whose digest is computed from it, and everything else — the
 * unpack, the link copies, the manifest, the stamp, the promotion — is the
 * production path.
 */

const TAG = LLAMACPP_TAG
const RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}`

let root
let logs
let fetched

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sync-runtime-stage-'))
  logs = []
  fetched = []
  for (const level of ['log', 'warn', 'error']) {
    vi.spyOn(console, level).mockImplementation((...parts) => {
      logs.push(parts.join(' '))
    })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

/** `fetch` answering every request with `bytes`, recording what was asked for. */
function serve(bytes) {
  vi.stubGlobal('fetch', async (url) => {
    fetched.push(String(url))
    return new Response(bytes)
  })
}

/** `fetch` failing the way an offline machine does. */
function offline() {
  vi.stubGlobal('fetch', async (url) => {
    fetched.push(String(url))
    throw new Error('offline')
  })
}

/** Every entry under `dir`, forward-slashed and sorted, directories excluded. */
function filesUnder(dir) {
  const out = []
  const walk = (at, prefix) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(at, entry.name), relative)
      else out.push(relative)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * A llama.cpp macOS release in miniature, as the real one is laid out: a
 * `llama-b…/` wrapper, the server, a versioned library and the bare-name link
 * to it, and the licence.
 */
function tarball() {
  const src = path.join(root, 'src')
  const wrapper = path.join(src, `llama-${TAG}`)
  mkdirSync(wrapper, { recursive: true })
  writeFileSync(path.join(wrapper, 'llama-server'), 'server')
  writeFileSync(path.join(wrapper, 'libggml.0.dylib'), 'lib')
  symlinkSync('libggml.0.dylib', path.join(wrapper, 'libggml.dylib'))
  writeFileSync(path.join(wrapper, 'LICENSE'), 'MIT')
  const archive = path.join(root, 'fixture.tar.gz')
  /* COPYFILE_DISABLE, or macOS `tar` adds `._*` AppleDouble entries that
     another platform's `tar` unpacks as real files. */
  execFileSync('tar', ['czf', archive, '-C', src, `llama-${TAG}`], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  return readFileSync(archive)
}

/** A Mach-O in miniature: the magic, then each name it records, NUL-terminated. */
function macho(...records) {
  return Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), ...records.map((name) => Buffer.from(`@rpath/${name}\0`))])
}

/**
 * The real macOS release's SHAPE: the server and its `-impl`, another tool
 * and ITS `-impl`, the network RPC server, a library under its three names
 * with the loader's name recorded by the server, and the licence.
 */
function releaseTarball() {
  const src = path.join(root, 'src')
  const wrapper = path.join(src, `llama-${TAG}`)
  mkdirSync(wrapper, { recursive: true })
  writeFileSync(path.join(wrapper, 'llama-server'), macho('libllama-server-impl.dylib', 'libggml.0.dylib'))
  writeFileSync(path.join(wrapper, 'libllama-server-impl.dylib'), macho('libggml.0.dylib'))
  writeFileSync(path.join(wrapper, 'llama-cli'), macho('libllama-cli-impl.dylib', 'libggml.0.dylib'))
  writeFileSync(path.join(wrapper, 'libllama-cli-impl.dylib'), macho('libggml.0.dylib'))
  writeFileSync(path.join(wrapper, 'ggml-rpc-server'), macho('libggml.0.dylib'))
  writeFileSync(path.join(wrapper, 'libggml.0.19.0.dylib'), macho('libggml.0.dylib'))
  symlinkSync('libggml.0.19.0.dylib', path.join(wrapper, 'libggml.0.dylib'))
  symlinkSync('libggml.0.dylib', path.join(wrapper, 'libggml.dylib'))
  writeFileSync(path.join(wrapper, 'LICENSE'), 'MIT')
  const archive = path.join(root, 'release.tar.gz')
  execFileSync('tar', ['czf', archive, '-C', src, `llama-${TAG}`], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  return readFileSync(archive)
}

/**
 * A zip of regular files, stored uncompressed — the format `unpack` reads for
 * Windows. Written here rather than by a `zip` tool, which not every machine
 * that runs this suite has; `unzip` and Windows's bsdtar, which unpack it,
 * are what production already needs.
 */
function zipOf(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of entries) {
    const data = Buffer.from(text)
    const bytesOfName = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x21, 12) // 1980-01-01, the earliest date a zip can say
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(bytesOfName.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(bytesOfName.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, bytesOfName, data)
    centrals.push(central, bytesOfName)
    offset += local.length + bytesOfName.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** A pin for `bytes`, as `BACKENDS` spells one, with the digest computed here. */
function pinFor(bytes, { backend = 'metal', asset = 'fixture.tar.gz', server = 'llama-server' } = {}) {
  return { backend, asset, sha256: sha256(bytes), server }
}

/** A tree as the lemond-era script left it, stamp and version-1 manifest included. */
function lemondEraTree(dir) {
  mkdirSync(path.join(dir, 'resources'), { recursive: true })
  mkdirSync(path.join(dir, 'backend', 'llamacpp', 'metal'), { recursive: true })
  writeFileSync(path.join(dir, 'lemond'), 'daemon')
  writeFileSync(path.join(dir, 'lemonade'), 'client')
  writeFileSync(path.join(dir, 'LICENSE'), 'Lemonade licence')
  writeFileSync(path.join(dir, 'resources', 'backend_versions.json'), '{}')
  writeFileSync(path.join(dir, 'backend', 'llamacpp', 'metal', 'llama-server'), 'the old server')
  writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ version: 1, lemonade: '11.7.0' }))
  writeFileSync(path.join(dir, '.version'), `11.7.0 darwin-arm64 llamacpp-${TAG} metal\n`)
}

const manifestOf = (dir) => JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'))

describe('stage, from a tarball', () => {
  /* The macOS and Linux archives are tarballs, unpacked by plain `tar`, and
     the fixture carries a symbolic link. On Windows plain `tar` may be Git's
     GNU tar, which reads `D:` as a remote host, and a link needs a privilege
     a test runner may not hold — and no Windows archive is a tarball, so
     nothing there takes this path. */
  beforeEach((context) => {
    if (process.platform === 'win32') {
      context.skip('Windows unpacks only zips, and its plain `tar` and link rules are not the ones this path uses')
    }
  })

  it('stages the server, its libraries with their links copied, a version-2 manifest and the stamp', async () => {
    const dir = path.join(root, 'current')
    const bytes = tarball()
    serve(bytes)

    await stage(dir, 'darwin-arm64', pinFor(bytes))

    expect(fetched).toEqual([`${RELEASE}/fixture.tar.gz`])
    expect(filesUnder(dir)).toEqual([
      '.version',
      'backend/llamacpp/metal/LICENSE',
      'backend/llamacpp/metal/libggml.0.dylib',
      'backend/llamacpp/metal/libggml.dylib',
      'backend/llamacpp/metal/llama-server',
      MANIFEST_FILE,
    ])
    const link = path.join(dir, 'backend', 'llamacpp', 'metal', 'libggml.dylib')
    expect(lstatSync(link).isSymbolicLink(), 'the bundle copy dereferences, so the tree must already have').toBe(false)
    expect(readFileSync(link, 'utf8')).toBe('lib')

    const manifest = manifestOf(dir)
    expect(Object.keys(manifest)).toEqual(['version', 'platform', 'llamacpp', 'files'])
    expect(manifest.version).toBe(2)
    expect(manifest.platform).toBe('darwin-arm64')
    expect(manifest.llamacpp).toEqual({ tag: TAG, backend: 'metal', server: 'backend/llamacpp/metal/llama-server' })
    expect(manifest.files.map((f) => f.path)).toEqual([
      'backend/llamacpp/metal/LICENSE',
      'backend/llamacpp/metal/libggml.0.dylib',
      'backend/llamacpp/metal/libggml.dylib',
      'backend/llamacpp/metal/llama-server',
    ])
    expect(readFileSync(path.join(dir, '.version'), 'utf8')).toBe(`${stampFor('darwin-arm64')}\n`)
    /* Nothing of the run is left beside the tree: not the archive, not the
       staging directory, not the tree it displaced. */
    expect(existsSync(`${dir}.staging`)).toBe(false)
    expect(existsSync(`${dir}.previous`)).toBe(false)
    expect(logs).toContain(`sync-inference-runtime: staged darwin-arm64 llama.cpp ${TAG} (metal), 4 files, into ${VENDOR}`)
  })

  /* ⚠️ THE TRIM, THROUGH THE WHOLE RUN. The release is llama.cpp's toolbox;
     Paper runs one program in it. Another tool and its `-impl` library, and
     `ggml-rpc-server` — a network server — must not reach the tree or the
     manifest, and the library the server loads arrives under the ONE name
     its load command asks for, not three copies. */
  it('stages only the server and what it loads: no other tool, no other tool’s library, one name per library', async () => {
    const dir = path.join(root, 'current')
    const bytes = releaseTarball()
    serve(bytes)

    await stage(dir, 'darwin-arm64', pinFor(bytes, { asset: 'release.tar.gz' }))

    const staged = [
      'backend/llamacpp/metal/LICENSE',
      'backend/llamacpp/metal/libggml.0.dylib',
      'backend/llamacpp/metal/libllama-server-impl.dylib',
      'backend/llamacpp/metal/llama-server',
    ]
    expect(filesUnder(dir)).toEqual(['.version', ...staged, MANIFEST_FILE])
    expect(manifestOf(dir).files.map((f) => f.path), 'the manifest lists exactly what is staged').toEqual(staged)
    const library = path.join(dir, 'backend', 'llamacpp', 'metal', 'libggml.0.dylib')
    expect(lstatSync(library).isSymbolicLink()).toBe(false)
    expect(readFileSync(library)).toEqual(macho('libggml.0.dylib'))
    expect(readFileSync(path.join(dir, '.version'), 'utf8')).toBe(`${stampFor('darwin-arm64')}\n`)
    expect(logs).toContain(
      'sync-inference-runtime: kept 4 of the 9 files release.tar.gz ships — llama-server, its libraries and what cannot run',
    )
  })

  /* AND A TREE STAGED WHOLE, BEFORE THE TRIM, IS REPLACED rather than kept:
     its stamp names today's pin and backend, and only the missing rule word
     says it holds every tool llama.cpp ships. */
  it('replaces a tree staged whole before the trim, though its pin is today’s', async () => {
    const dir = path.join(root, 'current')
    const metal = path.join(dir, 'backend', 'llamacpp', 'metal')
    mkdirSync(metal, { recursive: true })
    writeFileSync(path.join(metal, 'llama-server'), 'the untrimmed server')
    writeFileSync(path.join(metal, 'llama-cli'), 'a tool Paper never runs')
    writeFileSync(path.join(metal, 'ggml-rpc-server'), 'a network server')
    writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ version: 2 }))
    writeFileSync(path.join(dir, '.version'), `llamacpp-${TAG} darwin-arm64 metal\n`)
    const bytes = releaseTarball()
    serve(bytes)

    await stage(dir, 'darwin-arm64', pinFor(bytes, { asset: 'release.tar.gz' }))

    expect(fetched).toEqual([`${RELEASE}/release.tar.gz`])
    expect(readdirSync(metal).sort()).toEqual(['LICENSE', 'libggml.0.dylib', 'libllama-server-impl.dylib', 'llama-server'])
    expect(readFileSync(path.join(dir, '.version'), 'utf8')).toBe(`${stampFor('darwin-arm64')}\n`)
  })

  /* ⚠️ THE CASE THIS REWRITE EXISTS FOR. A lemond-era tree carries the daemon,
     Lemonade's resources and a version-1 manifest the plugin refuses; kept,
     every launch would fail verification. Replaced WHOLE — a merge over it
     would leave `lemond` beside a manifest that never heard of it, which the
     plugin refuses as a stranger in the tree. */
  it('replaces a lemond-era tree whole, leaving nothing of Lemonade behind', async () => {
    const dir = path.join(root, 'current')
    lemondEraTree(dir)
    const bytes = tarball()
    serve(bytes)

    await stage(dir, 'darwin-arm64', pinFor(bytes))

    expect(readdirSync(dir).sort()).toEqual(['.version', 'backend', MANIFEST_FILE])
    expect(readFileSync(path.join(dir, 'backend', 'llamacpp', 'metal', 'llama-server'), 'utf8')).toBe('server')
    expect(manifestOf(dir).version).toBe(2)
    expect(manifestOf(dir)).not.toHaveProperty('lemonade')
  })
})

describe('stage, from a zip', () => {
  /* llama.cpp's Windows zips put the files at the top, with no wrapper — the
     shape production meets — and carry every other tool as an `.exe` with an
     `-impl.dll` beside it, which the trim leaves behind. */
  it('unpacks a zip with no wrapper straight into the backend directory, leaving the other tools behind', async () => {
    const dir = path.join(root, 'current')
    const bytes = zipOf([
      ['llama-server.exe', 'MZ server'],
      ['llama-server-impl.dll', 'MZ server body'],
      ['ggml.dll', 'MZ lib'],
      ['llama-cli.exe', 'MZ another tool'],
      ['llama-cli-impl.dll', 'MZ its body'],
      ['LICENSE', 'MIT'],
    ])
    serve(bytes)

    await stage(dir, 'win32-x64', pinFor(bytes, { backend: 'cpu', asset: 'fixture.zip', server: 'llama-server.exe' }))

    expect(filesUnder(dir)).toEqual([
      '.version',
      'backend/llamacpp/cpu/LICENSE',
      'backend/llamacpp/cpu/ggml.dll',
      'backend/llamacpp/cpu/llama-server-impl.dll',
      'backend/llamacpp/cpu/llama-server.exe',
      MANIFEST_FILE,
    ])
    expect(manifestOf(dir).llamacpp.server).toBe('backend/llamacpp/cpu/llama-server.exe')
    expect(readFileSync(path.join(dir, '.version'), 'utf8')).toBe(`${stampFor('win32-x64')}\n`)
  })

  /* A zip has no `--strip-components`, so a wrapper is moved up by hand —
     Lemonade's zip had one, and the move once failed on a tree that was
     actually fine. */
  it('flattens a zip whose files sit under one wrapper directory', async () => {
    const dir = path.join(root, 'current')
    const bytes = zipOf([
      [`llama-${TAG}/llama-server.exe`, 'server'],
      [`llama-${TAG}/LICENSE`, 'MIT'],
    ])
    serve(bytes)

    await stage(dir, 'win32-x64', pinFor(bytes, { backend: 'cpu', asset: 'fixture.zip', server: 'llama-server.exe' }))

    expect(filesUnder(dir)).toEqual([
      '.version',
      'backend/llamacpp/cpu/LICENSE',
      'backend/llamacpp/cpu/llama-server.exe',
      MANIFEST_FILE,
    ])
  })
})

describe('stage, when nothing needs fetching or nothing can be', () => {
  it('does not fetch for a tree already staged at this pin, and leaves it as it is', async () => {
    const dir = path.join(root, 'current')
    mkdirSync(dir)
    writeFileSync(path.join(dir, '.version'), `${stampFor('darwin-arm64')}\n`)
    writeFileSync(path.join(dir, 'kept'), 'untouched')
    serve(Buffer.from('never asked for'))

    await stage(dir, 'darwin-arm64', pinFor(Buffer.from('never asked for')))

    expect(fetched).toEqual([])
    expect(readFileSync(path.join(dir, 'kept'), 'utf8')).toBe('untouched')
    expect(logs).toContain(`sync-inference-runtime: darwin-arm64 llama.cpp ${TAG} (metal) already staged`)
  })

  /* Absent is a normal state; shipping the previous pin's tree is not. */
  it('removes a stale tree and leaves the directory present but empty when the archive cannot be fetched', async () => {
    const dir = path.join(root, 'current')
    lemondEraTree(dir)
    offline()

    await stage(dir, 'darwin-arm64', pinFor(Buffer.from('unreachable')))

    expect(readdirSync(dir)).toEqual(['RUNTIME-ABSENT.txt'])
    expect(readFileSync(path.join(dir, 'RUNTIME-ABSENT.txt'), 'utf8')).toContain(
      `darwin-arm64 llama.cpp ${TAG} (metal) could not be fetched.`,
    )
    expect(logs).toContain('sync-inference-runtime: could not fetch fixture.tar.gz (offline) — the local route will report Absent')
    expect(logs).toContain(
      `sync-inference-runtime: removed the tree staged for an older pin — darwin-arm64 llama.cpp ${TAG} (metal) could not be fetched, so the companion's local route will report Absent`,
    )
  })

  it('says nothing about removing a tree when there was none', async () => {
    const dir = path.join(root, 'current')
    offline()

    await stage(dir, 'darwin-arm64', pinFor(Buffer.from('unreachable')))

    expect(readdirSync(dir)).toEqual(['RUNTIME-ABSENT.txt'])
    expect(logs.some((line) => line.includes('removed'))).toBe(false)
  })
})

describe('main', () => {
  /* A host with no published runtime keeps nothing: `VENDOR` cannot name a
     platform, so a tree staged elsewhere would ship in this host's bundle. */
  it('empties the tree on a host with no published runtime, and says why', async () => {
    const dir = path.join(root, VENDOR)
    lemondEraTree(dir)
    offline()

    await main({ root, platform: 'android', arch: 'arm64' })

    expect(fetched).toEqual([])
    expect(readdirSync(dir)).toEqual(['RUNTIME-ABSENT.txt'])
    expect(readFileSync(path.join(dir, 'RUNTIME-ABSENT.txt'), 'utf8')).toContain('No runtime is published for android-arm64.')
    expect(logs).toContain('sync-inference-runtime: removed a runtime staged for another host')
    expect(logs).toContain(
      "sync-inference-runtime: no runtime published for android-arm64 — the companion's local route will report Absent",
    )
    expect(existsSync(`${dir}.lock`), 'the lock outlived the run').toBe(false)
  })

  /* A supported host asks for ITS pinned archive, from the pinned release —
     the one request in this file that names the real asset. */
  it('asks for the host’s pinned archive, and releases the lock when it cannot have it', async () => {
    const dir = path.join(root, VENDOR)
    offline()

    await main({ root, platform: 'darwin', arch: 'arm64' })

    expect(fetched).toEqual([`${RELEASE}/llama-${TAG}-bin-macos-arm64.tar.gz`])
    expect(readFileSync(path.join(dir, 'RUNTIME-ABSENT.txt'), 'utf8')).toContain(
      `darwin-arm64 llama.cpp ${TAG} (metal) could not be fetched.`,
    )
    expect(existsSync(`${dir}.lock`), 'the lock outlived the run').toBe(false)
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * The one archive format this repository reads and writes, in Node alone.
 *
 * WHY IT EXISTS. `scan-corpus.mjs` shelled out to `unzip -p`, and the corpus
 * fixtures were built by shelling out to `zip`. Neither ships with Windows, so
 * eleven cases died with `spawnSync zip ENOENT` the first time that leg ran a
 * test suite — and `pnpm corpus` could not run there at all. `node:zlib` is
 * built in and speaks the only compression an EPUB ever uses, so the tools
 * were a dependency on the host rather than on anything the format required.
 *
 * DELIBERATELY SMALL. It reads the archives a reader's library actually holds
 * and writes the ones a fixture needs; it is not a general ZIP library. What
 * it does not implement it REFUSES — see `ZIP64` below — because a silent
 * misparse of a real book would be counted as a finding about that book, and
 * this whole corpus scan exists to turn design arguments into numbers.
 */

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const STORED = 0
const DEFLATED = 8
/** The EOCD is followed by a comment of up to this length, so it must be sought. */
const MAX_COMMENT = 0xffff
/** A count or offset of this value in the EOCD means the real one is in a ZIP64 record. */
const ZIP64_MARKER = 0xffffffff

/**
 * What a caller gets for an archive that cannot be read at all.
 *
 * A SENTINEL rather than an empty answer, and `scan-corpus.mjs` explains why
 * at length: "no member matched" is one of that scan's headline findings — a
 * book whose whole typography is Paper's sheet — and a corrupt archive
 * reported as the same thing is a silence dressed as a measurement.
 */
export const UNREADABLE = Symbol('unreadable')

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * `unzip`'s own pattern matching, which is the shell's and not a path's.
 *
 * `*` CROSSES A DIRECTORY SEPARATOR here. That is not an oversight copied from
 * a glob library: `unzip -p book.epub '*.css'` matches `OEBPS/styles/main.css`,
 * and every pattern this repository passes depends on it. A `*` that stopped
 * at `/` would find the stylesheets of flat books only, and report the rest as
 * having none — which is the exact false finding the sentinel above exists to
 * keep separate.
 */
export function matchesPattern(name, pattern) {
  const rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${rx}$`).test(name)
}

/** The central directory's entries, or null if this is not a readable archive. */
function centralDirectory(buf) {
  const from = Math.max(0, buf.length - MAX_COMMENT - 22)
  let eocd = -1
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  const start = buf.readUInt32LE(eocd + 16)
  /* ZIP64 IS REFUSED, NOT GUESSED. The 32-bit fields saturate and the true
     values live in a record this does not parse; reading the saturated ones
     would walk into the middle of the file and produce members that are not
     there. An EPUB over 4 GB or of 65 535 members is not a thing a reader's
     shelf holds, so refusing is honest and costs nothing. */
  if (count === 0xffff || start === ZIP64_MARKER) return null
  const entries = []
  let at = start
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIG) return null
    const method = buf.readUInt16LE(at + 10)
    const compressed = buf.readUInt32LE(at + 20)
    const uncompressed = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const offset = buf.readUInt32LE(at + 42)
    if (compressed === ZIP64_MARKER || uncompressed === ZIP64_MARKER || offset === ZIP64_MARKER) return null
    entries.push({
      name: buf.toString('utf8', at + 46, at + 46 + nameLen),
      method,
      compressed,
      offset,
    })
    at += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** One member's bytes, read through its LOCAL header — the only one that says where data starts. */
function bytesOf(buf, entry) {
  const at = entry.offset
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL_SIG) return null
  /* THE LOCAL HEADER'S OWN LENGTHS, not the central directory's. The extra
     field routinely differs between the two — a local one carries alignment
     padding a central one does not — and using the central length lands short
     of the data or inside it. */
  const nameLen = buf.readUInt16LE(at + 26)
  const extraLen = buf.readUInt16LE(at + 28)
  const from = at + 30 + nameLen + extraLen
  const raw = buf.subarray(from, from + entry.compressed)
  if (entry.method === STORED) return raw
  if (entry.method !== DEFLATED) return null
  try {
    return inflateRawSync(raw)
  } catch {
    return null
  }
}

/**
 * The members of an archive matching any of `patterns`, in archive order.
 *
 * Returns `UNREADABLE` for an archive that cannot be parsed, and an empty
 * array when it parsed and simply held nothing matching — the distinction
 * `scan-corpus.mjs` turns into two different findings.
 */
export function readMatching(file, patterns) {
  if (!existsSync(file)) return UNREADABLE
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return UNREADABLE
  }
  const entries = centralDirectory(buf)
  if (entries === null) return UNREADABLE
  const out = []
  for (const entry of entries) {
    if (!patterns.some((p) => matchesPattern(entry.name, p))) continue
    const bytes = bytesOf(buf, entry)
    /* A MEMBER THAT WILL NOT INFLATE MAKES THE WHOLE ARCHIVE UNREADABLE, which
       is what `unzip` did: it exits 9 on a corrupt member and this scan folds
       every non-zero-but-11 status into the sentinel. Returning the members
       that did inflate would report a partial book as a whole one. */
    if (bytes === null) return UNREADABLE
    out.push(bytes)
  }
  return out
}

/**
 * A STORE-only archive of `members`, as a Buffer.
 *
 * Uncompressed throughout, deliberately: a fixture is read once by the test
 * that wrote it, compression buys nothing, and STORE is the one method every
 * reader — including `unzip`, so a person can still inspect a fixture by hand
 * — implements without qualification. EPUB's own rule that `mimetype` come
 * first and uncompressed is satisfied for free.
 */
export function writeZip(members) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, contents] of members) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(LOCAL_SIG, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0, 6)
    head.writeUInt16LE(STORED, 8)
    head.writeUInt16LE(0, 10)
    head.writeUInt16LE(0, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    head.writeUInt16LE(0, 28)
    local.push(head, nameBuf, data)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(CENTRAL_SIG, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0, 8)
    dir.writeUInt16LE(STORED, 10)
    dir.writeUInt16LE(0, 12)
    dir.writeUInt16LE(0, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30)
    dir.writeUInt16LE(0, 32)
    dir.writeUInt16LE(0, 34)
    dir.writeUInt16LE(0, 36)
    dir.writeUInt32LE(0, 38)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuf)
    offset += head.length + nameBuf.length + data.length
  }
  const body = Buffer.concat(local)
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIG, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([body, directory, end])
}

/** Only used to prove the reader against a compressed archive — see the test. */
export function writeDeflatedZip(members) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, contents] of members) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8')
    const packed = deflateRawSync(data)
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(LOCAL_SIG, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(DEFLATED, 8)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    local.push(head, nameBuf, packed)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(CENTRAL_SIG, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(DEFLATED, 10)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuf)
    offset += head.length + nameBuf.length + packed.length
  }
  const body = Buffer.concat(local)
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIG, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}

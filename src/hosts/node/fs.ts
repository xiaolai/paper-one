import { constants } from 'node:fs'
import { access, appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { CONTENT_EXTENSIONS, folderOf, type FileSystem, type IndexFs, type SizePort } from '../../kernel'

/**
 * The kernel's two filesystem seams, over `node:fs` (phase 11, WI-11.2).
 *
 * `src/kernel/core` was measured at 14 095 lines with exactly TWO files
 * importing Tauri — `bookFiles.ts` and `bookVault.ts` — and both are seam
 * IMPLEMENTATIONS over interfaces the core already defines. This file is the
 * other implementation of the same two interfaces. No logic moved to write
 * it; nothing here decides anything about a book.
 *
 * The two seams stay distinct, as `bookVault.ts`'s own header insists:
 *
 *   - `IndexFs` (= `VaultFs` + `readDir`) is the LIBRARY's filesystem —
 *     `books/<id>/book.json`, `index.json`, `trash/`, `sync/journal.jsonl`.
 *     Bytes in, bytes out, relative to the data directory.
 *   - `FileSystem` is the FLAT STORE's — one JSON document read as text,
 *     written atomically, and moved aside when it will not parse.
 *
 * EVERY PATH IS RELATIVE TO THE ROOT, and `under()` proves it before any call
 * touches the disk. The kernel builds its paths through `folderOf`, which
 * already sanitises a book id into `[A-Za-z0-9_]`, so this is the second lock
 * rather than the first — but a host is a trust boundary, and a host that
 * accepted `../` would make the sanitiser the only thing between a hostile
 * record and the rest of the disk.
 *
 * WHAT `under()` DOES NOT DO, stated because a reader will otherwise assume
 * it: it is a check on the PATH, not on the filesystem. A symlink inside the
 * data directory is followed like any other, so `trash` pointing somewhere
 * else is somewhere else this host reads and deletes.
 *
 * That is deliberate rather than overlooked. Resolving every component with
 * `realpath` and refusing anything outside the root would break a library
 * kept on an external volume and symlinked into place, which is a setup
 * people genuinely have — and it would buy nothing against the attacker it
 * appears to stop, because anyone who can plant a symlink inside the data
 * directory can already write anything they like into the library it holds.
 * The threat this guards is a CONSTRUCTED path — an id, a name, a value off
 * the wire — reaching outside the root, and that it does guard, exactly.
 *
 * Behaviour is matched to the Tauri adapters deliberately, including where
 * they throw: `readDir` on a missing directory THROWS, because the library
 * scan is the one caller that must tell "no library yet" from "unreadable",
 * and `remove` on a missing file throws for the same reason `@tauri-apps/
 * plugin-fs` does. A host that quietly answered "fine" to both would make
 * every test that passes here pass for a reason the app does not share.
 */


/**
 * The absolute path of `path` inside `root`, or a throw.
 *
 * `relative` rather than a `startsWith` on the joined string: `startsWith`
 * says `/data/library-backup` is inside `/data/library`, which it is not.
 * An empty relative path is the root itself, which several callers name
 * (`mkdir('')` at boot).
 */
export function under(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`node fs: ${JSON.stringify(path)} is absolute; paths are relative to the data directory`)
  /* The root RESOLVED first, so the comparison below is between two absolute
   * paths. A relative root would make `relative()` answer about the process's
   * working directory rather than about the library. */
  const base = resolve(root)
  const full = resolve(base, path)
  const rel = relative(base, full)
  if (rel === '') return full
  /* AN ABSOLUTE `rel` IS AN ESCAPE, and it is the one this guard missed.
   *
   * On Windows a DRIVE-RELATIVE path — `D:outside` — is not absolute, so it
   * passes the check above. Resolved against a root on another drive it
   * becomes `D:\outside`, and `relative()` cannot express a path between two
   * drives, so it returns that absolute path unchanged. It begins with
   * neither `..` nor the root, so the containment test accepted it and every
   * adapter operation — including the recursive `remove` — was free to work
   * outside the data directory.
   *
   * POSIX never produces an absolute `rel`, so this costs nothing there; it
   * is checked unconditionally rather than under a platform test, because a
   * guard that only runs on the platform it was written on is how this class
   * of hole survives review. */
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`node fs: ${JSON.stringify(path)} leaves the data directory`)
  }
  return full
}

/** Distinguishes one write's temp file from another's. */
let nextTemp = 0

const missing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'

/**
 * The library's filesystem, rooted at `root`.
 *
 * `appendFile` is present and real, so the sync journal costs one write per
 * line rather than a rewrite of the whole file — the fallback the interface
 * documents is correct and O(n) per append, "a price only tests should pay",
 * and a Node host running against a real library is not a test.
 */
export function nodeIndexFs(root: string): IndexFs {
  const at = (path: string) => under(root, path)
  return {
    readFile: async (path) => new Uint8Array(await readFile(at(path))),
    writeFile: async (path, bytes) => {
      await writeFile(at(path), bytes)
    },
    exists: async (path) => {
      /* RESOLVED FIRST, outside the `try`. Inside it, a path that leaves the
       * data directory throws and is swallowed by the `catch` — so a
       * traversal attempt answers "no such file" instead of being refused,
       * and the refusal this seam exists for becomes a soft no. */
      const target = at(path)
      try {
        await access(target, constants.F_OK)
        return true
      } catch (cause) {
        /* ONLY "NOT THERE" IS FALSE.
         *
         * Every error used to be, so a directory the process could not
         * traverse (`EACCES`), or a descriptor limit (`EMFILE`), or an I/O
         * failure all answered "no such file". Callers across this repository
         * lean on `exists()` precisely to tell absence from failure — the
         * journal decides whether to overwrite a file by it, the trash
         * decides whether a book was already restored, the content layer
         * decides whether a folder is empty. Reporting a failure as absence
         * turns every one of those into the wrong branch, silently.
         *
         * `ENOENT` and `ENOTDIR` are absence — the second is a path whose
         * PARENT is not a directory, so the target cannot exist either.
         * Anything else is raised. */
        const code = (cause as { code?: unknown })?.code
        if (code === 'ENOENT' || code === 'ENOTDIR') return false
        throw cause
      }
    },
    mkdir: async (path) => {
      await mkdir(at(path), { recursive: true })
    },
    remove: async (path) => {
      await rm(at(path), { force: false })
    },
    rename: async (from, to) => {
      await rename(at(from), at(to))
    },
    removeDir: async (path) => {
      await rm(at(path), { recursive: true, force: true })
    },
    appendFile: async (path, bytes) => {
      await appendFile(at(path), bytes)
    },
    /* A REAL SEEK, for the same reason the Tauri adapter has one: `content.read`
     * serves a book a slice at a time, and the interface's fallback is O(n) per
     * slice — quadratic over a book, with a 300 MB scanned PDF re-read once per
     * megabyte served.
     *
     * The handle is closed in a `finally`, because a leaked one holds a
     * descriptor until the process ends and a CLI serving a shelf opens many.
     *
     * `read` answers what it has, not what was asked: a short answer at the end
     * of a file is normal, so this loops until the slice is full or the file
     * runs out. */
    readRange: async (path, offset, length) => {
      const handle = await open(at(path), 'r')
      try {
        const buffer = new Uint8Array(length)
        let filled = 0
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
          if (bytesRead === 0) break
          filled += bytesRead
        }
        return buffer.subarray(0, filled)
      } finally {
        await handle.close()
      }
    },
    readDir: async (path) => {
      const entries = await readdir(at(path), { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    },
  }
}

/**
 * The flat store's filesystem, rooted at `root`.
 *
 * `write` goes through a temporary neighbour and a rename, exactly as
 * `appStorage.ts` does and for the same reason: a truncated store loses EVERY
 * mark rather than one, and `writeFile` over an existing path truncates
 * before it writes. A rename over a complete file is atomic on every
 * filesystem this ships to.
 */
export function nodeTextFs(root: string): FileSystem {
  const at = (path: string) => under(root, path)
  return {
    read: async (path) => {
      try {
        return await readFile(at(path), 'utf8')
      } catch (error) {
        if (missing(error)) return null
        throw error
      }
    },
    write: async (path, text) => {
      const target = at(path)
      /* UNIQUE PER WRITE, not one `.writing` shared by every writer.
       *
       * Two processes over one library — `paper` beside the app, or two
       * `paper` runs — both wrote the same temp path and both renamed it, so
       * one write's bytes were published under the other's rename and the
       * loser silently lost its content. The pid and a counter make the
       * temp name private to this write; the rename is still the atomic
       * publish it always was. */
      const writing = `${target}.${process.pid}.${nextTemp++}.writing`
      try {
        await writeFile(writing, text, 'utf8')
        await rename(writing, target)
      } catch (cause) {
        await rm(writing, { force: true }).catch(() => {})
        throw cause
      }
    },
    quarantine: async (path, to) => {
      /* A SECOND CORRUPTION MUST NOT ERASE THE FIRST.
       *
       * `rename` REPLACES its destination on POSIX, so quarantining twice to
       * the same `.corrupt` name destroyed the earlier copy — the one holding
       * whatever the reader might still have recovered. The point of moving a
       * damaged file aside is that it is still there.
       *
       * The plain name is used when it is free, so the ordinary single-fault
       * case keeps the name the caller asked for and the tests expect. A
       * collision takes a suffix, and the loop is bounded: if a hundred
       * quarantines of one file have accumulated, something is wrong that a
       * hundred-and-first copy will not clarify. */
      const target = at(to)
      let destination = target
      for (let n = 1; n <= 100; n += 1) {
        try {
          await access(destination, constants.F_OK)
        } catch {
          break
        }
        destination = `${target}.${n}`
      }
      await rename(at(path), destination)
    },
  }
}

/**
 * Is the reader's app holding this library open?
 *
 * THREE ANSWERS, NOT TWO, and the third is the important one. This began as a
 * boolean and every case it could not decide — an unsupported platform, a
 * probe that failed — collapsed into `false`, meaning "safe to journal". That
 * is failing OPEN on the one question protecting `journal.jsonl` from a second
 * writer, and a second writer corrupts `nextSeq` and the rev CAS in a way no
 * later pass detects.
 *
 * So an undecidable answer is `unknown`, and the caller treats `unknown`
 * exactly as it treats `running`. The cost is that on a platform this cannot
 * probe, `paper` declines to journal and says so — which is the behaviour the
 * CLI had before journalling existed at all, and strictly better than a
 * corrupt journal.
 *
 * WHAT IT CAN ACTUALLY DECIDE:
 *
 * - **macOS**: `pgrep -f` against the bundle's executable path. `-f` and never
 *   `-x`, because Tauri names the executable inside the bundle `app`, so
 *   `pgrep -x Paper` can never match — a mistake that once reported the app
 *   closed on a machine where it was plainly running.
 * - **Linux and Windows**: `unknown`. A Tauri app there is a bare executable
 *   with no `Paper.app` bundle path to match, so the macOS probe would answer
 *   `absent` for a running app — a false negative, which is the dangerous
 *   direction. Saying so is better than guessing.
 *
 * STILL A HEURISTIC where it answers at all: it matches any Paper process on
 * the machine, not one holding THIS data root, and it is read once before the
 * journal is opened rather than held for the duration. The real fix is a
 * per-data-root lock taken by both the app and the CLI, which needs a Rust
 * command with an ACL entry on the app side; until that exists this is the
 * honest approximation and is documented as one in `dev-docs/cli.md`.
 */
export type AppPresence = 'running' | 'absent' | 'unknown'

export async function appPresence(): Promise<AppPresence> {
  if (process.platform !== 'darwin') return 'unknown'
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)('pgrep', ['-f', 'Paper.app/Contents/MacOS/'])
    return stdout.trim().length > 0 ? 'running' : 'absent'
  } catch (error) {
    /* `pgrep` exits 1 with no output when nothing matches — that is a real
     * ANSWER, not a failure, and the only error shape that may mean `absent`.
     * Anything else (no `pgrep`, a permission problem) is undecided. */
    const code = (error as { code?: unknown })?.code
    const out = (error as { stdout?: unknown })?.stdout
    if (code === 1 && typeof out === 'string' && out.trim() === '') return 'absent'
    return 'unknown'
  }
}

/**
 * The journal's durability barrier, over a real file descriptor.
 *
 * `JournalOptions.fsync` defaults to a no-op, and a no-op is what the CLI had:
 * every journal line was a write the page cache could still be holding when
 * the process exited. The app binds the peer plugin's `fs_fsync` here; this is
 * the same barrier for a Node process.
 *
 * It opens for READING. `fsync(2)` flushes whatever the descriptor names, and
 * a read handle is enough — opening for write would truncate on the wrong flag
 * and needs a permission the barrier does not. The journal also fsyncs its
 * DIRECTORY after a rename (`fsyncDir`), which is a read handle of necessity.
 *
 * NOT a full `F_FULLFSYNC`: on macOS `fsync(2)` hands the data to the drive
 * without waiting for the drive's own cache to commit, so this survives a
 * process crash — the case the journal's dirty flag is paired with — and not
 * necessarily a power cut. Said plainly rather than implied, because a barrier
 * believed to be stronger than it is, is worse than a missing one.
 */
export function nodeFsyncPort(root: string): (path: string) => Promise<void> {
  return async (path: string) => {
    const handle = await open(under(root, path), 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

/**
 * Bytes on disk, over `node:fs` — the kernel's `SizePort` (phase 11).
 *
 * `stat`, not a read: measuring a 200 MB PDF by decoding it would make
 * `paper content locate` cost as much as opening the book. The whole-library
 * walk is one `stat` per file, which on the 1 959-book library WI-8.6
 * measured is a few thousand syscalls — a price an explicit `paper shelf
 * status` may pay and nothing else calls.
 *
 * A file that is not there is `null`, never zero. "Nobody can say" and
 * "empty" are different answers and a caller has to be able to tell them
 * apart before opening a blob stream.
 */
export function nodeSizePort(root: string): SizePort {
  const bytesAt = async (path: string): Promise<number | null> => {
    try {
      const info = await stat(under(root, path))
      return info.isFile() ? info.size : null
    } catch {
      return null
    }
  }
  return {
    bytesAt,
    contentBytes: async (bookId) => {
      const folder = folderOf(bookId)
      /* `CONTENT_EXTENSIONS` ORDER, and `content.locate` walks the same list
       * to choose the `ext` it reports. A folder is not supposed to hold two
       * content files, but it can — and when the two sides picked differently
       * (this one by preference order, that one alphabetically) one answer
       * named `azw3` and carried the epub's byte count. Two fields describing
       * two files, in one answer about one book. */
      for (const ext of CONTENT_EXTENSIONS) {
        const size = await bytesAt(`${folder}/content.${ext}`)
        if (size !== null) return size
      }
      return null
    },
    libraryBytes: async () => {
      let total = 0
      let whole = true
      const walk = async (path: string): Promise<void> => {
        let entries: { name: string; directory: boolean }[]
        try {
          entries = (await readdir(under(root, path), { withFileTypes: true })).map((entry) => ({
            name: entry.name,
            directory: entry.isDirectory(),
          }))
        } catch {
          /* A directory that will not read makes the total INCOMPLETE, and an
           * incomplete total must not be reported as an exact one: the whole
           * point of `null` in this port is "nobody can say", and a number
           * that is quietly short is worse than no number — a reader would
           * believe their library is smaller than it is. */
          whole = false
          return
        }
        for (const entry of entries) {
          const at = path === '' ? entry.name : `${path}/${entry.name}`
          if (entry.directory) await walk(at)
          else {
            const size = await bytesAt(at)
            if (size === null) whole = false
            else total += size
          }
        }
      }
      await walk('')
      return whole ? total : null
    },
  }
}

/** The data directory itself, made if it is not there. Returned absolute, so
 *  every later message names one path rather than two spellings of it. */
export async function makeDataDir(dir: string): Promise<string> {
  const root = resolve(dir)
  await mkdir(root, { recursive: true })
  return root
}

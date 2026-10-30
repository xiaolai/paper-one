import type { JournalFs } from './journal'

/**
 * The sync capability's own filesystem fake — with the crash semantics the
 * journal's tests live on.
 *
 * Its OWN, not the kernel's `fakeFs.testkit`: a capability may import the
 * kernel only through its public entry, and a test double is exactly the
 * kind of internal that must not leak across that line. The behaviours the
 * kernel fake earned the hard way are kept — `exists` is true for a
 * directory with something in it, `rename` refuses to move a non-empty
 * directory onto a non-empty one, `removeDir` takes what is under it — and
 * two are added:
 *
 *   `appendFile`  the journal's own primitive, byte-appending;
 *   a DURABILITY MODEL: every mutation lands in the live view at once, and
 *   in the durable view only at `fsync(path)` — with `durableView(...)`
 *   able to answer "what would the disk hold if we lost power after op K",
 *   keeping an arbitrary byte PREFIX of any append that was still in
 *   flight, and dropping or keeping other pending ops per path. That is
 *   the whole crash model: prefixes survive, non-fsynced writes reorder.
 */

interface Op {
  readonly n: number
  readonly kind: 'write' | 'append' | 'rename' | 'remove' | 'removeDir' | 'fsync'
  readonly path: string
  readonly to?: string
  readonly bytes?: Uint8Array
}

export interface CrashableFs extends JournalFs {
  readonly store: Map<string, Uint8Array>
  /** Every mutating op and fsync, in order. */
  readonly ops: readonly Op[]
  /** Always present here (the journal's own primitive) — and REASSIGNABLE,
   *  so a test can make it fail after N appends: the kill switch. */
  appendFile(path: string, bytes: Uint8Array): Promise<void>
  /** The durability hook to hand the journal. */
  fsync(path: string): Promise<void>
  /**
   * The files a crash after `ops[k]` could leave, under one policy for the
   * ops that were not yet fsynced:
   *
   *   'all'   every op reached the disk (the crash lost nothing)
   *   'none'  nothing after each path's last fsync reached it
   *   'torn'  everything reached it except that the LAST append kept only
   *           `tear` of its bytes — the truncated-tail case
   */
  durableView(k: number, policy: 'all' | 'none' | 'torn', tear?: number): Map<string, Uint8Array>
}

export function crashableFs(seed: Record<string, string> = {}): CrashableFs {
  const store = new Map<string, Uint8Array>()
  for (const [key, value] of Object.entries(seed)) store.set(key, new TextEncoder().encode(value))
  const ops: Op[] = []
  let n = 0
  const log = (op: Omit<Op, 'n'>) => void ops.push({ ...op, n: n++ })

  const fs: CrashableFs = {
    store,
    ops,
    readFile: async (path) => {
      const bytes = store.get(path)
      if (!bytes) throw new Error(`no such file: ${path}`)
      return bytes
    },
    writeFile: async (path, bytes) => {
      log({ kind: 'write', path, bytes })
      store.set(path, bytes)
    },
    appendFile: async (path, bytes) => {
      log({ kind: 'append', path, bytes })
      const held = store.get(path) ?? new Uint8Array(0)
      const joined = new Uint8Array(held.length + bytes.length)
      joined.set(held, 0)
      joined.set(bytes, held.length)
      store.set(path, joined)
    },
    exists: async (path) => [...store.keys()].some((k) => k === path || k.startsWith(`${path}/`)),
    mkdir: async () => {},
    remove: async (path) => {
      log({ kind: 'remove', path })
      store.delete(path)
    },
    removeDir: async (path) => {
      log({ kind: 'removeDir', path })
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) store.delete(key)
      }
    },
    rename: async (from, to) => {
      const moving = [...store.keys()].filter((k) => k === from || k.startsWith(`${from}/`))
      const occupied = [...store.keys()].some((k) => k === to || k.startsWith(`${to}/`))
      if (occupied && moving.some((k) => k !== from)) {
        throw new Error(`rename: ${to} is a non-empty directory`)
      }
      log({ kind: 'rename', path: from, to })
      for (const key of moving) {
        const bytes = store.get(key)!
        store.set(key === from ? to : `${to}${key.slice(from.length)}`, bytes)
        store.delete(key)
      }
    },
    readDir: async (path) => {
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (!key.startsWith(`${path}/`)) continue
        const head = key.slice(path.length + 1).split('/')[0]
        if (head) names.add(head)
      }
      return [...names].map((name) => ({ name, isDirectory: !name.includes('.') }))
    },
    fsync: async (path) => {
      /* HONEST like the real plugin: fsync opens the path, and a path that
       * is neither a file nor a directory holding one is an error. The
       * permissive fake hid exactly one real bug — the empty-shelf
       * bootstrap fsyncing a journal file it never wrote. */
      const isDir = [...store.keys()].some((k) => k.startsWith(`${path}/`))
      if (!store.has(path) && !isDir) throw new Error(`fsync: no such file or directory: ${path}`)
      log({ kind: 'fsync', path })
    },
    durableView: (k, policy, tear = 0.5) => {
      /* Replay ops[0..k] over the seed, tracking each path's last fsync.
       * Ops at or before a path's last fsync (≤ k) are durable whatever the
       * policy; later ones are the pending set the policy decides. */
      const lastFsync = new Map<string, number>()
      for (const op of ops) {
        if (op.n > k) break
        if (op.kind === 'fsync') lastFsync.set(op.path, op.n)
      }
      const durable = new Map<string, Uint8Array>()
      for (const [key, value] of Object.entries(seed)) durable.set(key, new TextEncoder().encode(value))
      /* Which op is the LAST append still pending per path, for 'torn'. */
      const lastPendingAppend = new Map<string, number>()
      for (const op of ops) {
        if (op.n > k) break
        if (op.kind === 'append' && op.n > (lastFsync.get(op.path) ?? -1)) lastPendingAppend.set(op.path, op.n)
      }
      const apply = (op: Op, cut: number | null) => {
        switch (op.kind) {
          case 'write':
            durable.set(op.path, op.bytes!)
            return
          case 'append': {
            const held = durable.get(op.path) ?? new Uint8Array(0)
            const take = cut === null ? op.bytes! : op.bytes!.subarray(0, Math.floor(op.bytes!.length * cut))
            const joined = new Uint8Array(held.length + take.length)
            joined.set(held, 0)
            joined.set(take, held.length)
            durable.set(op.path, joined)
            return
          }
          case 'remove':
            durable.delete(op.path)
            return
          case 'removeDir':
            for (const key of [...durable.keys()]) {
              if (key === op.path || key.startsWith(`${op.path}/`)) durable.delete(key)
            }
            return
          case 'rename': {
            const moving = [...durable.keys()].filter((key) => key === op.path || key.startsWith(`${op.path}/`))
            for (const key of moving) {
              const bytes = durable.get(key)!
              durable.set(key === op.path ? op.to! : `${op.to}${key.slice(op.path.length)}`, bytes)
              durable.delete(key)
            }
            return
          }
          case 'fsync':
            return
        }
      }
      for (const op of ops) {
        if (op.n > k) break
        /* Durable when a LATER fsync covered the path — or, for a rename,
         * the path it moved things to, which is how temp-and-rename is made
         * durable in the first place. Deliberately pessimistic otherwise:
         * an op no fsync ever covered may be lost however old it is, and
         * recovery has to cope with that too. */
        const covered = Math.max(lastFsync.get(op.path) ?? -1, op.to ? (lastFsync.get(op.to) ?? -1) : -1)
        const pending = op.n > covered
        if (!pending) {
          apply(op, null)
          continue
        }
        if (policy === 'all') {
          apply(op, null)
        } else if (policy === 'none') {
          /* dropped */
        } else {
          apply(op, op.kind === 'append' && op.n === lastPendingAppend.get(op.path) ? tear : null)
        }
      }
      return durable
    },
  }
  return fs
}

/** A fresh fake seeded with another view's exact bytes — reopening after a crash. */
export function fsOver(view: Map<string, Uint8Array>): CrashableFs {
  const fs = crashableFs()
  for (const [key, value] of view) fs.store.set(key, value)
  return fs
}

/** One file as parsed JSON lines, for journal assertions. */
export function journalLines(fs: CrashableFs, path: string): unknown[] {
  const bytes = fs.store.get(path)
  if (!bytes) return []
  return new TextDecoder()
    .decode(bytes)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown)
}

/** The flat store the cards and settings ride on. */
export function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

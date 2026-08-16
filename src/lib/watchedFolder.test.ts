import { describe, expect, it, vi } from 'vitest'
import type { DirFs } from './importFolder'
import { watchFolder, type WatchOps } from './watchedFolder'

/**
 * The watcher's coordination, without a filesystem.
 *
 * Everything here is about WHEN an import runs rather than what it does: the
 * settle window, the one-at-a-time rule, and the catch-up run at startup. That
 * the underlying import works is `importFolder.test.ts`'s job; that Tauri's
 * `watch` is permitted needs the app, and its Cargo feature flag is exactly the
 * kind of thing that is green everywhere and fails at runtime.
 */

function fakeDir(files: Record<string, string>) {
  const names = Object.keys(files)
  const fs: DirFs & { written: Map<string, Uint8Array> } = {
    written: new Map(),
    readDir: async () => names.map((name) => ({ name, isDirectory: false })),
    readOutside: async (path) => new TextEncoder().encode(files[path.split('/').pop() ?? ''] ?? ''),
    readFile: async () => new Uint8Array(),
    writeFile: async (path, bytes) => void fs.written.set(path, bytes),
    exists: async (path) => fs.written.has(path),
    mkdir: async () => {},
    remove: async () => {},
    rename: async (from, to) => {
      const bytes = fs.written.get(from)
      if (bytes) fs.written.set(to, bytes)
      fs.written.delete(from)
    },
  }
  return fs
}

function fakeWatch() {
  let fire: (() => void) | null = null
  const unsubscribe = vi.fn()
  const ops: WatchOps = {
    watch: async (_path, onEvent) => {
      fire = onEvent
      return unsubscribe
    },
  }
  return { ops, fire: () => fire?.(), unsubscribe }
}

/**
 * REAL timers, with a tiny settle window.
 *
 * Fake timers do not work here and the reason is worth recording: the import
 * hashes with `crypto.subtle.digest`, which is a genuine async operation
 * resolving off the timer queue entirely. `runAllTimersAsync` runs the settle
 * timer and returns before the digest lands, so the yield it would schedule next
 * does not exist yet — the clock runs out ahead of the work. A 5ms window and a
 * real wait is slower by milliseconds and actually tests the coordination.
 */
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const SETTLE = 5

describe('watchFolder', () => {
  /**
   * A file arriving is not one event.
   *
   * A copy in progress emits create-then-write repeatedly, and a sync client can
   * emit dozens across a batch. Importing on each would read a half-written book
   * and hash whatever had landed so far.
   */
  it('waits for changes to settle rather than importing on every event', async () => {
    {
      const fs = fakeDir({ 'a.epub': 'ALPHA' })
      const { ops, fire } = fakeWatch()
      const imported = vi.fn()
      await watchFolder(fs, ops, '/books', imported, { settleMs: 60 })

      fire()
      fire()
      fire()
      // Still inside the window: three events must not be three imports.
      await tick(20)
      expect(imported).not.toHaveBeenCalled()
      await tick(200)
      expect(imported).toHaveBeenCalledTimes(1)
    }
  })

  /* A book that arrived while the app was closed would otherwise never be seen
   * — watching reports changes, not history. */
  it('imports once at startup, before any event', async () => {
    {
      const fs = fakeDir({ 'a.epub': 'ALPHA' })
      const { ops } = fakeWatch()
      const imported = vi.fn()
      await watchFolder(fs, ops, '/books', imported, { settleMs: SETTLE })
      await tick(50)
      expect(imported).toHaveBeenCalledTimes(1)
    }
  })

  /**
   * A book whose bytes are in the vault but whose ROW is gone.
   *
   * It reports as a duplicate, so filtering the handover on `added` discarded
   * the batch before the shelf could recover it — and it would stay invisible
   * forever, because every later run reported it exactly the same way. What is
   * worth SAYING and what is worth shelving are different questions, and only
   * the caller can answer the first.
   */
  it('hands over an all-duplicate batch, so a missing row can be recovered', async () => {
    const fs = fakeDir({ 'a.epub': 'ALPHA' })
    const { ops, fire } = fakeWatch()
    const imported = vi.fn()
    await watchFolder(fs, ops, '/books', imported, { settleMs: SETTLE })
    await tick(100)
    expect(imported).toHaveBeenCalledTimes(1)

    // Second pass: the book is already held, so every outcome is a duplicate.
    fire()
    await tick(100)
    expect(imported).toHaveBeenCalledTimes(2)
    expect(imported.mock.calls[1]![0]).toEqual([
      expect.objectContaining({ status: 'duplicate' }),
    ])
  })

  /* An empty folder still has nothing to hand over. */
  it('says nothing when a change added no books', async () => {
    {
      const fs = fakeDir({})
      const { ops, fire } = fakeWatch()
      const imported = vi.fn()
      await watchFolder(fs, ops, '/books', imported, { settleMs: SETTLE })
      await tick(50)
      fire()
      await tick(50)
      expect(imported).not.toHaveBeenCalled()
    }
  })

  it('stops watching, and cancels a pending import', async () => {
    {
      const fs = fakeDir({ 'a.epub': 'ALPHA' })
      const { ops, fire, unsubscribe } = fakeWatch()
      const imported = vi.fn()
      const watcher = await watchFolder(fs, ops, '/books', imported, { settleMs: 60 })
      fire()
      watcher.stop()
      await tick(500)
      expect(unsubscribe).toHaveBeenCalled()
      expect(imported).not.toHaveBeenCalled()
    }
  })
})

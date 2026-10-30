import { describe, expect, it, vi } from 'vitest'
import { haulFromPaths, openedNotice, takeOpened, OPEN_FILES_EVENT, OPEN_FILES_READY_EVENT } from './openedFiles'

const reads = (failing: readonly string[] = []) =>
  vi.fn(async (path: string) => {
    if (failing.includes(path)) throw new Error(`EACCES ${path}`)
    return new File([path], path.slice(path.lastIndexOf('/') + 1))
  })

describe('what a launch carried', () => {
  it('reads each path in turn and keeps the path beside the bytes, as the picker does', async () => {
    const read = reads()
    const order: string[] = []
    read.mockImplementation(async (path) => {
      order.push(`start ${path}`)
      await Promise.resolve()
      order.push(`end ${path}`)
      return new File([path], 'x')
    })
    const haul = await haulFromPaths(['/Books/A.epub', '/Books/B.pdf'], read)
    expect(haul.books.map((one) => one.path)).toEqual(['/Books/A.epub', '/Books/B.pdf'])
    expect(haul.unreadable).toBe(0)
    /* One at a time: the second read starts after the first has ended. */
    expect(order).toEqual(['start /Books/A.epub', 'end /Books/A.epub', 'start /Books/B.pdf', 'end /Books/B.pdf'])
  })

  it('counts a path that will not read, and keeps the rest', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const haul = await haulFromPaths(['/Books/A.epub', '/Books/gone.epub', '/Books/C.epub'], reads(['/Books/gone.epub']))
    expect(haul.books.map((one) => one.file.name)).toEqual(['A.epub', 'C.epub'])
    expect(haul.unreadable).toBe(1)
    quiet.mockRestore()
  })

  it('says which kind of nothing it was, and names the count that failed', () => {
    expect(openedNotice({ books: [], unreadable: 0 })).toBe('Nothing Paper can open was in what was opened.')
    expect(openedNotice({ books: [], unreadable: 2 })).toBe('Nothing that was opened could be read — 2 files failed.')
    const one = { file: new File([], 'a'), path: '/a' }
    expect(openedNotice({ books: [one], unreadable: 1 })).toBe('1 file could not be read.')
    expect(openedNotice({ books: [one], unreadable: 0 })).toBeUndefined()
  })

  it('hands the books to the picker route with the path kept, and the note rides along', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const addAndOpen = vi.fn(async () => {})
    const notice = vi.fn()
    await takeOpened(['/Books/A.epub', '/Books/bad.epub'], { read: reads(['/Books/bad.epub']), addAndOpen, notice })
    expect(addAndOpen).toHaveBeenCalledTimes(1)
    const [picked, note] = addAndOpen.mock.calls[0]! as unknown as [readonly { path: string }[], string | undefined]
    expect(picked.map((one) => one.path)).toEqual(['/Books/A.epub'])
    expect(note).toBe('1 file could not be read.')
    expect(notice).not.toHaveBeenCalled()
    quiet.mockRestore()
  })

  it('says so, and adds nothing, when nothing could be read', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const addAndOpen = vi.fn(async () => {})
    const notice = vi.fn()
    await takeOpened(['/Books/bad.epub'], { read: reads(['/Books/bad.epub']), addAndOpen, notice })
    expect(addAndOpen).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith('Nothing that was opened could be read — 1 file failed.')
    quiet.mockRestore()
  })

  /* The two names are the contract with `src-tauri/src/opened.rs`; a rename
     on one side is an event emitted into nothing on the other. */
  it('names the same two events the shell does', () => {
    const rust = readRust()
    expect(rust).toContain(`pub const OPEN: &str = "${OPEN_FILES_EVENT}";`)
    expect(rust).toContain(`pub const READY: &str = "${OPEN_FILES_READY_EVENT}";`)
  })
})

function readRust(): string {
  /* `require`, in a repo of `import`s: this suite runs in the node
   * environment and READS the Rust file, never imports it — a static
   * `import 'node:fs'` at the top would drag the node builtin into a file
   * under `src/kernel/ui`, where the browser-safety survey would rightly
   * flag it. The late `require` keeps the dependency out of the graph. */
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  return readFileSync(new URL('../../../src-tauri/src/opened.rs', import.meta.url), 'utf8')
}

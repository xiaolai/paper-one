import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { globSync } from 'node:fs'
import { notifyAll } from './notify'

describe('notifyAll', () => {
  it('tells every subscriber even when an earlier one throws', () => {
    /* ⚠️ **THE FIRST ONE TO FAIL USED TO SILENCE THE REST**, and which ones
       those were depended on insertion order — so the symptom was "some
       panels do not refresh, sometimes". */
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const told: string[] = []
      notifyAll(
        [
          () => told.push('first'),
          () => {
            throw new Error('this subscriber is broken')
          },
          () => told.push('third'),
        ],
        'test',
      )
      expect(told).toEqual(['first', 'third'])
      expect(error).toHaveBeenCalledOnce()
    } finally {
      error.mockRestore()
    }
  })

  it('does not throw, because the change it announces has already happened', () => {
    /* ⚠️ **THE THROW USED TO TRAVEL BACK INTO A WRITE THAT HAD LANDED.** These
       are called after the disk write, so a rejecting notification told the
       reader their change failed while it sat on disk. */
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        notifyAll(
          [
            () => {
              throw new Error('broken')
            },
          ],
          'test',
        ),
      ).not.toThrow()
    } finally {
      error.mockRestore()
    }
  })

  it('survives a subscriber that unsubscribes while being told', () => {
    /* A panel that unmounts on the change it is hearing about does exactly
       this, and mutating the set mid-iteration is how one subscriber comes to
       be skipped. */
    const listeners = new Set<() => void>()
    const told: string[] = []
    const first = () => {
      listeners.delete(second)
      told.push('first')
    }
    const second = () => told.push('second')
    listeners.add(first)
    listeners.add(second)
    notifyAll(listeners, 'test')
    expect(told).toEqual(['first', 'second'])
  })
})

describe('no store announces without it', () => {
  it('leaves no bare listener loop anywhere in src/', () => {
    /* ⚠️ **THIS DEFECT WAS FOUND AND FIXED FIVE TIMES IN FIVE FILES BEFORE
       ANYBODY WROTE ONE NOTIFIER**, and four more files still had the bare
       loop when an audit went looking. A class that keeps coming back needs
       the walk, not another fix: `for (const listener of ...) listener()`
       calls each subscriber inside whatever `try` the caller happens to be
       in, which is the caller's write. */
    const here = dirname(fileURLToPath(import.meta.url))
    const root = join(here, '..', '..')
    /* Production modules only. A test file may build a fake store with a bare
       loop, and holding those to the rule would be holding the fixture to the
       fixture's own subject. `notify.ts` is the loop. */
    const files = globSync('**/*.{ts,tsx}', { cwd: root }).filter(
      (one) => !/\.test\.tsx?$/u.test(one) && !one.endsWith('core/notify.ts'),
    )
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8')
      /* The bare shape: a loop over listeners whose body is a bare call. */
      if (/for \(const \w+ of \[?\.{0,3}\w*listeners?\]?\)\s*\w+\(\)/u.test(source)) {
        offenders.push(relative(root, join(root, file)))
      }
    }
    expect(offenders).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { buildMoveMap, classifyLib, rewriteSource } from './carve-kernel.mjs'

/**
 * The pure halves of the K.3 codemod. The move itself is verified by running
 * the script twice (the second run must be a no‑op) and by the whole suite +
 * typecheck + build afterwards; these cases pin the two rules that are easy to
 * get subtly wrong — the core/ui classification and the reference rewriter.
 */

const files = [
  'src/lib/state.ts',
  'src/lib/panes.ts',
  'src/lib/commands.ts',
  'src/lib/marks.ts',
  'src/lib/useMarks.ts',
  'src/lib/marks.test.ts',
  'src/lib/rendererIsolation.test.ts',
  'src/lib/appStorage.ts',
  'src/lib/useStoredCollection.ts',
  'src/reader/wordSnap/classify.ts',
  'src/pane/Notes.tsx',
  'src/App.tsx',
  'src/main.tsx',
]
const sources = {
  'src/lib/state.ts': "import { useReducer } from 'react'\nexport const x = 1\n",
  'src/lib/panes.ts': "import { paneFits } from './state'\n",
  'src/lib/commands.ts': "import { panesFor } from './panes'\nimport { DEFAULT } from './metrics'\n",
  'src/lib/marks.ts': "import { compare } from 'foliate-js/epubcfi.js'\n",
  'src/lib/useMarks.ts': "import { useState } from 'react'\nimport { type Mark } from './marks'\n",
  'src/lib/marks.test.ts': "import { marks } from './marks'\n",
  'src/lib/rendererIsolation.test.ts': "import { readFileSync } from 'node:fs'\n",
  'src/lib/appStorage.ts': "import { localStore } from './useStoredCollection'\n",
  'src/lib/useStoredCollection.ts': "import { useCallback } from 'react'\n",
  'src/reader/wordSnap/classify.ts': '',
  'src/pane/Notes.tsx': '',
  'src/App.tsx': '',
  'src/main.tsx': '',
}
const read = (f) => sources[f] ?? ''

describe('classifyLib — ui if it imports React, transitively; else core', () => {
  it('classifies direct, transitive, and untouched modules; tests follow their module', () => {
    const kind = classifyLib(files, read)
    expect(kind.get('src/lib/state.ts')).toBe('ui')
    expect(kind.get('src/lib/panes.ts')).toBe('ui') // via state
    expect(kind.get('src/lib/commands.ts')).toBe('ui') // via panes
    expect(kind.get('src/lib/marks.ts')).toBe('core')
    expect(kind.get('src/lib/useMarks.ts')).toBe('ui')
    expect(kind.get('src/lib/appStorage.ts')).toBe('ui') // the one value import — a K.5 candidate
    expect(kind.get('src/lib/marks.test.ts')).toBe('core') // beside marks.ts
    expect(kind.get('src/lib/rendererIsolation.test.ts')).toBe('core') // no module, no React
  })
})

describe('buildMoveMap — the layout', () => {
  it('sends core to kernel/core, hooks to kernel/ui/hooks, other ui to kernel/ui, dirs and App under kernel/ui, and leaves main.tsx', () => {
    const map = buildMoveMap(files, read)
    expect(map.get('src/lib/marks.ts')).toBe('src/kernel/core/marks.ts')
    expect(map.get('src/lib/useMarks.ts')).toBe('src/kernel/ui/hooks/useMarks.ts')
    expect(map.get('src/lib/state.ts')).toBe('src/kernel/ui/state.ts')
    expect(map.get('src/reader/wordSnap/classify.ts')).toBe('src/kernel/ui/reader/wordSnap/classify.ts')
    expect(map.get('src/pane/Notes.tsx')).toBe('src/kernel/ui/pane/Notes.tsx')
    expect(map.get('src/App.tsx')).toBe('src/kernel/ui/App.tsx')
    expect(map.has('src/main.tsx')).toBe(false)
  })
})

describe('rewriteSource — every relative reference that resolves in the old tree', () => {
  const oldTree = {
    'src/lib/marks.ts': 'file',
    'src/lib/state.ts': 'file',
    'src/lib/useMarks.ts': 'file',
    'src/App.tsx': 'file',
    'src/main.tsx': 'file',
    'src/pane/Settings.tsx': 'file',
    'src/reader/wordSnap/corpus.ts': 'file',
    'src/reader/wordSnap': 'dir',
    'src/reader': 'dir',
    'src/lib': 'dir',
    'src': 'dir',
    'src-tauri/tauri.conf.json': 'file',
    'src-tauri': 'dir',
  }
  const existsOld = (p) => oldTree[p] ?? null
  const moves = new Map([
    ['src/lib/marks.ts', 'src/kernel/core/marks.ts'],
    ['src/lib/state.ts', 'src/kernel/ui/state.ts'],
    ['src/lib/useMarks.ts', 'src/kernel/ui/hooks/useMarks.ts'],
    ['src/App.tsx', 'src/kernel/ui/App.tsx'],
    ['src/pane/Settings.tsx', 'src/kernel/ui/pane/Settings.tsx'],
    ['src/reader/wordSnap/corpus.ts', 'src/kernel/ui/reader/wordSnap/corpus.ts'],
  ])
  const dirs = new Map([['src/reader', 'src/kernel/ui/reader']])
  const mapPath = (p) => {
    if (moves.has(p)) return moves.get(p)
    for (const [from, to] of dirs) if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length)
    return p
  }

  it('re-points imports between two moved files, keeping the extension-less form', () => {
    const out = rewriteSource("import { m } from './marks'\n", 'src/lib/useMarks.ts', 'src/kernel/ui/hooks/useMarks.ts', existsOld, mapPath)
    expect(out).toBe("import { m } from '../../core/marks'\n")
  })

  it('re-points a reference from an unmoved file to a moved one', () => {
    const out = rewriteSource("import { App } from './App'\nimport { s } from './lib/state'\n", 'src/main.tsx', 'src/main.tsx', existsOld, mapPath)
    expect(out).toBe("import { App } from './kernel/ui/App'\nimport { s } from './kernel/ui/state'\n")
  })

  it('re-points a moved file\'s reference to an unmoved target (deeper now)', () => {
    const out = rewriteSource("new URL('../../src-tauri/tauri.conf.json', import.meta.url)", 'src/lib/x.test.ts', 'src/kernel/core/x.test.ts', existsOld, mapPath)
    expect(out).toBe("new URL('../../../src-tauri/tauri.conf.json', import.meta.url)")
  })

  it('handles helper-wrapped paths and directory references with a trailing slash', () => {
    const out = rewriteSource("read('../pane/Settings.tsx'); new URL('../src/reader/wordSnap/', import.meta.url)", 'src/lib/state.test.ts', 'src/kernel/ui/state.test.ts', existsOld, mapPath)
    expect(out).toContain("read('./pane/Settings.tsx')")
    expect(out).toContain("'../src/reader/wordSnap/'") // resolves outside the fake tree from src/lib → untouched
  })

  it("keeps a same-directory './' as './' (the bug the first run had: never './/')", () => {
    const out = rewriteSource("!s.startsWith('./')", 'src/reader/wordSnap/corpus.test.ts', 'src/kernel/ui/reader/wordSnap/corpus.test.ts', existsOld, mapPath)
    expect(out).toBe("!s.startsWith('./')")
  })

  it('leaves unresolvable strings, bare-name specifiers and package imports alone', () => {
    const src = "import x from 'react'\nconst a = '../../etc'\nconst b = './nope'\n"
    expect(rewriteSource(src, 'src/lib/marks.ts', 'src/kernel/core/marks.ts', existsOld, mapPath)).toBe(src)
  })

  it('is a no-op for an unmoved file whose targets did not move', () => {
    const src = "import { j } from '../lib/inline-ts.mjs'\n"
    expect(rewriteSource(src, 'scripts/x.mjs', 'scripts/x.mjs', existsOld, mapPath)).toBe(src)
  })
})

/**
 * carve-kernel — move the reader into `src/kernel/{core,ui}` and re‑point every
 * relative reference. K.3 of dev-docs/plans/phase-05-kernel-capabilities.md.
 *
 * REPLAYABLE, BY DESIGN. Another branch keeps adding files under the old
 * directories; the move therefore cannot be a one‑off commit anyone rebases
 * across by hand. This script computes the move map from the tree AS IT IS,
 * moves what is still in the old place, and re‑relativises every reference —
 * so it is run once to carve, and again after any rebase to sweep stragglers.
 * A run that finds nothing to move and nothing to rewrite changes no file.
 *
 * The map:
 *   src/lib/<m>.ts(x)          → src/kernel/core/<m>            (non‑React, transitively)
 *                              → src/kernel/ui/hooks/<m>        (use*.ts, React)
 *                              → src/kernel/ui/<m>              (other React‑bound modules)
 *   src/lib/<m>.test.ts(x)     → beside <m>; a test with no module classifies itself
 *   src/{reader,pane,screens,shell,overlays,styles}/** → src/kernel/ui/<same>
 *   src/App.tsx                → src/kernel/ui/App.tsx
 *   src/main.tsx, src/vite-env.d.ts, src/kernel/**, src/capabilities/**, src/app/** stay.
 *
 * The rule for `core` vs `ui` is mechanical: a module is `ui` if it imports
 * React or transitively imports a `ui` module; else `core`. K.5 refines by
 * hand what this leaves in the wrong half (`appStorage` reaches React through
 * one value import, for instance) — the mechanical rule is what makes the move
 * replayable, and a judgement call is not.
 *
 * What is rewritten: every string literal beginning `./` or `../` — in
 * `import`/`export … from`, dynamic `import()`, `new URL('…', import.meta.url)`,
 * and helper calls like `read('../x')` — that resolves to a path existing in
 * the OLD tree, when either end of it moves. Extension‑less specifiers stay
 * extension‑less; a trailing `/` stays. One explicit fixup covers the bare
 * `'..'` in `src/styles/tokens.test.ts`, which means "the src root" and cannot
 * be told from a directory name by shape.
 *
 *   node scripts/carve-kernel.mjs            move + rewrite
 *   node scripts/carve-kernel.mjs --dry-run  print the plan, touch nothing
 *   node scripts/carve-kernel.mjs --check    exit 1 if anything would change
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = 'src'
const UI_DIRS = ['reader', 'pane', 'screens', 'shell', 'overlays', 'styles']
const TEXT_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.css'])
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']

/** Explicit fixups for references no rule can read from shape alone. Applied only when the file moves. */
const FIXUPS = [
  {
    file: 'src/styles/tokens.test.ts',
    from: "const SRC = join(HERE, '..')",
    to: "const SRC = join(HERE, '..', '..', '..')",
    why: "'..' meant the src root; from src/kernel/ui/styles that is three levels up",
  },
]

/** Every file under `dir` (repo‑relative posix paths), skipping node_modules etc. */
function walk(dir, out = []) {
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue
    const rel = posix.join(dir, entry.name)
    if (entry.isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

/** `src/lib` modules classified into `ui` and `core` by the mechanical rule. */
export function classifyLib(files, read) {
  const lib = files.filter((f) => /^src\/lib\/[^/]+\.tsx?$/.test(f))
  const modules = lib.filter((f) => !/\.test\.tsx?$/.test(f))
  const names = new Map(modules.map((f) => [f.slice('src/lib/'.length).replace(/\.tsx?$/, ''), f]))
  const react = new Set()
  const deps = new Map()
  const importsOf = (f) => {
    const s = read(f)
    const isReact = /from ['"]react(-dom)?(\/[^'"]*)?['"]/.test(s)
    const local = [...s.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)]
      .map((m) => m[1].replace(/\.tsx?$/, ''))
      .filter((n) => names.has(n))
      .map((n) => names.get(n))
    return { isReact, local }
  }
  for (const f of modules) {
    const { isReact, local } = importsOf(f)
    if (isReact) react.add(f)
    deps.set(f, local)
  }
  const ui = new Set(react)
  let changed = true
  while (changed) {
    changed = false
    for (const f of modules) {
      if (!ui.has(f) && deps.get(f).some((d) => ui.has(d))) {
        ui.add(f)
        changed = true
      }
    }
  }
  const kind = new Map()
  for (const f of modules) kind.set(f, ui.has(f) ? 'ui' : 'core')
  for (const t of lib.filter((f) => /\.test\.tsx?$/.test(f))) {
    const mod = t.replace(/\.test(\.tsx?)$/, '$1')
    const modAlt = mod.endsWith('.ts') ? mod.slice(0, -3) + '.tsx' : mod.slice(0, -4) + '.ts'
    if (kind.has(mod)) kind.set(t, kind.get(mod))
    else if (kind.has(modAlt)) kind.set(t, kind.get(modAlt))
    else kind.set(t, importsOf(t).isReact ? 'ui' : 'core')
  }
  return kind
}

/** old repo‑relative path → new repo‑relative path, for everything that moves. */
export function buildMoveMap(files, read) {
  const map = new Map()
  const kind = classifyLib(files, read)
  for (const [f, k] of kind) {
    const base = f.slice('src/lib/'.length)
    if (k === 'core') map.set(f, `src/kernel/core/${base}`)
    else if (/^use[A-Z]/.test(base)) map.set(f, `src/kernel/ui/hooks/${base}`)
    else map.set(f, `src/kernel/ui/${base}`)
  }
  for (const f of files) {
    for (const d of UI_DIRS) {
      if (f.startsWith(`src/${d}/`)) map.set(f, `src/kernel/ui/${f.slice(4)}`)
    }
    if (f === 'src/App.tsx') map.set(f, 'src/kernel/ui/App.tsx')
  }
  return map
}

/** Directory prefixes that move as a whole (for `'../src/kernel/ui/reader/wordSnap/'`‑style refs). */
function dirMapFor() {
  const dirs = new Map()
  for (const d of UI_DIRS) dirs.set(`src/${d}`, `src/kernel/ui/${d}`)
  // Any deeper directory under a moved dir maps by prefix; src/lib itself dissolves
  // (its files fan out), so it is not a dir mapping.
  return dirs
}

/**
 * Re‑relativise one source text. `oldFile`/`newFile` are repo‑relative; `existsOld`
 * answers whether an old repo‑relative path was a file or dir before the move;
 * `mapPath` maps an old path to its new one (identity when unmoved).
 */
export function rewriteSource(text, oldFile, newFile, existsOld, mapPath) {
  const oldDir = posix.dirname(oldFile)
  const newDir = posix.dirname(newFile)
  return text.replace(/(['"])(\.\.?\/[^'"\n]*)\1/g, (whole, q, spec) => {
    const trailingSlash = spec.endsWith('/')
    const bare = trailingSlash ? spec.slice(0, -1) : spec
    // Which extension form did the author use? Try the spec as written first.
    let found = null
    let usedExt = ''
    for (const ext of RESOLVE_EXTS) {
      const candidate = posix.normalize(posix.join(oldDir, bare + ext))
      const kind = existsOld(candidate)
      // As written (no suffix): a file or, with a trailing slash, a directory.
      // With a suffix we added: it must be a file.
      const want = ext === '' ? (trailingSlash ? 'dir' : 'any') : 'file'
      if (kind && (want === 'any' || kind === want)) {
        found = candidate
        usedExt = ext
        break
      }
    }
    if (!found) return whole
    const mappedTarget = mapPath(found)
    if (mappedTarget === found && oldDir === newDir) return whole
    // Strip the resolution suffix we added, so the specifier keeps its original form.
    let target = mappedTarget
    if (usedExt) target = target.slice(0, target.length - usedExt.length)
    let rel = posix.relative(newDir, target)
    // The file's own directory relativises to '' — that is '.', not './' + '' + '/'.
    if (rel === '') rel = '.'
    if (!rel.startsWith('.')) rel = './' + rel
    if (trailingSlash) rel += '/'
    return `${q}${rel}${q}`
  })
}

function gitTracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: REPO, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function plan() {
  const files = [...walk(SRC), ...walk('scripts')]
  const read = (f) => readFileSync(join(REPO, f), 'utf8')
  const moveMap = buildMoveMap(files, read)
  const dirMap = dirMapFor()
  const fileSet = new Set(files)
  const dirSet = new Set()
  for (const f of files) {
    let d = posix.dirname(f)
    while (d && d !== '.' && !dirSet.has(d)) {
      dirSet.add(d)
      d = posix.dirname(d)
    }
  }
  const existsOld = (p) => (fileSet.has(p) ? 'file' : dirSet.has(p) ? 'dir' : existsSync(join(REPO, p)) ? (statSync(join(REPO, p)).isDirectory() ? 'dir' : 'file') : null)
  const mapPath = (p) => {
    if (moveMap.has(p)) return moveMap.get(p)
    for (const [from, to] of dirMap) {
      if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length)
    }
    return p
  }
  const rewrites = []
  for (const f of files) {
    if (!TEXT_EXT.has(posix.extname(f))) continue
    const before = read(f)
    const newPath = moveMap.get(f) ?? f
    let after = rewriteSource(before, f, newPath, existsOld, mapPath)
    if (moveMap.has(f)) {
      for (const fx of FIXUPS) if (fx.file === f && after.includes(fx.from)) after = after.split(fx.from).join(fx.to)
    }
    if (after !== before) rewrites.push({ file: f, newPath, content: after })
  }
  return { moveMap, rewrites }
}

export function apply({ moveMap, rewrites }) {
  // 1. write rewritten contents at the OLD paths, 2. move. Order does not matter for
  //    correctness (content is path‑independent once rewritten), but writing first
  //    keeps a crash mid‑way easy to reason about: every file is either at its old
  //    path with new content, or moved — the script re‑run finishes either state.
  for (const r of rewrites) writeFileSync(join(REPO, r.file), r.content)
  for (const [from, to] of moveMap) {
    mkdirSync(join(REPO, posix.dirname(to)), { recursive: true })
    if (gitTracked(from)) execFileSync('git', ['mv', from, to], { cwd: REPO, stdio: 'inherit' })
    else renameSync(join(REPO, from), join(REPO, to))
  }
  // 3. remove emptied directories under src/
  for (const d of ['src/lib', ...UI_DIRS.map((d) => `src/${d}`)]) {
    const abs = join(REPO, d)
    if (existsSync(abs)) {
      const left = walk(d)
      if (left.length === 0) removeEmptyDirs(abs)
    }
  }
}

function removeEmptyDirs(abs) {
  for (const e of readdirSync(abs, { withFileTypes: true })) if (e.isDirectory()) removeEmptyDirs(join(abs, e.name))
  if (readdirSync(abs).length === 0) rmdirSync(abs)
}

function main(argv) {
  const dry = argv.includes('--dry-run')
  const check = argv.includes('--check')
  const p = plan()
  const nMoves = p.moveMap.size
  const nRewrites = p.rewrites.length
  if (dry || check) {
    for (const [from, to] of p.moveMap) process.stdout.write(`move  ${from} → ${to}\n`)
    for (const r of p.rewrites) process.stdout.write(`edit  ${r.file}${r.newPath !== r.file ? ` (→ ${r.newPath})` : ''}\n`)
  }
  process.stdout.write(`carve-kernel: ${nMoves} moves, ${nRewrites} rewrites${dry ? ' (dry run)' : check ? ' (check)' : ''}\n`)
  if (dry) return 0
  if (check) return nMoves + nRewrites ? 1 : 0
  if (nMoves + nRewrites === 0) return 0
  apply(p)
  return 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`carve-kernel: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 1
  }
}

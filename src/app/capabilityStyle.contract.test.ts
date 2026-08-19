import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CONTRIBUTED UI IS DRAWN IN PAPER'S VOCABULARY, not in each capability's idea
 * of it.
 *
 * A capability may import the kernel only through its public entry, and the
 * kernel's own controls are a hashed CSS Module — so for a while there was no
 * way to ask for a Paper button from the other side of that boundary. Both
 * capabilities that shipped did the only thing left: two hand-rolled inline
 * objects (`{ gap: '8px' }`, `{ opacity: 0.7, fontSize: '0.85em' }`) and bare
 * `<button>`/`<input>`. Bare form controls get the browser's own chrome, so
 * the Devices section rendered a system-blue submit button and a
 * default-bordered field inside a pane where everything else was Paper's.
 *
 * `CAPABILITY_UI` closed the gap. This closes it in the direction that matters
 * next: nothing stops the third capability doing exactly what the first two
 * did, and an unstyled pane is invisible to every other check in the repo —
 * it type-checks, it tests green, and it only looks wrong in the running app,
 * which is where it was eventually found.
 *
 * THE RULE IS THE ONE `tokens.test.ts` USES, one layer up: a raw length or a
 * colour in an inline style is a design decision taken where the design system
 * cannot see it. Percentages, `0` and computed values are structure — "half of
 * itself", "share of what is left" — and stay allowed, exactly as they do
 * there. What a capability needs and cannot express belongs in
 * `kernel/ui/styles/capability.css` as a rule the whole layer can reach.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPABILITIES = join(HERE, '..', 'capabilities')

/** A length with a unit, or a colour. What a token exists for. */
const RAW_VALUE = /(\d\s*(px|r?em|ch|vh|vw)\b)|(#[0-9a-fA-F]{3,8}\b)|\b(rgba?|hsla?|oklch)\s*\(/

/** The `{ … }` starting at `from`, brace-matched — so a nested object or a
 *  template literal does not end it early. */
function objectAt(source: string, from: number): string {
  let depth = 0
  for (let i = from; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(from, i + 1)
    }
  }
  return source.slice(from)
}

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length

/**
 * Every style a component actually applies, with the line it is applied on —
 * INLINE OR NAMED.
 *
 * The named form is the one that matters, and missing it is how this check
 * would have been useless: what shipped was not `style={{ gap: '8px' }}` but a
 * module-level `const row = { gap: '8px' }` applied as `style={row}`, five
 * times per file. A guard written against the shape that is easy to match
 * rather than the shape that occurred is a guard that passes for ever.
 *
 * So an identifier in `style={…}` is followed to its declaration, and a spread
 * inside an inline style is followed the same way.
 */
export function inlineStyleOffences(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = []
  const seen = new Set<string>()

  /** The initializer of `const <name> … = { … }`, if there is one. */
  const declared = (name: string): string | null => {
    const at = source.search(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^=]*=\\s*\\{`))
    return at === -1 ? null : objectAt(source, source.indexOf('{', at))
  }

  const report = (body: string, index: number) => {
    if (!RAW_VALUE.test(body)) return
    const text = body.replace(/\s+/g, ' ').slice(0, 90)
    const key = `${lineOf(source, index)}:${text}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ line: lineOf(source, index), text })
  }

  for (const match of source.matchAll(/style=\{/g)) {
    const body = objectAt(source, match.index + 'style='.length)
    // `style={{…}}` — the object is the inner brace pair; `style={x}` — the
    // body is just the reference, and the object is wherever x was declared.
    report(body, match.index)
    for (const ref of body.matchAll(/(?:\.\.\.)?\b([A-Za-z_$][\w$]*)\b/g)) {
      const name = ref[1] as string
      if (seen.has(`decl:${name}`)) continue
      seen.add(`decl:${name}`)
      const init = declared(name)
      if (init) report(init, match.index)
    }
  }
  return found
}

function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) tsxUnder(path, out)
    else if (entry.endsWith('.tsx')) out.push(path)
  }
  return out
}

describe('capability UI draws with the kernel’s vocabulary', () => {
  const files = tsxUnder(CAPABILITIES)

  it('finds capability components to check', () => {
    // A glob that matches nothing passes every assertion below it.
    expect(files.length).toBeGreaterThan(0)
  })

  it('takes no design decision in an inline style', () => {
    const offences = files.flatMap((file) =>
      inlineStyleOffences(readFileSync(file, 'utf8')).map(
        (one) => `${relative(CAPABILITIES, file)}:${one.line}  ${one.text}`,
      ),
    )
    expect(
      offences,
      `use CAPABILITY_UI, or add a rule to kernel/ui/styles/capability.css:\n${offences.join('\n')}`,
    ).toEqual([])
  })

  /* THE GUARD'S OWN GUARD — the `boundaries:selftest` idea, in miniature. A
     detector that has quietly stopped detecting passes for ever, and this one
     is a regex over source: it is exactly the kind that rots into a pass. */
  it('still bites on what actually shipped', () => {
    /* THE NAMED FORM FIRST, because it is what was actually there — a
       module-level object applied by reference. A detector that only matched
       `style={{` reported one offence per file and missed the five that
       mattered, which is the failure this case exists to prevent. */
    const named = `const row: React.CSSProperties = { display: 'flex', gap: '8px', padding: '4px 0' }\n<div style={row} />`
    expect(inlineStyleOffences(named)).toHaveLength(1)
    const spread = `const dim = { fontSize: '0.85em' }\n<div style={{ ...row, ...dim }} />`
    expect(inlineStyleOffences(spread).length).toBeGreaterThan(0)
    expect(inlineStyleOffences(`<div style={{ opacity: 0.7, fontSize: '0.85em' }} />`)).toHaveLength(1)
    expect(inlineStyleOffences(`<div style={{ background: '#fff' }} />`)).toHaveLength(1)
  })

  it('leaves structure alone', () => {
    // Percentages, 0, and anything computed — no scale step could say these.
    expect(inlineStyleOffences(`<div style={{ flex: 1, width: '100%', inset: 0 }} />`)).toEqual([])
    expect(inlineStyleOffences(`<div style={{ width: \`\${pct}%\` }} />`)).toEqual([])
    expect(inlineStyleOffences(`<img style={{ maxWidth: 'var(--prose-narrow)' }} />`)).toEqual([])
  })
})

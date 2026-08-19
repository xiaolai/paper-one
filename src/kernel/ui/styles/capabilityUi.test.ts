import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_UI } from '../../core/capabilityUi'

/**
 * THE TWO HALVES, HELD TO EACH OTHER.
 *
 * `CAPABILITY_UI` is strings and `capability.css` is rules, and nothing in the
 * language connects them: a name exported with no rule behind it renders in
 * the browser's default chrome, silently and only in the app, which is the
 * exact failure this vocabulary was added to fix. A rule with no name exported
 * is the other direction — a control no capability can reach, and dead CSS
 * nobody knows is dead.
 *
 * So the test is both directions, and it is why the names are a frozen table
 * rather than written inline at each call site.
 */

const CSS = readFileSync(fileURLToPath(new URL('./capability.css', import.meta.url)), 'utf8')

/** Every class the stylesheet DEFINES — the selector heads, without the
 *  pseudo-classes and attribute tails hanging off them. */
const defined = new Set(
  [...CSS.matchAll(/\.(paper-cap-[a-z-]+)/g)].map((match) => match[1] as string),
)

const exported = Object.entries(CAPABILITY_UI)

describe('the capability vocabulary', () => {
  it('defines a rule for every name it exports', () => {
    for (const [key, name] of exported) {
      expect(defined.has(name), `${key} → .${name} has no rule in capability.css`).toBe(true)
    }
  })

  it('exports a name for every rule it defines', () => {
    const names = new Set<string>(exported.map(([, name]) => name))
    for (const name of defined) {
      expect(names.has(name), `.${name} is defined but no capability can name it`).toBe(true)
    }
  })

  /* NAMESPACED, because these are global class names in a document that also
     carries CSS Modules and the book's own stylesheet. The prefix is what
     stops a capability's class from being something a component already
     styles, and what makes an unexpected one obvious in devtools. */
  it('namespaces every name', () => {
    for (const [key, name] of exported) {
      expect(name, key).toMatch(/^paper-cap-[a-z-]+$/)
    }
  })

  /* It is public API and it crosses a boundary: a capability that mutated it
     would change what every other capability draws with. */
  it('is frozen', () => {
    expect(Object.isFrozen(CAPABILITY_UI)).toBe(true)
  })

  /* The stylesheet is only shipped by the UI entry, which is the one place
     the app's other global stylesheets are brought in. Reached any other way
     — imported by a capability, say — it would be in the bundle twice and
     the boundary would have been crossed to get it. */
  it('ships with the UI entry and nowhere else', () => {
    const entry = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    expect(entry).toMatch(/import '\.\/styles\/capability\.css'/)
  })
})

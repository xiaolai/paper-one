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

/** The kernel's own side pane, whose settings rows a contributed one has to
 *  sit among without looking like a visitor. */
const PANE_CSS = readFileSync(
  fileURLToPath(new URL('../pane/SidePane.module.css', import.meta.url)),
  'utf8',
)

/**
 * One declaration out of one rule, comments stripped.
 *
 * Loud on a miss, in both directions: a renamed class or a dropped property
 * has to fail as "not found" rather than quietly compare `undefined` with
 * `undefined` and pass. That failure mode is what makes most stylesheet
 * guards worthless.
 */
function declared(css: string, selector: string, property: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source)
  if (!rule) throw new Error(`no rule for ${selector}`)
  const value = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(rule[1] ?? '')
  if (!value) throw new Error(`${selector} declares no ${property}`)
  return (value[1] ?? '').trim()
}

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

/**
 * THE QUANTITIES, HELD TO THE KERNEL'S.
 *
 * The names being in step says a contributed control is styled. It says
 * nothing about whether it is styled like Paper — and that is where this
 * actually went wrong. Every value below was a token, so the raw-value guard
 * passed; they were simply the WRONG tokens, and the result was a settings
 * section with its own row height, its own left margin and a text field
 * borrowed from the command palette sitting in a row beside a 28px button.
 *
 * Nothing in a build can see that. These are the four quantities a reader
 * sees immediately when they disagree.
 */
describe('the capability vocabulary, measured against the kernel it sits in', () => {
  /* A contributed row is a SETTINGS row and must stand as tall as one, or the
     pane reads with two rhythms in one column. */
  it('gives a contributed row the kernel settings row height', () => {
    expect(declared(CSS, '.paper-cap-row', 'min-height')).toBe(
      declared(PANE_CSS, '.settingRow', 'height'),
    )
  })

  /* And start in the same column. `.settingRow` insets its label; a section
     with no inset put "This device" ten pixels left of "Flow" above it. */
  it('starts a contributed label in the same column as a kernel one', () => {
    const kernel = declared(PANE_CSS, '.settingRow', 'padding').split(/\s+/)
    expect(declared(CSS, '.paper-cap-section', 'padding-inline')).toBe(kernel[1])
  })

  /**
   * A FIELD AND A BUTTON IN ONE ROW ARE ONE CONTROL HEIGHT.
   *
   * The pair form is a field beside a Pair button. The field took
   * `--control-field`, whose own definition calls it "the command palette's
   * own field, which is the largest control in the app … deliberately a step
   * above `CONTROL.lg` — the ramp describes controls that sit among other
   * controls, and this one does not". It sat among other controls: 52px next
   * to 28px.
   */
  it('matches a field to the button beside it', () => {
    expect(declared(CSS, '.paper-cap-field', 'height')).toBe(
      declared(CSS, '.paper-cap-button', 'height'),
    )
    expect(declared(CSS, '.paper-cap-field', 'border-radius')).toBe(
      declared(CSS, '.paper-cap-button', 'border-radius'),
    )
  })

  /* The palette's field is a step off the ramp on purpose. Nothing that sits
     in a row may reach for it — which is how it got here in the first place.
     Comments stripped first: the rule above EXPLAINS the token by name, and a
     guard an explanation can break is a guard that gets deleted. */
  it('never reaches for the command palette\'s field', () => {
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/--control-field/)
  })
})

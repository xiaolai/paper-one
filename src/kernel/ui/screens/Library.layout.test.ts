import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guards on the properties that stop the library screen moving under a reader.
 *
 * A folder import used to draw its progress as a block above the search
 * field — an ordinary flex child of the screen's column, carrying the current
 * book's filename. It appeared, and the whole shelf slid down. It vanished,
 * and the shelf slid back. In between, real filenames run past a hundred
 * characters, so the block rewrapped between one and three lines on almost
 * every book of a two-thousand-book import: the shelf jittered continuously
 * for the length of the import.
 *
 * The line lives in the status bar now. What makes that a fix rather than a
 * relocation is entirely CSS — a bar of fixed height whose contents clip
 * instead of wrapping — so those are the properties worth a durable check.
 * The arrangement is invisible to every other kind of test in this repo:
 * jsdom does not lay anything out, so nothing else here can tell a bar that
 * holds its height from one that grows.
 *
 * Same approach and same reasoning as `Reader.layout.test.ts`.
 */
const css = readFileSync(
  fileURLToPath(new URL('./Library.module.css', import.meta.url)),
  'utf8',
)

/** The stylesheet with comments removed — the prose below names classes and
 *  properties it is describing rather than declaring. */
const source = css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * One rule's body.
 *
 * Loud when the selector is missing: a renamed class must fail as an absent
 * rule rather than pass as an empty one, which is the failure mode that makes
 * a stylesheet guard worthless.
 */
function ruleBody(selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source)
  if (!match) throw new Error(`Library.module.css has no rule for ${selector}`)
  return match[1] ?? ''
}

describe('the status bar cannot move the shelf', () => {
  /* A HEIGHT, not a min-height and not nothing. This is the one property that
   * makes the foot safe to put a growing string in: whatever it is handed, the
   * bar is the same height and the scroll region above it does not resize. */
  it('is a fixed height', () => {
    expect(ruleBody('.status')).toMatch(/height:\s*var\(--status-bar-h\)/)
  })

  /* The other half. A fixed-height bar whose text wraps just overflows its own
   * box; the text has to be refused a second line in the first place. */
  it('clips its work line rather than wrapping it', () => {
    const work = ruleBody('.statusWork')
    expect(work).toMatch(/white-space:\s*nowrap/)
    expect(work).toMatch(/overflow:\s*hidden/)
    expect(work).toMatch(/text-overflow:\s*ellipsis/)
    /* And it must be allowed to shrink: a flex item defaults to `min-width:
     * auto`, which refuses to go below its content — so without this the long
     * filename pushes the bar wider than the window and clips nothing. */
    expect(work).toMatch(/min-width:\s*0/)
  })

  /* Counts that tick upward on every book, in a line the eye keeps returning
   * to. Proportional digits make "1,412 of 1,959" shuffle sideways as it
   * counts, which is a smaller version of the same complaint. */
  it('sets the counting text in tabular figures', () => {
    expect(ruleBody('.statusWork')).toMatch(/font-variant-numeric:\s*tabular-nums/)
  })
})

describe('the chrome above the shelf', () => {
  /* THE BANNER MUST NOT COME BACK. It is the only element this screen has ever
   * had between the heading and the search field, and its whole problem was
   * being there at all. */
  it('has no import banner rule left to render into', () => {
    expect(source).not.toMatch(/\.importing\s*\{/)
  })

  /**
   * ONE GUTTER FOR THIS SCREEN, and it is `--shelf-pad-x`.
   *
   * The banner padded with `--stage-pad-x`, which is the READER's gutter and
   * is not defined here at all — so it fell back to its own literal and sat
   * 24px in while the search field and every cover sat at 40px. Nothing
   * announces that kind of mistake; the variable simply resolves to the
   * fallback and the row is quietly out of line.
   */
  it('never reaches for the reader\'s gutter', () => {
    expect(source).not.toMatch(/--stage-pad-x/)
  })
})

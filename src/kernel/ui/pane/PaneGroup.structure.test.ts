import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * ONE ACCORDION IN THE SIDE PANE, AND EVERY SETTING INSIDE ONE.
 *
 * Two rules the pane had broken by growing, in three different ways.
 *
 * It drew three kinds of heading. The settings panel had plain captions over
 * Appearance and Reading and disclosures over Light and Spacing; the Library
 * panel had a plain caption over Views and Tags that could not be opened at
 * all, and — twenty lines below it — a hand-rolled disclosure over Subjects
 * that reproduced the button, the chevron and the count by hand, and dropped
 * `aria-controls` on the way. Three spellings of one idea in one pane, and a
 * reader could not tell by looking which heading in front of them would do
 * anything.
 *
 * And five settings ended up under no heading at all. Flow, the reading ruler,
 * the scrollbar, the progress rule and the side pane's own position were
 * whatever was left after the headings above them had claimed their rows — and
 * they sat BELOW two collapsed groups, so with Spacing shut they read as
 * Spacing's contents and with it open they read as nothing's.
 *
 * Neither is visible to a type-checker, a linter or a screenshot diff. Both are
 * obvious the moment somebody reads the file, which is exactly why they want a
 * test: nobody reads the whole file when adding one row to the end.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Every panel in the side pane, by file — not a list to keep in step. */
const PANELS = readdirSync(HERE).filter(
  (name) => name.endsWith('.tsx') && name !== 'PaneGroup.tsx',
)

/**
 * A panel's markup, comments stripped.
 *
 * The prose in these files names the classes it is discussing — including the
 * caption class this test forbids — and a guard that its own explanation can
 * break is a guard that gets deleted rather than fixed.
 */
const markup = (name: string) =>
  readFileSync(new URL(name, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

describe.each(PANELS)('%s', (panel) => {
  const MARKUP = markup(panel)

  /**
   * NO SECOND KIND OF HEADING. `groupTitle` and `groupTitleRow` are what
   * `PaneGroup` is built out of; reached directly by a panel they are a
   * caption that looks like a disclosure and does nothing.
   */
  it('draws its group headings through PaneGroup and nowhere else', () => {
    expect(MARKUP).not.toMatch(/styles\.groupTitle\b/)
    expect(MARKUP).not.toMatch(/styles\.groupTitleRow\b/)
  })

  /* And does not rebuild the disclosure by hand, which is how the Subjects
     group came to be missing `aria-controls` while looking identical. */
  it('does not hand-roll a disclosure', () => {
    expect(MARKUP).not.toMatch(/styles\.groupToggle\b/)
    expect(MARKUP).not.toMatch(/styles\.groupChevron\b/)
  })

  /* Balanced, or the depth walk below proves nothing — a missing close would
     put every later control "inside" a group that had ended. */
  it('opens and closes every group it starts', () => {
    expect(MARKUP.match(/<PaneGroup/g)?.length ?? 0).toBe(
      MARKUP.match(/<\/PaneGroup>/g)?.length ?? 0,
    )
  })
})

/** Anything in the settings panel that renders a control a reader can set. */
const CONTROL = /styles\.settingRow|<StepRow|styles\.themeGrid/

describe('the settings panel', () => {
  /**
   * Walks the panel counting `PaneGroup` depth, and reports any control
   * standing outside one. The message names the line, because "a row is
   * ungrouped" is not actionable and "line 312 is" is.
   */
  it('puts every control inside a group', () => {
    const orphans: string[] = []
    let depth = 0
    for (const [at, line] of markup('Settings.tsx').split('\n').entries()) {
      /* Counted before the control check, so a control on the same line as its
       * group's opening tag is inside it. */
      if (line.includes('<PaneGroup')) depth += 1
      if (line.includes('</PaneGroup>')) depth -= 1
      if (depth === 0 && CONTROL.test(line)) orphans.push(`${String(at + 1)}: ${line.trim()}`)
    }
    expect(orphans, `settings outside any group:\n${orphans.join('\n')}`).toEqual([])
  })
})

describe('a group and what it holds', () => {
  const css = readFileSync(new URL('./SidePane.module.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )

  /**
   * THE CONTENTS ARE INDENTED UNDER THE HEADING, and by the heading's own
   * measurements. Flush, a group says nothing about where it ends: a closed
   * group and an open one differ only in how many rows follow, and with two
   * groups in a column the reader counts chevrons to work out which rows
   * belong to which.
   *
   * Derived rather than chosen — the chevron plus the gap after it — so a
   * row's label starts in the same column as the heading's label rather than
   * under its disclosure mark, and stays there if either value changes.
   */
  it("indents the body by the heading's chevron and the gap after it", () => {
    const body = /\.groupBody\s*\{([^}]*)\}/.exec(css)
    if (!body) throw new Error('SidePane.module.css has no rule for .groupBody')
    expect(body[1]).toMatch(
      /padding-inline-start:\s*calc\(var\(--icon-control\)\s*\+\s*var\(--space-6\)\)/,
    )
  })
})

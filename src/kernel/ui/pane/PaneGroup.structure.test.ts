import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_READING_STYLE } from '../../core/metrics'

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

/** The fifteen, from the type rather than from a list kept in step by hand. */
const READING_STYLE_KEYS = Object.keys(DEFAULT_READING_STYLE)

/**
 * The heading MECHANISMS — the files allowed to reach the heading classes,
 * because building the heading is what they are for.
 *
 * This was `name !== 'PaneGroup.tsx'`, a hand-kept exclusion of one, which
 * read as "except that file" rather than "except a mechanism". `PaneBand`
 * arrived and had to be added by hand; naming the category is what stops the
 * third one being added to a list nobody notices is a list.
 */
const MECHANISMS = ['PaneGroup.tsx', 'PaneBand.tsx']

/** Every panel in the side pane, by file — not a list to keep in step. */
const PANELS = readdirSync(HERE).filter(
  (name) => name.endsWith('.tsx') && !MECHANISMS.includes(name),
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

  /**
   * AND ITS BAND CAPTIONS THROUGH `PaneBand`.
   *
   * A band caption is deliberately a SECOND kind of heading — quieter, and
   * carrying no chevron, because it labels groups rather than opening
   * anything. That is precisely the shape this whole file exists to keep
   * scarce: the pane once drew three kinds of heading and a reader could not
   * tell by looking which of them did something.
   *
   * So the second kind is allowed exactly once, in the component that owns it.
   * Hand-rolled anywhere else it becomes the fourth spelling.
   */
  it('draws its band captions through PaneBand and nowhere else', () => {
    expect(MARKUP).not.toMatch(/styles\.bandTitle\b/)
    expect(MARKUP).not.toMatch(/styles\.band\b/)
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

/**
 * Anything in the settings panel that renders a control a reader can set.
 *
 * THE SHARED ROWS ARE CONTROLS TOO. WI-14.4 added fifteen settings and eleven
 * of them are the same cycling row, so it became a component — and a component
 * is invisible to a scan for `styles.settingRow`, which would have let every
 * one of the fifteen sit outside a group with this test still green. Named
 * here, and the walk below starts inside `Settings` so the components' own
 * DEFINITIONS are not read as ungrouped rows.
 */
const CONTROL = /styles\.settingRow|<StepRow|<CycleRow|<ToggleRow|styles\.themeGrid/

describe('the settings panel', () => {
  /**
   * Walks the panel counting `PaneGroup` depth, and reports any control
   * standing outside one. The message names the line, because "a row is
   * ungrouped" is not actionable and "line 312 is" is.
   */
  it('puts every control inside a group', () => {
    const orphans: string[] = []
    let depth = 0
    const lines = markup('Settings.tsx').split('\n')
    /* FROM THE PANEL'S OWN JSX, not from the top of the file. The shared row
       components are declared above it and contain `styles.settingRow` in their
       own markup; read from line one they are fifteen orphans that are not
       there. What this test is about is where a row is USED. */
    const opens = lines.findIndex((line) => line.includes('export function Settings('))
    expect(opens, 'Settings.tsx has no panel — this test would assert nothing').toBeGreaterThan(-1)
    for (const [at, line] of lines.slice(opens).entries()) {
      /* Counted before the control check, so a control on the same line as its
       * group's opening tag is inside it. */
      if (line.includes('<PaneGroup')) depth += 1
      if (line.includes('</PaneGroup>')) depth -= 1
      if (depth === 0 && CONTROL.test(line)) orphans.push(`${String(at + opens + 1)}: ${line.trim()}`)
    }
    expect(orphans, `settings outside any group:\n${orphans.join('\n')}`).toEqual([])
  })
})

/**
 * EVERY READING SETTING HAS A ROW, or it is unreachable.
 *
 * WI-14.4 added fifteen at once. A setting with a `--paper-*` property, a rule
 * that reads it and no control in the panel is invisible in every direction:
 * the sheets test passes, the contract test passes, the reducer branch is
 * covered by its own test, and no reader can ever move it. Derived from the
 * type's own keys, so a sixteenth fails here rather than shipping unreachable.
 */
describe('the reading settings are all reachable', () => {
  const panel = markup('Settings.tsx')

  it('gives every setting in ReadingStyle a control', () => {
    const missing = READING_STYLE_KEYS.filter((key) => !panel.includes(`'${key}'`))
    expect(
      missing,
      `\nsettings with no row in the panel:\n  ${missing.join('\n  ')}\n`,
    ).toEqual([])
  })

  it('knows what the settings are, so the check above can fail', () => {
    expect(READING_STYLE_KEYS.length).toBe(15)
    expect(panel.includes("'notASetting'")).toBe(false)
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

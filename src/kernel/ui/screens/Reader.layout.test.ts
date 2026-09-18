import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A guard on the one CSS property that carries `proseBleed`.
 *
 * The arithmetic in `proseBleed` was correct and unit-tested for weeks while
 * the CSS applying it did nothing: the book is a `position: absolute; inset: 0`
 * child of `.text`, and an absolutely positioned box resolves its insets
 * against the containing block's PADDING box. So `padding-inline-end` left the
 * book at the full width of the grid, foliate centred the measure inside that,
 * and the moment a mark widened the margin column the text sat 72px off its own
 * track and ran under the notes.
 *
 * Nothing could catch that from the arithmetic — both sides agreed. This is the
 * cheapest durable check on the property itself, and it fails with the reason
 * attached rather than leaving the next person to rediscover it in the browser.
 */
/** A stylesheet's text, by its path from this file. */
const sheet = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const css = sheet('./Reader.module.css')

/**
 * One rule's body, comments removed.
 *
 * Scoped rather than scanning the whole file, and stripped rather than taken
 * raw. The previous version searched the entire stylesheet: the passage above
 * NAMES `padding-inline-end` in prose, so a check for "no padding declaration"
 * could be satisfied or broken by an edit to a comment, and a bleed applied to
 * some unrelated selector would have counted as this rule being correct.
 */
function ruleBody(selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source)
  // Loud: a renamed class must fail as a missing rule, not pass as an empty one.
  if (!match) throw new Error(`Reader.module.css has no rule for ${selector}`)
  return match[1] ?? ''
}

/**
 * Bleed declarations in the book's own rule, as `property → variable`.
 *
 * Both halves, because the property alone cannot tell the two edges apart:
 * `margin-inline-start` written twice passed a test that only counted two
 * allowed declarations, and the end of the measure would have run under the
 * margin notes with every assertion green.
 */
function bleedDeclarations(): string[] {
  return [
    ...ruleBody('.text').matchAll(/([a-z-]+)\s*:\s*var\(--text-bleed-([a-z]+)/g),
  ].map((match) => `${match[1] ?? ''} -> ${match[2] ?? ''}`)
}

describe('the prose bleed', () => {
  it('is applied to both edges, each from its own variable', () => {
    expect(bleedDeclarations().sort()).toEqual([
      'margin-inline-end -> end',
      'margin-inline-start -> start',
    ])
  })

  it('uses margin, which an absolutely positioned book actually follows', () => {
    // Stated separately from the pairing above so a regression to padding
    // fails with the reason attached rather than as a mismatched list.
    for (const declaration of bleedDeclarations()) {
      expect(declaration).toMatch(/^margin-inline-(start|end) -> /)
    }
  })

  it('never uses padding, which the book would silently ignore', () => {
    expect(ruleBody('.text')).not.toMatch(/padding-inline-[a-z]+\s*:\s*var\(--text-bleed/)
  })
})

const glossCss = sheet('../reader/LookUpFace.module.css')

const tokensCss = sheet('../styles/tokens.css')

const popupCss = sheet('../reader/SelectionTools.module.css')

/**
 * Every opacity a rule sets, as a NUMBER, whether it was written as a literal
 * or as a token.
 *
 * ⚠️ **IT USED TO MATCH `[\d.]+` AND ONLY THAT.** When `.failedReason`'s
 * `0.75` became `var(--opacity-quiet)` the pattern found nothing, and the
 * non-vacuity assertion below — the one that exists so a loop over no
 * declarations cannot pass — went red. That was the guard working: the check is
 * "is this element visible", and an assertion that can only read literals stops
 * asking it the moment the design system is used properly.
 *
 * Following the token is also STRONGER. A literal `opacity: 0` was catchable
 * before; a token defined as `0` was not, because there was no literal to read.
 * Now both are.
 */
function opacitiesOf(selector: string): number[] {
  const out: number[] = []
  for (const [, raw] of glossRule(selector).matchAll(/opacity\s*:\s*([^;]+)/g)) {
    const value = (raw ?? '').trim()
    const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
    if (!token) {
      out.push(Number(value))
      continue
    }
    const defined = new RegExp(`${token[1]}\\s*:\\s*([\\d.]+)`).exec(tokensCss)
    if (!defined) throw new Error(`tokens.css defines no ${token[1]}`)
    out.push(Number(defined[1]))
  }
  return out
}

/** The same scoping as `ruleBody`, over the lookup face's own stylesheet. */
function glossRule(selector: string): string {
  const source = glossCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source)
  if (!match) throw new Error(`LookUpFace.module.css has no rule for ${selector}`)
  return match[1] ?? ''
}

/**
 * WI-16.3's CSS half, and ONLY that half — carried from the strip to the
 * lookup face that replaced it (phase 17, L1), selectors renamed and assertions
 * unchanged.
 *
 * The behaviour — which element each state renders into, whether the failure is
 * visible, whether it says "couldn't" — is asserted by RENDERING, in
 * `reader/LookUpFace.test.tsx`. It used to be asserted here by scanning
 * `Reader.tsx`'s source, and an audit named what that misses: adding `hidden`
 * to the failed element leaves every source assertion green while the failure
 * disappears from the screen.
 *
 * What stays here is the one question a rendering test cannot answer. CSS
 * Modules give jsdom a hashed class name and no stylesheet, so "is it amber" is
 * legible only from the stylesheet — and amber is the whole point:
 * `core/gloss.ts` says an apology must never be resolved as a definition
 * "because an apology rendered in amber reads as a definition".
 */
describe('the gloss that did not arrive', () => {
  /**
   * ⚠️ **THIS REQUIRED `.definition` ITSELF TO BE AMBER, AND THAT WAS A CLAIM
   * ABOUT THE SHAPE RATHER THAN ABOUT THE DOCTRINE** (2026-09-18). The rule
   * `core/gloss.ts` states is that a machine's words are amber and an apology
   * is not; it says nothing about which ELEMENT carries the colour. Pinning it
   * to the definition's own rule meant the test failed when the amber moved
   * from a filled box, to a 2px rule, to the term — three times, for three
   * appearance changes that all kept the doctrine perfectly.
   *
   * So it asks the question the doctrine actually asks: amber appears SOMEWHERE
   * among the elements a definition is drawn from, and NOWHERE among the four
   * states that are not definitions. That survives the next appearance change
   * and still fails the only thing worth failing — an apology in amber.
   */
  it('is not amber, while the definition still is', () => {
    /* Non-vacuity first: a test that only asserted the absence would pass if
       every one of them lost its colour. */
    const definition = ['.definition', '.term', '.body'].map(glossRule).join('\n')
    expect(definition).toMatch(/var\(--amber/)
    expect(glossRule('.failed')).not.toMatch(/var\(--amber/)
    expect(glossRule('.failedReason')).not.toMatch(/var\(--amber/)
    /* The two non-answers that are not failures borrow none of it either. */
    expect(glossRule('.absent')).not.toMatch(/var\(--amber/)
    expect(glossRule('.refused')).not.toMatch(/var\(--amber/)
    /* ⚠️ **AND THE PART OF SPEECH DOES NOT, THOUGH IT IS PART OF A DEFINITION.**
       The doctrine asks that a machine's words carry the colour, not that each
       element of them repeats it (the correction above) — and §10's prototype
       draws this line small, italic and muted, which is also what keeps the
       term the one amber thing in a 40px-wide card. Its own assertion, because
       it is the one element inside a definition that the clause above would
       otherwise let drift into amber unremarked. */
    expect(glossRule('.partOfSpeech')).not.toMatch(/var\(--amber/)
    /* ⚠️ **AND NEITHER DOES A PRONUNCIATION THAT WOULD NOT PLAY**, though it is
       drawn INSIDE the definition's own box — which is what makes it the one
       element the clause above could not reach. It is Paper speaking about
       itself, exactly like `.absent` and `.refused`, so it wears the failure
       states' grey; amber here would be a machine's apology dressed as part of
       the answer, which is the doctrine in miniature. */
    expect(glossRule('.unspoken')).not.toMatch(/var\(--amber/)
  })

  /*
   * PRONUNCIATION — the control that replaced IPA, because a language model has
   * no phonetic data and would invent a transcription (`core/voice.ts`).
   *
   * Its BEHAVIOUR is asserted by rendering, in `reader/LookUpFace.test.tsx`.
   * What only the stylesheet can answer is the same two questions every other
   * state gets here: is the notice actually drawn, and does the headword's new
   * row take back the wrapping the face is built on.
   */
  it('draws a pronunciation that would not play, rather than hiding it', () => {
    expect(glossRule('.unspoken')).not.toMatch(/display\s*:\s*none/)
    expect(glossRule('.unspoken')).not.toMatch(/visibility\s*:\s*(hidden|collapse)/)
    for (const value of opacitiesOf('.unspoken')) {
      expect(value).toBeGreaterThan(0)
    }
    /* The failure states' own treatment: small and grey, not the definition's. */
    expect(glossRule('.unspoken')).toMatch(/color\s*:\s*var\(--muted\)/)
    expect(glossRule('.unspoken')).toMatch(/font-size\s*:\s*var\(--text-small\)/)
  })

  /* THE CONTROL IS SIZED LIKE THE FACE'S OTHER GLYPH BUTTON. `.back` is the
     precedent, and the number is the one thing the two have to agree about — a
     bar of glyphs with one odd-sized button in it reads as a mistake. */
  it('sizes the pronunciation control like the face’s way back', () => {
    for (const rule of ['.back', '.say']) {
      expect(glossRule(rule)).toMatch(/width\s*:\s*var\(--control-sm\)/)
      expect(glossRule(rule)).toMatch(/height\s*:\s*var\(--control-sm\)/)
    }
  })

  /* IT IS ALSO DRAWN, and quietly rather than invisibly — the same question the
     failure states get below, asked of the element §10 makes muted on purpose:
     `--muted` is a colour, and a rule that reached `opacity: 0` or
     `display: none` would leave every rendered case green. */
  it('draws the part of speech quietly, not invisibly', () => {
    expect(glossRule('.partOfSpeech')).not.toMatch(/display\s*:\s*none/)
    expect(glossRule('.partOfSpeech')).not.toMatch(/visibility\s*:\s*(hidden|collapse)/)
    for (const value of opacitiesOf('.partOfSpeech')) {
      expect(value).toBeGreaterThan(0)
    }
    /* §10's treatment, which is the whole of the design decision here: small,
       italic, muted. Read from the stylesheet because jsdom has none. */
    expect(glossRule('.partOfSpeech')).toMatch(/font-style\s*:\s*italic/)
    expect(glossRule('.partOfSpeech')).toMatch(/font-size\s*:\s*var\(--text-small\)/)
    expect(glossRule('.partOfSpeech')).toMatch(/color\s*:\s*var\(--muted\)/)
  })

  /*
   * THE OTHER HALF OF "drawn apart": it has to be drawn.
   *
   * `LookUpFace.test.tsx` catches a `hidden` attribute, and cannot catch this —
   * CSS Modules give jsdom a hashed class name and no stylesheet, so a rule
   * that hid the element would leave every mounted case green while the reader
   * saw nothing. A verification pass named exactly that mutation. This is the
   * only place it is visible.
   */
  it('is drawn at all — not hidden by its own rule', () => {
    for (const rule of ['.failed', '.failedReason', '.absent', '.refused']) {
      expect(glossRule(rule)).not.toMatch(/display\s*:\s*none/)
      expect(glossRule(rule)).not.toMatch(/visibility\s*:\s*(hidden|collapse)/)
      expect(glossRule(rule)).not.toMatch(/content-visibility\s*:\s*hidden/)
      /* Opacity is READ rather than pattern-matched, because the pattern that
       * looks right is wrong: `/opacity:\s*0(\D|$)/` matches `opacity: 0.75`,
       * since `.` is a non-digit. The question is numeric, so ask it that way —
       * through the token, which `opacitiesOf` resolves. */
      for (const value of opacitiesOf(rule)) {
        expect(value).toBeGreaterThan(0)
      }
    }
    /* Non-vacuity: the reason IS de-emphasised, so a loop over no declarations
     * at all would pass. There is one to find. */
    expect(opacitiesOf('.failedReason')).toHaveLength(1)
  })

  /* L5. The strip was one line, so a failure's reason was ELLIPSISED — and it is
   * the only account the reader gets of why there is no definition. The face
   * wraps it, and a URL-length reason with no spaces wraps too. */
  it('wraps the reason rather than cutting it to one line', () => {
    expect(glossRule('.failedReason')).not.toMatch(/white-space\s*:\s*nowrap/)
    expect(glossRule('.failedReason')).not.toMatch(/text-overflow\s*:\s*ellipsis/)
    expect(glossRule('.failedReason')).toMatch(/overflow-wrap\s*:\s*anywhere/)
  })
})

/*
 * THE TERM, which is whatever the reader selected — up to 120 code points, and a
 * URL or a long compound has no break in it. The face is capped at
 * `--lookup-measure`, so every element that names the term has to be able to
 * wrap it. Until 2026-09-13 only the answer and the reason could, and the term
 * ran out of the popup in the definition, in "couldn't define" and in "needs a
 * language model" alike.
 */
describe('the lookup face’s own words', () => {
  it('wraps a term with no break in it, in every state that names one', () => {
    /* By inheritance, from the one box every state is drawn inside. */
    expect(glossRule('.content')).toMatch(/overflow-wrap\s*:\s*anywhere/)
    /* And nothing in between takes it back — `.headword` included, which is a
       NEW LINK IN THAT CHAIN: the term became a flex item when the pronunciation
       control joined it on one row, and a flex item that refuses to wrap pushes
       the control off the card instead of breaking. */
    for (const rule of ['.definition', '.headword', '.term', '.failed', '.absent']) {
      expect(glossRule(rule)).not.toMatch(/overflow-wrap\s*:\s*normal/)
      expect(glossRule(rule)).not.toMatch(/word-break\s*:\s*keep-all/)
      expect(glossRule(rule)).not.toMatch(/white-space\s*:\s*(nowrap|pre)\s*(;|$)/)
    }
  })

  /* `SelectionTools` bounds EVERY face by the room it is placed in, because
     placement can move a surface and cannot shrink one — so the popup has to
     scroll within that bound, or the bound only clips what it holds.
     ON THE POPUP ITSELF, NOT THE LOOKUP'S RULE: this read
     `.popup[data-face='lookup']` until 2026-09-14, when the rows were bounded
     too (#159) and a scroll that only one face had would have clipped the
     other three. `auto` in both directions — a row overflows sideways and an
     answer downwards. */
  it('scrolls any face larger than its room, rather than clipping it', () => {
    const source = popupCss.replace(/\/\*[\s\S]*?\*\//g, '')
    const match = /\.popup\s*\{([^}]*)\}/.exec(source)
    if (!match) throw new Error('SelectionTools.module.css has no rule for .popup')
    expect(match[1]).toMatch(/(^|;|\s)overflow\s*:\s*auto/)
  })

  /* And the way out must not scroll away with the answer. */
  it('keeps Back in sight while a long answer scrolls', () => {
    expect(glossRule('.back')).toMatch(/position\s*:\s*sticky/)
    expect(glossRule('.back')).toMatch(/top\s*:\s*0/)
  })
})

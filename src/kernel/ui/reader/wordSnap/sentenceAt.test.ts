import { describe, expect, it, vi } from 'vitest'
import { buildFixture, elem, txt, type Fixture } from './domFake.testkit'
import { sentenceAt } from './sentenceAt'

/**
 * The sentence a selection sits in, over the hand-built DOM.
 *
 * Every case here is a claim about what the reader is looking at, so every
 * fixture is markup a real book ships: a paragraph split by `<em>`, a source
 * newline inside a `<p>`, per-character ruby, a `noteref` superscript, a
 * positioned sidenote, a `<br>` in the middle of a sentence.
 *
 * **The discriminating property throughout is that the wrong walk gives a
 * different string.** `domFake.testkit.ts` refuses duplicate text nodes for
 * exactly that reason, and the cases below are built so that reading the wrong
 * entry, the wrong offset or the wrong locale changes the answer rather than
 * leaving it accidentally right.
 *
 * **Live-lane partner: `scripts/sentence-parity.mjs`.** Segmentation here is
 * Node's ICU, and the app runs on WebKit's. Nothing in this lane can prove the
 * two agree — that is what the sentence corpus and its parity driver are for,
 * and the lane is manual-only, so **check whether it has been run.**
 */

/** A `Range` as this module reads one: four fields and nothing else. */
function rangeOf(
  fixture: Fixture,
  start: readonly [string, number],
  end: readonly [string, number],
): Range {
  return {
    startContainer: fixture.text(start[0]),
    startOffset: start[1],
    endContainer: fixture.text(end[0]),
    endOffset: end[1],
  } as unknown as Range
}

describe('sentenceAt — the run', () => {
  /*
   * The ordinary case, and the one the phase exists for: the model gets the
   * whole sentence rather than a 64-character window that begins mid-word.
   * Three sentences, so the middle one has a boundary strictly inside the run
   * on both sides — see the completeness cases below for why that matters.
   */
  it('returns the sentence the term sits in, not the window around it', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('First one. The old man taught the '),
        elem('em', {}, [txt('boy')]),
        txt(' to fish. Last one.'),
      ]),
    )

    expect(sentenceAt(rangeOf(fixture, ['boy', 0], ['boy', 3]))).toEqual({
      sentence: 'The old man taught the boy to fish.',
      term: 'boy',
    })
  })

  /*
   * §A1. A sentinel is an entry ABSENT from `flat.nodes`, never a string match
   * on its character. This paragraph holds a real text node whose data is
   * exactly `'\n'` — ordinary pretty-printed XHTML — and the two tests
   * disagree about it: by absence it is the text it is, by value it is a block
   * boundary that cuts the paragraph in half at its own indentation. The cut
   * version loses `Alpha one.` and then declines, because the surviving run
   * starts at the term's sentence.
   */
  it('does not split a paragraph at a source newline inside it', () => {
    const fixture = buildFixture(
      elem('p', {}, [txt('Alpha one.'), txt('\n'), txt('Beta two. Gamma three.')]),
    )

    expect(sentenceAt(rangeOf(fixture, ['Beta two. Gamma three.', 5], ['Beta two. Gamma three.', 8]))).toEqual(
      { sentence: 'Beta two.', term: 'two' },
    )
  })

  /*
   * §A2. `dog` occurs twice, and `indexOf` returns the wrong one — which
   * chooses the wrong sentence, and then declines because that sentence starts
   * at the run's edge. The term is located by OFFSET, which is the only thing
   * that can tell two identical words apart.
   */
  it('locates the term by offset, so a word repeated earlier does not win', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('A dog sat here. The '),
        elem('em', {}, [txt('dog')]),
        txt(' ran away. Done now.'),
      ]),
    )

    expect(sentenceAt(rangeOf(fixture, ['dog', 0], ['dog', 3]))).toEqual({
      sentence: 'The dog ran away.',
      term: 'dog',
    })
  })

  /*
   * §A3. Two blocks, and the end anchor is in the second. The start's run
   * cannot say where the selection stops, so completeness on that side cannot
   * be established. It declines; it must not throw and it must not quietly
   * answer about the first block alone.
   */
  it('declines a selection that spans two blocks, without throwing', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]),
        elem('p', {}, [txt('Delta four. Epsilon five. Zeta six.')]),
      ]),
    )

    expect(
      sentenceAt(rangeOf(fixture, ['Alpha one. Beta two. Gamma three.', 11], ['Delta four. Epsilon five. Zeta six.', 17])),
    ).toBeNull()
  })

  /*
   * §A4. The term itself contains a terminator, so it belongs to two segments
   * and taking only the first would send half of what the reader selected.
   */
  it('takes both segments when the selection spans a sentence boundary', () => {
    const fixture = buildFixture(
      elem('p', {}, [txt('One here. Two there. Three everywhere. Four beyond.')]),
    )

    expect(
      sentenceAt(
        rangeOf(
          fixture,
          ['One here. Two there. Three everywhere. Four beyond.', 14],
          ['One here. Two there. Three everywhere. Four beyond.', 26],
        ),
      ),
    ).toEqual({ sentence: 'Two there. Three everywhere.', term: 'there. Three' })
  })

  /*
   * §A5. A list item, a heading, a verse line: the run IS the sentence, and
   * nothing in it says so. Both of its boundaries coincide with the run's
   * edges, so under §C1 there is no sentence to vouch for and the caller falls
   * back to what shipped before this existed.
   */
  it('declines a run with no sentence boundary inside it', () => {
    const fixture = buildFixture(elem('li', {}, [txt('Apples')]))

    expect(sentenceAt(rangeOf(fixture, ['Apples', 0], ['Apples', 6]))).toBeNull()
  })
})

describe('sentenceAt — what is in the run but not in the sentence', () => {
  /*
   * §B1, and the case that killed revision 1's rule. PER-CHARACTER ruby is
   * standard, so `<rt>` lands INSIDE the term: a range from 漢 through 字
   * flattens to `漢かん字`. Keeping the interior entry leaves the reading in the
   * sentence; dropping it without normalising the term means the term no
   * longer occurs in the sentence it is supposedly from. Both must come back
   * as exactly 漢字, which is why this returns a pair rather than a string.
   */
  it('drops the ruby reading from both the sentence and the term', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('前の文です。'),
        elem('ruby', { display: 'ruby' }, [
          txt('漢'),
          elem('rt', { display: 'ruby-text' }, [txt('かん')]),
          txt('字'),
          elem('rt', { display: 'ruby-text' }, [txt('じ')]),
        ]),
        txt('は難しい。次の文です。'),
      ]),
    )

    const found = sentenceAt(rangeOf(fixture, ['漢', 0], ['字', 1]))

    expect(found).toEqual({ sentence: '漢字は難しい。', term: '漢字' })
    expect(found?.sentence).not.toContain('かん')
    expect(found?.sentence).not.toContain('じ')
    /* The term must OCCUR in the sentence, or the model is being asked about a
     * word that is not there. This is the assertion the pair exists for. */
    expect(found?.sentence).toContain(found?.term ?? '')
  })

  /*
   * §B1 again, from the other side: `<rp>` is the parenthesis a browser
   * without ruby support shows around a reading. It is the annotation too, and
   * filtering only `<rt>` leaves the brackets welded into the word.
   */
  it('drops the ruby fallback parentheses as well as the reading', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('最初の文。'),
        elem('ruby', { display: 'ruby' }, [
          txt('東京'),
          elem('rp', { display: 'ruby-text' }, [txt('（')]),
          elem('rt', { display: 'ruby-text' }, [txt('とうきょう')]),
          elem('rp', { display: 'ruby-text' }, [txt('）')]),
        ]),
        txt('は大きい。最後の文。'),
      ]),
    )

    expect(sentenceAt(rangeOf(fixture, ['東京', 0], ['東京', 2]))).toEqual({
      sentence: '東京は大きい。',
      term: '東京',
    })
  })

  /*
   * §B2, and the measured trap in it. The marker's own text carries the
   * spacing; closing the gap entirely yields `He left.Then she stayed.`, which
   * ICU returns as ONE segment — so the sentence would swallow its neighbour.
   * A filtered entry leaves a space behind.
   */
  it('drops a footnote marker and leaves a separator where it was', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('One first. He left.'),
        elem('a', { attributes: { 'epub:type': 'noteref' } }, [txt(' 1 ')]),
        txt('Then she stayed. Last one.'),
      ]),
    )

    const found = sentenceAt(
      rangeOf(fixture, ['Then she stayed. Last one.', 9], ['Then she stayed. Last one.', 15]),
    )

    expect(found).toEqual({ sentence: 'Then she stayed.', term: 'stayed' })
    expect(found?.sentence).not.toContain('1')
  })

  /*
   * The same marker in a book foliate could parse as XML. `epub:type` is in
   * the OPS namespace there and in the null namespace when the book had to be
   * reparsed as `text/html` — reading one spelling covers half the shelf.
   */
  it('drops a footnote marker whose epub:type is namespaced', () => {
    const OPS = 'http://www.idpf.org/2007/ops'
    const fixture = buildFixture(
      elem('p', {}, [
        txt('One first. He left.'),
        elem(
          'a',
          { attributes: { 'epub:type': 'noteref' }, namespaced: { [`${OPS}|type`]: 'noteref' } },
          [txt(' 1 ')],
        ),
        txt('Then she stayed. Last one.'),
      ]),
    )

    expect(
      sentenceAt(rangeOf(fixture, ['Then she stayed. Last one.', 9], ['Then she stayed. Last one.', 15]))
        ?.sentence,
    ).toBe('Then she stayed.')
  })

  it('drops a footnote marker carrying only the ARIA role', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('One first. He left.'),
        elem('a', { attributes: { role: 'doc-noteref' } }, [txt(' 1 ')]),
        txt('Then she stayed. Last one.'),
      ]),
    )

    expect(
      sentenceAt(rangeOf(fixture, ['Then she stayed. Last one.', 9], ['Then she stayed. Last one.', 15]))
        ?.sentence,
    ).toBe('Then she stayed.')
  })

  /*
   * §B2's other half, and the reason the filter is by SEMANTIC and never by
   * tag. `<sup>` is an exponent far more often than it is a note marker;
   * filtering it would quietly rewrite `x2` as `x`, along with every ordinal
   * and every bit of maths in the book.
   */
  it('keeps a <sup> that is not a note reference', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('First bit. Take x'),
        elem('sup', {}, [txt('2')]),
        txt(' here. Last bit.'),
      ]),
    )

    expect(sentenceAt(rangeOf(fixture, ['First bit. Take x', 11], ['First bit. Take x', 15]))).toEqual({
      sentence: 'Take x2 here.',
      term: 'Take',
    })
  })

  /*
   * §B3, and this is NOT a fixed-layout problem. `isBlockLevel` returns false
   * for `position: absolute|fixed` unconditionally, so a positioned sidenote
   * in an ordinary reflowable EPUB merges into the prose with no sentinel
   * between them — and a stray `Sidebar.` then decides where the sentence
   * ends.
   */
  it('drops a positioned sidenote out of a reflowable paragraph', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('One first. The whale '),
        elem('span', { position: 'absolute' }, [txt('Sidebar. ')]),
        txt('swam here. Last one.'),
      ]),
    )

    const found = sentenceAt(rangeOf(fixture, ['One first. The whale ', 15], ['One first. The whale ', 20]))

    expect(found).toEqual({ sentence: 'The whale swam here.', term: 'whale' })
    expect(found?.sentence).not.toContain('Sidebar')
  })

  /*
   * The mirror of the case above: when the TERM is the positioned content, the
   * prose around it is what does not share its context. The rule is "the same
   * nearest positioned ancestor as the term", not "in flow".
   */
  it('keeps the term’s own positioned box and drops the prose around it', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        txt('Running head. '),
        elem('span', { id: 'note', position: 'absolute' }, [
          txt('One first. The whale swam here. Last one.'),
        ]),
        txt(' Drop folio.'),
      ]),
    )

    const found = sentenceAt(
      rangeOf(
        fixture,
        ['One first. The whale swam here. Last one.', 15],
        ['One first. The whale swam here. Last one.', 20],
      ),
    )

    expect(found).toEqual({ sentence: 'The whale swam here.', term: 'whale' })
    expect(found?.sentence).not.toContain('folio')
  })
})

describe('sentenceAt — what an audit found', () => {
  /*
   * Ruby annotation by SHAPE as well as by name. CSS lets any element be a
   * ruby annotation box, and `flatten` already reads `display.startsWith('ruby')`
   * rather than trusting a tag — so a filter here that knew only RT and RP was
   * the near-miss this whole directory argues against, in the file that argues
   * it. The fixture uses a `<span>`, which no tag list would catch.
   */
  it('drops a ruby annotation that is a span with display: ruby-text', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('前の文です。'),
        elem('span', { display: 'ruby' }, [
          txt('漢字'),
          elem('span', { display: 'ruby-text' }, [txt('かんじ')]),
        ]),
        txt('は難しい。次の文です。'),
      ]),
    )

    expect(sentenceAt(rangeOf(fixture, ['漢字', 0], ['漢字', 2]))).toEqual({
      sentence: '漢字は難しい。',
      term: '漢字',
    })
  })

  /*
   * §A3 in the shape §B3 makes possible. A term starting in the prose and
   * ending inside a positioned box spans two visual contexts — so one of its
   * ends is about to be filtered away, and what came back was PART of what the
   * reader selected, with nothing saying so. Ruby and noteref drops are not
   * this: those are annotation spliced inside one context.
   */
  it('declines a term whose two ends are in different positioned contexts', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('One first. The whale '),
        elem('span', { position: 'absolute' }, [txt('swam')]),
        txt(' here. Last one.'),
      ]),
    )

    /* The reader selected `whale swam`. Without the guard the positioned half
     * is filtered away and a perfectly well-formed answer comes back about
     * `whale` alone — a term that is not what was asked about, in a sentence
     * that reads as if it were. That is the shape this declines. */
    expect(
      sentenceAt(rangeOf(fixture, ['One first. The whale ', 15], ['swam', 4])),
    ).toBeNull()
    /* Non-vacuity: the same run answers when the term stays in one context. */
    expect(
      sentenceAt(rangeOf(fixture, ['One first. The whale ', 15], ['One first. The whale ', 20]))
        ?.sentence,
    ).toBe('The whale here.')
  })

  /*
   * The locale must come from text the run still CONTAINS. Here the term
   * begins inside a footnote marker that this pass filters out, and that
   * marker carries a `lang` of its own — reading it would segment the sentence
   * under metadata belonging to something that is not in it. The observable is
   * the abbreviation merge, which is gated on the locale's script.
   */
  it('takes the locale from a kept entry, not from one it filtered away', () => {
    const fixture = buildFixture(
      elem('p', { attributes: { lang: 'en' } }, [
        txt('Alpha one. He met Mr.'),
        elem('a', { attributes: { 'epub:type': 'noteref', lang: 'zh' } }, [txt(' 9 ')]),
        txt(' Smith today. Beta two.'),
      ]),
    )

    /* The term begins where the marker used to be, so the entry holding its
     * start is the one this pass filtered out. Reading `lang` from THAT entry
     * gives `zh`, which turns the Latin merge off and answers `Smith today.` —
     * a sentence beginning at an abbreviation, under the language of a
     * footnote marker that is not in the run. The first KEPT entry says `en`,
     * and `en` is what the run is written in. */
    expect(sentenceAt(rangeOf(fixture, [' 9 ', 0], [' Smith today. Beta two.', 6]))).toEqual({
      sentence: 'He met Mr. Smith today.',
      term: 'Smith',
    })
  })

  /*
   * The cap bounds the ANSWER; this bounds the WORK. `flatten` never splits a
   * text node, so its budget is a budget and not a bound — one pathological
   * node arrives whole and would be squeezed and segmented in full,
   * synchronously, ON THE SELECTION PATH, before the answer was rejected for
   * being too long. A reader who dragged across it would feel the stall and
   * never learn why.
   */
  it('declines a run past the work bound without segmenting it', () => {
    const huge = `Alpha one. ${'padding words here. '.repeat(4_000)}Beta two.`
    expect(huge.length).toBeGreaterThan(64_000)
    const fixture = buildFixture(elem('p', {}, [txt(huge)]))
    const diagnostics = { info: vi.fn() }

    /* THE ASSERTION IS THAT THE SEGMENTER IS NEVER BUILT, not that the call was
     * fast. A wall-clock bound is the wrong instrument here and measurably so:
     * segmenting this exact 80 kB fixture takes single-digit milliseconds, so a
     * guard placed AFTER segmentation would pass a timing assertion while doing
     * precisely the work the guard exists to avoid. */
    const built = vi.spyOn(Intl, 'Segmenter')
    try {
      const found = sentenceAt(rangeOf(fixture, [huge, 30], [huge, 37]), {
        diagnostics: diagnostics as never,
      })

      expect(found).toBeNull()
      expect(diagnostics.info).toHaveBeenCalledWith('gloss.sentence', {
        outcome: 'fallback',
        gap: 'too-long',
      })
      expect(built).not.toHaveBeenCalled()
    } finally {
      built.mockRestore()
    }

    /* Non-vacuity: the spy DOES see the ordinary path, so "never called" above
     * means the work was skipped rather than that the spy was never wired. */
    const ordinary = buildFixture(elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]))
    const watched = vi.spyOn(Intl, 'Segmenter')
    try {
      sentenceAt(rangeOf(ordinary, ['Alpha one. Beta two. Gamma three.', 11], [
        'Alpha one. Beta two. Gamma three.',
        15,
      ]))
      expect(watched).toHaveBeenCalled()
    } finally {
      watched.mockRestore()
    }
  })
})

describe('sentenceAt — completeness is the gate', () => {
  /*
   * §C2. `He said,<br>and left.` yields a sentinel `Flattened` cannot tell
   * from `</p>`, so the run ends at `He said,` — a fragment with a comma on
   * it, which is exactly the shape a model would answer confidently about.
   * The end of the segment coincides with the run's edge, so nothing is
   * vouched for and the caller falls back. The fallback returns the whole
   * sentence, which is the right answer by the other route.
   */
  it('declines a sentence cut by a <br>', () => {
    const fixture = buildFixture(elem('p', {}, [txt('He said,'), elem('br', {}), txt('and left.')]))

    expect(sentenceAt(rangeOf(fixture, ['He said,', 3], ['He said,', 7]))).toBeNull()
  })

  /*
   * §C1, and the reason it reads no `flatten` flag. `flatten.test.ts` pins
   * `truncatedEnd === false` for a window the budget cut short, because the
   * cut happened to land on a space — so a completeness rule that trusted that
   * flag would call this run complete and send a sentence with its tail
   * missing. The boundary here coincides with the window's edge, whatever kind
   * of edge that is, so it is not evidence of a sentence ending.
   */
  it('declines when the run was cut by the budget, however safe the cut was', () => {
    const fixture = buildFixture(
      elem('p', {}, [
        elem('span', {}, [txt('Alpha one. ')]),
        elem('span', {}, [txt('Beta two. ')]),
        elem('span', {}, [txt('Gamma three. ')]),
        elem('span', {}, [txt('Delta four. ')]),
      ]),
    )

    /* 30 characters: the walk reaches `Beta two. ` and stops on a space, so it
     * reports itself untruncated while `Gamma three.` never arrived. */
    expect(sentenceAt(rangeOf(fixture, ['Beta two. ', 0], ['Beta two. ', 4]), { maxChars: 30 })).toBeNull()
    /* The same selection with room to see the whole paragraph is answered. */
    expect(sentenceAt(rangeOf(fixture, ['Beta two. ', 0], ['Beta two. ', 4]))).toEqual({
      sentence: 'Beta two.',
      term: 'Beta',
    })
  })

  /*
   * A first sentence and a last sentence both touch their block's edge, and
   * `</p>` is indistinguishable from `<br>` and from a budget cut. This is the
   * price of the rule, stated as a case rather than left to be discovered: the
   * phase covers the interior of a paragraph and declines its two ends.
   */
  it('declines the first and last sentence of a block', () => {
    const fixture = buildFixture(elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]))
    const whole = 'Alpha one. Beta two. Gamma three.'

    expect(sentenceAt(rangeOf(fixture, [whole, 6], [whole, 9]))).toBeNull()
    expect(sentenceAt(rangeOf(fixture, [whole, 11], [whole, 15]))).toEqual({
      sentence: 'Beta two.',
      term: 'Beta',
    })
    expect(sentenceAt(rangeOf(fixture, [whole, 27], [whole, 32]))).toBeNull()
  })
})

describe('sentenceAt — the locale', () => {
  const PARAGRAPH = 'Alpha one. He met Mr. Smith today. Beta two.'

  /*
   * §D2. `resolveSegmenterLocale` validates a tag it is handed and nothing
   * discovers one, so until now every book segmented in the host's locale.
   * The nearest ancestor `lang` is what `:lang()` uses and the only rule that
   * survives a mixed-language book.
   *
   * The observable is the abbreviation merge, which is gated to Latin-script
   * locales: under `en` the run `He met Mr. Smith today.` is one sentence,
   * under `zh` ICU ends a sentence at `Mr.` and the answer is a different
   * string. A implementation ignoring `lang` would give the same answer twice.
   */
  it('segments in the nearest ancestor’s language', () => {
    const english = buildFixture(elem('p', { attributes: { lang: 'en' } }, [txt(PARAGRAPH)]))
    const chinese = buildFixture(elem('p', { attributes: { lang: 'zh' } }, [txt(PARAGRAPH)]))

    expect(sentenceAt(rangeOf(english, [PARAGRAPH, 22], [PARAGRAPH, 27]))?.sentence).toBe(
      'He met Mr. Smith today.',
    )
    expect(sentenceAt(rangeOf(chinese, [PARAGRAPH, 22], [PARAGRAPH, 27]))?.sentence).toBe(
      'Smith today.',
    )
  })

  it('prefers the nearest declaration to the document’s own', () => {
    const fixture = buildFixture(
      elem('div', { attributes: { lang: 'zh' } }, [
        elem('p', { attributes: { lang: 'en' } }, [txt(PARAGRAPH)]),
      ]),
    )

    expect(sentenceAt(rangeOf(fixture, [PARAGRAPH, 22], [PARAGRAPH, 27]))?.sentence).toBe(
      'He met Mr. Smith today.',
    )
  })

  it('reads xml:lang, which is where an XHTML book puts it', () => {
    const XML = 'http://www.w3.org/XML/1998/namespace'
    const fixture = buildFixture(
      elem('p', { namespaced: { [`${XML}|lang`]: 'zh' } }, [txt(PARAGRAPH)]),
    )

    expect(sentenceAt(rangeOf(fixture, [PARAGRAPH, 22], [PARAGRAPH, 27]))?.sentence).toBe(
      'Smith today.',
    )
  })

  /*
   * `new Intl.Segmenter('en_US')` throws a `RangeError`, and EPUBs carry
   * exactly that spelling. `resolveSegmenterLocale` repairs it — and a tag it
   * cannot repair is transparent rather than final, so a typo on one span does
   * not discard the book's own declaration a level up.
   */
  it('repairs a POSIX-spelled tag and steps past one it cannot use', () => {
    const posix = buildFixture(elem('p', { attributes: { lang: 'zh_Hans_CN' } }, [txt(PARAGRAPH)]))
    const broken = buildFixture(
      elem('div', { attributes: { lang: 'zh' } }, [
        elem('span', { attributes: { lang: '???' } }, [txt(PARAGRAPH)]),
      ]),
    )

    expect(sentenceAt(rangeOf(posix, [PARAGRAPH, 22], [PARAGRAPH, 27]))?.sentence).toBe('Smith today.')
    expect(sentenceAt(rangeOf(broken, [PARAGRAPH, 22], [PARAGRAPH, 27]))?.sentence).toBe('Smith today.')
  })
})

describe('sentenceAt — it declines rather than throwing', () => {
  /*
   * §E5. A snapshot's range may have been re-rendered between the selection
   * and the lookup — on a PDF that is what a zoom does, and `replaceChildren`
   * leaves a text node that looks perfectly intact from the inside.
   */
  it('declines a range whose nodes have left the document', () => {
    const fixture = buildFixture(
      elem('div', { id: 'layer' }, [elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')])]),
    )
    const range = rangeOf(fixture, ['Alpha one. Beta two. Gamma three.', 11], [
      'Alpha one. Beta two. Gamma three.',
      15,
    ])
    expect(sentenceAt(range)).not.toBeNull()

    fixture.replaceChildren('layer', [elem('p', {}, [txt('Repainted at a new scale.')])])

    expect(sentenceAt(range)).toBeNull()
  })

  it('declines a boundary that is not a text node', () => {
    const fixture = buildFixture(elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]))
    const range = {
      startContainer: fixture.root,
      startOffset: 0,
      endContainer: fixture.root,
      endOffset: 1,
    } as unknown as Range

    expect(sentenceAt(range)).toBeNull()
  })

  /*
   * §E6. This runs on the selection path, where a throw loses the reader's
   * lookup — the same rule `resolveSegmenterLocale` is total for.
   */
  it('declines rather than throwing when the walk itself fails', () => {
    const exploding = {
      get startContainer(): never {
        throw new Error('the document was torn down mid-walk')
      },
      startOffset: 0,
      endContainer: null,
      endOffset: 0,
    } as unknown as Range

    expect(() => sentenceAt(exploding)).not.toThrow()
    expect(sentenceAt(exploding)).toBeNull()
  })

  /*
   * A THROW IS NOT ONE FACT. Collapsed into a bare `threw` count, a build where
   * the extractor is simply broken looks exactly like one where books are
   * merely awkward — the failure §C exists to prevent, one level in. `error`
   * rather than `info`, because nothing here should ever throw.
   *
   * The cause goes through `redact`, which reduces an Error to its TYPE and
   * nothing else, so no message and no stack — and therefore no book text —
   * can ride out on one.
   */
  it('says that it threw, and what kind, without carrying the throw’s words', () => {
    const throwing = (thrown: unknown): Range =>
      ({
        get startContainer(): never {
          throw thrown
        },
        startOffset: 0,
        endContainer: null,
        endOffset: 0,
      }) as unknown as Range
    const diagnostics = { info: vi.fn(), error: vi.fn() }

    sentenceAt(throwing(new TypeError('the document was torn down mid-walk')), {
      diagnostics: diagnostics as never,
    })
    /* ⚠️ A THROWN VALUE IS NOT ALWAYS AN ERROR. `redact` reduces an Error to
     * its class name, and passes a string under an unknown key through
     * UNCHANGED — so forwarding the raw value put whatever was thrown into the
     * log, and a line of the book is exactly the kind of thing that ends up
     * thrown. The reduction happens where the value is. */
    sentenceAt(throwing('Call me Ishmael. Some years ago…'), {
      diagnostics: diagnostics as never,
    })
    /* And `throw undefined` is legal JavaScript. Reading absence off the value
     * filed it as an ordinary fallback with nothing to say. */
    sentenceAt(throwing(undefined), { diagnostics: diagnostics as never })

    expect(diagnostics.info).not.toHaveBeenCalled()
    expect(diagnostics.error.mock.calls).toEqual([
      ['gloss.sentence', { outcome: 'fallback', gap: 'threw', cause: 'TypeError' }],
      ['gloss.sentence', { outcome: 'fallback', gap: 'threw', cause: 'string' }],
      ['gloss.sentence', { outcome: 'fallback', gap: 'threw', cause: 'undefined' }],
    ])
    expect(JSON.stringify(diagnostics.error.mock.calls)).not.toContain('Ishmael')
  })

  /* An `Error` whose `name` was set to a sentence is the same leak wearing a
   * different hat — `name` is an ordinary mutable property. */
  it('refuses an Error name that is not shaped like a type', () => {
    const named = new Error('boom')
    named.name = 'Call me Ishmael'
    const diagnostics = { info: vi.fn(), error: vi.fn() }

    sentenceAt(
      {
        get startContainer(): never {
          throw named
        },
        startOffset: 0,
        endContainer: null,
        endOffset: 0,
      } as unknown as Range,
      { diagnostics: diagnostics as never },
    )

    expect(diagnostics.error).toHaveBeenCalledWith('gloss.sentence', {
      outcome: 'fallback',
      gap: 'threw',
      cause: 'Error',
    })
  })
})

describe('sentenceAt — whether the path fires at all', () => {
  /*
   * §F4. After this phase some lookups use a real sentence and some fall back,
   * and the reader cannot act on the difference — showing it would be noise.
   * But a build where EVERY lookup falls back looks identical to a working one
   * from the outside, which is the failure §C exists to prevent one level up.
   *
   * The reason is a closed enum word. Never the sentence, never the term,
   * never any book text.
   */
  function spy(): { info: ReturnType<typeof vi.fn> } {
    return { info: vi.fn() }
  }

  it('records the outcome of each attempt', () => {
    const fixture = buildFixture(elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]))
    const whole = 'Alpha one. Beta two. Gamma three.'
    const diagnostics = spy()

    sentenceAt(rangeOf(fixture, [whole, 11], [whole, 15]), {
      diagnostics: diagnostics as never,
    })
    sentenceAt(rangeOf(fixture, [whole, 0], [whole, 5]), { diagnostics: diagnostics as never })

    expect(diagnostics.info.mock.calls).toEqual([
      ['gloss.sentence', { outcome: 'used' }],
      ['gloss.sentence', { outcome: 'fallback', gap: 'run-start' }],
    ])
  })

  it('names the reason a selection across two blocks fell back', () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]),
        elem('p', {}, [txt('Delta four. Epsilon five. Zeta six.')]),
      ]),
    )
    const diagnostics = spy()

    sentenceAt(
      rangeOf(fixture, ['Alpha one. Beta two. Gamma three.', 11], ['Delta four. Epsilon five. Zeta six.', 17]),
      { diagnostics: diagnostics as never },
    )

    expect(diagnostics.info).toHaveBeenCalledWith('gloss.sentence', {
      outcome: 'fallback',
      gap: 'span-blocks',
    })
  })
})
